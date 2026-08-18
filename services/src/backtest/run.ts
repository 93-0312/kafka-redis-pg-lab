import { config } from '../config.js';
import type { DailyCandle } from '../domain/indicators.js';
import { STRATEGIES, type StrategyDef } from '../domain/strategy.js';
import { createPool } from '../lib/pg.js';
import { fetchDailyCandles, toDailyCandle } from '../lib/toss.js';
import type { Market, TickEvent } from '../types.js';
import { runBacktest, type BacktestConfig, type StrategyResult } from './engine.js';

/**
 * 백테스트 CLI.
 *
 *   npm run backtest                                  # 전체 히스토리 × 전략 5개
 *   npm run backtest -- --from 2026-08-18 --to 2026-08-19
 *   npm run backtest -- --markets KR
 *   npm run backtest -- --trades meanrevert           # 해당 전략의 체결 내역까지 출력
 *   npm run backtest -- --sweep meanrevert            # 진입/익절/손절 그리드 스윕 (상위 15개)
 *
 * ★ 백테스트 성적은 과거에 대한 사실이지 미래 수익의 보장이 아닙니다.
 *   특히 데이터가 짧을수록 과적합 위험이 큽니다. 최종 검증은 페이퍼 트레이딩으로.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const pct = (r: number): string => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(2)}%`;
const krw = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;

async function loadTicks(from?: string, to?: string): Promise<TickEvent[]> {
  const pool = createPool();
  const where: string[] = [];
  const params: string[] = [];
  if (from) { params.push(from); where.push(`polled_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`polled_at < ($${params.length}::date + 1)`); }

  const sql = `
    SELECT event_id, symbol, name, market, currency, price, prev_close, traded_at, polled_at
    FROM ticks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY polled_at ASC`;
  const res = await pool.query(sql, params);
  await pool.end();

  return res.rows.map((r) => ({
    eventId: r.event_id,
    symbol: r.symbol,
    name: r.name,
    market: r.market as TickEvent['market'],
    currency: r.currency as TickEvent['currency'],
    price: Number(r.price),
    prevClose: r.prev_close === null ? null : Number(r.prev_close),
    tradedAt: r.traded_at ? new Date(r.traded_at).toISOString() : null,
    polledAt: new Date(r.polled_at).toISOString(),
  }));
}

function printResults(results: StrategyResult[]): void {
  console.log(
    '전략'.padEnd(10),
    '수익률'.padStart(8),
    '실현손익'.padStart(12),
    '거래비용'.padStart(11),
    'MDD'.padStart(7),
    '체결'.padStart(5),
    '청산'.padStart(5),
    '승률'.padStart(6),
    '미청산'.padStart(5),
  );
  for (const r of [...results].sort((a, b) => b.totalReturn - a.totalReturn)) {
    console.log(
      r.label.padEnd(10),
      pct(r.totalReturn).padStart(8),
      krw(r.realizedPnl).padStart(12),
      krw(r.costsPaid).padStart(11),
      `-${(r.maxDrawdown * 100).toFixed(2)}%`.padStart(7),
      String(r.fills).padStart(5),
      String(r.sells).padStart(5),
      (r.winRate === null ? '-' : `${(r.winRate * 100).toFixed(0)}%`).padStart(6),
      String(r.openPositions).padStart(5),
    );
  }
}

/** 진입 임계(등락률 기반 전략)·익절·손절을 바꾼 변형 전략을 만듭니다. 진입은 크로싱 기준. */
function makeVariant(base: StrategyDef, entryPct: number, tp: number, sl: number): StrategyDef {
  const dir = base.id === 'momentum' ? 1 : -1; // meanrevert/deepdip 는 하락 진입
  const th = (dir * entryPct) / 100;
  return {
    ...base,
    id: `${base.id}(e${entryPct},tp${tp},sl${sl})`,
    label: `e±${entryPct} tp${tp} sl${sl}`,
    entry: (_t, rate, ctx) => {
      if (ctx.prevRate === null) return null;
      const crossed = dir > 0
        ? ctx.prevRate < th && rate >= th
        : ctx.prevRate > th && rate <= th;
      return crossed ? `진입 ${pct(rate)} (${dir > 0 ? '+' : '-'}${entryPct}% 돌파)` : null;
    },
    takeProfitPct: tp,
    stopLossPct: sl,
  };
}

