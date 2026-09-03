'use client';

import { useEffect, useState } from 'react';
import { money } from '@/lib/format';
import type { BitgakView, DashboardSummary, QuoteRow } from '@/lib/types';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';
const REFRESH_MS = 60_000; // 선은 일봉 기반이라 하루에 한 번 바뀜 — 느긋하게

/** 선 스타일. 전략 화면과 색을 맞춰 "누가 그은 선인지" 바로 알게 합니다 */
const LINE_STYLE: Record<string, { color: string; dash?: string; width: number }> = {
  bitgak: { color: '#4cc38a', width: 1.8 },
  bitgakw: { color: '#c9a2ff', width: 1.8 },
  gogo: { color: '#8b94a7', dash: '5 4', width: 1.2 },
  gogojeo: { color: '#ff9f5b', width: 1.8 },
};

const UP = '#ef5350';
const DOWN = '#5b8def';

export function BitgakPanel() {
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [symbol, setSymbol] = useState<string>('005930');
  const [view, setView] = useState<BitgakView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 종목 목록 (요약 API 재사용)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/summary`);
        if (!res.ok) return;
        const json = (await res.json()) as DashboardSummary;
        if (alive) setQuotes([...json.quotes].sort((a, b) => a.name.localeCompare(b.name, 'ko')));
      } catch { /* 아래 뷰 fetch 가 에러를 표시 */ }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/bitgak?symbol=${symbol}`);
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) {
          setError(json.error ?? `조회 실패 (${res.status})`);
          setView(null);
          return;
        }
        setError(null);
        setView(json as BitgakView);
      } catch {
        if (alive) setError('API 서버(4000)에 연결할 수 없습니다.');
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [symbol]);

  return (
    <>
      <p className="panel-desc" style={{ marginBottom: 8 }}>
        빗각 전략들이 <strong>실제로 쓰는 것과 같은 함수</strong>로 그린 추세선입니다.
        ● 은 선을 만든 피벗(거래량 실린 저점/고점), ○ 은 채택 안 된 후보. 선이 없는
        종목은 그 전략이 지금 진입 후보로 안 본다는 뜻입니다.
      </p>

      <section className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            style={{
              background: '#12161f', color: '#e8ecf4', border: '1px solid #2a3242',
              borderRadius: 6, padding: '6px 10px', fontFamily: 'inherit', fontSize: 13,
            }}
          >
            {quotes.length === 0 && <option value={symbol}>{symbol}</option>}
            {quotes.map((q) => (
              <option key={q.symbol} value={q.symbol}>
                {q.name} ({q.symbol})
              </option>
            ))}
          </select>
          {view && (
            <span style={{ fontSize: 13, color: '#8b94a7' }}>
              현재가 <strong style={{ color: '#e8ecf4' }}>{money(view.lastPrice, view.currency)}</strong>
              {' · '}일봉 {view.candles.length}개 (as-of 전일까지)
            </span>
          )}
        </div>

        {error && <div className="empty">{error}</div>}
        {!error && !view && <div className="empty">불러오는 중…</div>}
        {view && <BitgakChart view={view} />}

        {view && (
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
            {(['bitgak', 'bitgakw', 'gogojeo'] as const).map((id) => {
              const line = view.lines.find((l) => l.id === id);
              const st = LINE_STYLE[id]!;
              const label = id === 'bitgak' ? '일봉 빗각' : id === 'bitgakw' ? '주봉 빗각' : '고고저 하단';
              return (
                <span key={id} style={{ fontSize: 12.5, color: line ? st.color : '#5a6274' }}>
                  ━ {label}:{' '}
                  {line
                    ? `오늘 ${money(line.today, view.currency)}`
                    : '없음 (상승 저점쌍/하락 고점쌍 없음)'}
                </span>
              );
            })}
          </div>
        )}
      </section>

      <p className="panel-desc">
        일봉·주봉 빗각은 <strong>매수 지지선이자 손절선</strong>(선 이탈 시 청산),
        고고저 하단은 하락 채널에서 반등을 노리는 매수선입니다. 회색 점선(고고 저항선)은
        하단이 어느 선을 평행 이동한 것인지 보여주는 맥락입니다.
      </p>
    </>
  );
}

