import { changeRate, dateKey } from '../domain/quotes.js';
import {
  CtxTracker,
  decide,
  isStale,
  positionSize,
  type StrategyDef,
} from '../domain/strategy.js';
import type { Market, PaperPosition, TickEvent } from '../types.js';

/**
 * 백테스트 엔진.
 * 라이브 파이프라인과 "같은 순수 함수"(decide / positionSize / CtxTracker / isStale)를
 * 히스토리 틱에 재생합니다. 시간은 벽시계가 아니라 틱의 polledAt 을 씁니다.
 *
 * 라이브와 다른 점 (의도적 단순화):
 *  - 주문→체결 지연 없음 (같은 틱에서 즉시 체결)
 *  - 환율은 구간 내 고정값 하나를 씁니다 (환율 히스토리는 저장하지 않으므로)
 */

export interface BacktestConfig {
  initialCash: number;
  positionPct: number;
  maxPositions: number;
  cooldownSec: number;
  staleTickSec: number;
  markets: Market[];
  /** USD→KRW 고정 환율 (근사) */
  usdKrw: number;
}

export interface BacktestTrade {
  time: string;
  symbol: string;
  name: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  realizedPnl?: number;
  reason: string;
}

export interface StrategyResult {
  strategyId: string;
  label: string;
  finalEquity: number;
  totalReturn: number;
  realizedPnl: number;
  fills: number;
  sells: number;
  wins: number;
  /** 청산 기준 승률. 청산이 없으면 null */
  winRate: number | null;
  /** 최대 낙폭 (자산 고점 대비, 0.05 = -5%) */
  maxDrawdown: number;
  openPositions: number;
  trades: BacktestTrade[];
}

interface SimAccount {
  cash: number;
  positions: Map<string, PaperPosition>;
  cooldownUntil: Map<string, number>;
  trades: BacktestTrade[];
  realizedPnl: number;
  wins: number;
  sells: number;
  peak: number;
  maxDrawdown: number;
}

export function runBacktest(
  ticks: TickEvent[],
  defs: StrategyDef[],
  cfg: BacktestConfig,
): StrategyResult[] {
  const tracker = new CtxTracker();
  const lastPrice = new Map<string, { price: number; fx: number }>();

  const accounts = new Map<string, SimAccount>(
    defs.map((d) => [
      d.id,
      {
        cash: cfg.initialCash,
        positions: new Map(),
        cooldownUntil: new Map(),
        trades: [],
        realizedPnl: 0,
        wins: 0,
        sells: 0,
        peak: cfg.initialCash,
        maxDrawdown: 0,
      },
    ]),
  );

  const equityOf = (acc: SimAccount): number => {
    let value = acc.cash;
    for (const pos of acc.positions.values()) {
      const last = lastPrice.get(pos.symbol);
      const fx = pos.currency === 'USD' ? cfg.usdKrw : 1;
      value += pos.quantity * (last?.price ?? pos.avgPrice) * fx;
    }
    return value;
  };

  for (const tick of ticks) {
    if (!config_ok(tick, cfg)) continue;

    const now = Date.parse(tick.polledAt) || 0;
    const fx = tick.currency === 'USD' ? cfg.usdKrw : 1;
    lastPrice.set(tick.symbol, { price: tick.price, fx });

    const rate = changeRate(tick.price, tick.prevClose);
    const ctx = tracker.next(tick, dateKey(tick.polledAt));

    for (const def of defs) {
      const acc = accounts.get(def.id)!;
      const position = acc.positions.get(tick.symbol) ?? null;
      const decision = decide(tick, rate, position, ctx, def);

      if (decision?.side === 'BUY') {
        if ((acc.cooldownUntil.get(tick.symbol) ?? 0) > now) continue;
        if (acc.positions.size >= cfg.maxPositions) continue;
        const quantity = positionSize(acc.cash, cfg.positionPct, tick.price * fx);
        if (quantity < 1) continue;

        acc.cash -= quantity * tick.price * fx;
        acc.positions.set(tick.symbol, {
          symbol: tick.symbol,
          name: tick.name,
          market: tick.market,
          currency: tick.currency,
          quantity,
          avgPrice: tick.price,
          openedAt: tick.polledAt,
        });
        acc.cooldownUntil.set(tick.symbol, now + cfg.cooldownSec * 1000);
        acc.trades.push({
          time: tick.polledAt, symbol: tick.symbol, name: tick.name,
          side: 'BUY', quantity, price: tick.price, reason: decision.reason,
        });
      } else if (decision?.side === 'SELL' && position) {
        const realized = (tick.price - position.avgPrice) * position.quantity * fx;
        acc.cash += position.quantity * tick.price * fx;
        acc.positions.delete(tick.symbol);
        acc.realizedPnl += realized;
        acc.sells += 1;
        if (realized > 0) acc.wins += 1;
        acc.trades.push({
          time: tick.polledAt, symbol: tick.symbol, name: tick.name,
          side: 'SELL', quantity: position.quantity, price: tick.price,
          realizedPnl: realized, reason: decision.reason,
        });
      }

      // 자산 고점·최대 낙폭 갱신
      const equity = equityOf(acc);
      if (equity > acc.peak) acc.peak = equity;
      else if (acc.peak > 0) {
        const dd = (acc.peak - equity) / acc.peak;
        if (dd > acc.maxDrawdown) acc.maxDrawdown = dd;
      }
    }
  }

  return defs.map((def) => {
    const acc = accounts.get(def.id)!;
    const finalEquity = equityOf(acc);
    return {
      strategyId: def.id,
      label: def.label,
      finalEquity,
      totalReturn: (finalEquity - cfg.initialCash) / cfg.initialCash,
      realizedPnl: acc.realizedPnl,
      fills: acc.trades.length,
      sells: acc.sells,
      wins: acc.wins,
      winRate: acc.sells > 0 ? acc.wins / acc.sells : null,
      maxDrawdown: acc.maxDrawdown,
      openPositions: acc.positions.size,
      trades: acc.trades,
    };
  });
}

function config_ok(tick: TickEvent, cfg: BacktestConfig): boolean {
  if (!cfg.markets.includes(tick.market)) return false;
  if (!tick.prevClose || tick.price <= 0) return false;
  // "지금"은 틱의 polledAt: 폴링 시점 기준으로 체결 시각이 오래됐으면 라이브처럼 관망
  const now = Date.parse(tick.polledAt) || 0;
  if (isStale(tick.tradedAt, now, cfg.staleTickSec)) return false;
  return true;
}
