import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { AsOfIndicatorStore, type DailyCandle } from '../domain/indicators.js';
import { changeRate, dateKey } from '../domain/quotes.js';
import { CtxTracker, STRATEGIES, decide, isStale, positionSize, trackPeak } from '../domain/strategy.js';
import { createProducer, onShutdown, runResilientConsumer } from '../lib/kafka.js';
import { K } from '../lib/keys.js';
import { createRedis } from '../lib/redis.js';
import { markProgress, startHeartbeat } from '../lib/heartbeat.js';
import { sendSlackMessage } from '../lib/slack.js';
import { fetchDailyCandles, fetchExchangeRate, fetchStockWarnings, toDailyCandle } from '../lib/toss.js';
import type { PaperOrderEvent, PaperPosition, TickEvent } from '../types.js';

/**
 * 전략 워커 (Consumer Group C)
 * 틱 하나가 들어오면 5개 전략을 전부 평가합니다. 전략마다 독립된 가상계좌를 쓰므로
 * 같은 틱에 어떤 전략은 사고, 어떤 전략은 팔고, 어떤 전략은 관망할 수 있습니다.
 *
 * 판단 결과는 paper.orders 토픽으로 발행하고 체결은 paper-exec 워커가 맡습니다.
 * ★ 이 워커는 실주문을 내지 않습니다 ★
 */

/** 초단타/신고가 전략용 시장 상태. 백테스트 엔진과 같은 구현(CtxTracker)을 공유합니다. */
const ctxTracker = new CtxTracker();

/**
 * USD→KRW 환율. 계좌 현금이 원화라서 미국 주식 주문 금액 환산에 필요합니다.
 * 30분마다 갱신하고, API/체결 시뮬레이터가 쓸 수 있게 Redis 에도 올려둡니다.
 */
let usdKrw = 0;
async function refreshFx(redis: ReturnType<typeof createRedis>): Promise<void> {
  try {
    const fx = await fetchExchangeRate();
    const rate = Number(fx.midRate) || Number(fx.rate);
    if (rate > 0) {
      usdKrw = rate;
      await redis.set(K.fxUsdKrw, String(rate));
      console.log(`[strategy] 환율 갱신: $1 = ${rate.toLocaleString('ko-KR')}원`);
    }
  } catch (err) {
    console.warn('[strategy] 환율 조회 실패:', (err as Error).message);
    if (usdKrw === 0) {
      const cached = Number(await redis.get(K.fxUsdKrw));
      if (cached > 0) usdKrw = cached;
    }
  }
}

/**
 * 일봉 지표 스토어. 시작 시 + 30분마다 종목별 일봉 80개를 받아 갱신합니다.
 * as-of 조회라 오늘의 미완성 봉은 지표에 섞이지 않습니다.
 */
let indicatorStore = new AsOfIndicatorStore(new Map(), dateKey);

async function refreshIndicators(
  symbols: string[],
  redis: ReturnType<typeof createRedis>,
): Promise<void> {
  const bySymbol = new Map<string, DailyCandle[]>();
  for (const symbol of symbols) {
    try {
      // 종목당 1콜 순차 호출 — rate limit(초당 ~10회) 안에서 여유
      const candles = await fetchDailyCandles(symbol, 80);
      bySymbol.set(symbol, candles.map(toDailyCandle));
    } catch (err) {
      console.warn(`[strategy] ${symbol} 일봉 조회 실패:`, (err as Error).message);
    }
  }
  if (bySymbol.size === 0) return;
  indicatorStore = new AsOfIndicatorStore(bySymbol, dateKey);

  // 대시보드 표시용으로 오늘 기준 as-of 지표 + 일봉 원본을 Redis 에 게시합니다.
  const today = dateKey();
  for (const [symbol, candles] of bySymbol.entries()) {
    await redis.set(K.dailyCandles(symbol), JSON.stringify(candles));
    const ind = indicatorStore.get(symbol, today);
    await redis.hset(K.indicators(symbol), {
      ma20: ind.ma20 !== null ? String(ind.ma20) : '',
      ma60: ind.ma60 !== null ? String(ind.ma60) : '',
      rsi14: ind.rsi14 !== null ? String(ind.rsi14) : '',
      bbUpper: ind.bbUpper !== null ? String(ind.bbUpper) : '',
      bbLower: ind.bbLower !== null ? String(ind.bbLower) : '',
      atrPct: ind.atrPct !== null ? String(ind.atrPct) : '',
      updatedAt: new Date().toISOString(),
    });
  }
  console.log(`[strategy] 지표 부트스트랩 완료: ${bySymbol.size}종목 × 일봉 80개 (MA/볼린저/RSI/ATR)`);
}

