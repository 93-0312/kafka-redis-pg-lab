import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildReversalAlert,
  buildSpikeAlert,
  buildThresholdAlert,
  changeLevel,
  isSpike,
  levelSeverity,
} from './alerts.js';
import { AsOfIndicatorStore, computeDailyIndicators, type DailyCandle } from './indicators.js';
import { changeRate, mergeCandle, minuteBucket, pickPrevClose } from './quotes.js';
import { STRATEGIES, decide, isStale, positionSize, type MarketCtx } from './strategy.js';
import type { PaperPosition, TickEvent } from '../types.js';

const tick = (over: Partial<TickEvent> = {}): TickEvent => ({
  eventId: 'e1',
  symbol: '005930',
  name: '삼성전자',
  market: 'KR',
  currency: 'KRW',
  price: 73400,
  prevClose: 71900,
  tradedAt: '2026-08-18T10:00:00+09:00',
  polledAt: '2026-08-18T10:00:01+09:00',
  ...over,
});

test('changeRate: 기본 계산', () => {
  assert.equal(changeRate(110, 100), 0.1);
  assert.equal(changeRate(90, 100), -0.1);
});

test('changeRate: 기준가가 없으면 0', () => {
  assert.equal(changeRate(100, null), 0);
  assert.equal(changeRate(100, 0), 0);
});

test('minuteBucket: HHmm 포맷', () => {
  const bucket = minuteBucket('2026-08-18T09:05:59+09:00');
  assert.match(bucket, /^\d{4}$/);
});

test('mergeCandle: 첫 틱은 OHLC 가 모두 현재가', () => {
  assert.deepEqual(mergeCandle(null, 100), { o: 100, h: 100, l: 100, c: 100, n: 1 });
});

test('mergeCandle: 고가/저가 갱신과 틱 수 증가', () => {
  const c1 = mergeCandle(null, 100);
  const c2 = mergeCandle(c1, 105);
  const c3 = mergeCandle(c2, 98);
  assert.deepEqual(c3, { o: 100, h: 105, l: 98, c: 98, n: 3 });
});

test('pickPrevClose: 최신 봉이 오늘이면 직전 봉의 종가', () => {
  const candles = [
    { timestamp: '2026-08-18T09:00:00+09:00', closePrice: '73400' },
    { timestamp: '2026-08-17T09:00:00+09:00', closePrice: '71900' },
  ];
  assert.equal(pickPrevClose(candles, '20260818'), 71900);
});

test('pickPrevClose: 최신 봉이 과거면(휴장) 그 봉의 종가', () => {
  const candles = [
    { timestamp: '2026-08-15T09:00:00+09:00', closePrice: '71900' },
    { timestamp: '2026-08-14T09:00:00+09:00', closePrice: '70000' },
  ];
  assert.equal(pickPrevClose(candles, '20260818'), 71900);
});

test('pickPrevClose: 봉이 없으면 null', () => {
  assert.equal(pickPrevClose([], '20260818'), null);
});

test('changeLevel: step 계단 계산', () => {
  assert.equal(changeLevel(0.023, 1), 2);
  assert.equal(changeLevel(-0.011, 1), 1);
  assert.equal(changeLevel(0.009, 1), 0);
  assert.equal(changeLevel(0.05, 2), 2);
});

test('levelSeverity: 계단이 높을수록 심각도 상승', () => {
  assert.equal(levelSeverity(1), 'INFO');
  assert.equal(levelSeverity(2), 'WARN');
  assert.equal(levelSeverity(3), 'CRITICAL');
});

test('buildThresholdAlert: 상승은 SURGE, 하락은 PLUNGE', () => {
  const up = buildThresholdAlert(tick(), 0.021, 2);
  assert.equal(up.type, 'SURGE');
  assert.equal(up.severity, 'WARN');
  assert.match(up.message, /\+2\.10%/);

  const down = buildThresholdAlert(tick(), -0.033, 3);
  assert.equal(down.type, 'PLUNGE');
  assert.equal(down.severity, 'CRITICAL');
});

