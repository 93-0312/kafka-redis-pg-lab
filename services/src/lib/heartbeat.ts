import type Redis from 'ioredis';
import { K } from './keys.js';

/**
 * 워커 생존 신호. 20초마다 TTL 60초 키를 갱신합니다.
 * 키가 사라진 워커 = 60초 이상 침묵 = 죽었거나 멈춘 것.
 * /api/health 와 아침 브리핑이 이 키로 파이프라인 전체의 생존을 판단합니다.
 */
export const WORKER_NAMES = ['api', 'quote', 'alert', 'strategy', 'paper-exec', 'history', 'producer'] as const;

export function startHeartbeat(redis: Redis, name: (typeof WORKER_NAMES)[number]): NodeJS.Timeout {
  const beat = () => {
    redis.set(K.heartbeat(name), new Date().toISOString(), 'EX', 60).catch(() => undefined);
  };
  beat();
  const timer = setInterval(beat, 20_000);
  timer.unref?.();
  return timer;
}

/** 살아있는 워커 목록과 죽은 워커 목록 */
export async function checkHeartbeats(redis: Redis): Promise<{ alive: string[]; dead: string[] }> {
  const alive: string[] = [];
  const dead: string[] = [];
  for (const name of WORKER_NAMES) {
    if (await redis.exists(K.heartbeat(name))) alive.push(name);
    else dead.push(name);
  }
  return { alive, dead };
}