function BitgakChart({ view }: { view: BitgakView }) {
  const { candles, lines, currency } = view;
  if (candles.length === 0) return <div className="empty">일봉이 없습니다.</div>;

  const W = 720;
  const H = 280;
  const PAD_B = 22;
  const PAD_T = 14;
  const PAD_R = 64; // 오른쪽: 오늘 선 값 라벨 공간
  const innerH = H - PAD_B - PAD_T;
  const innerW = W - PAD_R;

  // 스케일은 캔들 기준. 선은 가격대 근처(±30% 범위)일 때만 스케일에 포함해
  // 멀리 떨어진 선이 캔들을 납작하게 만드는 것을 막습니다 (밖이면 잘려 보임).
  let min = Math.min(...candles.map((c) => c.l));
  let max = Math.max(...candles.map((c) => c.h));
  const pad = (max - min) * 0.3 || max * 0.01;
  for (const line of lines) {
    for (const v of [...line.series, line.today]) {
      if (v !== null && v >= min - pad && v <= max + pad) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
  }
  const span = max - min || max * 0.001 || 1;
  const y = (v: number) => PAD_T + innerH - ((v - min) / span) * innerH;
  const barW = innerW / candles.length;
  const cx = (i: number) => i * barW + barW / 2;
  const idxOf = new Map(candles.map((c, i) => [c.t, i]));

  const fmt = (v: number): string => money(v, currency);
  const ticks = [max, (max + min) / 2, min];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="빗각 차트">
      {ticks.map((tv, i) => (
        <g key={i}>
          <line x1={0} x2={innerW} y1={y(tv)} y2={y(tv)} stroke="#1e2430" strokeWidth={1} />
          <text x={4} y={y(tv) - 4} fill="#8b94a7" fontSize={10}>{fmt(tv)}</text>
        </g>
      ))}

      {/* 캔들 */}
      {candles.map((d, i) => {
        const up = d.c >= d.o;
        const color = up ? UP : DOWN;
        const x = cx(i);
        const bodyTop = y(Math.max(d.o, d.c));
        const bodyH = Math.max(1, Math.abs(y(d.o) - y(d.c)));
        return (
          <g key={d.t}>
            <line x1={x} x2={x} y1={y(d.h)} y2={y(d.l)} stroke={color} strokeWidth={1} opacity={0.85} />
            <rect x={x - barW * 0.3} y={bodyTop} width={barW * 0.6} height={bodyH} fill={color} rx={1} opacity={0.85}>
              <title>{`${d.t.slice(0, 10)} · 시 ${fmt(d.o)} 고 ${fmt(d.h)} 저 ${fmt(d.l)} 종 ${fmt(d.c)} · 거래량 ${d.v.toLocaleString('ko-KR')}`}</title>
            </rect>
          </g>
        );
      })}

      {/* 추세선들 */}
      {lines.map((line) => {
        const st = LINE_STYLE[line.id] ?? { color: '#8b94a7', width: 1.2 };
        const pts = line.series
          .map((v, i) => (v === null ? null : `${cx(i).toFixed(1)},${y(v).toFixed(1)}`))
          .filter(Boolean)
          .join(' ');
        return (
          <g key={line.id}>
            <polyline
              points={pts} fill="none" stroke={st.color}
              strokeWidth={st.width} strokeDasharray={st.dash} opacity={0.9}
            />
            {/* 채택 안 된 후보 피벗 (흐리게) */}
            {line.candidates.map((p) => {
              const i = idxOf.get(p.t);
              if (i === undefined) return null;
              return (
                <circle
                  key={`c${p.t}`} cx={cx(i)} cy={y(p.price)} r={3}
                  fill="none" stroke={st.color} strokeWidth={1} opacity={0.35}
                />
              );
            })}
            {/* 선을 만든 피벗/앵커 (진하게) */}
            {line.points.map((p) => {
              const i = idxOf.get(p.t);
              if (i === undefined) return null;
              return (
                <circle key={`p${p.t}`} cx={cx(i)} cy={y(p.price)} r={4} fill={st.color} opacity={0.95}>
                  <title>{`${line.label} ${p.role === 'anchor' ? '앵커(최저점)' : '피벗'} · ${p.t.slice(0, 10)} · ${fmt(p.price)}`}</title>
                </circle>
              );
            })}
            {/* 오늘 투영값 라벨 (오른쪽 여백) */}
            {line.today >= min && line.today <= max && (
              <text x={innerW + 4} y={y(line.today) + 3.5} fill={st.color} fontSize={10}>
                {fmt(line.today)}
              </text>
            )}
          </g>
        );
      })}

      {/* x축 날짜 */}
      {candles.map((d, i) => {
        const step = Math.ceil(candles.length / 8);
        if (i % step !== 0) return null;
        return (
          <text key={`l${d.t}`} x={cx(i)} y={H - 6} fill="#8b94a7" fontSize={9.5} textAnchor="middle">
            {`${d.t.slice(5, 7)}/${d.t.slice(8, 10)}`}
          </text>
        );
      })}
    </svg>
  );
}
