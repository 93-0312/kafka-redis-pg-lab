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

/** 월/일 (로컬=KST). 밤 미장이 자정을 넘겨 날짜가 섞이므로 시각 앞에 붙인다. */
const monthDay = (d: Date): string =>
  `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;

/** 실시간 시세·알림용: 월/일 시:분:초 */
export const clock = (iso: string): string => {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${monthDay(d)} ${d.toLocaleTimeString('ko-KR', { hour12: false })}`;
};

/** 체결 내역용: 월/일 시:분 (여러 날짜가 섞인 피드에서 언제 체결됐는지 구분) */
export const stamp = (iso: string): string => {
  if (!iso) return '-';
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${monthDay(d)} ${hm}`;
};

export const hhmm = (bucket: string): string => `${bucket.slice(0, 2)}:${bucket.slice(2)}`;