/**
 * 매수 유의 종목 필터.
 * VI(변동성완화장치) 발동 중이거나 정리매매/투자위험 지정 종목은 신규 진입을 막습니다.
 * 급등락 전략은 VI 에 자주 걸리는데, VI 중에는 2분 단일가 전환이라 즉시 체결 가정이 깨집니다.
 *
 * 캐시는 10초만 둡니다 (동일 틱 폭주 시 중복 호출 방지용 최소 완충).
 * VI 는 2분짜리 이벤트라 캐시가 길면 "VI 를 발동시킨 바로 그 급등"을 쫓아 들어가는
 * 최악의 타이밍에 필터가 낡아 있게 됩니다. 크로싱+쿨다운 덕에 매수 시도가 희소해서
 * 매번 신선하게 확인해도 rate limit 부담이 없습니다.
 */
const BLOCKED_WARNINGS = new Set([
  'VI_STATIC', 'VI_DYNAMIC', 'VI_STATIC_AND_DYNAMIC',
  'LIQUIDATION_TRADING', 'INVESTMENT_RISK',
]);
const warningCache = new Map<string, { blocked: boolean; until: number }>();

async function isTradeBlocked(symbol: string): Promise<boolean> {
  const cached = warningCache.get(symbol);
  if (cached && cached.until > Date.now()) return cached.blocked;

  let blocked = false;
  try {
    const warnings = await fetchStockWarnings(symbol);
    blocked = warnings.some((w) => BLOCKED_WARNINGS.has(w.warningType));
    if (blocked) {
      console.warn(`[strategy] ${symbol} 매수 유의(${warnings.map((w) => w.warningType).join(',')}) — 진입 차단`);
    }
  } catch {
    // 조회 실패 시 차단하지 않습니다 (필터는 보조 장치, 파이프라인을 멈추지 않음)
  }
  warningCache.set(symbol, { blocked, until: Date.now() + 10_000 });
  return blocked;
}

/** 전략 계좌의 현재 자산 (현금 + 보유 포지션의 원화 환산 평가액) */
async function computeEquity(
  redis: ReturnType<typeof createRedis>,
  strategyId: string,
): Promise<number> {
  let equity = Number(await redis.hget(K.paperAccount(strategyId), 'cash')) || 0;
  const symbols = await redis.smembers(K.paperPosIndex(strategyId));
  for (const symbol of symbols) {
    const pos = await redis.hgetall(K.paperPos(strategyId, symbol));
    const qty = Number(pos['quantity'] ?? 0);
    const avg = Number(pos['avgPrice'] ?? 0);
    const last = Number(await redis.hget(K.quote(symbol), 'price')) || avg;
    const fx = pos['currency'] === 'USD' ? usdKrw || 1400 : 1;
    equity += qty * last * fx;
  }
  return equity;
}

/**
 * 일일 킬 스위치: 당일 시작 자산 대비 -X% 면 그날은 신규 진입을 멈춥니다 (청산은 계속).
 * 전략이 무너지는 날 손실이 눈덩이처럼 불어나는 것을 막는 최소 안전장치입니다.
 */
