import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STRATEGIES } from '../domain/strategy.js';
import type { TickEvent } from '../types.js';
import { runBacktest, type BacktestConfig } from './engine.js';

const NO_COSTS = { feePct: 0, krSellTaxPct: 0, slippagePct: 0 };

const CFG: BacktestConfig = {
  initialCash: 100_000_000,
  positionPct: 10,
  maxPositions: 5,
  cooldownSec: 600,
  staleTickSec: 600,
  markets: ['KR'],
  usdKrw: 1400,
  maxHoldMin: 360,
  dailyMaxLossPct: 2,
  costs: NO_COSTS,
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
    tick(0, 100_000),  // 0% — 기준 수립 (크로싱 감지용)
    tick(3, 97_000),   // -3% 하향 돌파 — 진입 (103주)
    tick(6, 95_000),   // 평단 대비 -2.06% — 손절
  ];
  const [r] = runBacktest(ticks, meanrevert, CFG);
  assert.ok(r);
  assert.equal(r.sells, 1);
  assert.equal(r.wins, 0);
  assert.equal(r.realizedPnl, -(103 * 2000));
  assert.ok(r.maxDrawdown > 0);
});

test('engine: 손절 후 계속 -2% 아래면 재진입하지 않는다 (크로싱)', () => {
  const ticks = [
    tick(0, 100_000),  // 기준
    tick(3, 97_000),   // -3% 돌파 — 진입
    tick(6, 95_000),   // 손절
    tick(9, 94_000),   // -6% 지만 "이미 아래" 상태 — 크로싱 아님 + 쿨다운
    tick(12, 93_000),  // 계속 하락 — 여전히 재진입 없음 (하락 추세 연속 손절 방지)
  ];
  const [r] = runBacktest(ticks, meanrevert, CFG);
  assert.ok(r);
  assert.equal(r.fills, 2); // BUY 1 + SELL 1 뿐
});

test('engine: 거래비용이 실현손익을 갉아먹는다', () => {
  const costCfg: BacktestConfig = {
    ...CFG,
    costs: { feePct: 0.015, krSellTaxPct: 0.15, slippagePct: 0.05 },
  };
  const ticks = [
    tick(0, 100_000),
    tick(3, 97_000),   // 진입 103주
    tick(6, 99_000),   // +2.06% 익절
  ];
  const [free] = runBacktest(ticks, meanrevert, CFG);
  const [paid] = runBacktest(ticks, meanrevert, costCfg);
  assert.ok(free && paid);
  assert.ok(paid.costsPaid > 0);
  // 왕복 비용 ≈ 매수 0.065% + 매도 0.215% — 비용 반영 실현손익이 정확히 그만큼 작아야 함
  assert.ok(paid.realizedPnl < free.realizedPnl);
  assert.ok(Math.abs(free.realizedPnl - paid.realizedPnl - paid.costsPaid) < 1);
});

test('engine: 시간 청산 — 익절/손절 미도달 좀비 포지션 강제 종료', () => {
  const ticks = [
    tick(0, 100_000),
    tick(3, 97_000),                 // -3% 돌파 — 진입
    tick(60 * 60 * 7, 97_500),       // 7시간 뒤에도 ±1.5% 안 — maxHoldMin(360분) 초과 → 강제 청산
  ];
  const [r] = runBacktest(ticks, meanrevert, CFG);
  assert.ok(r);
  assert.equal(r.sells, 1);
  assert.match(r.trades[1]!.reason, /시간 청산/);
  assert.equal(r.openPositions, 0);
});

test('engine: 일일 킬 스위치 — 당일 -2% 손실이면 신규 진입 중단', () => {
  // positionPct 100% 로 만들어 한 번의 손절로 계좌 -2% 를 넘기게 합니다
  const cfg: BacktestConfig = { ...CFG, positionPct: 100, cooldownSec: 1 };
  const ticks = [
    tick(0, 100_000),
    tick(3, 97_000),   // -2% 하향 돌파 — 진입 (전액)
    tick(6, 94_500),   // 평단 대비 -2.58% 손절 → 계좌 -2.5%
    tick(10, 99_000),  // -1% 까지 반등 (크로싱 기준 리셋)
    tick(13, 97_500),  // -2.5% 재돌파 — 진입 신호… 이지만 킬 스위치 발동 — 진입 금지
  ];
  const [r] = runBacktest(ticks, meanrevert, cfg);
  assert.ok(r);
  assert.equal(r.killDays, 1);
  assert.equal(r.fills, 2); // 첫 사이클 BUY+SELL 뿐, 재진입 없음
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
