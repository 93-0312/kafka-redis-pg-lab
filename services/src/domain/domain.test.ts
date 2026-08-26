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
import {
  AsOfIndicatorStore,
  EMPTY_INDICATORS,
  computeDailyIndicators,
  type DailyCandle,
  type DailyIndicators,
} from './indicators.js';
import { changeRate, mergeCandle, minuteBucket, pickPrevClose } from './quotes.js';
import {
  STRATEGIES,
  decide,
  isRegularSession,
  isStale,
  positionSize,
  trackPeak,
  type MarketCtx,
} from './strategy.js';
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
const position = (avgPrice: number, peakPrice?: number): PaperPosition => ({
  symbol: '005930', name: '삼성전자', market: 'KR', currency: 'KRW',
  quantity: 10, avgPrice, openedAt: '2026-08-18T10:00:00+09:00', peakPrice,
});

test('전략 8개가 등록되어 있다', () => {
  assert.deepEqual(
    STRATEGIES.map((s) => s.id),
    ['meanrevert', 'momentum', 'deepdip', 'scalper', 'highbreak', 'bollbounce', 'bandride', 'goldenzone'],
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

test('scalper: 1분 변화율이 +0.3% 를 상향 돌파하는 순간에만 매수 (당일 상승 종목 한정)', () => {
  const def = byId('scalper');
  assert.equal(
    decide(tick(), 0.01, null, { ...CTX, shortChange: 0.004, prevShortChange: 0.002 }, def)?.side,
    'BUY',
  );
  // 이미 +0.3% 위에 있던 상태 → 관망
  assert.equal(
    decide(tick(), 0.01, null, { ...CTX, shortChange: 0.004, prevShortChange: 0.0035 }, def),
    null,
  );
  // 당일 하락 중인 종목의 1분 급등은 되돌림 — 진입하지 않습니다
  assert.equal(
    decide(tick(), -0.01, null, { ...CTX, shortChange: 0.004, prevShortChange: 0.002 }, def),
    null,
  );
  assert.equal(decide(tick(), 0.01, null, { ...CTX, shortChange: 0.002, prevShortChange: 0 }, def), null);
  assert.equal(decide(tick(), 0.01, null, CTX, def), null); // 기준가 없으면 관망
});

test('highbreak: 당일 고가를 +0.3% 이상 "강하게" 돌파 + 상승 중일 때만 매수', () => {
  const def = byId('highbreak');
  // 73,900 × 1.003 = 74,117. 74,200 은 +0.41% → 진입
  assert.equal(decide(tick({ price: 74200 }), 0.01, null, { ...CTX, dayHigh: 73900 }, def)?.side, 'BUY');
  // 74,000 은 +0.14% → 마진 미달, 진입 안 함
  assert.equal(decide(tick({ price: 74000 }), 0.01, null, { ...CTX, dayHigh: 73900 }, def), null);
  assert.equal(decide(tick({ price: 73000 }), 0.01, null, { ...CTX, dayHigh: 73900 }, def), null);
  assert.equal(decide(tick({ price: 74200 }), -0.01, null, { ...CTX, dayHigh: 73900 }, def), null); // 하락 중
  assert.equal(decide(tick({ price: 74200 }), 0.01, null, CTX, def), null); // dayHigh 없으면 관망
});

test('decide: 포지션이 있으면 익절/손절만 검토', () => {
  const def = byId('meanrevert');
  // 익절선(+1.5%) 통과 직후엔 팔지 않고 고점을 따라갑니다 (트레일링)
  assert.equal(decide(tick({ price: 71100 }), 0, position(70000, 71100), CTX, def), null);
  assert.match(decide(tick({ price: 68900 }), 0, position(70000), CTX, def)?.reason ?? '', /손절/);
  assert.equal(decide(tick({ price: 70500 }), -0.05, position(70000), CTX, def), null);
});

test('트레일링 익절: 익절선 위에서 고점 대비 되밀리면 청산, 익절선 밑으로는 안 내려간다', () => {
  const def = byId('meanrevert'); // 익절 +1.5% · 트레일 -0.8%
  // 고점 73,000 → 청산선 = max(71,050(익절선), 72,416(고점-0.8%)) = 72,416
  assert.equal(decide(tick({ price: 72_500 }), 0, position(70_000, 73_000), CTX, def), null);
  assert.match(
    decide(tick({ price: 72_400 }), 0, position(70_000, 73_000), CTX, def)?.reason ?? '',
    /트레일링 익절/,
  );
  // 고점이 익절선 바로 위(71,100)면 청산선은 익절선(71,050) — 그 아래로는 절대 안 내려갑니다
  assert.match(
    decide(tick({ price: 71_040 }), 0, position(70_000, 71_100), CTX, def)?.reason ?? '',
    /트레일링 익절/,
  );
  // 손절은 트레일링과 무관하게 그대로 동작
  assert.match(decide(tick({ price: 68_900 }), 0, position(70_000, 71_100), CTX, def)?.reason ?? '', /손절/);
});

// ATR 이 큰 장에서 고정 폭이 노이즈에 먼저 걸리는 문제(평균회귀 승률 1/9)에 대한 회귀 테스트
const daily = (atrPct: number | null, over: Partial<DailyIndicators> = {}): DailyIndicators => ({
  ...EMPTY_INDICATORS, atrPct, ma20: 60_000, rsi14: 50, ...over,
});

test('volAdaptive: ATR 이 크면 익절·손절·트레일링 폭이 같은 배율로 넓어진다', () => {
  const def = byId('meanrevert'); // 기준 익절 +1.5% · 손절 -1.5% · 트레일 -0.8%
  const hot = { ...CTX, daily: daily(9) }; // ATR 9% → 배율 3 → 손절 -4.5% · 익절 +4.5%

  // -4.29% 는 기존이라면 손절이지만, ATR 9% 장에서는 노이즈 범위로 보고 버팁니다
  assert.equal(decide(tick({ price: 67_000 }), 0, position(70_000), hot, def), null);
  // -4.57% 로 넓어진 손절선을 넘기면 그때 청산
  assert.match(decide(tick({ price: 66_800 }), 0, position(70_000), hot, def)?.reason ?? '', /손절/);

  // 익절선도 같이 넓어져 손익비가 보존됩니다 (+1.5% 에서 팔지 않음)
  assert.equal(decide(tick({ price: 71_100 }), 0, position(70_000, 71_100), hot, def), null);
});

test('volAdaptive: 배율은 1~3배로 제한되고, 지표가 없으면 기존 폭 그대로다', () => {
  const def = byId('meanrevert');
  // 조용한 장(ATR 1%)에서 폭을 좁히지는 않습니다 — 좁히면 과매매로 되돌아갑니다
  assert.match(
    decide(tick({ price: 68_900 }), 0, position(70_000), { ...CTX, daily: daily(1) }, def)?.reason ?? '',
    /손절/,
  );
  // ATR 30% 라도 손절은 -4.5% 에서 멈춥니다 (상한 3배) — 킬 스위치보다 먼저 걸리게
  assert.match(
    decide(tick({ price: 66_800 }), 0, position(70_000), { ...CTX, daily: daily(30) }, def)?.reason ?? '',
    /손절/,
  );
  // 지표 부트스트랩 전(atrPct null)에는 기존 동작
  assert.match(
    decide(tick({ price: 68_900 }), 0, position(70_000), { ...CTX, daily: daily(null) }, def)?.reason ?? '',
    /손절/,
  );
});

test('volAdaptive 를 켜지 않은 전략은 ATR 과 무관하게 고정 폭을 쓴다', () => {
  const def = byId('momentum'); // volAdaptive 없음
  assert.match(
    decide(tick({ price: 67_000 }), 0, position(70_000), { ...CTX, daily: daily(9) }, def)?.reason ?? '',
    /손절/,
  );
});

test('scalper: 진입 문턱도 ATR 에 비례해 올라간다 (과매매 억제)', () => {
  const def = byId('scalper'); // 기준 문턱 1분 +0.3%
  const hot = (shortChange: number): MarketCtx => ({
    ...CTX, shortChange, prevShortChange: 0.001, daily: daily(9), // ATR 9% → 문턱 0.9%
  });

  // ATR 9% 장에서 1분 +0.5% 는 노이즈 — 기존이라면 진입했을 자리입니다
  assert.equal(decide(tick(), 0.01, null, hot(0.005), def), null);
  // 문턱을 넘으면 진입하고, 사유에 실제 적용된 문턱이 찍힙니다
  const buy = decide(tick(), 0.01, null, hot(0.0095), def);
  assert.equal(buy?.side, 'BUY');
  assert.match(buy?.reason ?? '', /\+0\.90% 상향 돌파/);

  // 조용한 장(지표 없음)에서는 기존 0.3% 문턱 그대로
  assert.equal(
    decide(tick(), 0.01, null, { ...CTX, shortChange: 0.005, prevShortChange: 0.001 }, def)?.side,
    'BUY',
  );
});

test('trackPeak: 보유 중 최고가만 올라가고 내려가지 않는다', () => {
  const pos = position(70_000);
  assert.equal(trackPeak(pos, 69_000), 70_000); // 평단 아래면 평단 유지
  assert.equal(trackPeak(pos, 72_000), 72_000);
  assert.equal(trackPeak(pos, 71_000), 72_000);
  assert.equal(pos.peakPrice, 72_000);
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

test('전략 지표 필터: RSI 과열 제외/MA20 추세 확인', () => {
  const mr = byId('meanrevert');
  const crossing = { ...CTX, prevRate: -0.01 };
  // RSI 70 (과매도 아님) → meanrevert 진입 거부
  assert.equal(
    decide(tick(), -0.021, null, { ...crossing, daily: { ...emptyDaily, rsi14: 75 } }, mr), null);
  // RSI 30 → 진입
  assert.equal(
    decide(tick(), -0.021, null, { ...crossing, daily: { ...emptyDaily, rsi14: 65 } }, mr)?.side, 'BUY');
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
  const highVol = { ...CTX, daily: { ...emptyDaily, atrPct: 4 } }; // 손절 = min(5, max(3, 6)) = 5% (상한)
  // 평단 70000, 현재 67000 = -4.29% : 고정 -3% 면 손절이지만 ATR 손절(-5%)로는 홀드
  assert.equal(decide(tick({ price: 67000 }), 0, position(70000), highVol, dd), null);
  // -5.14% 면 상한 5% 손절 발동 (ATR 1.5배=6% 까지 기다리지 않음)
  assert.match(decide(tick({ price: 66400 }), 0, position(70000), highVol, dd)?.reason ?? '', /손절/);
});

const emptyDaily = {
  ma20: null, ma60: null, rsi14: null, bbUpper: null, bbLower: null, atrPct: null, lastClose: null,
};

test('highbreak: 비대칭 청산 (+3% 익절선부터 트레일링(-1.5%) / -0.8% 손절)', () => {
  const def = byId('highbreak');
  assert.equal(decide(tick({ price: 72000 }), 0, position(70000), CTX, def), null); // +2.86% 아직 익절선 전
  // 고점 73,000(+4.3%)까지 갔다가 되밀릴 때: 청산선 = max(익절선 72,100, 고점×0.985=71,905) = 72,100.
  // 72,500 은 청산선 위 → 홀드
  assert.equal(decide(tick({ price: 72500 }), 0, position(70000, 73000), CTX, def), null);
  // 72,000 은 청산선(72,100) 아래 → 트레일링 익절
  assert.match(
    decide(tick({ price: 72_000 }), 0, position(70000, 73000), CTX, def)?.reason ?? '',
    /트레일링 익절/,
  );
  // -0.8% 손절: 70,000 × 0.992 = 69,440 이하
  assert.match(decide(tick({ price: 69400 }), 0, position(70000), CTX, def)?.reason ?? '', /손절/);
  assert.equal(decide(tick({ price: 69500 }), 0, position(70000), CTX, def), null); // -0.71% 아직 홀드
});

test('highbreak: 고가를 "스치는" 약한 돌파(마진 0.3% 미만)는 진입하지 않는다', () => {
  const def = byId('highbreak');
  const ctx = { ...CTX, dayHigh: 73_900 };
  assert.equal(decide(tick({ price: 74_000 }), 0.01, null, ctx, def), null); // +0.14% — 노이즈
  assert.equal(decide(tick({ price: 74_200 }), 0.01, null, ctx, def)?.side, 'BUY'); // +0.41% — 강한 돌파
});

test('positionSize: 현금 비중으로 정수 수량, 1주 미만이면 0', () => {
  assert.equal(positionSize(10_000_000, 10, 70_000), 14);
  assert.equal(positionSize(10_000_000, 10, 1_650_000), 0);
  assert.equal(positionSize(0, 10, 70_000), 0);
});

test('isRegularSession: KRX 09:00~15:19 (마감 동시호가 제외)', () => {
  assert.equal(isRegularSession('KR', '2026-08-18T10:00:00+09:00'), true);  // 화요일 장중
  assert.equal(isRegularSession('KR', '2026-08-18T15:19:00+09:00'), true);  // 연속 체결 마지막 분
  assert.equal(isRegularSession('KR', '2026-08-18T15:25:00+09:00'), false); // 동시호가 — 예상체결가 구간
  assert.equal(isRegularSession('KR', '2026-08-18T08:50:00+09:00'), false); // 개장 전 동시호가
  assert.equal(isRegularSession('KR', '2026-08-18T17:00:00+09:00'), false); // NXT 시간외
  assert.equal(isRegularSession('KR', '2026-08-22T10:00:00+09:00'), false); // 토요일
});

test('isRegularSession: 미국 09:30~16:00 ET (서머타임 자동)', () => {
  // 8월(DST): 23:00 KST = 10:00 ET → 정규장
  assert.equal(isRegularSession('US', '2026-08-18T23:00:00+09:00'), true);
  // 18:00 KST = 05:00 ET → 프리마켓
  assert.equal(isRegularSession('US', '2026-08-18T18:00:00+09:00'), false);
  // 07:00 KST = 18:00 ET (전일) → 애프터마켓 종료 후
  assert.equal(isRegularSession('US', '2026-08-18T07:00:00+09:00'), false);
});

test('모든 전략이 정규장 전용이다 (시간외 진입 품질 문제는 전략 무관)', () => {
  assert.ok(STRATEGIES.every((s) => s.regularSessionOnly === true));
  // 시간외에는 어떤 전략도 진입하지 않음 (예: meanrevert, NXT 시간외 -2.1% 크로싱)
  const mr = byId('meanrevert');
  const offSession = tick({ tradedAt: '2026-08-18T17:00:00+09:00' });
  assert.equal(decide(offSession, -0.021, null, { ...CTX, prevRate: -0.01 }, mr), null);
});

test('highbreak: 정규장 밖에서는 신고가 갱신에도 진입하지 않는다', () => {
  const def = byId('highbreak');
  const inSession = tick({ price: 74200, tradedAt: '2026-08-18T10:00:00+09:00' });
  const offSession = tick({ price: 74200, tradedAt: '2026-08-18T17:00:00+09:00' }); // NXT 시간외
  const ctx = { ...CTX, dayHigh: 73900 };
  assert.equal(decide(inSession, 0.01, null, ctx, def)?.side, 'BUY');
  assert.equal(decide(offSession, 0.01, null, ctx, def), null);
  // 청산(익절/손절)은 시간외에도 정상 동작해야 합니다
  assert.match(
    decide(tick({ price: 69_000, tradedAt: '2026-08-18T17:00:00+09:00' }), 0, position(70000), CTX, def)?.reason ?? '',
    /손절/,
  );
});

test('isStale: 오래된 틱은 매매 금지', () => {
  const now = Date.parse('2026-08-18T12:00:00+09:00');
  assert.equal(isStale('2026-08-18T11:55:00+09:00', now, 600), false);
  assert.equal(isStale('2026-08-18T11:40:00+09:00', now, 600), true);
  assert.equal(isStale(null, now, 600), true);
});
