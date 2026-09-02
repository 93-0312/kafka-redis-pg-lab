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
  // 날짜는 KST 기준으로 해석합니다. 오프셋 없이 넘기면 Postgres(UTC)가
  // UTC 자정으로 받아서 KST 00~09시(미국 야간 세션)가 잘려나갑니다.
  if (from) { params.push(`${from}T00:00:00+09:00`); where.push(`polled_at >= $${params.length}`); }
  if (to) { params.push(`${to}T00:00:00+09:00`); where.push(`polled_at < ($${params.length}::timestamptz + interval '1 day')`); }

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

  const t0 = Date.now();
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
    onProgress: (done, total) => {
      const pctDone = ((done / total) * 100).toFixed(0);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`재생 중... ${(done / 1e6).toFixed(1)}M/${(total / 1e6).toFixed(1)}M 틱 (${pctDone}%) · ${elapsed}초 경과`);
    },
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

  // --only bitgak,gogojeo : 지정한 전략만 재생 (전략별 계좌가 독립이라 결과는 전체 런과 동일).
  // 전략 11개 전부 돌리면 재생만 ~1시간이므로, 새 전략 검증은 이걸로 줄입니다.
  // 단, decide() 등 공용 코드를 고쳤을 때는 전체 런으로 기존 전략 회귀 확인.
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const defs = only?.length ? STRATEGIES.filter((s) => only.includes(s.id)) : STRATEGIES;
  if (only?.length && defs.length < only.length) {
    const known = new Set(STRATEGIES.map((s) => s.id));
    console.warn(`⚠️ 모르는 전략 무시: ${only.filter((id) => !known.has(id)).join(', ')}`);
  }
  const results = runBacktest(ticks, defs, cfg);
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
