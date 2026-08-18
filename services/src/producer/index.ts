import { randomUUID } from 'node:crypto';
import type { Producer } from 'kafkajs';
import { config } from '../config.js';
import { dateKey, pickPrevClose } from '../domain/quotes.js';
import { startHeartbeat } from '../lib/heartbeat.js';
import { createProducer, onShutdown } from '../lib/kafka.js';
import { createRedis } from '../lib/redis.js';
import { fetchDailyCandles, fetchPrices, fetchStocks } from '../lib/toss.js';
import type { Market, TickEvent } from '../types.js';

/**
 * 토스증권 Open API 는 REST 만 제공합니다 (웹소켓 없음).
 * 그래서 이 producer 가 "폴링 → Kafka 스트림" 변환기를 맡습니다.
 *  - /api/v1/prices 는 한 번의 호출로 최대 200종목 배치 조회 -> 폴링 1회 = API 1회
 *  - 얻은 시세를 종목별 TickEvent 로 쪼개 파티션 키 = symbol 로 발행
 *    (같은 종목 = 같은 파티션 = 순서 보장. 캔들 롤업이 이 순서에 기대고 있습니다)
 */

interface SymbolMeta {
  name: string;
  market: Market;
  prevClose: number | null;
}

const meta = new Map<string, SymbolMeta>();

const marketOf = (symbol: string): Market => (/^\d{6}$/.test(symbol) ? 'KR' : 'US');

/** 종목명 + 전일종가를 불러옵니다. 시작 시 1회 + 주기적 갱신. */
async function refreshMeta(symbols: string[]): Promise<void> {
  const stocks = await fetchStocks(symbols).catch((err) => {
    console.warn('[producer] 종목 정보 조회 실패:', (err as Error).message);
    return [];
  });
  const nameBySymbol = new Map(stocks.map((s) => [s.symbol, s.name]));

  const today = dateKey();
  for (const symbol of symbols) {
    // 일봉은 종목당 1회 호출이므로 순차로 돌며 rate limit(초당 ~10회)을 피합니다.
    const prevClose = await fetchDailyCandles(symbol, 2)
      .then((candles) => pickPrevClose(candles, today))
      .catch((err) => {
        console.warn(`[producer] ${symbol} 일봉 조회 실패:`, (err as Error).message);
        return meta.get(symbol)?.prevClose ?? null;
      });

    meta.set(symbol, {
      name: nameBySymbol.get(symbol) ?? meta.get(symbol)?.name ?? symbol,
      market: marketOf(symbol),
      prevClose,
    });
  }
  console.log(
    `[producer] 메타 갱신 완료: ${symbols.map((s) => `${s}(${meta.get(s)?.name}, 전일 ${meta.get(s)?.prevClose ?? '?'})`).join(', ')}`,
  );
}

async function pollOnce(producer: Producer): Promise<number> {
  const symbols = config.toss.symbols;
  const prices = await fetchPrices(symbols);
  const polledAt = new Date().toISOString();

  const messages = prices.map((p) => {
    const m = meta.get(p.symbol);
    const tick: TickEvent = {
      eventId: randomUUID(),
      symbol: p.symbol,
      name: m?.name ?? p.symbol,
      market: m?.market ?? marketOf(p.symbol),
      currency: p.currency,
      price: Number(p.lastPrice),
      prevClose: m?.prevClose ?? null,
      tradedAt: p.timestamp,
      polledAt,
    };
    return {
      key: config.producer.partitionKey === 'symbol' ? tick.symbol : null,
      value: JSON.stringify(tick),
    };
  });

  await producer.send({ topic: config.kafka.topic, messages });
  return messages.length;
}

async function main(): Promise<void> {
  const symbols = config.toss.symbols;
  console.log(`[producer] topic=${config.kafka.topic} poll=${config.toss.pollMs}ms symbols=${symbols.join(',')}`);

  await refreshMeta(symbols);
  const metaTimer = setInterval(
    () => void refreshMeta(symbols).catch((err) => console.error('[producer] 메타 갱신 실패', err)),
    config.toss.metaRefreshMin * 60 * 1000,
  );

  const producer = await createProducer('mktlab-producer');
  const redis = createRedis('producer');
  startHeartbeat(redis, 'producer');
  onShutdown(async () => {
    clearInterval(metaTimer);
    await producer.disconnect();
    redis.disconnect();
  });

  let sent = 0;
  let polls = 0;

  // setInterval 대신 재귀 setTimeout: 폴링이 밀려도 호출이 겹치지 않게 합니다.
  const loop = async () => {
    try {
      sent += await pollOnce(producer);
      polls += 1;
      if (polls % 10 === 0) {
        console.log(`[producer] 폴링 ${polls}회 · 틱 ${sent}건 발행`);
      }
    } catch (err) {
      console.error('[producer] 폴링 실패:', (err as Error).message);
    }
    setTimeout(() => void loop(), config.toss.pollMs);
  };
  void loop();
}

void main();
