import pg from 'pg';
import { config } from '../config.js';

/**
 * Postgres 커넥션 풀.
 * Kafka 는 30일 순환 버퍼이고, 장기 축적·질의(백테스트)는 Postgres 가 담당합니다.
 */
export function createPool(): pg.Pool {
  const pool = new pg.Pool({ connectionString: config.postgres.url, max: 5 });
  pool.on('error', (err) => console.error('[pg]', err.message));
  return pool;
}

/** 틱 히스토리 스키마. event_id PK 가 곧 멱등 처리입니다 (ON CONFLICT DO NOTHING). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ticks (
  event_id   uuid PRIMARY KEY,
  symbol     text NOT NULL,
  name       text NOT NULL,
  market     text NOT NULL,
  currency   text NOT NULL,
  price      numeric NOT NULL,
  prev_close numeric,
  traded_at  timestamptz,
  polled_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticks_symbol_polled ON ticks (symbol, polled_at);
`;
