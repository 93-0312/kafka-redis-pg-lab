import { readPaper } from '../api/paper.js';
import { createPool } from '../lib/pg.js';
import { createRedis } from '../lib/redis.js';
import { sendSlackMessage } from '../lib/slack.js';
import type { PaperTradeRecord } from '../types.js';

/**
 * 아침 브리핑 (작업 스케줄러가 매일 07:30 실행)
 *  1) 전략별 자산을 paper_equity_daily 에 스냅샷 (일별 자산 곡선 축적)
 *  2) 밤새 성적 요약을 슬랙으로 발송
 *
 * API 서버 없이 Redis/Postgres 에 직접 붙으므로 백엔드 프로세스와 독립적으로 돌아갑니다.
 */

const SNAPSHOT_SQL = `
CREATE TABLE IF NOT EXISTS paper_equity_daily (
  snapshot_date   date NOT NULL,
  strategy_id     text NOT NULL,
  equity          numeric NOT NULL,
  cash            numeric NOT NULL,
  positions_value numeric NOT NULL,
  total_rate      numeric NOT NULL,
  realized_pnl    numeric NOT NULL,
  trade_count     int NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, strategy_id)
);
`;

const pct = (r: number): string => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(2)}%`;
const krw = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;
const signKrw = (n: number): string => `${n >= 0 ? '+' : '-'}${krw(Math.abs(n))}`;
const medal = (i: number): string => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}위`;

async function main(): Promise<void> {
  const redis = createRedis('daily-report');
  const pool = createPool();
  await pool.query(SNAPSHOT_SQL);

  const paper = await readPaper(redis);
  if (paper.strategies.length === 0) {
    console.log('페이퍼 계좌가 없습니다 — 발송 생략');
    redis.disconnect();
    await pool.end();
    return;
  }

  // 스냅샷 날짜는 KST 기준 발송일. Postgres 는 UTC 라서 CURRENT_DATE 를 쓰면
  // 07:30 KST 실행 시 전날(UTC 22:30)로 찍히는 시간대 버그가 있습니다.
  const now = new Date();
  const todayKst = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // 1) 오늘 날짜로 스냅샷 upsert
  for (const s of paper.strategies) {
    await pool.query(
      `INSERT INTO paper_equity_daily
         (snapshot_date, strategy_id, equity, cash, positions_value, total_rate, realized_pnl, trade_count)
       VALUES ($8, $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (snapshot_date, strategy_id) DO UPDATE SET
         equity = EXCLUDED.equity, cash = EXCLUDED.cash,
         positions_value = EXCLUDED.positions_value, total_rate = EXCLUDED.total_rate,
         realized_pnl = EXCLUDED.realized_pnl, trade_count = EXCLUDED.trade_count,
         created_at = now()`,
      [
        s.strategyId, s.totals.equity, s.totals.cash, s.totals.positionsValue,
        s.totals.totalRate, s.totals.realizedPnl, s.totals.tradeCount, todayKst,
      ],
    );
  }

  // 2) 직전 스냅샷(가장 최근 과거 날짜) 대비 변화
  const prev = await pool.query(
    `SELECT strategy_id, equity FROM paper_equity_daily
     WHERE snapshot_date = (
       SELECT max(snapshot_date) FROM paper_equity_daily WHERE snapshot_date < $1
     )`,
    [todayKst],
  );
  const prevEquity = new Map<string, number>(
    prev.rows.map((r) => [r.strategy_id as string, Number(r.equity)]),
  );

  // 3) 최근 24시간 체결 요약
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const lines: string[] = [];
  let totalFills24h = 0;

  for (const [i, s] of paper.strategies.entries()) {
    const trades24h = (
      await redis.lrange(`mkt:paper:${s.strategyId}:trades`, 0, -1)
    )
      .map((r) => JSON.parse(r) as PaperTradeRecord)
      .filter((t) => t.status === 'FILLED' && Date.parse(t.filledAt) >= cutoff);
    const realized24h = trades24h.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
    totalFills24h += trades24h.length;

    const prevEq = prevEquity.get(s.strategyId);
    const delta = prevEq !== undefined ? ` (전일 대비 ${signKrw(s.totals.equity - prevEq)})` : '';

    lines.push(
      `${medal(i)} *${s.label}* ${pct(s.totals.totalRate)} · ${krw(s.totals.equity)}${delta}\n` +
        `    포지션 ${s.positions.length}개 · 24h 체결 ${trades24h.length}건 (실현 ${signKrw(realized24h)})`,
    );
  }

  // 워커 생존 점검: 죽어 있는 프로세스가 있으면 브리핑 맨 위에 경고를 띄웁니다.
  const { checkHeartbeats } = await import('../lib/heartbeat.js');
  const workers = await checkHeartbeats(redis);
  const healthLine = workers.dead.length > 0
    ? `🚨 *워커 다운: ${workers.dead.join(', ')}* — 파이프라인 점검 필요\n`
    : '';

  const today = new Date();
  const title = `📊 페이퍼 트레이딩 아침 브리핑 — ${today.getMonth() + 1}/${today.getDate()} 07:30`;
  const body = healthLine + lines.join('\n');
  const footer = `24h 총 체결 ${totalFills24h}건 · 전략별 시작 자금 1억 · ⚠️ 학습용 시뮬레이션 (실주문 없음)`;

  const ok = await sendSlackMessage(`${title}\n${body}`, [
    { type: 'header', text: { type: 'plain_text', text: title } },
    { type: 'section', text: { type: 'mrkdwn', text: body } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] },
  ]);

  console.log(ok ? '브리핑 발송 완료' : '브리핑 발송 실패 (스냅샷은 기록됨)');
  redis.disconnect();
  await pool.end();
  process.exit(ok ? 0 : 1);
}

void main();
