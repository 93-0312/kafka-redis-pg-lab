import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STRATEGIES } from '../domain/strategy.js';
import type { TickEvent } from '../types.js';
import { runBacktest, type BacktestConfig } from './engine.js';

const CFG: BacktestConfig = {
  initialCash: 100_000_000,
  positionPct: 10,
  maxPositions: 5,
  cooldownSec: 600,
  staleTickSec: 600,
  markets: ['KR'],
  usdKrw: 1400,
};

/** polledAt = tradedAt (신선한 틱) */
const tick = (sec: number, price: number, over: Partial<TickEvent> = {}): TickEvent => {
  const iso = new Date(Date.parse('2026-08-18T10:00:00+09:00') + sec * 1000).toISOString();
  return {
    eventId: `e${sec}-${price}`,
    symbol: '005930',
    name: '삼성전자',
    market: 'KR',
    currency: 'KRW',
    price,
    prevClose: 100_000,
    tradedAt: iso,
    polledAt: iso,
    ...over,
  };
};

const meanrevert = STRATEGIES.filter((s) => s.id === 'meanrevert');

test('engine: 급락 매수 → 반등 익절 사이클', () => {
  const ticks = [
    tick(0, 100_000),  // 0% — 관망
    tick(3, 97_000),   // -3% — 진입
    tick(6, 99_000),   // 평단 대비 +2.06% — 익절
  ];
  const [r] = runBacktest(ticks, meanrevert, CFG);
  assert.ok(r);
  assert.equal(r.fills, 2);
  assert.equal(r.sells, 1);
  assert.equal(r.wins, 1);
  assert.equal(r.winRate, 1);
  // 10% 비중: 1000만 ÷ 97000 = 103주, 주당 +2000원 → +206,000원
  assert.equal(r.realizedPnl, 103 * 2000);
  assert.equal(r.finalEquity, CFG.initialCash + 103 * 2000);
  assert.equal(r.openPositions, 0);
});

test('engine: 손절과 MDD 기록', () => {
  const ticks = [
    tick(0, 97_000),   // -3% — 진입 (103주)
    tick(3, 95_000),   // 평단 대비 -2.06% — 손절
  ];
  const [r] = runBacktest(ticks, meanrevert, CFG);
  assert.ok(r);
  assert.equal(r.sells, 1);
  assert.equal(r.wins, 0);
  assert.equal(r.realizedPnl, -(103 * 2000));
  assert.ok(r.maxDrawdown > 0);
});

test('engine: 쿨다운 안에는 재진입하지 않는다', () => {
  const ticks = [
    tick(0, 97_000),   // 진입
    tick(3, 95_000),   // 손절
    tick(6, 94_000),   // -6% 지만 쿨다운(600초) 중 — 재진입 금지
  ];
  const [r] = runBacktest(ticks, meanrevert, CFG);
  assert.ok(r);
  assert.equal(r.fills, 2); // BUY 1 + SELL 1 뿐
});

test('engine: 낡은 틱(장 마감 정지 시세)은 무시', () => {
  const stale = tick(0, 90_000, { tradedAt: '2026-08-18T08:00:00+09:00' }); // 2시간 전 체결가
  const [r] = runBacktest([stale], meanrevert, CFG);
  assert.ok(r);
  assert.equal(r.fills, 0);
});

test('engine: 대상 외 시장은 매매하지 않는다', () => {
  const us = tick(0, 100, { symbol: 'AAPL', market: 'US', currency: 'USD', prevClose: 105 });
  const [r] = runBacktest([us], meanrevert, CFG); // markets: ['KR']
  assert.ok(r);
  assert.equal(r.fills, 0);
});
