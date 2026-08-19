import { config } from '../config.js';
import {
  buildReversalAlert,
  buildSpikeAlert,
  buildThresholdAlert,
  changeLevel,
  isSpike,
} from '../domain/alerts.js';
import { changeRate, dateKey } from '../domain/quotes.js';
import { isStale } from '../domain/strategy.js';
import { onShutdown, runResilientConsumer } from '../lib/kafka.js';
import { ALERT_LIST_MAX, K } from '../lib/keys.js';
import { createRedis } from '../lib/redis.js';
import { markProgress, startHeartbeat } from '../lib/heartbeat.js';
import { sendSlackAlert } from '../lib/slack.js';
import type { PriceAlert, TickEvent } from '../types.js';

/**
 * 알림 워커 (Consumer Group B)
 * quote 워커와 같은 토픽을 독립적으로 소비합니다. 이 워커를 껐다 켜도
 * 시세 캐싱에는 아무 영향이 없습니다 — 컨슈머 그룹을 나누는 이유입니다.
 *
 * 규칙 2가지:
 *  - SURGE/PLUNGE: 전일 대비 등락률이 ±step% 계단에 새로 도달
 *  - SPIKE: spikeWindowSec 초 안에 spikeRate% 이상 급변
 *
 * 같은 알림의 반복 발송은 SET NX EX(쿨다운)로 막습니다.
 * 알림은 "지금 보고 있는 사람"에게만 의미 있으므로 Pub/Sub(유실 허용)으로 쏘고,
 * 새로고침 대비용으로 List 에 최근 내역만 보관합니다.
 */

async function publish(redis: ReturnType<typeof createRedis>, alert: PriceAlert): Promise<void> {
  const payload = JSON.stringify(alert);
  await redis
    .multi()
    .publish(K.alertChannel, payload)
    .lpush(K.alertRecent, payload)
    .ltrim(K.alertRecent, 0, ALERT_LIST_MAX - 1)
    .exec();
  console.log(`[alert] ${alert.severity} ${alert.type} · ${alert.message}`);

  // 슬랙은 부가 채널: 실패해도 파이프라인은 계속 갑니다 (sendSlackAlert 내부에서 삼킴)
  await sendSlackAlert(alert);
}

async function main(): Promise<void> {
  const redis = createRedis('alert');
  startHeartbeat(redis, 'alert');
  console.log(`[alert] group=${config.kafka.groups.alert} 구독 시작`);

  onShutdown(async () => {
    redis.disconnect();
  });

  await runResilientConsumer({
    clientId: 'mktlab-alert',
    groupId: config.kafka.groups.alert,
    topic: config.kafka.topic,
    fromBeginning: false,
    onProgress: () => markProgress(redis, 'alert'),
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const tick = JSON.parse(message.value.toString()) as TickEvent;
      if (tick.price <= 0) return;

      // 장 마감 후에는 가격이 종가에 얼어붙은 틱이 계속 흐릅니다.
      // 체결 시각이 오래된 틱은 알림 평가에서 제외해 "종가 기준 반복 알림"을 막습니다.
      if (isStale(tick.tradedAt, Date.now(), config.alerts.staleTickSec)) return;

      // --- SURGE / PLUNGE / REBOUND / PULLBACK: 등락률 계단 + 방향성 ---
      if (tick.prevClose) {
        const rate = changeRate(tick.price, tick.prevClose);
        const stateKey = K.alertState(tick.symbol, dateKey(tick.polledAt));
        const st = await redis.hgetall(stateKey);
        const minRate = Math.min(Number(st['minRate'] ?? rate), rate);
        const maxRate = Math.max(Number(st['maxRate'] ?? rate), rate);

        // 급락/급등 알림은 "당일 최심 레벨을 새로 갱신할 때만" 냅니다.
        // -7% 를 이미 알렸다면 반등 중인 -6% 를 다시 '급락 도달'로 알리지 않습니다.
        const level = changeLevel(rate, config.alerts.changeRateStep);
        if (level >= 1) {
          const field = rate >= 0 ? 'upLevel' : 'downLevel';
          const deepest = Number(st[field] ?? 0);
          if (level > deepest) {
            await redis.hset(stateKey, field, String(level));
            await publish(redis, buildThresholdAlert(tick, rate, level));
          }
        }

        // 반등: 유의미한 급락(-2% 이하) 후 저점 대비 +N%p 회복.
        // 다음 반등 알림은 추가로 +N%p 더 회복했을 때만 (도배 방지).
        const step = config.alerts.reboundPct / 100;
        if (minRate <= -0.02 && rate - minRate >= step) {
          const lastAt = st['reboundAt'] !== undefined ? Number(st['reboundAt']) : null;
          if (lastAt === null || rate >= lastAt + step) {
            await redis.hset(stateKey, 'reboundAt', String(rate));
            await publish(redis, buildReversalAlert(tick, 'REBOUND', minRate, rate));
          }
        }
        // 상승 되돌림: +2% 이상 급등 후 고점 대비 -N%p 반납
        if (maxRate >= 0.02 && maxRate - rate >= step) {
          const lastAt = st['pullbackAt'] !== undefined ? Number(st['pullbackAt']) : null;
          if (lastAt === null || rate <= lastAt - step) {
            await redis.hset(stateKey, 'pullbackAt', String(rate));
            await publish(redis, buildReversalAlert(tick, 'PULLBACK', maxRate, rate));
          }
        }

        await redis
          .multi()
          .hset(stateKey, { minRate: String(minRate), maxRate: String(maxRate) })
          .expire(stateKey, 60 * 60 * 48)
          .exec();
      }

      // --- SPIKE: 단시간 급변 ---
      // 윈도우 시작가를 SET NX EX 로 고정해 두고, 윈도우가 사는 동안 현재가와 비교합니다.
      const baseKey = K.spikeBase(tick.symbol);
      const set = await redis.set(baseKey, String(tick.price), 'EX', config.alerts.spikeWindowSec, 'NX');
      if (set !== 'OK') {
        const base = Number(await redis.get(baseKey));
        if (base > 0 && isSpike(tick.price, base, config.alerts.spikeRate)) {
          const mark = K.alertMark(tick.symbol, 'spike');
          const fresh = await redis.set(mark, '1', 'EX', config.alerts.cooldownSec, 'NX');
          if (fresh === 'OK') {
            const totalRate = changeRate(tick.price, tick.prevClose);
            await publish(
              redis,
              buildSpikeAlert(tick, base, config.alerts.spikeWindowSec, totalRate),
            );
          }
          // 알림을 쐈으면 다음 윈도우는 현재가부터 다시 시작합니다.
          await redis.set(baseKey, String(tick.price), 'EX', config.alerts.spikeWindowSec);
        }
      }
    },
  });
}

void main();
