'use client';

import { hhmm } from '@/lib/format';
import type { Currency, FocusIndicators, MinuteCandle } from '@/lib/types';

interface Props {
  data: ({ t: string } & MinuteCandle)[];
  currency: Currency;
  prevClose: number;
  indicators?: FocusIndicators | null;
  /** '1m' = 분봉(당일), '1d' = 일봉 */
  interval?: '1m' | '1d';
}

/** 표시 중인 캔들 기준 롤링 지표 — 차트 시간 단위와 항상 일치합니다 */
function rollingSeries(closes: number[], window: number) {
  const ma: (number | null)[] = [];
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < closes.length; i += 1) {
    if (i < window - 1) {
      ma.push(null); upper.push(null); lower.push(null);
      continue;
    }
    const win = closes.slice(i - window + 1, i + 1);
    const mean = win.reduce((s, v) => s + v, 0) / window;
    const sd = Math.sqrt(win.reduce((s, v) => s + (v - mean) ** 2, 0) / window);
    ma.push(mean); upper.push(mean + 2 * sd); lower.push(mean - 2 * sd);
  }
  return { ma, upper, lower };
}

function polylinePoints(
  series: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  return series
    .map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');
}

const UP = '#ef5350';
const DOWN = '#5b8def';
const MA_COLOR = '#f0c778';
const BB_COLOR = '#b48def';

const fmt = (v: number, currency: Currency): string =>
  currency === 'KRW'
    ? Math.round(v).toLocaleString('ko-KR')
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * 의존성 없는 SVG 캔들 차트.
 * quote 워커가 틱 스트림에서 롤업한 1분봉(mkt:candle:*)을 그대로 그립니다.
 */
export function PriceChart({ data, currency, prevClose, indicators, interval = '1m' }: Props) {
  if (data.length === 0) {
    return <div className="empty">아직 캔들이 없습니다. producer 와 quote 워커를 실행해 주세요.</div>;
  }

  const W = 720;
  const H = 200;
  const PAD_B = 22;
  const PAD_T = 14;
  const innerH = H - PAD_B - PAD_T;
  const isDaily = interval === '1d';

  // 표시 중인 캔들로 계산한 롤링 MA20·볼린저 — 분 모드면 "20분", 일 모드면 "20일".
  // 차트의 시간 단위와 지표의 시간 단위가 항상 같습니다.
  const { ma, upper, lower } = rollingSeries(data.map((d) => d.c), 20);

  let min = Math.min(...data.map((d) => d.l));
  let max = Math.max(...data.map((d) => d.h));
  // 전일 종가 기준선은 분 모드에서만 의미가 있습니다.
  if (!isDaily && prevClose > 0) {
    min = Math.min(min, prevClose);
    max = Math.max(max, prevClose);
  }
  for (const s of [ma, upper, lower]) {
    for (const v of s) {
      if (v !== null) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
  }

  // 분 모드 한정: 전략이 쓰는 일봉 기준선(일MA20)을 수평선으로 겹쳐 보여줍니다.
  // 장중 가격대에서 크게 벗어나면 캔들이 납작해지므로 그리지 않습니다.
  const nearRange = (v: number | null | undefined): v is number =>
    v != null && v > 0 && v >= min - (max - min) * 0.5 && v <= max + (max - min) * 0.5;
  const levels: { value: number; label: string; color: string }[] = [];
  if (!isDaily && nearRange(indicators?.ma20)) {
    levels.push({ value: indicators!.ma20!, label: '일MA20', color: MA_COLOR });
  }
  for (const lv of levels) {
    min = Math.min(min, lv.value);
    max = Math.max(max, lv.value);
  }

  const span = max - min || max * 0.001 || 1;
  const y = (v: number) => PAD_T + innerH - ((v - min) / span) * innerH;

  const barW = W / data.length;
  const cx = (i: number) => i * barW + barW / 2;
  const ticks = [max, (max + min) / 2, min];
  const axisLabel = (t: string): string =>
    isDaily ? `${t.slice(4, 6)}/${t.slice(6, 8)}` : hhmm(t);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="1분봉 차트">
      {ticks.map((tv, i) => (
        <g key={i}>
          <line x1={0} x2={W} y1={y(tv)} y2={y(tv)} stroke="#1e2430" strokeWidth={1} />
          <text x={4} y={y(tv) - 4} fill="#8b94a7" fontSize={10}>
            {fmt(tv, currency)}
          </text>
        </g>
      ))}

      {!isDaily && prevClose > 0 && (
        <line
          x1={0}
          x2={W}
          y1={y(prevClose)}
          y2={y(prevClose)}
          stroke="#8b94a7"
          strokeWidth={1}
          strokeDasharray="4 4"
          opacity={0.7}
        />
      )}

      {/* 롤링 볼린저밴드 (표시 시간 단위 기준) */}
      <polyline points={polylinePoints(upper, cx, y)} fill="none" stroke={BB_COLOR} strokeWidth={1} opacity={0.55} />
      <polyline points={polylinePoints(lower, cx, y)} fill="none" stroke={BB_COLOR} strokeWidth={1} opacity={0.55} />
      {/* 롤링 MA20 */}
      <polyline points={polylinePoints(ma, cx, y)} fill="none" stroke={MA_COLOR} strokeWidth={1.5} opacity={0.9} />

      {levels.map((lv) => (
        <g key={lv.label}>
          <line
            x1={0} x2={W} y1={y(lv.value)} y2={y(lv.value)}
            stroke={lv.color} strokeWidth={1} strokeDasharray="6 3" opacity={0.6}
          />
          <text x={W - 4} y={y(lv.value) - 4} fill={lv.color} fontSize={9.5} textAnchor="end">
            {lv.label} {fmt(lv.value, currency)}
          </text>
        </g>
      ))}

      {data.map((d, i) => {
        const up = d.c >= d.o;
        const color = up ? UP : DOWN;
        const x = cx(i);
        const bodyTop = y(Math.max(d.o, d.c));
        const bodyH = Math.max(1, Math.abs(y(d.o) - y(d.c)));
        return (
          <g key={d.t}>
            <line x1={x} x2={x} y1={y(d.h)} y2={y(d.l)} stroke={color} strokeWidth={1} />
            <rect x={x - barW * 0.32} y={bodyTop} width={barW * 0.64} height={bodyH} fill={color} rx={1}>
              <title>{`${axisLabel(d.t)} · 시 ${fmt(d.o, currency)} 고 ${fmt(d.h, currency)} 저 ${fmt(d.l, currency)} 종 ${fmt(d.c, currency)} (${isDaily ? '거래량' : '틱'} ${d.n.toLocaleString('ko-KR')})`}</title>
            </rect>
          </g>
        );
      })}

      {data.map((d, i) => {
        const step = Math.ceil(data.length / 8);
        if (i % step !== 0) return null;
        return (
          <text key={`l${d.t}`} x={cx(i)} y={H - 6} fill="#8b94a7" fontSize={9.5} textAnchor="middle">
            {axisLabel(d.t)}
          </text>
        );
      })}
    </svg>
  );
}
