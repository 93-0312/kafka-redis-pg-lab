import { config } from '../config.js';

/**
 * 토스증권 Open API 클라이언트.
 *  - OAuth2 Client Credentials 토큰을 메모리에 캐싱하고 만료 60초 전에 자동 갱신합니다.
 *  - 429(rate limit) 응답 시 Retry-After 헤더만큼 기다렸다가 1회 재시도합니다.
 *  - client_secret 은 이 프로세스 밖으로 절대 내보내지 않습니다 (이벤트에도 싣지 않음).
 */

interface TokenState {
  value: string;
  /** epoch ms */
  expiresAt: number;
}

interface ApiEnvelope<T> {
  result: T;
}

export interface TossPrice {
  symbol: string;
  timestamp: string | null;
  lastPrice: string;
  currency: 'KRW' | 'USD';
}

export interface TossStock {
  symbol: string;
  name: string;
  englishName?: string;
  market?: string;
  currency?: 'KRW' | 'USD';
}

export interface TossCandle {
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
  currency: 'KRW' | 'USD';
}

let token: TokenState | null = null;

async function fetchToken(): Promise<TokenState> {
  const { baseUrl, clientId, clientSecret } = config.toss;
  if (!clientId || !clientSecret) {
    throw new Error('TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 .env 에 없습니다.');
  }

  const res = await fetch(`${baseUrl}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`토큰 발급 실패 (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  return {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
}

async function getToken(force = false): Promise<string> {
  if (force || !token || Date.now() >= token.expiresAt) {
    token = await fetchToken();
  }
  return token.value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tossGet<T>(
  path: string,
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, config.toss.baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt += 1) {
    const bearer = await getToken(attempt > 0);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}`, ...headers } });

    if (res.status === 401 && attempt === 0) continue; // 토큰 만료/폐기 -> 강제 재발급 후 1회 재시도

    if (res.status === 429 && attempt === 0) {
      const wait = Number(res.headers.get('Retry-After') ?? 1);
      console.warn(`[toss] rate limit — ${wait}초 대기 후 재시도`);
      await sleep(Math.max(1, wait) * 1000);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${path} 실패 (${res.status}): ${body.slice(0, 300)}`);
    }

    return ((await res.json()) as ApiEnvelope<T>).result;
  }
}

/** 현재가 배치 조회. 한 번의 호출로 최대 200종목. */
export function fetchPrices(symbols: string[]): Promise<TossPrice[]> {
  return tossGet<TossPrice[]>('/api/v1/prices', { symbols: symbols.join(',') });
}

/** 종목 기본 정보 (종목명 등) */
export function fetchStocks(symbols: string[]): Promise<TossStock[]> {
  return tossGet<TossStock[]>('/api/v1/stocks', { symbols: symbols.join(',') });
}

// ── 계좌·자산 (X-Tossinvest-Account 헤더 필요) ──────────────

interface TossPriceByCurrency {
  krw: string;
  usd?: string | null;
}

export interface TossAccount {
  accountNo: string;
  accountSeq: number;
  accountType: string;
}

export interface TossHoldingsItem {
  symbol: string;
  name: string;
  marketCountry: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  quantity: string;
  lastPrice: string;
  averagePurchasePrice: string;
  marketValue: { purchaseAmount: string; amount: string; amountAfterCost: string };
  profitLoss: { amount: string; amountAfterCost: string; rate: string; rateAfterCost: string };
  dailyProfitLoss: { amount: string; rate: string };
}

export interface TossHoldingsOverview {
  totalPurchaseAmount: TossPriceByCurrency;
  marketValue: { amount: TossPriceByCurrency; amountAfterCost: TossPriceByCurrency };
  profitLoss: {
    amount: TossPriceByCurrency;
    amountAfterCost: TossPriceByCurrency;
    rate: string;
    rateAfterCost: string;
  };
  dailyProfitLoss: { amount: TossPriceByCurrency; rate: string };
  items: TossHoldingsItem[];
}

export interface TossExchangeRate {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  midRate: string;
}

/** 계좌 목록 조회 */
export function fetchAccounts(): Promise<TossAccount[]> {
  return tossGet<TossAccount[]>('/api/v1/accounts');
}

/** 보유 주식 조회 (종목별 상세 + 통화별 합산) */
export function fetchHoldings(accountSeq: number): Promise<TossHoldingsOverview> {
  return tossGet<TossHoldingsOverview>('/api/v1/holdings', {}, {
    'X-Tossinvest-Account': String(accountSeq),
  });
}

export interface TossStockWarning {
  warningType: string;
  exchange?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

/** 매수 유의사항 조회 (VI 발동, 정리매매, 투자경고/위험 등) */
export function fetchStockWarnings(symbol: string): Promise<TossStockWarning[]> {
  return tossGet<TossStockWarning[]>(`/api/v1/stocks/${encodeURIComponent(symbol)}/warnings`);
}

/** USD→KRW 환율 조회 */
export function fetchExchangeRate(): Promise<TossExchangeRate> {
  return tossGet<TossExchangeRate>('/api/v1/exchange-rate', {
    baseCurrency: 'USD',
    quoteCurrency: 'KRW',
  });
}

/** 일봉 조회. 전일 종가 계산용으로 최근 2개면 충분합니다. */
export async function fetchDailyCandles(symbol: string, count = 2): Promise<TossCandle[]> {
  const page = await tossGet<{ candles: TossCandle[] }>('/api/v1/candles', {
    symbol,
    interval: '1d',
    count: String(count),
  });
  return page.candles;
}
