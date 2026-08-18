import type { Currency } from './types';

/** 통화별 가격 표기. KRW 는 정수, USD 는 소수 둘째 자리까지. */
export const money = (n: number, currency: Currency): string =>
  currency === 'KRW'
    ? `${Math.round(n).toLocaleString('ko-KR')}원`
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 등락률. +/- 부호를 항상 붙입니다. */
export const signPct = (rate: number): string =>
  `${rate > 0 ? '+' : ''}${(rate * 100).toFixed(2)}%`;

/** 등락 색상 클래스: 상승 빨강 / 하락 파랑 (국내 증권 관례) */
export const upDown = (rate: number): 'up' | 'down' | 'flat' =>
  rate > 0 ? 'up' : rate < 0 ? 'down' : 'flat';

export const clock = (iso: string): string => {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleTimeString('ko-KR', { hour12: false });
};

export const hhmm = (bucket: string): string => `${bucket.slice(0, 2)}:${bucket.slice(2)}`;
