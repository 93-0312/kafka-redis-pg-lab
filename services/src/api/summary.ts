import type Redis from 'ioredis';
import { dateKey } from '../domain/quotes.js';
import { K } from '../lib/keys.js';
import type { Currency, Market, MinuteCandle, QuoteSnapshot } from '../types.js';

export interface DashboardSummary {
  quotes: QuoteSnapshot[];
  totals: {
    symbols: number;
    up: number;
    down: number;
    flat: number;
  };
  /** focus 종목의 1분봉 (최근 60분) */
  focus: string | null;
  candles: ({ t: string } & MinuteCandle)[];
  generatedAt: string;
}

const n = (v: string | undefined | null): number => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function readSummary(redis: Redis, focusParam?: string): Promise<DashboardSummary> {
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
  if (focus) {
    const raw = await redis.hgetall(K.candle(focus, dateKey()));
    candles = Object.entries(raw)
      .map(([t, v]) => ({ t, ...(JSON.parse(v) as MinuteCandle) }))
      .sort((a, b) => a.t.localeCompare(b.t))
      .slice(-60);
  }

  return { quotes, totals, focus, candles, generatedAt: new Date().toISOString() };
}
