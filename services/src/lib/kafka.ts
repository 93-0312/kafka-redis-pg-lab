import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import { config } from '../config.js';

export function createKafka(clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: [...config.kafka.brokers],
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 300, retries: 10 },
  });
}

export async function createProducer(clientId: string): Promise<Producer> {
  const producer = createKafka(clientId).producer({
    allowAutoTopicCreation: true,
    idempotent: true, // 중복 전송 방지
  });
  await producer.connect();
  return producer;
}

export async function createConsumer(clientId: string, groupId: string): Promise<Consumer> {
  const consumer = createKafka(clientId).consumer({
    groupId,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });
  await consumer.connect();
  return consumer;
}

export interface ResilientConsumerOpts {
  clientId: string;
  groupId: string;
  topic: string;
  fromBeginning: boolean;
  eachMessage: (payload: { message: { value: Buffer | null }; partition: number }) => Promise<void>;
  /** 이 시간(초) 동안 메시지가 없으면 컨슈머를 재접속합니다 */
  stallSec?: number;
  /** 메시지 처리 성공 시 호출 (진행률 기록용) */
  onProgress?: () => void;
}

/**
 * 스톨 자동 복구 컨슈머.
 *
 * 실제 장애 사례(2026-08-19): 프로세스는 살아 하트비트를 보내는데 kafkajs 컨슈머만
 * 조용히 멈춰서 시세가 몇 시간 얼어붙었습니다. "살아있음(liveness)"과
 * "일하고 있음(progress)"은 다릅니다.
 *
 * producer 가 24시간 3초마다 틱을 발행하므로 market.ticks 컨슈머는 항상 메시지를
 * 받아야 정상입니다. stallSec 동안 무소식이면 컨슈머를 끊고 다시 조인합니다.
 * (주의: 조용한 게 정상인 토픽(paper.orders)에는 쓰지 마세요 — 재접속 낭비)
 */
export async function runResilientConsumer(opts: ResilientConsumerOpts): Promise<void> {
  const stallMs = (opts.stallSec ?? 120) * 1000;
  let lastMessageAt = Date.now();
  let restarting = false;
  let consumer: Consumer | null = null;

  const start = async (): Promise<void> => {
    consumer = await createConsumer(opts.clientId, opts.groupId);
    await consumer.subscribe({ topic: opts.topic, fromBeginning: opts.fromBeginning });
    await consumer.run({
      eachMessage: async (payload) => {
        lastMessageAt = Date.now();
        await opts.eachMessage(payload as never);
        opts.onProgress?.();
      },
    });
  };

  await start();

  const watchdog = setInterval(() => {
    void (async () => {
      if (restarting || Date.now() - lastMessageAt < stallMs) return;
      restarting = true;
      console.warn(
        `[${opts.groupId}] ${Math.round((Date.now() - lastMessageAt) / 1000)}초 동안 메시지 없음 — 컨슈머 재접속`,
      );
      try {
        await consumer?.disconnect();
      } catch {
        /* 이미 죽은 커넥션이면 무시 */
      }
      try {
        await start();
        lastMessageAt = Date.now();
        console.log(`[${opts.groupId}] 컨슈머 재접속 완료`);
      } catch (err) {
        console.error(`[${opts.groupId}] 재접속 실패 — 다음 주기에 재시도:`, (err as Error).message);
      }
      restarting = false;
    })();
  }, 30_000);
  watchdog.unref?.();

  onShutdown(async () => {
    clearInterval(watchdog);
    await consumer?.disconnect();
  });
}

/** SIGINT/SIGTERM 시 컨슈머를 깔끔히 내려서 리밸런싱이 빨리 끝나도록 합니다. */
export function onShutdown(fn: () => Promise<void>): void {
  let closing = false;
  const handler = async () => {
    if (closing) return;
    closing = true;
    console.log('\n[shutdown] 정리 중...');
    try {
      await fn();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}
