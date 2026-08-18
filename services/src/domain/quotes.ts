import type { MinuteCandle } from '../types.js';

/** 로컬(KST) 기준 YYYYMMDD */
export function dateKey(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 로컬(KST) 기준 HHmm. 1분봉 버킷 field 로 씁니다. */
export function minuteBucket(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 등락률. 기준가가 없거나 0이면 0. */
export function changeRate(price: number, prevClose: number | null): number {
  if (!prevClose || prevClose <= 0) return 0;
  return (price - prevClose) / prevClose;
}

/**
 * 1분봉 롤업. 같은 분에 도착한 틱을 기존 봉에 병합합니다.
 * read-modify-write 지만, 파티션 키가 symbol 이라 같은 종목은 항상
 * 같은 컨슈머가 순서대로 처리하므로 경합이 없습니다. (파티션 키의 존재 이유)
 */
export function mergeCandle(prev: MinuteCandle | null, price: number): MinuteCandle {
  if (!prev) return { o: price, h: price, l: price, c: price, n: 1 };
  return {
    o: prev.o,
    h: Math.max(prev.h, price),
    l: Math.min(prev.l, price),
    c: price,
    n: prev.n + 1,
  };
}

/**
 * 일봉 목록에서 "전일 종가"를 고릅니다.
 *  - 최신 봉이 오늘 날짜면: 오늘 봉은 아직 만들어지는 중이므로 그 직전 봉의 종가
 *  - 최신 봉이 과거 날짜면(휴장 등): 그 봉의 종가가 곧 직전 거래일 종가
 */
export function pickPrevClose(
  candles: { timestamp: string; closePrice: string }[],
  todayKey: string,
): number | null {
  if (candles.length === 0) return null;
  const sorted = [...candles].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const latest = sorted[0]!;
  const target = dateKey(latest.timestamp) === todayKey ? sorted[1] : latest;
  if (!target) return null;
  const close = Number(target.closePrice);
  return Number.isFinite(close) && close > 0 ? close : null;
}