test('isSpike: 윈도우 내 변동률 임계 판정', () => {
  assert.equal(isSpike(100.6, 100, 0.5), true);
  assert.equal(isSpike(100.4, 100, 0.5), false);
  assert.equal(isSpike(99.4, 100, 0.5), true);
});

test('buildReversalAlert: 반등은 저점→현재를 담는다', () => {
  const a = buildReversalAlert(tick(), 'REBOUND', -0.072, -0.061);
  assert.equal(a.type, 'REBOUND');
  assert.equal(a.severity, 'WARN'); // 저점 -7.2% 는 깊은 급락 → 주목
  assert.match(a.message, /저점 -7\.20% → 현재 -6\.10% \(\+1\.1%p 회복\)/);

  const b = buildReversalAlert(tick(), 'REBOUND', -0.03, -0.019);
  assert.equal(b.severity, 'INFO'); // 얕은 급락에서의 반등은 정보성
});

test('buildReversalAlert: 되돌림은 고점→현재를 담는다', () => {
  const a = buildReversalAlert(tick(), 'PULLBACK', 0.042, 0.028);
  assert.equal(a.type, 'PULLBACK');
  assert.match(a.message, /고점 \+4\.20% → 현재 \+2\.80% \(-1\.4%p 반납\)/);
});

test('buildSpikeAlert: 급변 방향과 폭이 메시지에 담긴다', () => {
  const a = buildSpikeAlert(tick({ price: 74000 }), 73000, 60, 0.029);
  assert.equal(a.type, 'SPIKE');
  assert.equal(a.severity, 'CRITICAL');
  assert.match(a.message, /60초 내 \+1\.37%/);
});

// ── 페이퍼 트레이딩 전략 ─────────────────────────────────

const CTX: MarketCtx = { shortChange: null, dayHigh: null, prevRate: null, prevShortChange: null };
const byId = (id: string) => {
  const def = STRATEGIES.find((s) => s.id === id);
  assert.ok(def, `전략 없음: ${id}`);
  return def;
};
const position = (avgPrice: number): PaperPosition => ({
  symbol: '005930', name: '삼성전자', market: 'KR', currency: 'KRW',
  quantity: 10, avgPrice, openedAt: '2026-08-18T10:00:00+09:00',
});

test('전략 5개가 등록되어 있다', () => {
  assert.deepEqual(
    STRATEGIES.map((s) => s.id),
    ['meanrevert', 'momentum', 'deepdip', 'scalper', 'highbreak'],
  );
});

test('meanrevert: -2% 를 "새로" 하향 돌파하는 순간에만 매수 (크로싱)', () => {
  const def = byId('meanrevert');
  // 직전 -1% → 현재 -2.1%: 돌파 순간 → 매수
  assert.equal(decide(tick(), -0.021, null, { ...CTX, prevRate: -0.01 }, def)?.side, 'BUY');
  // 직전 -3% → 현재 -2.1%: 이미 아래에 있던 상태 → 관망 (레벨 조건 결함 방지)
  assert.equal(decide(tick(), -0.021, null, { ...CTX, prevRate: -0.03 }, def), null);
  // 당일 첫 틱(prevRate null): 갭 하락 시가로는 진입하지 않음
  assert.equal(decide(tick(), -0.021, null, CTX, def), null);
  // 임계 미달
  assert.equal(decide(tick(), -0.019, null, { ...CTX, prevRate: -0.01 }, def), null);
});

test('momentum: +2% 상향 돌파 순간에만 매수 (크로싱)', () => {
  const def = byId('momentum');
  assert.equal(decide(tick(), 0.021, null, { ...CTX, prevRate: 0.01 }, def)?.side, 'BUY');
  assert.equal(decide(tick(), 0.021, null, { ...CTX, prevRate: 0.03 }, def), null); // 이미 위
  assert.equal(decide(tick(), 0.021, null, CTX, def), null); // 첫 틱
});

