import type { DailyIndicators } from './indicators.js';
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
  /**
   * 직전 틱의 전일 대비 등락률. 당일 첫 틱이면 null.
   * 진입은 "조건을 만족하는 상태"가 아니라 "조건을 새로 돌파하는 순간"(크로싱)에만
   * 발동해야 합니다 — 하락 추세에서 손절→재진입을 반복하는 결함을 막는 엣지 트리거입니다.
   * 당일 첫 틱은 null 이라 갭 시가로는 진입하지 않습니다 (갭과 장중 하락은 성격이 다름).
   */
  prevRate: number | null;
  /** 직전 틱의 shortChange (초단타 크로싱 감지용) */
  prevShortChange: number | null;
  /**
   * 일봉 기반 as-of 지표 (전일까지의 데이터로 계산 — 선견 편향 없음).
   * 없으면(부트스트랩 전 등) 전략의 지표 필터는 통과시킵니다 (보조 확인 원칙).
   */
  daily?: DailyIndicators;
}

export interface StrategyDef {
  id: string;
  label: string;
  description: string;
  /** 진입 판단. 진입하면 사유 문자열, 아니면 null */
  entry: (tick: TickEvent, changeRate: number, ctx: MarketCtx) => string | null;
  takeProfitPct: number;
  stopLossPct: number;
  /**
   * 트레일링 익절 폭(%). 지정하면 익절선에 닿아도 즉시 팔지 않고 고점을 따라갑니다.
   * 청산선 = max(익절선, 고점×(1-trailPct)) — 익절선 아래로는 내려가지 않으므로
   * 고정 익절보다 나쁠 수 없고, 추세가 이어지면 더 먹습니다.
   * (승률이 낮은 돌파 전략은 "이긴 거래를 크게" 만들어야 기대값이 서기 때문에 넣었습니다)
   */
  trailPct?: number;
  /** 동적 손절 폭(%). 지정 시 stopLossPct 대신 사용 (예: ATR 기반) */
  dynamicStopPct?: (ctx: MarketCtx) => number;
  /** true 면 정규장(KRX 09:00~15:30 / US 09:30~16:00 ET)에서만 신규 진입. 청산은 항상 허용 */
  regularSessionOnly?: boolean;
}

/** 지표 필터 헬퍼: 지표가 없으면 통과 (보조 확인이지 필수 조건이 아님) */
const rsiBelow = (ctx: MarketCtx, level: number): boolean =>
  ctx.daily?.rsi14 == null || ctx.daily.rsi14 < level;
const aboveMa20 = (ctx: MarketCtx, price: number): boolean =>
  ctx.daily?.ma20 == null || price > ctx.daily.ma20;

