import { config } from '../config.js';
import { changeRate, dateKey, mergeCandle, minuteBucket } from '../domain/quotes.js';
import { createConsumer, onShutdown } from '../lib/kafka.js';
import { K, PROCESSED_TTL_SEC } from '../lib/keys.js';
import { createRedis } from '../lib/redis.js';
import { startHeartbeat } from '../lib/heartbeat.js';
import type { MinuteCandle, TickEvent } from '../types.js';

const CANDLE_TTL = 60 * 60 * 48;

/**
 * 시세 워커 (Consumer Group A)
 *  - 최신가 스냅샷: Redis Hash (대시보드가 바로 읽는 캐시)
 *  - 등락률 랭킹: ZSET
 *  - 1분봉 롤업: 틱 스트림 -> OHLC. 파티션 키가 symbol 이라 같은 종목은
 *    항상 같은 컨슈머가 순서대로 처리하므로 read-modify-write 가 안전합니다.
 */
async function main(): Promise<void> {
  const redis = createRedis('quote');
  startHeartbeat(redis, 'quote');
  const consumer = await createConsumer('mktlab-quote', config.kafka.groups.quote);

  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: true });
  console.log(`[quote] group=${config.kafka.groups.quote} 구독 시작`);

  onShutdown(async () => {
    await consumer.disconnect();
    redis.disconnect();
  });

  let processed = 0;
  let skipped = 0;

  await consumer.run({
    eachMessage: async ({ message, partition }) => {
      if (!message.value) return;
      const tick = JSON.parse(message.value.toString()) as TickEvent;

      // 멱등 처리: Kafka 는 at-least-once 라 같은 틱을 두 번 받을 수 있습니다.
      const idemKey = K.processed(config.kafka.groups.quote, tick.eventId);
      const first = await redis.set(idemKey, '1', 'EX', PROCESSED_TTL_SEC, 'NX');
      if (first !== 'OK') {
        skipped += 1;
        return;
      }

      const rate = changeRate(tick.price, tick.prevClose);

      const pipe = redis.multi();
      pipe.hset(K.quote(tick.symbol), {
        symbol: tick.symbol,
        name: tick.name,
        market: tick.market,
        currency: tick.currency,
        price: String(tick.price),
        prevClose: String(tick.prevClose ?? 0),
        change: String(tick.prevClose ? tick.price - tick.prevClose : 0),
        changeRate: String(rate),
        tradedAt: tick.tradedAt ?? '',
        updatedAt: tick.polledAt,
      });
      pipe.sadd(K.symbolIndex, tick.symbol);
      pipe.zadd(K.rank, rate, tick.symbol);
      await pipe.exec();

      // 1분봉 롤업
      const date = dateKey(tick.polledAt);
      const bucket = minuteBucket(tick.polledAt);
      const candleKey = K.candle(tick.symbol, date);
      const prevRaw = await redis.hget(candleKey, bucket);
      const prev = prevRaw ? (JSON.parse(prevRaw) as MinuteCandle) : null;
      await redis
        .multi()
        .hset(candleKey, bucket, JSON.stringify(mergeCandle(prev, tick.price)))
        .expire(candleKey, CANDLE_TTL)
        .exec();

      processed += 1;
      if (processed % 100 === 0) {
        console.log(`[quote] p${partition} 처리 ${processed}건 (중복 스킵 ${skipped}건)`);
      }
    },
  });
}

void main();
