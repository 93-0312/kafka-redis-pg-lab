export type Market = 'KR' | 'US';
export type Currency = 'KRW' | 'USD';

export interface QuoteRow {
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  price: number;
  prevClose: number;
  change: number;
  changeRate: number;
  tradedAt: string;
  updatedAt: string;
}

export interface MinuteCandle {
  o: number;
  h: number;
  l: number;
  c: number;
  n: number;
}

export interface DashboardSummary {
  quotes: QuoteRow[];
  totals: {
    symbols: number;
    up: number;
    down: number;
    flat: number;
  };
  focus: string | null;
  candles: ({ t: string } & MinuteCandle)[];
  generatedAt: string;
}

export interface PortfolioItem {
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  marketValue: number;
  marketValueKrw: number;
  profitAmount: number;
  profitRate: number;
  dailyAmount: number;
  dailyRate: number;
  weight: number;
}

export interface PortfolioSummary {
  accountNo: string;
  usdKrw: number;
  totals: {
    purchaseKrw: number;
    marketKrw: number;
    profitKrw: number;
    profitRate: number;
    dailyProfitKrw: number;
    dailyRate: number;
  };
  items: PortfolioItem[];
  generatedAt: string;
  cached: boolean;
}

export interface PaperPositionView {
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  marketValue: number;
  marketValueKrw: number;
  unrealizedPnl: number;
  unrealizedRate: number;
  openedAt: string;
}

export interface PaperTradeRecord {
  tradeId: string;
  symbol: string;
  name: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  /** 구버전 기록에는 없음 (KRW 간주) */
  currency?: Currency;
  amount: number;
  amountKrw?: number;
  realizedPnl?: number;
  strategy: string;
  reason: string;
  status: 'FILLED' | 'REJECTED';
  rejectReason?: string;
  filledAt: string;
}

export interface PaperStrategySummary {
  strategyId: string;
  label: string;
  description: string;
  startedAt: string;
  totals: {
    initialCash: number;
    cash: number;
    positionsValue: number;
    equity: number;
    totalPnl: number;
    totalRate: number;
    realizedPnl: number;
    tradeCount: number;
  };
  positions: PaperPositionView[];
  trades: PaperTradeRecord[];
}

export interface PaperSummary {
  strategyNote: string;
  strategies: PaperStrategySummary[];
  generatedAt: string;
}

export interface PriceAlert {
  alertId: string;
  type: 'SURGE' | 'PLUNGE' | 'SPIKE';
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  symbol: string;
  name: string;
  /** 구버전 알림에는 없을 수 있음 (심볼로 추정) */
  market?: Market;
  price: number;
  currency: Currency;
  changeRate: number;
  message: string;
  detectedAt: string;
}