async function main(): Promise<void> {
  const from = arg('from');
  const to = arg('to');
  const markets = (arg('markets') ?? 'KR,US')
    .split(',')
    .filter((m): m is Market => m === 'KR' || m === 'US');
  const sweep = arg('sweep');
  const showTrades = arg('trades');

  console.log(`히스토리 로드 중... (${from ?? '처음'} ~ ${to ?? '끝'})`);
  const ticks = await loadTicks(from, to);
  if (ticks.length === 0) {
    console.log('해당 구간에 틱이 없습니다.');
    return;
  }
  console.log(
    `틱 ${ticks.length.toLocaleString('ko-KR')}건 · ${ticks[0]!.polledAt.slice(0, 16)} ~ ${ticks[ticks.length - 1]!.polledAt.slice(0, 16)}\n`,
  );

  // 종목별 일봉 로드 (as-of 지표용). 실패해도 백테스트는 지표 필터 없이 계속 갑니다.
  const symbols = [...new Set(ticks.map((t) => t.symbol))];
  const dailyCandles = new Map<string, DailyCandle[]>();
  if (!process.argv.includes('--no-indicators')) {
    for (const symbol of symbols) {
      try {
        dailyCandles.set(symbol, (await fetchDailyCandles(symbol, 200)).map(toDailyCandle));
      } catch (err) {
        console.warn(`${symbol} 일봉 로드 실패 (${(err as Error).message}) — 지표 필터 없이 진행`);
      }
    }
    console.log(`지표 준비: ${dailyCandles.size}/${symbols.length}종목 일봉 로드 (MA·볼린저·RSI·ATR, as-of)\n`);
  }

  // 거래비용 (편도 %). --fee/--tax/--slip 로 조정, --no-costs 로 0 처리
  const noCosts = process.argv.includes('--no-costs');
  const costs = {
    feePct: noCosts ? 0 : Number(arg('fee') ?? 0.015),
    krSellTaxPct: noCosts ? 0 : Number(arg('tax') ?? 0.15),
    slippagePct: noCosts ? 0 : Number(arg('slip') ?? 0.05),
  };
  console.log(
    `비용 모델: 수수료 ${costs.feePct}%/편도 · 국내 매도세 ${costs.krSellTaxPct}% · 슬리피지 ${costs.slippagePct}%/편도\n`,
  );

  const cfg: BacktestConfig = {
    initialCash: config.paper.initialCash,
    positionPct: config.paper.positionPct,
    maxPositions: config.paper.maxPositions,
    cooldownSec: config.paper.cooldownSec,
    staleTickSec: config.paper.staleTickSec,
    markets,
    usdKrw: 1410,
    maxHoldMin: config.paper.maxHoldMin,
    dailyMaxLossPct: config.paper.dailyMaxLossPct,
    dailyCandles,
    costs,
  };

  if (sweep) {
    const base = STRATEGIES.find((s) => s.id === sweep);
    if (!base) {
      console.log(`알 수 없는 전략: ${sweep} (가능: ${STRATEGIES.map((s) => s.id).join(', ')})`);
      return;
    }
    if (!['meanrevert', 'momentum', 'deepdip'].includes(base.id)) {
      console.log('스윕은 등락률 진입 전략(meanrevert/momentum/deepdip)만 지원합니다.');
      return;
    }

    const entries = [1, 1.5, 2, 2.5, 3, 4];
    const tps = [0.5, 1, 1.5, 2, 3];
    const sls = [0.5, 1, 1.5, 2, 3];
    const variants: StrategyDef[] = [];
    for (const e of entries) for (const tp of tps) for (const sl of sls) {
      variants.push(makeVariant(base, e, tp, sl));
    }

    console.log(`${base.label}(${base.id}) 파라미터 스윕: ${variants.length}개 조합\n`);
    const results = runBacktest(ticks, variants, cfg);
    printResults(results.sort((a, b) => b.totalReturn - a.totalReturn).slice(0, 15));
    console.log('\n⚠️ 상위 조합일수록 과적합 가능성도 큽니다. 구간을 바꿔(walk-forward) 재검증하세요.');
    return;
  }

  const results = runBacktest(ticks, STRATEGIES, cfg);
  printResults(results);

  if (showTrades) {
    const r = results.find((x) => x.strategyId === showTrades);
    if (r) {
      console.log(`\n[${r.label}] 체결 내역 (${r.trades.length}건)`);
      for (const t of r.trades) {
        const pnl = t.realizedPnl !== undefined ? ` → ${krw(t.realizedPnl)}` : '';
        console.log(
          `  ${t.time.slice(5, 16)} ${t.side} ${t.name} ${t.quantity}주 @ ${t.price.toLocaleString('ko-KR')}${pnl} · ${t.reason}`,
        );
      }
    }
  }

  console.log('\n⚠️ 백테스트 성적은 과거의 사실일 뿐 미래 수익의 보장이 아닙니다. 최종 검증은 페이퍼로.');
}

void main();
