import { config } from '../config.js';
import { markProgress, startHeartbeat } from '../lib/heartbeat.js';
import { onShutdown, runResilientConsumer } from '../lib/kafka.js';
import { SCHEMA_SQL, createPool } from '../lib/pg.js';
import { createRedis } from '../lib/redis.js';
import type { TickEvent } from '../types.js';

/**
 * 히스토리 싱크 (Consumer Group D)
 * market.ticks 를 Postgres 에 영구 적재합니다. 백테스트·전략 학습의 데이터 기반입니다.
 *
 *  - Kafka 보존(30일) 안에서는 이 워커가 죽어 있어도 offset 부터 다시 읽어 복구됩니다
 *  - 멱등 처리는 Redis 가 아니라 DB 제약(event_id PK + ON CONFLICT DO NOTHING)으로 합니다.
 *    같은 문제를 푸는 두 방식(SET NX vs PK 충돌)을 비교해 보세요
 *  - fromBeginning: true — 처음 켜면 토픽에 남아 있는 과거 틱을 전부 백필합니다
 *  - 적재는 묶음(eachBatch)으로 합니다. 건별 INSERT 는 밀린 오프셋을 따라잡지 못해서
 *    리밸런스 타임아웃 → 재조인 → 다시 밀림 의 악순환에 빠집니다 (2026-08-19 실장애)
 */

async function main(): Promise<void> {
  const redis = createRedis('history');
  startHeartbeat(redis, 'history');
  const pool = createPool();
  await pool.query(SCHEMA_SQL);
  console.log('[history] Postgres 스키마 확인 완료');

  console.log(`[history] group=${config.kafka.groups.history} 구독 시작 → Postgres 적재`);

  onShutdown(async () => {
    await pool.end();
    redis.disconnect();
  });

  let inserted = 0;
  let duplicates = 0;

  await runResilientConsumer({
    clientId: 'mktlab-history',
    groupId: config.kafka.groups.history,
    topic: config.kafka.topic,
    fromBeginning: true,
    onProgress: () => markProgress(redis, 'history'),
    eachBatch: async ({ messages }) => {
      const ticks = messages
        .filter((m) => m.value)
        .map((m) => JSON.parse(m.value!.toString()) as TickEvent);
      if (ticks.length === 0) return;

      // 한 쿼리에 여러 행 — ($1..$9), ($10..$18), ... 로 펼칩니다.
      const COLS = 9;
      const values: unknown[] = [];
      const rows = ticks.map((t, i) => {
        values.push(
          t.eventId, t.symbol, t.name, t.market, t.currency,
          t.price, t.prevClose, t.tradedAt, t.polledAt,
        );
        const base = i * COLS;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
      });

      const res = await pool.query(
        `INSERT INTO ticks (event_id, symbol, name, market, currency, price, prev_close, traded_at, polled_at)
         VALUES ${rows.join(', ')}
         ON CONFLICT (event_id) DO NOTHING`,
        values,
      );

      const added = res.rowCount ?? 0;
      inserted += added;
      duplicates += ticks.length - added;
      console.log(
        `[history] 묶음 ${ticks.length}건 적재(신규 ${added}) · 누적 ${inserted}건 (중복 스킵 ${duplicates}건)`,
      );
    },
  });
}

void main();
