/**
 * 일봉 기반 기술 지표 (순수 함수).
 * 토스 캔들 API 로 받은 일봉을 넣으면 MA/볼린저/RSI/ATR 을 계산합니다.
 * 인프라 의존이 없어서 라이브 전략 워커와 백테스트가 같은 구현을 공유합니다.
 *
 * ★ as-of 원칙: 지표는 반드시 "해당일 이전"의 일봉으로만 계산해야 합니다.
 *   오늘 일봉(미완성)을 넣으면 백테스트에 선견 편향이 생깁니다.
 */

export interface DailyCandle {
  /** 봉 시작 시각 ISO */
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DailyIndicators {
  /** 20일 이동평균 */
  ma20: number | null;
  /** 60일 이동평균 */
  ma60: number | null;
  /** RSI(14) 0~100 */
  rsi14: number | null;
  /** 볼린저밴드(20, 2σ) */
  bbUpper: number | null;
  bbLower: number | null;
  /** ATR(14) 를 종가 대비 % 로 (변동성 기반 손절 폭에 사용) */
  atrPct: number | null;
  /** 직전 종가 */
  lastClose: number | null;
}

export const EMPTY_INDICATORS: DailyIndicators = {
  ma20: null, ma60: null, rsi14: null, bbUpper: null, bbLower: null, atrPct: null, lastClose: null,
};

const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * 지표 계산. candles 는 오래된 것 → 최신 순, "기준일 이전" 봉만 포함해야 합니다.
 * 데이터가 부족한 지표는 null (전략은 null 이면 해당 필터를 건너뜁니다).
 */
export function computeDailyIndicators(candles: DailyCandle[]): DailyIndicators {
  if (candles.length === 0) return EMPTY_INDICATORS;
  const closes = candles.map((c) => c.close);
  const lastClose = closes[closes.length - 1]!;

  const ma20 = closes.length >= 20 ? avg(closes.slice(-20)) : null;
  const ma60 = closes.length >= 60 ? avg(closes.slice(-60)) : null;

  // 볼린저밴드 (20, 2σ)
  let bbUpper: number | null = null;
  let bbLower: number | null = null;
  if (ma20 !== null) {
    const win = closes.slice(-20);
    const variance = avg(win.map((c) => (c - ma20) ** 2));
    const sd = Math.sqrt(variance);
    bbUpper = ma20 + 2 * sd;
    bbLower = ma20 - 2 * sd;
  }

  // RSI(14) — 단순평균 방식 (Cutler's RSI). Wilder 지수평활과 값이 다소 다르지만
  // 과매도/과열 판정 용도로는 동등하며, 시드 이력 없이 계산 가능해 채택.
  let rsi14: number | null = null;
  if (closes.length >= 15) {
    let gain = 0;
    let loss = 0;
    for (let i = closes.length - 14; i < closes.length; i += 1) {
      const diff = closes[i]! - closes[i - 1]!;
      if (diff > 0) gain += diff;
      else loss -= diff;
    }
    rsi14 = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }

  // ATR(14) — True Range 평균을 종가 대비 % 로
  let atrPct: number | null = null;
  if (candles.length >= 15) {
    const trs: number[] = [];
    for (let i = candles.length - 14; i < candles.length; i += 1) {
      const cur = candles[i]!;
      const prevClose = candles[i - 1]!.close;
      trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)));
    }
    atrPct = (avg(trs) / lastClose) * 100;
  }

  return { ma20, ma60, rsi14, bbUpper, bbLower, atrPct, lastClose };
}

/**
 * as-of 지표 스토어.
 * get(symbol, dayKey) 는 "그날 이전" 일봉만으로 계산한 지표를 돌려줍니다 —
 * 백테스트에서 해당일 틱을 재생할 때 이 값을 쓰면 선견 편향이 없고,
 * 라이브에서도 오늘의 미완성 봉이 지표를 오염시키지 않습니다.
 */
export class AsOfIndicatorStore {
  private cache = new Map<string, DailyIndicators>();

  constructor(
    private candlesBySymbol: Map<string, DailyCandle[]>,
    private toDayKey: (iso: string) => string,
  ) {}

  get(symbol: string, dayKey: string): DailyIndicators {
    const cacheKey = `${symbol}:${dayKey}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;

    const all = this.candlesBySymbol.get(symbol) ?? [];
    const past = all
      .filter((c) => this.toDayKey(c.timestamp) < dayKey)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const ind = computeDailyIndicators(past);
    this.cache.set(cacheKey, ind);
    return ind;
  }
}
