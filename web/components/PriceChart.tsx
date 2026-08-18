'use client';

import { hhmm } from '@/lib/format';
import type { Currency, MinuteCandle } from '@/lib/types';

interface Props {
  data: ({ t: string } & MinuteCandle)[];
  currency: Currency;
  prevClose: number;
}

const UP = '#ef5350';
const DOWN = '#5b8def';

const fmt = (v: number, currency: Currency): string =>
  currency === 'KRW'
    ? Math.round(v).toLocaleString('ko-KR')
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * 의존성 없는 SVG 캔들 차트.
 * quote 워커가 틱 스트림에서 롤업한 1분봉(mkt:candle:*)을 그대로 그립니다.
 */
export function PriceChart({ data, currency, prevClose }: Props) {
  if (data.length === 0) {
    return <div className="empty">아직 캔들이 없습니다. producer 와 quote 워커를 실행해 주세요.</div>;
  }

  const W = 720;
  const H = 200;
  const PAD_B = 22;
  const PAD_T = 14;
  const innerH = H - PAD_B - PAD_T;

  let min = Math.min(...data.map((d) => d.l));
  let max = Math.max(...data.map((d) => d.h));
  // 전일 종가 기준선도 차트 범위에 들어오게 합니다.
  if (prevClose > 0) {
    min = Math.min(min, prevClose);
    max = Math.max(max, prevClose);
  }
  const span = max - min || max * 0.001 || 1;
  const y = (v: number) => PAD_T + innerH - ((v - min) / span) * innerH;

  const barW = W / data.length;
  const ticks = [max, (max + min) / 2, min];

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

      {prevClose > 0 && (
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

      {data.map((d, i) => {
        const up = d.c >= d.o;
        const color = up ? UP : DOWN;
        const cx = i * barW + barW / 2;
        const bodyTop = y(Math.max(d.o, d.c));
        const bodyH = Math.max(1, Math.abs(y(d.o) - y(d.c)));
        return (
          <g key={d.t}>
            <line x1={cx} x2={cx} y1={y(d.h)} y2={y(d.l)} stroke={color} strokeWidth={1} />
            <rect x={cx - barW * 0.32} y={bodyTop} width={barW * 0.64} height={bodyH} fill={color} rx={1}>
              <title>{`${hhmm(d.t)} · 시 ${fmt(d.o, currency)} 고 ${fmt(d.h, currency)} 저 ${fmt(d.l, currency)} 종 ${fmt(d.c, currency)} (틱 ${d.n})`}</title>
            </rect>
          </g>
        );
      })}

      {data.map((d, i) => {
        const step = Math.ceil(data.length / 8);
        if (i % step !== 0) return null;
        return (
          <text key={`l${d.t}`} x={i * barW + barW / 2} y={H - 6} fill="#8b94a7" fontSize={9.5} textAnchor="middle">
            {hhmm(d.t)}
          </text>
        );
      })}
    </svg>
  );
}
