import { randomUUID } from 'node:crypto';
import type { AlertSeverity, PriceAlert, TickEvent } from '../types.js';

/**
 * 등락률이 몇 번째 계단(step)에 도달했는지 계산합니다.
 * step=1(%) 일 때 +2.3% -> 2, -1.1% -> 1, ±1% 미만 -> 0.
 */
export function changeLevel(rate: number, stepPct: number): number {
  if (stepPct <= 0) return 0;
  return Math.floor(Math.abs(rate * 100) / stepPct);
}

export function levelSeverity(level: number): AlertSeverity {
  if (level >= 3) return 'CRITICAL';
  if (level >= 2) return 'WARN';
  return 'INFO';
}

const pctText = (rate: number): string => `${rate >= 0 ? '+' : ''}${(rate * 100).toFixed(2)}%`;

/** 등락률 계단 도달 알림 (SURGE/PLUNGE) */
export function buildThresholdAlert(tick: TickEvent, rate: number, level: number): PriceAlert {
  const up = rate >= 0;
  return {
    alertId: randomUUID(),
    type: up ? 'SURGE' : 'PLUNGE',
    severity: levelSeverity(level),
    symbol: tick.symbol,
    name: tick.name,
    market: tick.market,
    price: tick.price,
    currency: tick.currency,
    changeRate: rate,
    message: `${tick.name} 전일 대비 ${pctText(rate)} (${up ? '상승' : '하락'} ${level}단계 도달)`,
    detectedAt: new Date().toISOString(),
  };
}

/** 단시간 급변 알림 (SPIKE). basePrice = 감시 윈도우 시작 시점 가격 */
export function buildSpikeAlert(
  tick: TickEvent,
  basePrice: number,
  windowSec: number,
  totalRate: number,
): PriceAlert {
  const moveRate = (tick.price - basePrice) / basePrice;
  return {
    alertId: randomUUID(),
    type: 'SPIKE',
    severity: 'CRITICAL',
    symbol: tick.symbol,
    name: tick.name,
    market: tick.market,
    price: tick.price,
    currency: tick.currency,
    changeRate: totalRate,
    message: `${tick.name} ${windowSec}초 내 ${pctText(moveRate)} 급변동`,
    detectedAt: new Date().toISOString(),
  };
}

/** 윈도우 내 변동률이 임계값을 넘었는지 */
export function isSpike(price: number, basePrice: number, spikeRatePct: number): boolean {
  if (basePrice <= 0) return false;
  return Math.abs((price - basePrice) / basePrice) * 100 >= spikeRatePct;
}
