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
