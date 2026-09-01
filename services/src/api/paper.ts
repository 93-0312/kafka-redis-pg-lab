import type Redis from 'ioredis';
import { STRATEGIES } from '../domain/strategy.js';
import { K } from '../lib/keys.js';
import type { Market, Currency, PaperTradeRecord } from '../types.js';

/**
 * 전략별 페이퍼 계좌 조회. 포지션 평가는 quote 워커가 캐싱한 최신가(mkt:quote:*)를 씁니다.
 */

export interface PaperPositionView {
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  /** 거래 통화 기준 평가금액 */
  marketValue: number;
  /** 원화 환산 평가금액 (총자산 계산용) */
  marketValueKrw: number;
  unrealizedPnl: number;
  unrealizedRate: number;
  openedAt: string;
}

export interface PaperStrategySummary {
  strategyId: string;
  label: string;
  description: string;
  startedAt: string;
  totals: {
    initialCash: number;
    cash: number;
    positionsValue: number;
    equity: number;
    totalPnl: number;
    totalRate: number;
    realizedPnl: number;
    tradeCount: number;
  };
  positions: PaperPositionView[];
  trades: PaperTradeRecord[];
}

export interface PaperSummary {
  strategyNote: string;
  strategies: PaperStrategySummary[];
  generatedAt: string;
}

const n = (v: string | null | undefined): number => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function readStrategy(
  redis: Redis,
  def: (typeof STRATEGIES)[number],
  usdKrw: number,
): Promise<PaperStrategySummary | null> {
  const account = await redis.hgetall(K.paperAccount(def.id));
  if (!account['initialCash']) return null;

  const symbols = await redis.smembers(K.paperPosIndex(def.id));
  const positions: PaperPositionView[] = [];
  for (const symbol of symbols) {
    const pos = await redis.hgetall(K.paperPos(def.id, symbol));
    if (!pos['symbol']) continue;
    const quantity = n(pos['quantity']);
    const avgPrice = n(pos['avgPrice']);
    const currency = (pos['currency'] ?? 'KRW') as Currency;
    const lastPrice = n(await redis.hget(K.quote(symbol), 'price')) || avgPrice;
    const marketValue = quantity * lastPrice;
    const fx = currency === 'USD' ? usdKrw : 1;
    positions.push({
      symbol,
      name: pos['name'] ?? symbol,
      market: (pos['market'] ?? 'KR') as Market,
      currency,
      quantity,
      avgPrice,
      lastPrice,
      marketValue,
      marketValueKrw: marketValue * fx,
      unrealizedPnl: (lastPrice - avgPrice) * quantity * fx,
      unrealizedRate: avgPrice > 0 ? (lastPrice - avgPrice) / avgPrice : 0,
      openedAt: pos['openedAt'] ?? '',
    });
  }
  positions.sort((a, b) => b.marketValueKrw - a.marketValueKrw);

  const allTrades = (await redis.lrange(K.paperTrades(def.id), 0, -1))
    .map((r) => JSON.parse(r) as PaperTradeRecord);
  const realizedPnl = allTrades.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);

  const initialCash = n(account['initialCash']);
  const cash = n(account['cash']);
  const positionsValue = positions.reduce((s, p) => s + p.marketValueKrw, 0);
  const equity = cash + positionsValue;

  return {
    strategyId: def.id,
    label: def.label,
    description: def.description,
    startedAt: account['startedAt'] ?? '',
    totals: {
      initialCash,
      cash,
      positionsValue,
      equity,
      totalPnl: equity - initialCash,
      totalRate: initialCash > 0 ? (equity - initialCash) / initialCash : 0,
      realizedPnl,
      tradeCount: allTrades.filter((t) => t.status === 'FILLED').length,
    },
    positions,
    trades: allTrades.slice(0, 30),
  };
}

export interface PaperTradesPage {
  trades: PaperTradeRecord[];
  /** 필터 적용 후 전체 건수 (더 보기 버튼 노출 판단용) */
  total: number;
  offset: number;
}

/**
 * 체결 내역 페이지 조회. 라이브 요약(readPaper)은 최근 30건만 싣지만,
 * 이 함수는 저장된 전량(최대 500건)을 offset/limit 으로 잘라 과거까지 넘겨봅니다.
 * 리스트는 lpush 라 index 0 이 최신입니다.
 */
export async function readPaperTrades(
  redis: Redis,
  strategyId: string,
  opts: { offset?: number; limit?: number; includeRejected?: boolean } = {},
): Promise<PaperTradesPage> {
  const includeRejected = opts.includeRejected ?? false;
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 500);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const all = (await redis.lrange(K.paperTrades(strategyId), 0, -1))
    .map((r) => JSON.parse(r) as PaperTradeRecord)
    .filter((t) => includeRejected || t.status !== 'REJECTED');
  return { total: all.length, offset, trades: all.slice(offset, offset + limit) };
}

