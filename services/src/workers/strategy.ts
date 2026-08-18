import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { changeRate, dateKey } from '../domain/quotes.js';
import { CtxTracker, STRATEGIES, decide, isStale, positionSize } from '../domain/strategy.js';
import { createConsumer, createProducer, onShutdown } from '../lib/kafka.js';
import { K } from '../lib/keys.js';
import { createRedis } from '../lib/redis.js';
import { sendSlackMessage } from '../lib/slack.js';
import { fetchExchangeRate } from '../lib/toss.js';
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
    await sendSlackMessage(msg);
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
  };
}

async function main(): Promise<void> {
  const redis = createRedis('strategy');
  await refreshFx(redis);
  const fxTimer = setInterval(() => void refreshFx(redis), 30 * 60 * 1000);

  const consumer = await createConsumer('mktlab-strategy', config.kafka.groups.strategy);
  const producer = await createProducer('mktlab-strategy-out');

  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: false });
  console.log(
    `[strategy] group=${config.kafka.groups.strategy} 구독 시작 · ` +
      `전략 ${STRATEGIES.length}개(${STRATEGIES.map((s) => s.id).join(',')}) 동시 운용 · ` +
      `시장=${config.paper.markets.join(',')}`,
  );

  onShutdown(async () => {
    clearInterval(fxTimer);
    await consumer.disconnect();
    await producer.disconnect();
    redis.disconnect();
  });

  await consumer.run({
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

      for (const def of STRATEGIES) {
        const position = await loadPosition(redis, def.id, tick.symbol);

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
