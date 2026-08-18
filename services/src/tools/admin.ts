import { config } from '../config.js';
import { createKafka } from '../lib/kafka.js';
import { createRedis } from '../lib/redis.js';

const command = process.argv[2] ?? 'help';

async function createTopic(): Promise<void> {
  const admin = createKafka('mktlab-admin').admin();
  await admin.connect();
  const existing = await admin.listTopics();

  for (const topic of [config.kafka.topic, config.kafka.paperTopic]) {
    if (existing.includes(topic)) {
      console.log(`토픽이 이미 있습니다: ${topic}`);
      continue;
    }
    await admin.createTopics({
      topics: [
        {
          topic,
          numPartitions: config.kafka.partitions,
          replicationFactor: 1,
          // 30일 보관: 히스토리 싱크가 죽어 있던 기간을 Kafka 재생으로 복구할 수 있는 보험
          configEntries: [{ name: 'retention.ms', value: String(30 * 24 * 60 * 60 * 1000) }],
        },
      ],
    });
    console.log(`토픽 생성 완료: ${topic} (파티션 ${config.kafka.partitions}개)`);
  }
  await admin.disconnect();
}

async function showLag(): Promise<void> {
  const admin = createKafka('mktlab-admin').admin();
  await admin.connect();

  const high = await admin.fetchTopicOffsets(config.kafka.topic);
  for (const groupId of Object.values(config.kafka.groups)) {
    const committed = await admin.fetchOffsets({ groupId, topics: [config.kafka.topic] });
    const parts = committed[0]?.partitions ?? [];
    console.log(`\n[${groupId}]`);
    for (const p of parts) {
      const end = high.find((h) => h.partition === p.partition);
      const lag = Number(end?.offset ?? 0) - Number(p.offset === '-1' ? 0 : p.offset);
      console.log(`  partition ${p.partition}  committed=${p.offset}  end=${end?.offset}  lag=${lag}`);
    }
  }
  await admin.disconnect();
}

async function clearRedis(): Promise<void> {
  const redis = createRedis('admin');

  // 학습용이라 SCAN 으로 mkt:* 를 전부 지웁니다. 운영에서 KEYS/SCAN 전체 삭제는 금물.
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'mkt:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== '0');

  console.log(`Redis 정리 완료: mkt:* 키 ${deleted}개 삭제`);
  redis.disconnect();
}

async function replay(): Promise<void> {
  console.log('▶ 재처리(replay) 시작');
  console.log('  주의: quote 워커를 먼저 종료해야 합니다 (컨슈머 그룹이 활성 상태면 오프셋 변경 불가)\n');

  await clearRedis();

  const admin = createKafka('mktlab-admin').admin();
  await admin.connect();
  await admin.resetOffsets({
    groupId: config.kafka.groups.quote,
    topic: config.kafka.topic,
    earliest: true,
  });
  await admin.disconnect();

  console.log(`\n오프셋을 earliest 로 되돌렸습니다: ${config.kafka.groups.quote}`);
  console.log('이제 `npm run quote` 를 다시 실행하면 지난 틱 전체로 캔들을 처음부터 재생성합니다.');
  console.log('→ REST 폴링 데이터를 Kafka 에 넣어두었기 때문에 가능한 일입니다.');
}

async function main(): Promise<void> {
  switch (command) {
    case 'create-topic':
      await createTopic();
      break;
    case 'lag':
      await showLag();
      break;
    case 'reset':
      await clearRedis();
      break;
    case 'replay':
      await replay();
      break;
    default:
      console.log(`사용법:
  npm run setup    # 토픽 생성
  npm run lag      # 컨슈머 그룹별 오프셋/랙 확인
  npm run reset    # Redis 시세 데이터 초기화
  npm run replay   # Redis 초기화 + quote 오프셋을 earliest 로 리셋`);
  }
  process.exit(0);
}

void main();
