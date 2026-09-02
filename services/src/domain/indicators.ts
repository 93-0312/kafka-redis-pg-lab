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
  /**
   * 빗각(상승 추세선) 값 — 거래량 가중 스윙 저점 2개를 이어 오늘로 투영한 지지선.
   * 인범 빗각의 기계화: "손바뀜(거래량)이 많았던 의미 있는 저점"들을 잇습니다.
   * 상승 기울기 저점쌍이 없으면 null (하락 추세선은 지지로 안 씀).
   */
  trendline: number | null;
  /** 주봉 합성 빗각 — 일봉을 주봉으로 묶어 큰 스케일 저점들로 그은 지지선 (원본 빗각에 더 가까움) */
  trendlineW: number | null;
  /**
   * 고고저 채널 하단 — 거래량 가중 스윙 고점 2개로 그은 "하락" 추세선을,
   * 그 구간의 최저점에 평행 이동해 오늘로 투영한 값. "하락이 이 근처에서 멈춘다"는
   * 평행 채널 가정의 매수 지지선입니다. 하락 고점쌍이 없으면 null.
   */
  channelLow: number | null;
  /** 직전 종가 */
  lastClose: number | null;
}

export const EMPTY_INDICATORS: DailyIndicators = {
  ma20: null, ma60: null, rsi14: null, bbUpper: null, bbLower: null, atrPct: null,
  trendline: null, trendlineW: null, channelLow: null, lastClose: null,
};

const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * 빗각(상승 추세선) 계산. candles 는 오래된 것 → 최신 순, 기준일 이전 봉만.
 *  1) 좌우 PIVOT_K 일보다 낮은 국소 최저 = 스윙 저점 후보
 *  2) 그중 거래량이 구간 평균 이상인 봉만 채택 (손바뀜 많았던 "의미 있는" 저점 = 매물대)
 *  3) 가장 최근 유효 저점 2개를 이어 기울기 산출, 상승(>0)일 때만 유효
 *  4) 오늘(마지막 봉 다음날) 시점으로 선형 투영
 * 저점이 2개 미만이거나 기울기가 하락이면 null.
 */
const PIVOT_K = 3;
export function computeTrendline(candles: DailyCandle[], pivotK = PIVOT_K, minLen = 20): number | null {
  const n = candles.length;
  if (n < minLen) return null;
  const vols = candles.map((c) => c.volume).filter((v) => v > 0);
  const avgVol = vols.length > 0 ? avg(vols) : 0;

  const lows: { i: number; low: number }[] = [];
  for (let i = pivotK; i < n - pivotK; i += 1) {
    const c = candles[i]!;
    let isPivot = true;
    for (let j = i - pivotK; j <= i + pivotK; j += 1) {
      if (j !== i && candles[j]!.low < c.low) { isPivot = false; break; }
    }
    if (isPivot && c.volume >= avgVol) lows.push({ i, low: c.low });
  }
  if (lows.length < 2) return null;

  const p1 = lows[lows.length - 2]!; // 과거 저점
  const p2 = lows[lows.length - 1]!; // 최근 저점
  const dt = p2.i - p1.i;
  if (dt <= 0) return null;
  const slope = (p2.low - p1.low) / dt;
  if (slope <= 0) return null; // 상승 빗각만 지지선으로 인정
  // candles 마지막 index = n-1 (전일). 오늘은 그 다음날 = index n.
  return p2.low + slope * (n - p2.i);
}

/**
 * 고고저 채널 하단. candles 는 오래된 것 → 최신 순, 기준일 이전 봉만.
 *  1) 좌우 pivotK 일보다 높은 국소 최고 + 거래량 평균 이상 = 의미 있는 스윙 고점
 *  2) 최근 고점 2개를 이은 기울기가 하락(<0)일 때만 유효 (하락 추세선)
 *  3) 첫 고점 이후 구간의 최저가에 같은 기울기로 평행 이동 (채널 하단)
 *  4) 오늘 시점으로 투영
 * ★ 상단(고점 저항선)은 매도자들이 실제로 있던 자리라는 행동 논리가 있지만,
 *   하단은 "진폭이 유지된다"는 평행 채널 가정 하나로 서 있습니다 — 백테스트로 심판.
 */
export function computeChannelLow(candles: DailyCandle[], pivotK = PIVOT_K, minLen = 20): number | null {
  const n = candles.length;
  if (n < minLen) return null;
  const vols = candles.map((c) => c.volume).filter((v) => v > 0);
  const avgVol = vols.length > 0 ? avg(vols) : 0;

  const highs: { i: number; high: number }[] = [];
  for (let i = pivotK; i < n - pivotK; i += 1) {
    const c = candles[i]!;
    let isPivot = true;
    for (let j = i - pivotK; j <= i + pivotK; j += 1) {
      if (j !== i && candles[j]!.high > c.high) { isPivot = false; break; }
    }
    if (isPivot && c.volume >= avgVol) highs.push({ i, high: c.high });
  }
  if (highs.length < 2) return null;

  const p1 = highs[highs.length - 2]!;
  const p2 = highs[highs.length - 1]!;
  const dt = p2.i - p1.i;
  if (dt <= 0) return null;
  const slope = (p2.high - p1.high) / dt;
  if (slope >= 0) return null; // 하락 추세선만 (상승 채널의 하단은 bitgak 이 담당)

  // 채널 폭: 첫 고점 이후 구간에서 추세선 대비 가장 깊이 내려간 저가를 앵커로
  let anchorI = -1;
  let maxDepth = 0; // 추세선 아래로 벗어난 깊이 (음수일수록 깊음)
  for (let i = p1.i; i < n; i += 1) {
    const depth = candles[i]!.low - (p1.high + slope * (i - p1.i));
    if (anchorI < 0 || depth < maxDepth) {
      anchorI = i;
      maxDepth = depth;
    }
  }
  if (anchorI < 0) return null;
  return candles[anchorI]!.low + slope * (n - anchorI);
}

/**
 * 일봉 → 주봉 합성 (월요일 시작). 토스 캔들 API 는 주봉 interval 이 없어서
 * (2026-09-02 확인: "지원하지 않는 캔들 주기") 일봉 최대 200개(약 10개월)를 묶어 만듭니다.
 * 인범 빗각처럼 큰 스케일 저점을 잡으려면 주봉이 필요합니다.
 */
export function toWeeklyCandles(daily: DailyCandle[]): DailyCandle[] {
  const byWeek = new Map<number, DailyCandle>();
  const keys: number[] = [];
  for (const c of daily) {
    const dayMs = Date.parse(c.timestamp.slice(0, 10));
    if (!Number.isFinite(dayMs)) continue;
    // epoch(1970-01-01)=목요일 → +3일 보정으로 월요일 시작 주 인덱스
    const week = Math.floor((dayMs / 86_400_000 + 3) / 7);
    const w = byWeek.get(week);
    if (!w) {
      byWeek.set(week, { ...c });
      keys.push(week);
    } else {
      w.high = Math.max(w.high, c.high);
      w.low = Math.min(w.low, c.low);
      w.close = c.close;
      w.volume += c.volume;
    }
  }
  return keys.sort((a, b) => a - b).map((k) => byWeek.get(k)!);
}

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

  return {
    ma20, ma60, rsi14, bbUpper, bbLower, atrPct,
    trendline: computeTrendline(candles),
    // 주봉 빗각: 피벗 폭 2주(좌우), 최소 12주(~3개월). 200일 일봉이면 주봉 ~40개
    trendlineW: computeTrendline(toWeeklyCandles(candles), 2, 12),
    channelLow: computeChannelLow(candles),
    lastClose,
  };
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