test('deepdip: -4% 하향 돌파 순간에만 매수', () => {
  const def = byId('deepdip');
  assert.equal(decide(tick(), -0.041, null, { ...CTX, prevRate: -0.035 }, def)?.side, 'BUY');
  assert.equal(decide(tick(), -0.041, null, { ...CTX, prevRate: -0.05 }, def), null);
  assert.equal(decide(tick(), -0.03, null, { ...CTX, prevRate: -0.01 }, def), null);
});

test('scalper: 1분 변화율이 +0.3% 를 상향 돌파하는 순간에만 매수', () => {
  const def = byId('scalper');
  assert.equal(
    decide(tick(), 0, null, { ...CTX, shortChange: 0.004, prevShortChange: 0.002 }, def)?.side,
    'BUY',
  );
  // 이미 +0.3% 위에 있던 상태 → 관망
  assert.equal(
    decide(tick(), 0, null, { ...CTX, shortChange: 0.004, prevShortChange: 0.0035 }, def),
    null,
  );
  assert.equal(decide(tick(), 0, null, { ...CTX, shortChange: 0.002, prevShortChange: 0 }, def), null);
  assert.equal(decide(tick(), 0, null, CTX, def), null); // 기준가 없으면 관망
});

test('highbreak: 당일 고가 갱신 + 상승 중일 때만 매수', () => {
  const def = byId('highbreak');
  assert.equal(decide(tick({ price: 74000 }), 0.01, null, { ...CTX, dayHigh: 73900 }, def)?.side, 'BUY');
  assert.equal(decide(tick({ price: 73000 }), 0.01, null, { ...CTX, dayHigh: 73900 }, def), null);
  assert.equal(decide(tick({ price: 74000 }), -0.01, null, { ...CTX, dayHigh: 73900 }, def), null);
  assert.equal(decide(tick({ price: 74000 }), 0.01, null, CTX, def), null); // 첫 틱은 관망
});

test('decide: 포지션이 있으면 익절/손절만 검토', () => {
  const def = byId('meanrevert');
  assert.match(decide(tick({ price: 71100 }), 0, position(70000), CTX, def)?.reason ?? '', /익절/);
  assert.match(decide(tick({ price: 68900 }), 0, position(70000), CTX, def)?.reason ?? '', /손절/);
  assert.equal(decide(tick({ price: 70500 }), -0.05, position(70000), CTX, def), null);
});

// ── 지표 ───────────────────────────────────────────────

const candle = (day: number, close: number, spread = 0.01): DailyCandle => ({
  timestamp: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(),
  open: close, high: close * (1 + spread), low: close * (1 - spread), close, volume: 1000,
});

test('indicators: MA20·볼린저·RSI·ATR 계산', () => {
  // 100 에서 매일 +1 씩 오르는 30일
  const candles = Array.from({ length: 30 }, (_, i) => candle(i, 100 + i));
  const ind = computeDailyIndicators(candles);
  assert.ok(ind.ma20 !== null && Math.abs(ind.ma20 - avgOf(110, 129)) < 1e-9);
  assert.equal(ind.ma60, null); // 60개 미만
  assert.equal(ind.rsi14, 100); // 상승만 있으면 RSI 100
  assert.ok(ind.bbUpper! > ind.ma20! && ind.bbLower! < ind.ma20!);
  assert.ok(ind.atrPct! > 0);
  assert.equal(ind.lastClose, 129);
});

function avgOf(from: number, to: number): number {
  let s = 0;
  for (let v = from; v <= to; v += 1) s += v;
  return s / (to - from + 1);
}

test('indicators: 데이터 부족 시 null (전략 필터는 통과 처리)', () => {
  const ind = computeDailyIndicators([candle(0, 100)]);
  assert.equal(ind.ma20, null);
  assert.equal(ind.rsi14, null);
  assert.equal(ind.atrPct, null);
});

