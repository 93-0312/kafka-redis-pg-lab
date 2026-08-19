import { AsOfIndicatorStore, type DailyCandle } from '../domain/indicators.js';
import { changeRate, dateKey } from '../domain/quotes.js';
import {
  CtxTracker,
  decide,
  isStale,
  positionSize,
  trackPeak,
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
  /** 시간 청산: 이 시간(분) 넘게 보유하면 강제 청산 */
  maxHoldMin: number;
  /** 일일 킬 스위치: 당일 시작 자산 대비 이 % 손실이면 당일 신규 진입 중단 */
  dailyMaxLossPct: number;
  /** 종목별 일봉 (지표 as-of 계산용). 없으면 지표 필터는 통과 처리됩니다 */
  dailyCandles?: Map<string, DailyCandle[]>;
  /**
   * 거래비용 모델 (편도 기준 %).
   * scalper 처럼 익절 폭이 좁은 전략은 비용을 넣는 순간 기대값이 뒤집힐 수 있어서,
   * 비용 없는 백테스트 결과는 판단 근거로 쓸 수 없습니다.
   */
  costs: {
    /** 위탁 수수료 (매수·매도 각각) */
    feePct: number;
    /** 국내 주식 매도 시 거래세+농특세 (미국은 미적용) */
    krSellTaxPct: number;
    /** 슬리피지 추정 (매수·매도 각각) */
    slippagePct: number;
  };
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
  /** 수수료+거래세+슬리피지 누계 (원화) */
  costsPaid: number;
  fills: number;
  sells: number;
  wins: number;
  /** 청산 기준 승률. 청산이 없으면 null */
  winRate: number | null;
  /** 최대 낙폭 (자산 고점 대비, 0.05 = -5%) */
  maxDrawdown: number;
  /** 킬 스위치 발동 일수 */
  killDays: number;
  openPositions: number;
  trades: BacktestTrade[];
}

/** 포지션 + 매수에 실제로 나간 현금(비용 포함). 실현손익 = 순매도대금 - costKrw */
type SimPosition = PaperPosition & { costKrw: number };

interface SimAccount {
  cash: number;
  positions: Map<string, SimPosition>;
  cooldownUntil: Map<string, number>;
  trades: BacktestTrade[];
  realizedPnl: number;
  costsPaid: number;
  wins: number;
  sells: number;
  peak: number;
  maxDrawdown: number;
  /** 킬 스위치 상태: 당일 시작 자산과 발동 여부 */
  dayKey: string;
  dayStartEquity: number;
  killed: boolean;
  killCount: number;
}

export function runBacktest(
  ticks: TickEvent[],
  defs: StrategyDef[],
  cfg: BacktestConfig,
): StrategyResult[] {
  const tracker = new CtxTracker();
  const indicators = new AsOfIndicatorStore(cfg.dailyCandles ?? new Map(), dateKey);
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
        costsPaid: 0,
        wins: 0,
        sells: 0,
        peak: cfg.initialCash,
        maxDrawdown: 0,
        dayKey: '',
        dayStartEquity: cfg.initialCash,
        killed: false,
        killCount: 0,
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
    const dayKey = dateKey(tick.polledAt);
    const ctx = tracker.next(tick, dayKey, rate);
    ctx.daily = indicators.get(tick.symbol, dayKey);

    for (const def of defs) {
      const acc = accounts.get(def.id)!;

      // 날짜가 바뀌면 킬 스위치 리셋 + 당일 시작 자산 기록
      if (acc.dayKey !== dayKey) {
        acc.dayKey = dayKey;
        acc.dayStartEquity = equityOf(acc);
        acc.killed = false;
      }

      const position = acc.positions.get(tick.symbol) ?? null;
      // 트레일링 익절 기준점 갱신 (라이브 워커와 동일)
      if (position) trackPeak(position, tick.price);

      // 시간 청산 (라이브 워커와 동일)
      let decision = decide(tick, rate, position, ctx, def);
      if (!decision && position) {
        const heldMin = (now - Date.parse(position.openedAt)) / 60_000;
        if (heldMin >= cfg.maxHoldMin) {
          decision = { side: 'SELL', reason: `시간 청산: 보유 ${Math.round(heldMin)}분 ≥ ${cfg.maxHoldMin}분` };
        }
      }

      if (decision?.side === 'BUY') {
        // 일일 킬 스위치 (라이브 워커와 동일): 신규 진입만 차단
        if (!acc.killed && acc.dayStartEquity > 0) {
          const loss = (acc.dayStartEquity - equityOf(acc)) / acc.dayStartEquity;
          if (loss >= cfg.dailyMaxLossPct / 100) {
            acc.killed = true;
            acc.killCount += 1;
          }
        }
        if (acc.killed) continue;
        if ((acc.cooldownUntil.get(tick.symbol) ?? 0) > now) continue;
        if (acc.positions.size >= cfg.maxPositions) continue;
        const quantity = positionSize(acc.cash, cfg.positionPct, tick.price * fx);
        if (quantity < 1) continue;

        const gross = quantity * tick.price * fx;
        const buyCost = gross * (cfg.costs.feePct + cfg.costs.slippagePct) / 100;
        acc.cash -= gross + buyCost;
        acc.costsPaid += buyCost;
        acc.positions.set(tick.symbol, {
          symbol: tick.symbol,
          name: tick.name,
          market: tick.market,
          currency: tick.currency,
          quantity,
          avgPrice: tick.price,
          openedAt: tick.polledAt,
          peakPrice: tick.price,
          costKrw: gross + buyCost,
        });
        acc.cooldownUntil.set(tick.symbol, now + cfg.cooldownSec * 1000);
        acc.trades.push({
          time: tick.polledAt, symbol: tick.symbol, name: tick.name,
          side: 'BUY', quantity, price: tick.price, reason: decision.reason,
        });
      } else if (decision?.side === 'SELL' && position) {
        const simPos = position as SimPosition;
        const gross = simPos.quantity * tick.price * fx;
        const sellTax = tick.market === 'KR' ? cfg.costs.krSellTaxPct : 0;
        const sellCost = gross * (cfg.costs.feePct + cfg.costs.slippagePct + sellTax) / 100;
        const net = gross - sellCost;
        // 실현손익 = 순매도대금 - 매수 총지출(비용 포함)
        const realized = net - simPos.costKrw;

        acc.cash += net;
        acc.costsPaid += sellCost;
        acc.positions.delete(tick.symbol);
        acc.realizedPnl += realized;
        acc.sells += 1;
        if (realized > 0) acc.wins += 1;
        acc.trades.push({
          time: tick.polledAt, symbol: tick.symbol, name: tick.name,
          side: 'SELL', quantity: simPos.quantity, price: tick.price,
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
      costsPaid: acc.costsPaid,
      fills: acc.trades.length,
      sells: acc.sells,
      wins: acc.wins,
      winRate: acc.sells > 0 ? acc.wins / acc.sells : null,
      maxDrawdown: acc.maxDrawdown,
      killDays: acc.killCount,
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
