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
  /** 건별 처리. eachBatch 와 둘 중 하나만 지정합니다 */
  eachMessage?: (payload: { message: { value: Buffer | null }; partition: number }) => Promise<void>;
  /**
   * 묶음 처리. 밀린 오프셋을 따라잡아야 하는 워커(예: DB 적재)는 이 쪽을 씁니다.
   * chunkSize 단위로 잘라서 넘기고, 청크마다 오프셋을 확정하고 하트비트를 보냅니다 —
   * 백로그가 커도 리밸런스 타임아웃에 걸려 쫓겨나지 않습니다.
   */
  eachBatch?: (payload: { messages: { value: Buffer | null }[]; partition: number }) => Promise<void>;
  /** eachBatch 청크 크기 (기본 500) */
  chunkSize?: number;
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
  const chunkSize = opts.chunkSize ?? 500;
  let lastMessageAt = Date.now();
  let restarting = false;
  let lastRestartAt = 0;
  let consumer: Consumer | null = null;

  const start = async (): Promise<void> => {
    consumer = await createConsumer(opts.clientId, opts.groupId);
    // 조인이 끝난 시점을 스톨 시계의 기준으로 삼습니다. 조인 직후에는 아직 메시지가
    // 없는 게 정상인데, 이걸 스톨로 오인해 또 재접속하면 그룹에 유령 멤버만 쌓입니다.
    consumer.on(consumer.events.GROUP_JOIN, () => {
      lastMessageAt = Date.now();
    });
    await consumer.subscribe({ topic: opts.topic, fromBeginning: opts.fromBeginning });

    if (opts.eachBatch) {
      const handle = opts.eachBatch;
      await consumer.run({
        eachBatchAutoResolve: false,
        eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
          for (let i = 0; i < batch.messages.length; i += chunkSize) {
            if (!isRunning() || isStale()) break;
            const chunk = batch.messages.slice(i, i + chunkSize);
            await handle({ messages: chunk as never, partition: batch.partition });
            resolveOffset(chunk[chunk.length - 1]!.offset);
            await heartbeat(); // 청크마다 하트비트 — 백로그 처리 중 쫓겨나지 않도록
            lastMessageAt = Date.now();
            opts.onProgress?.();
          }
        },
      });
      return;
    }

    const handleOne = opts.eachMessage;
    if (!handleOne) throw new Error('eachMessage 또는 eachBatch 중 하나는 있어야 합니다');
    await consumer.run({
      eachMessage: async (payload) => {
        lastMessageAt = Date.now();
        await handleOne(payload as never);
        opts.onProgress?.();
      },
    });
  };

  await start();

  const watchdog = setInterval(() => {
    void (async () => {
      if (restarting || Date.now() - lastMessageAt < stallMs) return;
      // 재접속 간격 하한: 스톨 창(stallMs) 안에 두 번 재접속하지 않습니다.
      // 실제 장애(2026-08-19): 조인이 지연되는 컨슈머를 30초마다 재접속시키다
      // history-worker 그룹에 유령 멤버가 388개까지 쌓여 리밸런싱이 영원히 안 끝났습니다.
      if (Date.now() - lastRestartAt < stallMs) return;
      restarting = true;
      lastRestartAt = Date.now();
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
