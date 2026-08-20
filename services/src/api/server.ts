import cors from 'cors';
import express from 'express';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { checkHeartbeats, checkProgress, startHeartbeat } from '../lib/heartbeat.js';
import { K } from '../lib/keys.js';
import { createRedis } from '../lib/redis.js';
import { createPool } from '../lib/pg.js';
import { readPaper, readPaperDaily } from './paper.js';
import { readPortfolio } from './portfolio.js';
import { readSummary } from './summary.js';

const app = express();
app.use(cors());

/** 명령용 커넥션 */
const redis = createRedis('api');
/** 구독용 커넥션 — SUBSCRIBE 상태에서는 일반 명령을 쓸 수 없으므로 반드시 분리합니다. */
const sub = createRedis('api-sub');
/** 일별 손익 스냅샷 조회용 Postgres 풀 */
const pool = createPool();

/** 접속 중인 SSE 클라이언트 목록 */
const clients = new Set<Response>();

await sub.subscribe(K.alertChannel);
sub.on('message', (_channel, payload) => {
  broadcast('alert', payload);
});

function broadcast(event: string, data: string): void {
  const frame = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of clients) {
    res.write(frame);
  }
}

startHeartbeat(redis, 'api');

app.get('/api/health', async (_req: Request, res: Response) => {
  const workers = await checkHeartbeats(redis);
  // 진행률: 하트비트(생존)와 별개로 "실제로 소비 중인가". producer 가 3초마다
  // 발행하므로 틱 컨슈머가 180초 이상 조용하면 스톨로 판정합니다.
  const progress = await checkProgress(redis);
  const stalled = Object.entries(progress)
    .filter(([, age]) => age === null || age > 180)
    .map(([name]) => name);
  res.json({
    ok: workers.dead.length === 0 && stalled.length === 0,
    redis: redis.status,
    clients: clients.size,
    workers,
    /** 컨슈머별 마지막 메시지 처리 후 경과(초) */
    progressAgeSec: progress,
    stalled,
  });
});

app.get('/api/summary', async (req: Request, res: Response) => {
  const focus = typeof req.query['focus'] === 'string' ? req.query['focus'] : undefined;
  const interval = typeof req.query['interval'] === 'string' ? req.query['interval'] : undefined;
  res.json(await readSummary(redis, focus, interval));
});

app.get('/api/portfolio', async (_req: Request, res: Response) => {
  try {
    res.json(await readPortfolio(redis));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get('/api/paper', async (_req: Request, res: Response) => {
  const summary = await readPaper(redis);
  if (summary.strategies.length === 0) {
    res.status(404).json({ error: 'paper-exec 워커가 아직 계좌를 초기화하지 않았습니다.' });
    return;
  }
  res.json(summary);
});

app.get('/api/paper/daily', async (_req: Request, res: Response) => {
  try {
    res.json(await readPaperDaily(redis, pool));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/alerts', async (_req: Request, res: Response) => {
  const raw = await redis.lrange(K.alertRecent, 0, 49);
  res.json(raw.map((r) => JSON.parse(r)));
});

/**
 * ★ 브라우저는 Kafka 에 직접 붙을 수 없습니다 ★
 * 그래서 이 서버가 Kafka(→Redis) 와 브라우저 사이의 중계자가 됩니다.
 * SSE 는 서버→클라이언트 단방향이라 대시보드 용도에 딱 맞고, WebSocket 보다 훨씬 간단합니다.
 */
app.get('/api/stream', async (req: Request, res: Response) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  clients.add(res);

  const focus = typeof req.query['focus'] === 'string' ? req.query['focus'] : undefined;
  const interval = typeof req.query['interval'] === 'string' ? req.query['interval'] : undefined;

  const pushSnapshot = async () => {
    try {
      const summary = await readSummary(redis, focus, interval);
      res.write(`event: snapshot\ndata: ${JSON.stringify(summary)}\n\n`);
    } catch (err) {
      console.error('[api] snapshot 실패', err);
    }
  };

  await pushSnapshot();
  const timer = setInterval(() => void pushSnapshot(), 2000);
  // 프록시가 유휴 커넥션을 끊지 않도록 주기적으로 주석 프레임을 보냅니다.
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(timer);
    clearInterval(ping);
    clients.delete(res);
    res.end();
  });
});

/**
 * watch 모드 재시작 시 이전 프로세스가 포트를 놓기 전에 새 프로세스가 뜨는
 * 짧은 경합이 있습니다 (Windows 에서 특히). EADDRINUSE 면 잠시 후 재시도합니다.
 */
function listen(retries = 10): void {
  const server = app.listen(config.api.port, () => {
    console.log(`[api] http://localhost:${config.api.port}`);
    console.log(`[api] SSE  http://localhost:${config.api.port}/api/stream`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.warn(`[api] 포트 ${config.api.port} 사용 중 — 1초 후 재시도 (남은 ${retries}회)`);
      setTimeout(() => listen(retries - 1), 1000);
    } else {
      throw err;
    }
  });
}
listen();
