import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// .env 는 프로젝트 루트에 있고, 서비스는 services/ 에서 실행됩니다.
// dotenv 는 이미 설정된 변수를 덮어쓰지 않으므로 둘 다 읽어도 안전합니다.
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '../.env') });

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v.trim() === '') return fallback; // Number('') 은 0 이라 빈 값을 걸러야 합니다
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  kafka: {
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((s) => s.trim()),
    topic: process.env.KAFKA_TOPIC ?? 'market.ticks',
    /** 전략 워커가 발행하는 가상 주문 토픽 */
    paperTopic: process.env.KAFKA_TOPIC_PAPER ?? 'paper.orders',
    partitions: num(process.env.KAFKA_TOPIC_PARTITIONS, 3),
    groups: {
      quote: 'quote-worker',
      alert: 'alert-worker',
      strategy: 'strategy-worker',
      paperExec: 'paper-exec-worker',
      history: 'history-worker',
    },
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  postgres: {
    url: process.env.POSTGRES_URL ?? 'postgres://mktlab:mktlab@localhost:5432/mktlab',
  },
  api: {
    port: num(process.env.API_PORT, 4000),
  },
  toss: {
    baseUrl: process.env.TOSS_BASE_URL ?? 'https://openapi.tossinvest.com',
    clientId: process.env.TOSS_CLIENT_ID ?? '',
    clientSecret: process.env.TOSS_CLIENT_SECRET ?? '',
    /** 폴링할 종목. KRX 는 6자리 숫자, 미국은 티커. */
    symbols: (process.env.TOSS_SYMBOLS ?? '005930,000660,035420,035720,005380,AAPL,NVDA,TSLA,MSFT,AMZN')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** 현재가 폴링 주기(ms). /api/v1/prices 는 한 번에 200종목까지 배치 조회 가능. */
    pollMs: num(process.env.TOSS_POLL_MS, 3000),
    /** 종목명·전일종가 갱신 주기(분) */
    metaRefreshMin: num(process.env.TOSS_META_REFRESH_MIN, 30),
  },
  producer: {
    /**
     * 'symbol' -> 파티션 키를 symbol 로 사용 (같은 종목 = 같은 파티션 = 순서 보장)
     * 'random' -> 키 없이 라운드로빈 (순서 보장 깨짐. 캔들 롤업이 틀어지는 실습용 스위치)
     */
    partitionKey: (process.env.PRODUCER_PARTITION_KEY ?? 'symbol') as 'symbol' | 'random',
  },
  slack: {
    /** 슬랙 Incoming Webhook URL. 비어 있으면 슬랙 발송을 건너뜁니다. */
    webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
    /** 슬랙으로 보낼 시장. 'KR' | 'US' | 'KR,US' */
    markets: (process.env.SLACK_ALERT_MARKETS ?? 'KR')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is 'KR' | 'US' => s === 'KR' || s === 'US'),
    /** 이 심각도 이상만 슬랙 발송. 대시보드에는 전부 표시됩니다. */
    minSeverity: (process.env.SLACK_MIN_SEVERITY ?? 'WARN') as 'INFO' | 'WARN' | 'CRITICAL',
    /** 페이퍼 체결(매수/매도)도 슬랙으로 발송할지 */
    paperTrades: (process.env.SLACK_PAPER_TRADES ?? 'true') !== 'false',
    /** 페이퍼 매매 전용 채널 웹훅. 비어 있으면 기본 웹훅(webhookUrl)으로 발송 */
    paperWebhookUrl: process.env.SLACK_PAPER_WEBHOOK_URL ?? '',
  },
  paper: {
    /**
     * 전략별 초기 가상 현금(원). 5개 전략이 각자 이 금액으로 시작합니다.
     * ★ 이 랩은 실주문을 내지 않습니다. 모든 체결은 시뮬레이션입니다 ★
     */
    initialCash: num(process.env.PAPER_INITIAL_CASH, 100_000_000),
    /** 매매 대상 시장 */
    markets: (process.env.PAPER_MARKETS ?? 'KR')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is 'KR' | 'US' => s === 'KR' || s === 'US'),
    /** 진입당 현금 비중(%) */
    positionPct: num(process.env.PAPER_POSITION_PCT, 10),
    /** 전략당 동시 보유 종목 수 한도 */
    maxPositions: num(process.env.PAPER_MAX_POSITIONS, 5),
    /** 같은 전략×종목 재진입 금지 시간(초) */
    cooldownSec: num(process.env.PAPER_COOLDOWN_SEC, 600),
    /** 이보다 오래된 체결 시각의 틱은 무시 (장 마감 후 정지 시세로 매매 방지) */
    staleTickSec: num(process.env.PAPER_STALE_TICK_SEC, 600),
    /** 시간 청산: 이 시간(분) 넘게 보유하면 강제 청산. 익절/손절에 안 닿는 좀비 포지션 방지 */
    maxHoldMin: num(process.env.PAPER_MAX_HOLD_MIN, 360),
    /** 일일 킬 스위치: 당일 시작 자산 대비 이 % 손실이면 당일 신규 진입 중단 (청산은 허용) */
    dailyMaxLossPct: num(process.env.PAPER_DAILY_MAX_LOSS_PCT, 2),
    /** 거래비용 (편도 %). 백테스트 기본값과 동일하게 유지해야 페이퍼 성적을 믿을 수 있습니다 */
    costs: {
      feePct: num(process.env.PAPER_FEE_PCT, 0.015),
      krSellTaxPct: num(process.env.PAPER_KR_SELL_TAX_PCT, 0.15),
      slippagePct: num(process.env.PAPER_SLIPPAGE_PCT, 0.05),
    },
  },
  alerts: {
    /** 등락률 계단 간격(%). 1이면 ±1%, ±2%, ±3% ... 도달 시마다 알림 */
    changeRateStep: num(process.env.ALERT_CHANGE_STEP, 1),
    /** 급변 감시 윈도우(초) */
    spikeWindowSec: num(process.env.ALERT_SPIKE_WINDOW_SEC, 60),
    /** 윈도우 내 이 %p 이상 움직이면 급변 알림 */
    spikeRate: num(process.env.ALERT_SPIKE_RATE, 0.5),
    /** 같은 종목·같은 규칙 알림 재발송 금지 시간(초) */
    cooldownSec: num(process.env.ALERT_COOLDOWN_SEC, 300),
    /** 이보다 오래된 체결 시각의 틱은 알림 평가 제외 (장 마감 후 종가 반복 알림 방지) */
    staleTickSec: num(process.env.ALERT_STALE_TICK_SEC, 600),
    /** 반등/되돌림 알림 기준: 당일 극값 대비 이 %p 이상 움직이면 발송 */
    reboundPct: num(process.env.ALERT_REBOUND_PCT, 1),
  },
} as const;