export interface PaperDailyRow {
  /** 스냅샷 날짜 (07:30 기준). 'live' 는 마지막 스냅샷 이후 현재까지 진행분 */
  date: string;
  strategyId: string;
  equity: number;
  /** 직전 스냅샷 대비 손익 (첫 행은 초기 자금 대비) */
  dailyPnl: number;
  dailyRate: number;
  /** 이 구간에 실제 체결된 건수. 0이면 "거래 없음"으로 표시 (0원 손익과 구분) */
  tradeCount: number;
}

/**
 * 날짜별 손익. 아침 브리핑이 매일 07:30 에 남기는 자산 스냅샷의 차분입니다.
 * "하루" = 전일 07:30 → 당일 07:30 (국장 + 밤 미장 한 사이클).
 * 마지막에 현재 자산 기준 진행분(live)을 덧붙입니다.
 */
export async function readPaperDaily(
  redis: Redis,
  pool: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> },
): Promise<PaperDailyRow[]> {
  const res = await pool.query(
    `SELECT snapshot_date::text AS date, strategy_id, equity::float8 AS equity,
            extract(epoch from created_at) * 1000 AS created_ms
     FROM paper_equity_daily ORDER BY snapshot_date ASC`,
  );

  // 전략별 체결 시각(ms) 목록 — 각 구간의 실제 체결 수를 세기 위함.
  // "0원 손익"과 "매매 자체가 없던 날(휴면)"을 구분하려면 손익이 아니라 체결 수를 봐야 합니다.
  const fillsBySid = new Map<string, number[]>();
  for (const sid of new Set(res.rows.map((r) => String(r['strategy_id'])))) {
    const raw = await redis.lrange(K.paperTrades(sid), 0, -1);
    fillsBySid.set(
      sid,
      raw
        .map((s) => JSON.parse(s) as PaperTradeRecord)
        .filter((t) => t.status === 'FILLED')
        .map((t) => Date.parse(t.filledAt))
        .filter((ms) => Number.isFinite(ms)),
    );
  }
  const countFills = (sid: string, from: number, to: number): number =>
    (fillsBySid.get(sid) ?? []).filter((ms) => ms > from && ms <= to).length;

  const out: PaperDailyRow[] = [];
  const prevEquity = new Map<string, number>();
  const prevMs = new Map<string, number>();

  for (const r of res.rows) {
    const sid = String(r['strategy_id']);
    const equity = Number(r['equity']);
    const createdMs = Number(r['created_ms']);
    // 첫 스냅샷의 기준은 해당 전략 계좌의 초기 자금
    const base =
      prevEquity.get(sid) ??
      (n(await redis.hget(K.paperAccount(sid), 'initialCash')) || equity);
    out.push({
      date: String(r['date']),
      strategyId: sid,
      equity,
      dailyPnl: equity - base,
      dailyRate: base > 0 ? (equity - base) / base : 0,
      tradeCount: countFills(sid, prevMs.get(sid) ?? 0, createdMs),
    });
    prevEquity.set(sid, equity);
    prevMs.set(sid, createdMs);
  }

  // 진행분: 현재 자산 vs 마지막 스냅샷
  const current = await readPaper(redis);
  const now = Date.now();
  for (const s of current.strategies) {
    const base = prevEquity.get(s.strategyId) ?? s.totals.initialCash;
    out.push({
      date: 'live',
      strategyId: s.strategyId,
      equity: s.totals.equity,
      dailyPnl: s.totals.equity - base,
      dailyRate: base > 0 ? (s.totals.equity - base) / base : 0,
      tradeCount: countFills(s.strategyId, prevMs.get(s.strategyId) ?? 0, now),
    });
  }
  return out;
}

export async function readPaper(redis: Redis): Promise<PaperSummary> {
  // 미국 주식 포지션 평가용 환율 (strategy 워커가 30분마다 갱신)
  const usdKrw = n(await redis.get(K.fxUsdKrw)) || 1400;

  const strategies = (
    await Promise.all(STRATEGIES.map((def) => readStrategy(redis, def, usdKrw)))
  ).filter((s): s is PaperStrategySummary => s !== null);

  strategies.sort((a, b) => b.totals.totalRate - a.totals.totalRate);

  return {
    strategyNote: '학습용 예제 전략 — 투자 조언이 아니며 실주문을 내지 않습니다',
    strategies,
    generatedAt: new Date().toISOString(),
  };
}