const pct = (r: number): string => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(2)}%`;

/**
 * 신고가 돌파로 인정할 최소 폭(0.1%). 호가 한 틱 차이로 고가를 "스치는" 것까지
 * 돌파로 세면 하루에도 수십 번 진입해 수수료만 나갑니다 (실측 승률 13%).
 */
const HIGH_BREAK_MARGIN = 0.001;

/** 등락률이 임계값을 "이번 틱에 새로" 하향/상향 돌파했는지 (크로싱) */
const crossedDown = (prev: number | null, cur: number, threshold: number): boolean =>
  prev !== null && prev > threshold && cur <= threshold;
const crossedUp = (prev: number | null, cur: number, threshold: number): boolean =>
  prev !== null && prev < threshold && cur >= threshold;

export const STRATEGIES: StrategyDef[] = [
  {
    id: 'meanrevert',
    label: '평균회귀',
    description: '-2% 하향 돌파 + RSI<40 (과매도 확인) · 익절 +1.5%부터 트레일링(-0.8%) / 손절 -1.5% · 정규장 한정',
    regularSessionOnly: true,
    entry: (_t, rate, ctx) =>
      crossedDown(ctx.prevRate, rate, -0.02) && rsiBelow(ctx, 40)
        ? `급락 돌파 매수: ${pct(ctx.prevRate!)} → ${pct(rate)} (-2% 하향 돌파, RSI ${ctx.daily?.rsi14?.toFixed(0) ?? '?'})`
        : null,
    takeProfitPct: 1.5,
    stopLossPct: 1.5,
    trailPct: 0.8,
  },
  {
    id: 'momentum',
    label: '추세추종',
    description: '+2% 상향 돌파 + 주가>MA20 (추세 확인) · 익절 +1.5%부터 트레일링(-0.8%) / 손절 -1.5% · 정규장 한정',
    regularSessionOnly: true,
    entry: (t, rate, ctx) =>
      crossedUp(ctx.prevRate, rate, 0.02) && aboveMa20(ctx, t.price)
        ? `돌파 매수: ${pct(ctx.prevRate!)} → ${pct(rate)} (+2% 상향 돌파, MA20 위)`
        : null,
    takeProfitPct: 1.5,
    stopLossPct: 1.5,
    trailPct: 0.8,
  },
  {
    id: 'deepdip',
    label: '낙폭과대',
    description:
      '-4% 하향 돌파 매수, 길게 홀드 · 익절 +3%부터 트레일링(-1.5%) / 손절 max(3%, 1.5×ATR) · ' +
      '정규장 한정 (시간외 -4%는 대개 실체 있는 악재)',
    regularSessionOnly: true,
    entry: (_t, rate, ctx) =>
      crossedDown(ctx.prevRate, rate, -0.04)
        ? `낙폭과대 돌파 매수: ${pct(ctx.prevRate!)} → ${pct(rate)} (-4% 하향 돌파)`
        : null,
    takeProfitPct: 3,
    stopLossPct: 3,
    trailPct: 1.5,
    // -4% 빠진 종목의 일중 변동성이면 고정 -3% 는 노이즈에 터집니다. ATR 로 여유를 줍니다.
    dynamicStopPct: (ctx) =>
      ctx.daily?.atrPct != null ? Math.max(3, ctx.daily.atrPct * 1.5) : 3,
  },
  {
    id: 'scalper',
    label: '단기모멘텀',
    description:
      '1분 +0.3% 상향 돌파 "순간" 편승 (당일 상승 + MA20 위 + RSI<70 인 종목만) · ' +
      '익절 +1.5%부터 트레일링(-0.8%) / 손절 -1.5% · 정규장 한정',
    regularSessionOnly: true,
    entry: (t, rate, ctx) =>
      ctx.shortChange !== null &&
      crossedUp(ctx.prevShortChange, ctx.shortChange, 0.003) &&
      rsiBelow(ctx, 70) && // 이미 과열(RSI≥70)인 종목의 고점 추격은 걸러냅니다
      aboveMa20(ctx, t.price) && // 하락 추세 종목의 1분 반등은 대부분 되밀립니다
      rate > 0 // 당일 하락 중인 종목의 1분 급등은 되돌림일 뿐입니다
        ? `급등 편승: 1분 내 ${pct(ctx.shortChange)} (+0.3% 상향 돌파, MA20 위)`
        : null,
    takeProfitPct: 1.5,
    stopLossPct: 1.5,
    trailPct: 0.8,
  },
  {
    id: 'highbreak',
    label: '신고가돌파',
    description:
      '당일 고가 +0.1% 이상 돌파 + 상승 중 + 주가>MA20 (정규장 한정) · ' +
      '익절 +2%부터 트레일링(-1%) / 손절 -1%',
    regularSessionOnly: true,
    entry: (t, rate, ctx) =>
      ctx.dayHigh !== null &&
      t.price >= ctx.dayHigh * (1 + HIGH_BREAK_MARGIN) &&
      rate > 0 &&
      aboveMa20(ctx, t.price)
        ? `신고가 돌파: 당일 고가 ${ctx.dayHigh.toLocaleString('ko-KR')} 대비 ` +
          `${pct((t.price - ctx.dayHigh) / ctx.dayHigh)} 갱신 (${pct(rate)}, MA20 위)`
        : null,
    takeProfitPct: 2,
    stopLossPct: 1,
    trailPct: 1,
  },
];

export const STRATEGY_IDS = STRATEGIES.map((s) => s.id);

export interface Decision {
  side: 'BUY' | 'SELL';
  reason: string;
}

/**
 * 보유 중 최고가를 갱신해 돌려줍니다 (트레일링 익절의 기준점).
 * 라이브 워커와 백테스트 엔진이 같은 구현을 쓰도록 여기 둡니다.
 */
export function trackPeak(position: PaperPosition, price: number): number {
  const peak = Math.max(position.peakPrice ?? position.avgPrice, price);
  position.peakPrice = peak;
  return peak;
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
    const stopPct = def.dynamicStopPct?.(ctx) ?? def.stopLossPct;
    const tpLine = position.avgPrice * (1 + def.takeProfitPct / 100);
    const peak = Math.max(position.peakPrice ?? tick.price, tick.price);

    // 손절이 최우선입니다. 트레일링이 발동된 뒤 갭으로 손절선까지 밀린 경우에도
    // "트레일링 익절"이 아니라 손절로 기록되어야 성적 해석이 흐려지지 않습니다.
    if (fromAvg <= -stopPct / 100) {
      return { side: 'SELL', reason: `손절: 평단 대비 ${pct(fromAvg)} ≤ -${stopPct.toFixed(1)}%` };
    }

    // 트레일링 익절: 보유 중 고점이 한 번이라도 익절선을 넘었다면(=발동) 그 뒤로는
    // 고점을 따라가다가 trailPct 되밀릴 때 청산합니다. 청산선은 익절선 아래로
    // 내려가지 않으므로 고정 익절보다 나쁠 수 없고, 추세가 이어지면 더 먹습니다.
    if (def.trailPct != null && peak >= tpLine) {
      const exitLine = Math.max(tpLine, peak * (1 - def.trailPct / 100));
      if (tick.price <= exitLine) {
        return {
          side: 'SELL',
          reason:
            `트레일링 익절: 고점 ${Math.round(peak).toLocaleString('ko-KR')} 대비 ` +
            `${pct((tick.price - peak) / peak)} 되밀림 (평단 대비 ${pct(fromAvg)})`,
        };
      }
      return null; // 아직 고점 경신 중 — 홀드
    }
    if (def.trailPct == null && fromAvg >= def.takeProfitPct / 100) {
      return { side: 'SELL', reason: `익절: 평단 대비 ${pct(fromAvg)} ≥ +${def.takeProfitPct}%` };
    }
    return null;
  }

  // 정규장 전용 전략은 시간외·프리마켓에서 신규 진입하지 않습니다 (청산은 위에서 이미 처리됨)
  if (def.regularSessionOnly && !isRegularSession(tick.market, tick.tradedAt ?? tick.polledAt)) {
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

/**
 * "연속 체결이 가능한 정규장" 여부 판정 (신규 진입 허용 창).
 *  - KR: 09:00~15:19 KST — 마감 동시호가(15:20~15:30) 제외.
 *    동시호가 중 시세는 예상체결가라 실제로는 그 가격에 체결될 수 없는데,
 *    시뮬레이터는 즉시 체결을 가정하므로 이 구간의 진입은 가짜 체결이 됩니다.
 *    (NXT 프리/애프터마켓도 제외)
 *  - US: 09:30~16:00 ET (연속 체결, 서머타임 자동 반영, 프리/애프터 제외)
 * 시간외는 유동성이 얇아 적은 거래로도 신고가·급등이 만들어지므로,
 * 돌파 계열 전략은 정규장 신호만 믿는 것이 안전합니다.
 * 휴장일은 신선한 틱 자체가 없어서(stale 가드) 별도 처리가 필요 없습니다.
 * 청산에는 적용하지 않습니다 — 동시호가 중 청산 주문은 현실에서도 단일가에 체결됩니다.
 */
export function isRegularSession(market: 'KR' | 'US', isoTime: string): boolean {
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return false;
  const zone = market === 'KR' ? 'Asia/Seoul' : 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hm = Number(get('hour')) * 100 + Number(get('minute'));
  return market === 'KR' ? hm >= 900 && hm <= 1519 : hm >= 930 && hm <= 1600;
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
  private state = new Map<
    string,
    {
      windowBase: { price: number; ts: number } | null;
      dayKey: string;
      dayHigh: number | null;
      prevRate: number | null;
      prevShortChange: number | null;
    }
  >();
  private readonly windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  /**
   * 틱 반영 "전" 상태로 MarketCtx 를 돌려주고, 그 다음 내부 상태를 갱신합니다.
   * prevRate/prevShortChange 는 일 단위로 리셋됩니다 — 전일 마지막 값과 당일 시가를
   * 비교하면 갭 하락이 "돌파"로 오인되기 때문입니다.
   */
  next(tick: TickEvent, dayKey: string, rate: number): MarketCtx {
    const now = Date.parse(tick.polledAt) || 0;
    let st = this.state.get(tick.symbol);
    if (!st || st.dayKey !== dayKey) {
      st = { windowBase: null, dayKey, dayHigh: null, prevRate: null, prevShortChange: null };
      this.state.set(tick.symbol, st);
    }

    const shortChange =
      st.windowBase && now - st.windowBase.ts <= this.windowMs * 1.5 && st.windowBase.price > 0
        ? (tick.price - st.windowBase.price) / st.windowBase.price
        : null;

    const ctx: MarketCtx = {
      shortChange,
      dayHigh: st.dayHigh,
      prevRate: st.prevRate,
      prevShortChange: st.prevShortChange,
    };

    if (!st.windowBase || now - st.windowBase.ts >= this.windowMs) {
      st.windowBase = { price: tick.price, ts: now };
    }
    st.dayHigh = st.dayHigh === null ? tick.price : Math.max(st.dayHigh, tick.price);
    st.prevRate = rate;
    st.prevShortChange = shortChange;

    return ctx;
  }
}