test('AsOfIndicatorStore: 해당일 이전 봉만 사용 (선견 편향 방지)', () => {
  const dayKeyOf = (iso: string) => iso.slice(0, 10).replace(/-/g, '');
  const candles = Array.from({ length: 25 }, (_, i) => candle(i, 100 + i));
  const store = new AsOfIndicatorStore(new Map([['005930', candles]]), dayKeyOf);

  // 21번째 날(day=20) 기준: 이전 20개 봉으로 MA20 계산 가능
  const d20 = store.get('005930', dayKeyOf(candles[20]!.timestamp));
  assert.ok(d20.ma20 !== null);
  assert.equal(d20.lastClose, 119); // day 19 종가 — 당일(120)은 절대 포함 안 됨

  // 5번째 날 기준: 봉 4개뿐 → MA20 null
  const d4 = store.get('005930', dayKeyOf(candles[4]!.timestamp));
  assert.equal(d4.ma20, null);
});

test('전략 지표 필터: RSI 과매도/MA20 추세 확인', () => {
  const mr = byId('meanrevert');
  const crossing = { ...CTX, prevRate: -0.01 };
  // RSI 70 (과매도 아님) → meanrevert 진입 거부
  assert.equal(
    decide(tick(), -0.021, null, { ...crossing, daily: { ...emptyDaily, rsi14: 70 } }, mr), null);
  // RSI 30 → 진입
  assert.equal(
    decide(tick(), -0.021, null, { ...crossing, daily: { ...emptyDaily, rsi14: 30 } }, mr)?.side, 'BUY');
  // 지표 없으면 통과 (보조 확인 원칙)
  assert.equal(decide(tick(), -0.021, null, crossing, mr)?.side, 'BUY');

  const mo = byId('momentum');
  const up = { ...CTX, prevRate: 0.01 };
  // 주가(73400) < MA20(80000) → 추세 아님 → 거부
  assert.equal(
    decide(tick(), 0.021, null, { ...up, daily: { ...emptyDaily, ma20: 80000 } }, mo), null);
  // 주가 > MA20 → 진입
  assert.equal(
    decide(tick(), 0.021, null, { ...up, daily: { ...emptyDaily, ma20: 70000 } }, mo)?.side, 'BUY');
});

test('deepdip: ATR 기반 동적 손절 — 변동성 크면 손절 폭 확대', () => {
  const dd = byId('deepdip');
  const highVol = { ...CTX, daily: { ...emptyDaily, atrPct: 4 } }; // 손절 = max(3, 6) = 6%
  // 평단 70000, 현재 66500 = -5% : 고정 -3% 면 손절이지만 ATR 손절(-6%)로는 홀드
  assert.equal(decide(tick({ price: 66500 }), 0, position(70000), highVol, dd), null);
  // -6.5% 면 ATR 손절도 발동
  assert.match(decide(tick({ price: 65400 }), 0, position(70000), highVol, dd)?.reason ?? '', /손절/);
});

const emptyDaily = {
  ma20: null, ma60: null, rsi14: null, bbUpper: null, bbLower: null, atrPct: null, lastClose: null,
};

test('highbreak: 비대칭 청산 (+2% 익절 / -1% 손절)', () => {
  const def = byId('highbreak');
  assert.equal(decide(tick({ price: 71100 }), 0, position(70000), CTX, def), null); // +1.57% 아직 홀드
  assert.match(decide(tick({ price: 71500 }), 0, position(70000), CTX, def)?.reason ?? '', /익절/);
  assert.match(decide(tick({ price: 69200 }), 0, position(70000), CTX, def)?.reason ?? '', /손절/);
});

test('positionSize: 현금 비중으로 정수 수량, 1주 미만이면 0', () => {
  assert.equal(positionSize(10_000_000, 10, 70_000), 14);
  assert.equal(positionSize(10_000_000, 10, 1_650_000), 0);
  assert.equal(positionSize(0, 10, 70_000), 0);
});

test('isStale: 오래된 틱은 매매 금지', () => {
  const now = Date.parse('2026-08-18T12:00:00+09:00');
  assert.equal(isStale('2026-08-18T11:55:00+09:00', now, 600), false);
  assert.equal(isStale('2026-08-18T11:40:00+09:00', now, 600), true);
  assert.equal(isStale(null, now, 600), true);
});
