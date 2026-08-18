import { randomUUID } from 'node:crypto';
import { dateKey } from '../domain/quotes.js';
import { ALERT_LIST_MAX, K } from '../lib/keys.js';
import { createRedis } from '../lib/redis.js';
import type { MinuteCandle, PriceAlert } from '../types.js';

/**
 * Kafka·토스 API 없이 대시보드만 확인하고 싶을 때 쓰는 더미 데이터.
 * 프론트엔드 작업 중에는 이쪽이 훨씬 빠릅니다. (Kafka 학습은 안 됩니다)
 */

const SEED = [
  { symbol: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', prevClose: 71900, price: 73400 },
  { symbol: '000660', name: 'SK하이닉스', market: 'KR', currency: 'KRW', prevClose: 264000, price: 258500 },
  { symbol: '035420', name: 'NAVER', market: 'KR', currency: 'KRW', prevClose: 231500, price: 233000 },
  { symbol: '035720', name: '카카오', market: 'KR', currency: 'KRW', prevClose: 61200, price: 63900 },
  { symbol: '005380', name: '현대차', market: 'KR', currency: 'KRW', prevClose: 288000, price: 285500 },
  { symbol: 'AAPL', name: 'Apple', market: 'US', currency: 'USD', prevClose: 254.1, price: 259.62 },
  { symbol: 'NVDA', name: 'NVIDIA', market: 'US', currency: 'USD', prevClose: 231.4, price: 224.87 },
  { symbol: 'TSLA', name: 'Tesla', market: 'US', currency: 'USD', prevClose: 448.9, price: 461.3 },
] as const;

async function main(): Promise<void> {
  const redis = createRedis('seed');
  const now = new Date();
  const date = dateKey();

  for (const s of SEED) {
    const rate = (s.price - s.prevClose) / s.prevClose;
    await redis.hset(K.quote(s.symbol), {
      symbol: s.symbol,
      name: s.name,
      market: s.market,
      currency: s.currency,
      price: String(s.price),
      prevClose: String(s.prevClose),
      change: String(s.price - s.prevClose),
      changeRate: String(rate),
      tradedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await redis.sadd(K.symbolIndex, s.symbol);
    await redis.zadd(K.rank, rate, s.symbol);

    // 최근 40분짜리 랜덤워크 1분봉
    let price: number = s.prevClose;
    const candleKey = K.candle(s.symbol, date);
    for (let i = 40; i >= 1; i -= 1) {
      const t = new Date(now.getTime() - i * 60_000);
      const bucket = `${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}`;
      const o = price;
      const drift = (s.price - s.prevClose) / 40;
      const noise = s.prevClose * 0.002 * (Math.random() - 0.5);
      price = Math.max(0.01, o + drift + noise);
      const candle: MinuteCandle = {
        o,
        h: Math.max(o, price) + Math.abs(noise) / 2,
        l: Math.min(o, price) - Math.abs(noise) / 2,
        c: price,
        n: 20,
      };
      await redis.hset(candleKey, bucket, JSON.stringify(candle));
    }
  }

  const sample: PriceAlert = {
    alertId: randomUUID(),
    type: 'SURGE',
    severity: 'WARN',
    symbol: '035720',
    name: '카카오',
    market: 'KR',
    price: 63900,
    currency: 'KRW',
    changeRate: 0.0441,
    message: '카카오 전일 대비 +4.41% (상승 4단계 도달)',
    detectedAt: now.toISOString(),
  };
  await redis
    .multi()
    .lpush(K.alertRecent, JSON.stringify(sample))
    .ltrim(K.alertRecent, 0, ALERT_LIST_MAX - 1)
    .exec();

  console.log(`seed 완료: 종목 ${SEED.length}개 + 1분봉 + 샘플 알림`);
  redis.disconnect();
  process.exit(0);
}

void main();