async function killSwitchActive(
  redis: ReturnType<typeof createRedis>,
  strategyId: string,
  dayKey: string,
): Promise<boolean> {
  if (await redis.exists(K.paperKill(strategyId, dayKey))) return true;

  const dayStartKey = K.paperDayStart(strategyId, dayKey);
  let dayStart = Number(await redis.get(dayStartKey));
  if (!dayStart) {
    dayStart = await computeEquity(redis, strategyId);
    await redis.set(dayStartKey, String(dayStart), 'EX', 60 * 60 * 48, 'NX');
  }
  if (dayStart <= 0) return false;

  const equity = await computeEquity(redis, strategyId);
  const loss = (dayStart - equity) / dayStart;
  if (loss < config.paper.dailyMaxLossPct / 100) return false;

  const first = await redis.set(K.paperKill(strategyId, dayKey), '1', 'EX', 60 * 60 * 48, 'NX');
  if (first === 'OK') {
    const msg = `🛑 [킬 스위치] ${strategyId} 당일 손실 ${(loss * 100).toFixed(2)}% ≥ ${config.paper.dailyMaxLossPct}% — 오늘 신규 진입 중단 (청산은 계속)`;
    console.warn(`[strategy] ${msg}`);
    // 페이퍼 관련 알림이므로 페이퍼 채널로 (미설정 시 기본 채널)
    await sendSlackMessage(msg, undefined, config.slack.paperWebhookUrl);
  }
  return true;
}

async function loadPosition(
  redis: ReturnType<typeof createRedis>,
  strategyId: string,
  symbol: string,
): Promise<PaperPosition | null> {
  const raw = await redis.hgetall(K.paperPos(strategyId, symbol));
  if (!raw['symbol']) return null;
  return {
    symbol: raw['symbol'],
    name: raw['name'] ?? raw['symbol'],
    market: (raw['market'] ?? 'KR') as PaperPosition['market'],
    currency: (raw['currency'] ?? 'KRW') as PaperPosition['currency'],
    quantity: Number(raw['quantity'] ?? 0),
    avgPrice: Number(raw['avgPrice'] ?? 0),
    openedAt: raw['openedAt'] ?? '',
    peakPrice: raw['peakPrice'] ? Number(raw['peakPrice']) : undefined,
  };
}

