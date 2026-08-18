import { config } from '../config.js';
import { createConsumer, onShutdown } from '../lib/kafka.js';
import { SCHEMA_SQL, createPool } from '../lib/pg.js';
import type { TickEvent } from '../types.js';

/**
 * 히스토리 싱크 (Consumer Group D)
 * market.ticks 를 Postgres 에 영구 적재합니다. 백테스트·전략 학습의 데이터 기반입니다.
 *
 *  - Kafka 보존(30일) 안에서는 이 워커가 죽어 있어도 offset 부터 다시 읽어 복구됩니다
 *  - 멱등 처리는 Redis 가 아니라 DB 제약(event_id PK + ON CONFLICT DO NOTHING)으로 합니다.
 *    같은 문제를 푸는 두 방식(SET NX vs PK 충돌)을 비교해 보세요
 *  - fromBeginning: true — 처음 켜면 토픽에 남아 있는 과거 틱을 전부 백필합니다
 */

async function main(): Promise<void> {
  const pool = createPool();
  await pool.query(SCHEMA_SQL);
  console.log('[history] Postgres 스키마 확인 완료');

  const consumer = await createConsumer('mktlab-history', config.kafka.groups.history);
  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: true });
  console.log(`[history] group=${config.kafka.groups.history} 구독 시작 → Postgres 적재`);

  onShutdown(async () => {
    await consumer.disconnect();
    await pool.end();
  });

  let inserted = 0;
  let duplicates = 0;

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const t = JSON.parse(message.value.toString()) as TickEvent;

      const res = await pool.query(
        `INSERT INTO ticks (event_id, symbol, name, market, currency, price, prev_close, traded_at, polled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          t.eventId,
          t.symbol,
          t.name,
          t.market,
          t.currency,
          t.price,
          t.prevClose,
          t.tradedAt,
          t.polledAt,
        ],
      );

      if (res.rowCount === 1) inserted += 1;
      else duplicates += 1;

      if ((inserted + duplicates) % 500 === 0) {
        console.log(`[history] 적재 ${inserted}건 (중복 스킵 ${duplicates}건)`);
      }
    },
  });
}

void main();
