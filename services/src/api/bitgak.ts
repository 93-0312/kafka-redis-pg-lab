import type Redis from 'ioredis';
import {
  computeChannelLowDetail,
  computeTrendlineDetail,
  toWeeklyCandles,
  type DailyCandle,
} from '../domain/indicators.js';
import { dateKey } from '../domain/quotes.js';
import { K } from '../lib/keys.js';
import type { Currency, Market } from '../types.js';

/**
 * 빗각 시각화 API. 전략이 실제로 쓰는 것과 "같은 순수 함수"로 선을 계산해
 * 캔들 위에 겹칠 수 있는 형태(캔들 인덱스에 정렬된 시리즈)로 내려줍니다.
 * 일봉 원본은 strategy 워커가 지표 갱신 때마다 Redis 에 게시한 것을 읽습니다.
 */

export interface BitgakLine {
  id: string;
  label: string;
  /** candles 와 같은 길이. 선이 정의되지 않는 구간은 null */
  series: (number | null)[];
  /** 오늘(다음 봉) 투영값 — 전략 진입/이탈 판정에 쓰는 바로 그 값 */
  today: number;
  /** 선을 만든 근거 점들 (피벗 저점/고점, 앵커). t = 해당 봉 timestamp */
  points: { t: string; price: number; role: 'pivot' | 'anchor' }[];
  /** 채택 안 된 후보 피벗들 (흐리게 표시용) */
  candidates: { t: string; price: number }[];
}

export interface BitgakView {
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  lastPrice: number;
  /** 표시용 일봉 (최근 120개, 오래된 것 → 최신) */
  candles: { t: string; o: number; h: number; l: number; c: number; v: number }[];
  lines: BitgakLine[];
  updatedAt: string;
}

const SHOW = 120;

/** 주 인덱스 (월요일 시작) — domain.toWeeklyCandles 와 같은 공식 */
const weekNum = (iso: string): number =>
  Math.floor((Date.parse(iso.slice(0, 10)) / 86_400_000 + 3) / 7);

export async function readBitgak(redis: Redis, symbol: string): Promise<BitgakView | null> {
  const raw = await redis.get(K.dailyCandles(symbol));
  if (!raw) return null;
  // 저장 원본은 토스 응답 순서(최신→과거)라 정렬이 필수. 오늘의 미완성 봉도
  // 전략과 똑같이 제외해야(as-of) "전략이 보는 바로 그 선"이 그려집니다.
  const today = dateKey();
  const all = (JSON.parse(raw) as DailyCandle[])
    .filter((c) => dateKey(c.timestamp) < today)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (all.length === 0) return null;

  const quote = await redis.hgetall(K.quote(symbol));
  const offset = Math.max(0, all.length - SHOW);
  const shown = all.slice(offset);
  const nAbs = all.length;

  const lines: BitgakLine[] = [];
  const t = (i: number): string => all[i]!.timestamp;

  // ── 일봉 빗각 (상승 지지선) ─────────────────────────────
  const d = computeTrendlineDetail(all);
  if (d) {
    const chosen = new Set([d.a.i, d.b.i]);
    lines.push({
      id: 'bitgak',
      label: '일봉 빗각',
      series: shown.map((_, si) => {
        const i = si + offset;
        return i >= d.a.i ? d.a.price + d.slope * (i - d.a.i) : null;
      }),
      today: d.today,
      points: [d.a, d.b].map((p) => ({ t: t(p.i), price: p.price, role: 'pivot' as const })),
      candidates: d.pivots.filter((p) => !chosen.has(p.i)).map((p) => ({ t: t(p.i), price: p.price })),
    });
  }

  // ── 주봉 빗각 (주봉 합성 후 같은 계산, 일봉 축으로 환산) ──
  const weekly = toWeeklyCandles(all);
  const w = computeTrendlineDetail(weekly, 2, 12);
  if (w) {
    const wkOf = (wi: number): number => weekNum(weekly[wi]!.timestamp);
    const aWk = wkOf(w.a.i);
    const chosen = new Set([w.a.i, w.b.i]);
    lines.push({
      id: 'bitgakw',
      label: '주봉 빗각',
      series: shown.map((c) => {
        const wk = weekNum(c.timestamp);
        return wk >= aWk ? w.a.price + w.slope * (wk - aWk) : null;
      }),
      today: w.today,
      points: [w.a, w.b].map((p) => ({
        t: weekly[p.i]!.timestamp, price: p.price, role: 'pivot' as const,
      })),
      candidates: w.pivots.filter((p) => !chosen.has(p.i))
        .map((p) => ({ t: weekly[p.i]!.timestamp, price: p.price })),
    });
  }

  // ── 고고저 (하락 저항선 + 평행 이동한 채널 하단) ─────────
  const g = computeChannelLowDetail(all);
  if (g) {
    const chosen = new Set([g.a.i, g.b.i]);
    // 저항선 (고점 연결) — 하단이 어디서 "평행 이동"됐는지 보여주는 맥락선
    lines.push({
      id: 'gogo',
      label: '고고 저항선',
      series: shown.map((_, si) => {
        const i = si + offset;
        return i >= g.a.i ? g.a.price + g.slope * (i - g.a.i) : null;
      }),
      today: g.a.price + g.slope * (nAbs - g.a.i),
      points: [g.a, g.b].map((p) => ({ t: t(p.i), price: p.price, role: 'pivot' as const })),
      candidates: g.pivots.filter((p) => !chosen.has(p.i)).map((p) => ({ t: t(p.i), price: p.price })),
    });
    lines.push({
      id: 'gogojeo',
      label: '고고저 채널 하단',
      series: shown.map((_, si) => {
        const i = si + offset;
        return i >= g.a.i ? g.anchor.price + g.slope * (i - g.anchor.i) : null;
      }),
      today: g.today,
      points: [{ t: t(g.anchor.i), price: g.anchor.price, role: 'anchor' as const }],
      candidates: [],
    });
  }

  return {
    symbol,
    name: quote['name'] ?? symbol,
    market: (quote['market'] ?? 'KR') as Market,
    currency: (quote['currency'] ?? 'KRW') as Currency,
    lastPrice: Number(quote['price']) || all[all.length - 1]!.close,
    candles: shown.map((c) => ({
      t: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
    })),
    lines,
    updatedAt: new Date().toISOString(),
  };
}