async function main(): Promise<void> {
  const redis = createRedis('strategy');
  startHeartbeat(redis, 'strategy');
  await refreshFx(redis);
  await refreshIndicators(config.toss.symbols, redis);
  const fxTimer = setInterval(() => {
    void refreshFx(redis);
    void refreshIndicators(config.toss.symbols, redis);
  }, 30 * 60 * 1000);

  const producer = await createProducer('mktlab-strategy-out');

  console.log(
    `[strategy] group=${config.kafka.groups.strategy} 구독 시작 · ` +
      `전략 ${STRATEGIES.length}개(${STRATEGIES.map((s) => s.id).join(',')}) 동시 운용 · ` +
      `시장=${config.paper.markets.join(',')}`,
  );

  onShutdown(async () => {
    clearInterval(fxTimer);
    await producer.disconnect();
    redis.disconnect();
  });

  await runResilientConsumer({
    clientId: 'mktlab-strategy',
    groupId: config.kafka.groups.strategy,
    topic: config.kafka.topic,
    fromBeginning: false,
    onProgress: () => markProgress(redis, 'strategy'),
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const tick = JSON.parse(message.value.toString()) as TickEvent;

      if (!config.paper.markets.includes(tick.market)) return;
      if (!tick.prevClose || tick.price <= 0) return;
      if (isStale(tick.tradedAt, Date.now(), config.paper.staleTickSec)) return;

      // 환율 스냅샷: 원화 거래는 1, 달러 거래는 USD→KRW. 환율을 모르면 매매하지 않습니다.
      const fxRate = tick.currency === 'KRW' ? 1 : usdKrw;
      if (fxRate <= 0) return;

      const rate = changeRate(tick.price, tick.prevClose);
      const dayKey = dateKey(tick.polledAt);
      const ctx = ctxTracker.next(tick, dayKey, rate);
      ctx.daily = indicatorStore.get(tick.symbol, dayKey);

      for (const def of STRATEGIES) {
        const position = await loadPosition(redis, def.id, tick.symbol);

        // 트레일링 익절 기준점: 보유 중 최고가를 갱신해 둡니다.
        // (포지션 해시는 청산 시 통째로 삭제되므로 다음 진입에 남지 않습니다)
        if (position) {
          const prevPeak = position.peakPrice;
          const peak = trackPeak(position, tick.price);
          if (prevPeak === undefined || peak > prevPeak) {
            await redis.hset(K.paperPos(def.id, tick.symbol), { peakPrice: String(peak) });
          }
        }

        // 시간 청산: 익절도 손절도 안 닿는 좀비 포지션을 강제 종료합니다.
        let decision = decide(tick, rate, position, ctx, def);
        if (!decision && position) {
          const heldMin = (Date.now() - Date.parse(position.openedAt)) / 60_000;
          if (heldMin >= config.paper.maxHoldMin) {
            decision = { side: 'SELL', reason: `시간 청산: 보유 ${Math.round(heldMin)}분 ≥ ${config.paper.maxHoldMin}분` };
          }
        }
        if (!decision) continue;

        // 일일 킬 스위치: 발동 시 신규 진입만 차단, 청산은 그대로 진행합니다.
        if (decision.side === 'BUY' && (await killSwitchActive(redis, def.id, dayKey))) continue;
        // VI/정리매매/투자위험 종목 진입 차단 (전략 무관 공통 필터)
        if (decision.side === 'BUY' && (await isTradeBlocked(tick.symbol))) continue;

        // 체결 반영 전 같은 전략×종목 중복 주문 방지
        const pending = await redis.set(K.paperPending(def.id, tick.symbol), '1', 'EX', 30, 'NX');
        if (pending !== 'OK') continue;

        let quantity: number;
        if (decision.side === 'BUY') {
          if (await redis.exists(K.paperCooldown(def.id, tick.symbol))) continue;

          const openCount = await redis.scard(K.paperPosIndex(def.id));
          if (openCount >= config.paper.maxPositions) continue;

          const cash = Number(await redis.hget(K.paperAccount(def.id), 'cash'));
          // 현금은 원화이므로 가격을 원화로 환산해 수량을 계산합니다.
          quantity = positionSize(cash, config.paper.positionPct, tick.price * fxRate);
          if (quantity < 1) continue;

          // 주문을 실제로 낼 때만 쿨다운을 소모합니다 (현금 부족 등으로 스킵되면 쿨다운도 안 걸림)
          const cooldown = await redis.set(
            K.paperCooldown(def.id, tick.symbol), '1', 'EX', config.paper.cooldownSec, 'NX',
          );
          if (cooldown !== 'OK') continue;
        } else {
          quantity = position?.quantity ?? 0;
          if (quantity < 1) continue;
        }

        const order: PaperOrderEvent = {
          eventId: randomUUID(),
          symbol: tick.symbol,
          name: tick.name,
          market: tick.market,
          currency: tick.currency,
          side: decision.side,
          quantity,
          price: tick.price,
          fxRate,
          strategy: def.id,
          reason: decision.reason,
          orderedAt: new Date().toISOString(),
        };

        await producer.send({
          topic: config.kafka.paperTopic,
          messages: [{ key: order.symbol, value: JSON.stringify(order) }],
        });
        console.log(
          `[strategy:${def.id}] ${order.side} ${order.name} ${order.quantity}주 @ ${order.price.toLocaleString('ko-KR')} · ${order.reason}`,
        );
      }
    },
  });
}

void main();
