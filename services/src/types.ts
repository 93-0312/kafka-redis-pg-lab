export type Market = 'KR' | 'US';
export type Currency = 'KRW' | 'USD';

/**
 * Kafka 토픽에 흐르는 시세 틱.
 * 토스 Open API 는 REST 폴링만 제공하므로, producer 가 폴링 결과를
 * 틱 이벤트로 변환해 스트림으로 만들어 줍니다. (폴링 → 스트림화)
 */
export interface TickEvent {
  /** 이벤트 고유 ID. 멱등 처리(중복 소비 방지)의 기준이 됩니다. */
  eventId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  /** 현재가. USD 는 소수점이 있으므로 number 로 통일합니다. */
  price: number;
  /** 전일 종가. 등락률 계산의 기준. 장 시작 전 등으로 없으면 null */
  prevClose: number | null;
  /** 토스가 알려준 데이터 시각 (체결 미발생 시 null) */
  tradedAt: string | null;
  /** producer 가 폴링한 시각 (ISO8601). 캔들 버킷의 기준 */
  polledAt: string;
}

/** Redis Hash 에 저장되는 종목별 최신 시세 스냅샷 */
export interface QuoteSnapshot {
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  price: number;
  prevClose: number;
  /** price - prevClose */
  change: number;
  /** (price - prevClose) / prevClose. 예: 0.0123 = +1.23% */
  changeRate: number;
  tradedAt: string;
  updatedAt: string;
}

/** 1분봉. Redis Hash field(HHmm) 에 JSON 으로 저장됩니다. */
export interface MinuteCandle {
  o: number;
  h: number;
  l: number;
  c: number;
  /** 롤업에 반영된 틱 수 (거래량 대용. REST 폴링이라 실제 체결량은 아님) */
  n: number;
}

// ── 페이퍼 트레이딩 ─────────────────────────────────────

export type OrderSide = 'BUY' | 'SELL';

/** 전략 워커가 발행하는 가상 주문. paper.orders 토픽에 흐릅니다. */
export interface PaperOrderEvent {
  eventId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  side: OrderSide;
  quantity: number;
  /** 주문 시점 가격 (거래 통화 기준). 시뮬레이터는 이 가격에 전량 체결된 것으로 간주합니다. */
  price: number;
  /**
   * 주문 시점 환율 스냅샷 (KRW / 거래통화 1단위. KRW 거래면 1).
   * 계좌 현금이 원화이므로, 체결 금액을 이 환율로 환산해 차감/입금합니다.
   * 주문에 박아두면 재처리 시에도 같은 금액으로 체결됩니다 (멱등성).
   */
  fxRate: number;
  strategy: string;
  /** 전략이 왜 이 주문을 냈는지 (감사 로그) */
  reason: string;
  orderedAt: string;
}

/** Redis Hash 에 저장되는 가상 포지션 */
export interface PaperPosition {
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  quantity: number;
  avgPrice: number;
  openedAt: string;
}

/** 체결(또는 거부) 기록. Redis List 에 쌓입니다. */
export interface PaperTradeRecord {
  tradeId: string;
  symbol: string;
  name: string;
  side: OrderSide;
  quantity: number;
  /** 거래 통화 기준 가격 */
  price: number;
  /** 구버전 기록에는 없을 수 있음 (KRW 로 간주) */
  currency?: Currency;
  /** 거래 통화 기준 금액 (비용 제외) */
  amount: number;
  /** 원화 환산 계좌 현금 증감액 (매수: 지출 = 대금+비용, 매도: 입금 = 대금-비용) */
  amountKrw: number;
  /** 이 체결에서 지불한 거래비용 (원화). 구버전 기록에는 없음 */
  costKrw?: number;
  /** SELL 일 때만: 실현 손익 (원화) */
  realizedPnl?: number;
  strategy: string;
  reason: string;
  status: 'FILLED' | 'REJECTED';
  /** REJECTED 사유 */
  rejectReason?: string;
  filledAt: string;
}

export type AlertType = 'SURGE' | 'PLUNGE' | 'SPIKE' | 'REBOUND' | 'PULLBACK';
export type AlertSeverity = 'INFO' | 'WARN' | 'CRITICAL';

export interface PriceAlert {
  alertId: string;
  type: AlertType;
  severity: AlertSeverity;
  symbol: string;
  name: string;
  market: Market;
  price: number;
  currency: Currency;
  /** 알림 시점 등락률 */
  changeRate: number;
  message: string;
  detectedAt: string;
}
