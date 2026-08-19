import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { STRATEGIES } from '../domain/strategy.js';
import { createConsumer, onShutdown } from '../lib/kafka.js';
import { K, PROCESSED_TTL_SEC } from '../lib/keys.js';
import { createRedis } from '../lib/redis.js';
import { startHeartbeat } from '../lib/heartbeat.js';
import { sendSlackMessage } from '../lib/slack.js';
import type { PaperOrderEvent, PaperTradeRecord } from '../types.js';

const TRADES_MAX = 500;

/**
 * 페이퍼 체결 시뮬레이터.
 * paper.orders 의 가상 주문을 "주문 가격에 전량 체결"로 간주하고,
 * 주문에 태깅된 전략 ID 별로 분리된 가상 계좌를 갱신합니다.
 *
 * ★ 실주문 API 는 절대 호출하지 않습니다 ★
 * 자동매매로 갈 때 이 워커의 체결부만 토스 주문 API 로 바꾸면 됩니다.
 * 멱등 처리(K.processed)가 그대로 "중복 주문 방지"가 됩니다.
 */

async function ensureAccounts(redis: ReturnType<typeof createRedis>): Promise<void> {
  for (const def of STRATEGIES) {
    const key = K.paperAccount(def.id);
    if (await redis.exists(key)) continue;
    await redis.hset(key, {
      cash: String(config.paper.initialCash),
      initialCash: String(config.paper.initialCash),
      startedAt: new Date().toISOString(),
    });
    console.log(
      `[paper-exec] 계좌 생성: ${def.id} · 초기 자금 ${config.paper.initialCash.toLocaleString('ko-KR')}원`,
    );
  }
}

const STRATEGY_LABEL = new Map(STRATEGIES.map((s) => [s.id, s.label]));

