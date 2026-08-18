import type { PaperPosition, TickEvent } from '../types.js';

/**
 * 페이퍼 트레이딩 전략 5종 (학습용 예제).
 *
 * ★ 전부 파이프라인 학습을 위한 기계적 예제이지 투자 조언이 아닙니다 ★
 * 5개 전략이 각자 독립된 가상계좌로 같은 시장을 동시에 매매하므로,
 * 같은 장에서 전략별 성향 차이가 그대로 드러납니다.
 */

/** 전략 판단에 필요한 시장 부가 정보 (전략 워커가 틱 스트림에서 계산해 넘겨줍니다) */
export interface MarketCtx {
  /** 최근 ~60초 변화율 (소수비율). 기준가가 아직 없으면 null */
  shortChange: number | null;
  /** 오늘 지금까지의 고가 (현재 틱 반영 전). 첫 틱이면 null */
  dayHigh: number | null;
}

export interface StrategyDef {
  id: string;
  label: string;
  description: string;
  /** 진입 판단. 진입하면 사유 문자열, 아니면 null */
  entry: (tick: TickEvent, changeRate: number, ctx: MarketCtx) => string | null;
  takeProfitPct: number;
  stopLossPct: number;
}

const pct = (r: number): string => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(2)}%`;

export const STRATEGIES: StrategyDef[] = [
  {
    id: 'meanrevert',
    label: '평균회귀',
    description: '전일 대비 -2% 급락 시 반등 기대 매수 · 익절 +1.5% / 손절 -1.5%',
    entry: (_t, rate) => (rate <= -0.02 ? `급락 매수: 전일 대비 ${pct(rate)} ≤ -2%` : null),
    takeProfitPct: 1.5,
    stopLossPct: 1.5,
  },
  {
    id: 'momentum',
    label: '추세추종',
    description: '전일 대비 +2% 돌파 시 추세 지속 기대 매수 · 익절 +1.5% / 손절 -1.5%',
    entry: (_t, rate) => (rate >= 0.02 ? `돌파 매수: 전일 대비 ${pct(rate)} ≥ +2%` : null),
    takeProfitPct: 1.5,
    stopLossPct: 1.5,
  },
  {
    id: 'deepdip',
    label: '낙폭과대',
    description: '전일 대비 -4% 깊은 급락에서만 매수, 길게 홀드 · 익절 +3% / 손절 -3%',
    entry: (_t, rate) => (rate <= -0.04 ? `낙폭과대 매수: 전일 대비 ${pct(rate)} ≤ -4%` : null),
    takeProfitPct: 3,
    stopLossPct: 3,
  },
  {
    id: 'scalper',
    label: '초단타',
    description: '1분 내 +0.3% 급등에 편승, 빠른 회전 · 익절 +0.5% / 손절 -0.5%',
    entry: (_t, _rate, ctx) =>
      ctx.shortChange !== null && ctx.shortChange >= 0.003
        ? `급등 편승: 1분 내 ${pct(ctx.shortChange)} ≥ +0.3%`
        : null,
    takeProfitPct: 0.5,
    stopLossPct: 0.5,
  },
  {
    id: 'highbreak',
    label: '신고가돌파',
    description: '당일 고가 갱신 + 상승 중일 때 매수 · 익절 +2% / 손절 -1% (비대칭)',
    entry: (t, rate, ctx) =>
      ctx.dayHigh !== null && t.price > ctx.dayHigh && rate > 0
        ? `신고가 돌파: 당일 고가 ${ctx.dayHigh.toLocaleString('ko-KR')} 갱신 (${pct(rate)})`
        : null,
    takeProfitPct: 2,
    stopLossPct: 1,
  },
];

export const STRATEGY_IDS = STRATEGIES.map((s) => s.id);

export interface Decision {
  side: 'BUY' | 'SELL';
  reason: string;
}

/** 포지션이 있으면 청산(익절/손절)만, 없으면 진입만 검토합니다. */
export function decide(
  tick: TickEvent,
  changeRate: number,
  position: PaperPosition | null,
  ctx: MarketCtx,
  def: StrategyDef,
): Decision | null {
  if (position) {
    const fromAvg = (tick.price - position.avgPrice) / position.avgPrice;
    if (fromAvg >= def.takeProfitPct / 100) {
      return { side: 'SELL', reason: `익절: 평단 대비 ${pct(fromAvg)} ≥ +${def.takeProfitPct}%` };
    }
    if (fromAvg <= -def.stopLossPct / 100) {
      return { side: 'SELL', reason: `손절: 평단 대비 ${pct(fromAvg)} ≤ -${def.stopLossPct}%` };
    }
    return null;
  }

  const reason = def.entry(tick, changeRate, ctx);
  return reason ? { side: 'BUY', reason } : null;
}

/** 진입 수량 = (현금 × 비중%) ÷ 가격, 정수 내림. 1주도 못 사면 0 */
export function positionSize(cash: number, positionPct: number, price: number): number {
  if (price <= 0 || cash <= 0) return 0;
  return Math.floor((cash * positionPct) / 100 / price);
}

/** 틱이 너무 오래됐으면 매매하지 않습니다 (장 마감 후 정지 시세 방지) */
export function isStale(tradedAt: string | null, nowMs: number, staleSec: number): boolean {
  if (!tradedAt) return true;
  const t = Date.parse(tradedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > staleSec * 1000;
}

/**
 * 초단타/신고가 전략용 시장 상태 추적기 (종목별 1분 윈도우 기준가 + 당일 고가).
 * 인프라 의존이 없어서 라이브 전략 워커와 백테스트 엔진이 같은 구현을 공유합니다 —
 * 백테스트가 실전과 다르게 동작하는 사고를 구조적으로 막는 장치입니다.
 */
export class CtxTracker {
  private state = new Map<string, { windowBase: { price: number; ts: number } | null; dayKey: string; dayHigh: number | null }>();
  private readonly windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  /** 틱 반영 "전" 상태로 MarketCtx 를 돌려주고, 그 다음 내부 상태를 갱신합니다. */
  next(tick: TickEvent, dayKey: string): MarketCtx {
    const now = Date.parse(tick.polledAt) || 0;
    let st = this.state.get(tick.symbol);
    if (!st || st.dayKey !== dayKey) {
      st = { windowBase: null, dayKey, dayHigh: null };
      this.state.set(tick.symbol, st);
    }

    const ctx: MarketCtx = {
      shortChange:
        st.windowBase && now - st.windowBase.ts <= this.windowMs * 1.5 && st.windowBase.price > 0
          ? (tick.price - st.windowBase.price) / st.windowBase.price
          : null,
      dayHigh: st.dayHigh,
    };

    if (!st.windowBase || now - st.windowBase.ts >= this.windowMs) {
      st.windowBase = { price: tick.price, ts: now };
    }
    st.dayHigh = st.dayHigh === null ? tick.price : Math.max(st.dayHigh, tick.price);

    return ctx;
  }
}
