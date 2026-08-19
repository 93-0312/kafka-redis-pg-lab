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

/** market.ticks 를 소비하는 워커들 — producer 가 도는 한 항상 진행 중이어야 정상 */
export const TICK_CONSUMERS = ['quote', 'alert', 'strategy', 'history'] as const;

const lastMark = new Map<string, number>();

/** 메시지 처리 진행률 기록 (5초 스로틀). 스톨 감지의 근거가 됩니다. */
export function markProgress(redis: Redis, name: string): void {
  const now = Date.now();
  if (now - (lastMark.get(name) ?? 0) < 5_000) return;
  lastMark.set(name, now);
  redis.set(K.progress(name), new Date(now).toISOString(), 'EX', 600).catch(() => undefined);
}

/** 컨슈머별 마지막 처리 후 경과(초). 기록이 없으면 null */
export async function checkProgress(redis: Redis): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const name of TICK_CONSUMERS) {
    const iso = await redis.get(K.progress(name));
    out[name] = iso ? Math.round((Date.now() - Date.parse(iso)) / 1000) : null;
  }
  return out;
}