const priceText = (price: number, currency?: string): string =>
  currency === 'USD'
    ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${Math.round(price).toLocaleString('ko-KR')}원`;

async function record(
  redis: ReturnType<typeof createRedis>,
  strategyId: string,
  trade: PaperTradeRecord,
): Promise<void> {
  await redis
    .multi()
    .lpush(K.paperTrades(strategyId), JSON.stringify(trade))
    .ltrim(K.paperTrades(strategyId), 0, TRADES_MAX - 1)
    .exec();
  const pnl = trade.realizedPnl !== undefined
    ? ` · 실현손익 ${trade.realizedPnl >= 0 ? '+' : ''}${Math.round(trade.realizedPnl).toLocaleString('ko-KR')}원`
    : '';
  console.log(
    `[paper-exec:${strategyId}] ${trade.status} ${trade.side} ${trade.name} ${trade.quantity}주 @ ${trade.price.toLocaleString('ko-KR')}${pnl}${trade.rejectReason ? ` (${trade.rejectReason})` : ''}`,
  );

  // 페이퍼 체결 슬랙 알림 (SLACK_PAPER_TRADES=false 로 끌 수 있음)
  if (trade.status === 'FILLED' && config.slack.paperTrades) {
    const emoji = trade.side === 'BUY' ? '📈' : '📉';
    const action = trade.side === 'BUY' ? '매수' : '매도';
    const label = STRATEGY_LABEL.get(strategyId) ?? strategyId;
    await sendSlackMessage(
      `${emoji} [${label}] ${action} ${trade.name} ${trade.quantity.toLocaleString('ko-KR')}주 @ ${priceText(trade.price, trade.currency)}${pnl}\n· ${trade.reason}`,
      undefined,
      config.slack.paperWebhookUrl, // 페이퍼 전용 채널 (미설정 시 기본 채널)
    );
  }
}

async function main(): Promise<void> {
  const redis = createRedis('paper-exec');
  startHeartbeat(redis, 'paper-exec');
  await ensureAccounts(redis);

  const consumer = await createConsumer('mktlab-paper-exec', config.kafka.groups.paperExec);
  await consumer.subscribe({ topic: config.kafka.paperTopic, fromBeginning: true });
  console.log(`[paper-exec] group=${config.kafka.groups.paperExec} 구독 시작 (시뮬레이션 전용)`);

  onShutdown(async () => {
    await consumer.disconnect();
    redis.disconnect();
  });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const order = JSON.parse(message.value.toString()) as PaperOrderEvent;
      const sid = order.strategy;

      // 알 수 없는 전략의 주문은 버립니다 (전략 목록 변경 후 남은 과거 주문 등)
      if (!STRATEGIES.some((s) => s.id === sid)) return;

      // 멱등 처리: 같은 주문이 두 번 와도 체결은 한 번만.
      const idemKey = K.processed(config.kafka.groups.paperExec, order.eventId);
      const first = await redis.set(idemKey, '1', 'EX', PROCESSED_TTL_SEC, 'NX');
      if (first !== 'OK') return;

      // 구버전 주문(환율 없음)은 KRW 로 간주합니다.
      const fx = order.fxRate > 0 ? order.fxRate : 1;
      const amount = order.quantity * order.price;
      const grossKrw = amount * fx;

      // 거래비용: 백테스트 엔진과 동일 수식. 페이퍼가 비용을 무시하면 수익률을 과대평가합니다.
      const { feePct, krSellTaxPct, slippagePct } = config.paper.costs;
      const sellTax = order.side === 'SELL' && order.market === 'KR' ? krSellTaxPct : 0;
      const costKrw = (grossKrw * (feePct + slippagePct + sellTax)) / 100;
      // 매수: 대금+비용 지출 / 매도: 대금-비용 입금
      const cashDelta = order.side === 'BUY' ? grossKrw + costKrw : grossKrw - costKrw;

      const base: Omit<PaperTradeRecord, 'status' | 'rejectReason' | 'realizedPnl'> = {
        tradeId: randomUUID(),
        symbol: order.symbol,
        name: order.name,
        side: order.side,
        quantity: order.quantity,
        price: order.price,
        currency: order.currency,
        amount,
        amountKrw: cashDelta,
        costKrw,
        strategy: sid,
        reason: order.reason,
        filledAt: new Date().toISOString(),
      };

      const accountKey = K.paperAccount(sid);
      const posKey = K.paperPos(sid, order.symbol);

      if (order.side === 'BUY') {
        const cash = Number(await redis.hget(accountKey, 'cash'));
        if (cash < base.amountKrw) {
          await record(redis, sid, { ...base, status: 'REJECTED', rejectReason: '현금 부족' });
          return;
        }
        const pos = await redis.hgetall(posKey);
        const prevQty = Number(pos['quantity'] ?? 0);
        const prevAvg = Number(pos['avgPrice'] ?? 0);
        const prevCost = Number(pos['costKrw'] ?? 0);
        const newQty = prevQty + order.quantity;
        // 평단은 거래 통화 기준으로 유지합니다 (현금 차감만 원화 환산)
        const newAvg = (prevQty * prevAvg + amount) / newQty;

        await redis
          .multi()
          .hincrbyfloat(accountKey, 'cash', -base.amountKrw)
          .hset(posKey, {
            symbol: order.symbol,
            name: order.name,
            market: order.market,
            currency: order.currency,
            quantity: String(newQty),
            avgPrice: String(newAvg),
            // 매수 총지출(비용 포함) 누적 — 실현손익 = 순매도대금 - costKrw
            costKrw: String(prevCost + base.amountKrw),
            openedAt: pos['openedAt'] ?? base.filledAt,
          })
          .sadd(K.paperPosIndex(sid), order.symbol)
          .exec();
        await record(redis, sid, { ...base, status: 'FILLED' });
      } else {
        const pos = await redis.hgetall(posKey);
        const held = Number(pos['quantity'] ?? 0);
        if (held < order.quantity) {
          await record(redis, sid, {
            ...base, status: 'REJECTED', rejectReason: `보유 수량 부족 (${held}주)`,
          });
          return;
        }
        const posCost = Number(pos['costKrw'] ?? 0);
        // 실현손익 = 순매도대금 - 매수 총지출(비용 포함, 부분 매도 시 비례 배분)
        // 구버전 포지션(costKrw 없음)은 평단 기준으로 근사합니다.
        const avg = Number(pos['avgPrice'] ?? 0);
        const costBasis = posCost > 0 ? posCost * (order.quantity / held) : avg * order.quantity * fx;
        const realizedPnl = base.amountKrw - costBasis;
        const remain = held - order.quantity;

        const pipe = redis.multi().hincrbyfloat(accountKey, 'cash', base.amountKrw);
        if (remain > 0) {
          pipe.hset(posKey, { quantity: String(remain) });
        } else {
          pipe.del(posKey);
          pipe.srem(K.paperPosIndex(sid), order.symbol);
        }
        await pipe.exec();
        await record(redis, sid, { ...base, status: 'FILLED', realizedPnl });
      }
    },
  });
}

void main();
