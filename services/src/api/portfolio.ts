import type Redis from 'ioredis';
import { K } from '../lib/keys.js';
import {
  fetchAccounts,
  fetchExchangeRate,
  fetchHoldings,
  type TossHoldingsItem,
} from '../lib/toss.js';
import type { Market } from '../types.js';

/**
 * 포트폴리오 조회.
 * 시세와 달리 계좌 데이터는 초 단위로 변하지 않으므로 Kafka 를 거치지 않고
 * REST + Redis 캐시(30초)로 처리합니다. "모든 것을 스트림으로 만들 필요는 없다"는
 * 것도 이 랩의 학습 포인트입니다.
 */

const CACHE_TTL_SEC = 30;

export interface PortfolioItem {
  symbol: string;
  name: string;
  market: Market;
  currency: 'KRW' | 'USD';
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  /** 거래 통화 기준 평가금액 */
  marketValue: number;
  /** 원화 환산 평가금액 */
  marketValueKrw: number;
  profitAmount: number;
  profitRate: number;
  dailyAmount: number;
  dailyRate: number;
  /** 원화 환산 기준 비중 (0~1) */
  weight: number;
}

export interface PortfolioSummary {
  accountNo: string;
  usdKrw: number;
  totals: {
    /** 원화 환산 투자원금 */
    purchaseKrw: number;
    /** 원화 환산 평가금액 */
    marketKrw: number;
    /** 원화 환산 손익 */
    profitKrw: number;
    /** 손익률 (토스 계산값, 환율 반영) */
    profitRate: number;
    dailyProfitKrw: number;
    dailyRate: number;
  };
  items: PortfolioItem[];
  generatedAt: string;
  /** true 면 Redis 캐시에서 온 응답 */
  cached: boolean;
}

const n = (v: string | null | undefined): number => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** 통화별 합산 {krw, usd} 를 원화로 환산 */
const toKrw = (price: { krw: string; usd?: string | null }, usdKrw: number): number =>
  n(price.krw) + n(price.usd) * usdKrw;

function toItem(raw: TossHoldingsItem, usdKrw: number): Omit<PortfolioItem, 'weight'> {
  const marketValue = n(raw.marketValue.amount);
  return {
    symbol: raw.symbol,
    name: raw.name,
    market: raw.marketCountry,
    currency: raw.currency,
    quantity: n(raw.quantity),
    avgPrice: n(raw.averagePurchasePrice),
    lastPrice: n(raw.lastPrice),
    marketValue,
    marketValueKrw: raw.currency === 'USD' ? marketValue * usdKrw : marketValue,
    profitAmount: n(raw.profitLoss.amount),
    profitRate: n(raw.profitLoss.rate),
    dailyAmount: n(raw.dailyProfitLoss.amount),
    dailyRate: n(raw.dailyProfitLoss.rate),
  };
}

export async function readPortfolio(redis: Redis): Promise<PortfolioSummary> {
  const hit = await redis.get(K.portfolioCache);
  if (hit) {
    return { ...(JSON.parse(hit) as PortfolioSummary), cached: true };
  }

  const accounts = await fetchAccounts();
  const account = accounts.find((a) => a.accountType === 'BROKERAGE') ?? accounts[0];
  if (!account) {
    throw new Error('토스증권 계좌가 없습니다.');
  }

  const [holdings, fx] = await Promise.all([
    fetchHoldings(account.accountSeq),
    fetchExchangeRate(),
  ]);
  const usdKrw = n(fx.midRate) || n(fx.rate);

  const marketKrw = toKrw(holdings.marketValue.amount, usdKrw);
  const bare = holdings.items.map((i) => toItem(i, usdKrw));

  const summary: PortfolioSummary = {
    accountNo: account.accountNo,
    usdKrw,
    totals: {
      purchaseKrw: toKrw(holdings.totalPurchaseAmount, usdKrw),
      marketKrw,
      profitKrw: toKrw(holdings.profitLoss.amount, usdKrw),
      profitRate: n(holdings.profitLoss.rate),
      dailyProfitKrw: toKrw(holdings.dailyProfitLoss.amount, usdKrw),
      dailyRate: n(holdings.dailyProfitLoss.rate),
    },
    items: bare
      .map((i) => ({ ...i, weight: marketKrw > 0 ? i.marketValueKrw / marketKrw : 0 }))
      .sort((a, b) => b.marketValueKrw - a.marketValueKrw),
    generatedAt: new Date().toISOString(),
    cached: false,
  };

  await redis.set(K.portfolioCache, JSON.stringify(summary), 'EX', CACHE_TTL_SEC);
  return summary;
}
