import type Redis from 'ioredis';
import type { DailyCandle } from '../domain/indicators.js';
import { dateKey } from '../domain/quotes.js';
import { K } from '../lib/keys.js';
import type { Currency, Market, MinuteCandle, QuoteSnapshot } from '../types.js';

export type ChartInterval = '1m' | '1d';

export interface FocusIndicators {
  ma20: number | null;
  ma60: number | null;
  rsi14: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  atrPct: number | null;
}

export interface DashboardSummary {
  quotes: QuoteSnapshot[];
  totals: {
    symbols: number;
    up: number;
    down: number;
    flat: number;
  };
  /** focus 종목의 캔들. interval='1m' 이면 1분봉(최근 60개), '1d' 면 일봉(최근 60개) */
  focus: string | null;
  interval: ChartInterval;
  candles: ({ t: string } & MinuteCandle)[];
  /** focus 종목의 일봉 지표 (전략 워커가 30분마다 게시한 as-of 값) */
  indicators: FocusIndicators | null;
  generatedAt: string;
}

const n = (v: string | undefined | null): number => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function readSummary(
  redis: Redis,
  focusParam?: string,
  intervalParam?: string,
): Promise<DashboardSummary> {
  const interval: ChartInterval = intervalParam === '1d' ? '1d' : '1m';
  const symbols = await redis.smembers(K.symbolIndex);

  const pipe = redis.pipeline();
  for (const s of symbols) pipe.hgetall(K.quote(s));
  const results = (await pipe.exec()) ?? [];

  const quotes: QuoteSnapshot[] = [];
  for (const entry of results) {
    const raw = entry?.[1] as Record<string, string> | undefined;
    if (!raw || !raw['symbol']) continue;
    quotes.push({
      symbol: raw['symbol'],
      name: raw['name'] ?? raw['symbol'],
      market: (raw['market'] ?? 'KR') as Market,
      currency: (raw['currency'] ?? 'KRW') as Currency,
      price: n(raw['price']),
      prevClose: n(raw['prevClose']),
      change: n(raw['change']),
      changeRate: n(raw['changeRate']),
      tradedAt: raw['tradedAt'] ?? '',
      updatedAt: raw['updatedAt'] ?? '',
    });
  }

  quotes.sort((a, b) => b.changeRate - a.changeRate);

  const totals = {
    symbols: quotes.length,
    up: quotes.filter((q) => q.changeRate > 0).length,
    down: quotes.filter((q) => q.changeRate < 0).length,
    flat: quotes.filter((q) => q.changeRate === 0).length,
  };

  // focus 종목의 1분봉 차트 데이터
  const focus = focusParam && symbols.includes(focusParam) ? focusParam : (quotes[0]?.symbol ?? null);
  let candles: DashboardSummary['candles'] = [];
  let indicators: FocusIndicators | null = null;
  if (focus) {
    if (interval === '1d') {
      // 일 모드: 전략 워커가 게시한 토스 일봉 원본을 사용합니다.
      const raw = await redis.get(K.dailyCandles(focus));
      if (raw) {
        candles = (JSON.parse(raw) as DailyCandle[])
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .slice(-60)
          .map((c) => ({
            t: dateKey(c.timestamp),
            o: c.open, h: c.high, l: c.low, c: c.close, n: c.volume,
          }));
      }
    } else {
      const raw = await redis.hgetall(K.candle(focus, dateKey()));
      candles = Object.entries(raw)
        .map(([t, v]) => ({ t, ...(JSON.parse(v) as MinuteCandle) }))
        .sort((a, b) => a.t.localeCompare(b.t))
        .slice(-60);
    }

    const ind = await redis.hgetall(K.indicators(focus));
    if (ind['updatedAt']) {
      const opt = (v: string | undefined): number | null =>
        v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
      indicators = {
        ma20: opt(ind['ma20']),
        ma60: opt(ind['ma60']),
        rsi14: opt(ind['rsi14']),
        bbUpper: opt(ind['bbUpper']),
        bbLower: opt(ind['bbLower']),
        atrPct: opt(ind['atrPct']),
      };
    }
  }

  return { quotes, totals, focus, interval, candles, indicators, generatedAt: new Date().toISOString() };
}
