/**
 * Redis 키 네이밍을 한곳에 모읍니다.
 * 실무에서 Redis 사고의 절반은 "키 규칙이 코드 여기저기 흩어져서" 생깁니다.
 */
export const K = {
  /** HASH: 종목별 최신 시세 스냅샷 */
  quote: (symbol: string) => `mkt:quote:${symbol}`,
  /** SET: 시세가 들어온 종목 목록 (SCAN 을 피하기 위한 인덱스) */
  symbolIndex: 'mkt:symbols',
  /** ZSET: 등락률 랭킹. score = changeRate */
  rank: 'mkt:rank:changeRate',
  /** HASH: 종목별 1분봉. field = HHmm, value = JSON {o,h,l,c,n} */
  candle: (symbol: string, date: string) => `mkt:candle:${symbol}:${date}`,

  /** STRING(TTL): 급변 감시 윈도우 시작가. SET NX 로 윈도우당 1회 고정 */
  spikeBase: (symbol: string) => `mkt:spike:${symbol}`,
  /** STRING(TTL): 알림 쿨다운 마커. SET NX 성공 = 이번이 첫 알림 */
  alertMark: (symbol: string, rule: string) => `mkt:alertmark:${symbol}:${rule}`,

  /** Pub/Sub 채널: 실시간 알림 (놓쳐도 되는 것) */
  alertChannel: 'mkt:alerts',
  /** LIST: 최근 알림 보관 (Pub/Sub 은 유실되므로 새로고침 대비용) */
  alertRecent: 'mkt:alerts:recent',

  /** STRING(TTL): 포트폴리오 캐시. 계좌 API 를 매 요청마다 때리지 않기 위한 완충 */
  portfolioCache: 'mkt:portfolio:cache',

  /** STRING: USD→KRW 환율 (매매기준율). strategy 워커가 주기적으로 갱신 */
  fxUsdKrw: 'mkt:fx:usdkrw',

  /** HASH: 종목별 일봉 지표 (as-of 오늘). strategy 워커가 30분마다 게시, 대시보드가 표시 */
  indicators: (symbol: string) => `mkt:indicators:${symbol}`,
  /** STRING(JSON): 종목별 일봉 원본 (차트 일 모드용). strategy 워커가 30분마다 게시 */
  dailyCandles: (symbol: string) => `mkt:dailycandles:${symbol}`,

  /** HASH: 전략별 페이퍼 계좌 (cash, initialCash, startedAt) */
  paperAccount: (strategy: string) => `mkt:paper:${strategy}:account`,
  /** HASH: 전략별 페이퍼 포지션 */
  paperPos: (strategy: string, symbol: string) => `mkt:paper:${strategy}:pos:${symbol}`,
  /** SET: 전략별 보유 포지션 인덱스 */
  paperPosIndex: (strategy: string) => `mkt:paper:${strategy}:pos:index`,
  /** LIST: 전략별 체결/거부 기록 (최근 500건) */
  paperTrades: (strategy: string) => `mkt:paper:${strategy}:trades`,
  /** STRING(TTL): 전략×종목 재진입 쿨다운 */
  paperCooldown: (strategy: string, symbol: string) => `mkt:paper:${strategy}:cooldown:${symbol}`,
  /** STRING(TTL): 당일 시작 자산 (킬 스위치 기준값) */
  paperDayStart: (strategy: string, date: string) => `mkt:paper:${strategy}:daystart:${date}`,
  /** STRING(TTL): 킬 스위치 발동 마커. 존재하면 당일 신규 진입 금지 */
  paperKill: (strategy: string, date: string) => `mkt:paper:${strategy}:kill:${date}`,
  /** STRING(TTL): 워커 하트비트 (프로세스 생존) */
  heartbeat: (name: string) => `mkt:heartbeat:${name}`,
  /** STRING(TTL): 컨슈머 진행률 — 마지막 메시지 처리 시각. 생존과 별개로 "일하고 있는가" */
  progress: (name: string) => `mkt:progress:${name}`,
  /** STRING(TTL): 주문 발행 후 체결 반영 전 중복 주문 방지 */
  paperPending: (strategy: string, symbol: string) => `mkt:paper:${strategy}:pending:${symbol}`,

  /** STRING(TTL): 처리 완료 eventId (멱등 처리용) */
  processed: (group: string, eventId: string) => `mkt:processed:${group}:${eventId}`,
} as const;

export const ALERT_LIST_MAX = 200;
/** 멱등 키 보관 시간 (초). 재처리 실습 시에는 admin reset 으로 지웁니다. */
export const PROCESSED_TTL_SEC = 60 * 60 * 6;
