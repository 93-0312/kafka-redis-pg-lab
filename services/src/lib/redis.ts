import Redis from 'ioredis';
import { config } from '../config.js';

/**
 * ioredis 는 SUBSCRIBE 상태에 들어가면 일반 명령을 쓸 수 없습니다.
 * 그래서 "명령용"과 "구독용" 커넥션을 분리해야 합니다. 흔한 함정입니다.
 */
export function createRedis(role: string): Redis {
  const client = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  client.on('error', (err) => console.error(`[redis:${role}] ${err.message}`));
  return client;
}
