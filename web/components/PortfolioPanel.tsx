'use client';

import { useEffect, useState } from 'react';
import { money, signPct, upDown } from '@/lib/format';
import type { PortfolioSummary } from '@/lib/types';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';
const REFRESH_MS = 30_000;

const COLOR = { up: '#ef5350', down: '#5b8def', flat: '#e8ecf4' } as const;
/** 비중 바 색상 팔레트 (종목 수만큼 순환) */
const PALETTE = ['#5b8def', '#7ee0b4', '#f0c778', '#ef8b8b', '#b48def', '#6fd3e0', '#e0a76f', '#9dbcf7'];

const krw = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;

export function PortfolioPanel() {
  const [pf, setPf] = useState<PortfolioSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/portfolio`);
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) {
          setError(json.error ?? `포트폴리오 조회 실패 (${res.status})`);
          return;
        }
        setError(null);
        setPf(json as PortfolioSummary);
      } catch {
        if (alive) setError('API 서버(4000)에 연결할 수 없습니다.');
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (error) return <div className="empty">{error}</div>;
  if (!pf) return <div className="empty">포트폴리오 불러오는 중…</div>;

  const t = pf.totals;
  const profitDir = upDown(t.profitKrw);
  const dailyDir = upDown(t.dailyProfitKrw);
  const masked = `${pf.accountNo.slice(0, 4)}****${pf.accountNo.slice(-2)}`;

  return (
    <>
      <section className="grid-kpi">
        <div className="card">
          <div className="label">평가금액 (원화 환산)</div>
          <div className="value">{krw(t.marketKrw)}</div>
          <div className="hint">
            계좌 {masked} · $1 = {pf.usdKrw.toLocaleString('ko-KR')}원
          </div>
        </div>
        <div className="card">
          <div className="label">투자원금</div>
          <div className="value">{krw(t.purchaseKrw)}</div>
          <div className="hint">통화별 합산 환산</div>
        </div>
        <div className="card">
          <div className="label">평가손익</div>
          <div className="value" style={{ color: COLOR[profitDir] }}>
            {t.profitKrw >= 0 ? '+' : '-'}{krw(Math.abs(t.profitKrw))}
          </div>
          <div className="hint" style={{ color: COLOR[profitDir] }}>{signPct(t.profitRate)}</div>
        </div>
        <div className="card">
          <div className="label">일간 손익</div>
          <div className="value" style={{ color: COLOR[dailyDir] }}>
            {t.dailyProfitKrw >= 0 ? '+' : '-'}{krw(Math.abs(t.dailyProfitKrw))}
          </div>
          <div className="hint" style={{ color: COLOR[dailyDir] }}>{signPct(t.dailyRate)}</div>
        </div>
        <div className="card">
          <div className="label">보유 종목</div>
          <div className="value">{pf.items.length}</div>
          <div className="hint">30초 캐시 (Redis)</div>
        </div>
      </section>

      <section className="card" style={{ marginBottom: 12 }}>
        <p className="panel-title">종목 비중</p>
        <p className="panel-desc">원화 환산 평가금액 기준</p>
        <svg viewBox="0 0 720 26" width="100%" height={26} role="img" aria-label="종목 비중">
          {(() => {
            let x = 0;
            return pf.items.map((i, idx) => {
              const w = i.weight * 720;
              const rect = (
                <rect key={i.symbol} x={x} y={0} width={Math.max(w - 1.5, 0.5)} height={26} rx={3}
                  fill={PALETTE[idx % PALETTE.length]}>
                  <title>{`${i.name} ${(i.weight * 100).toFixed(1)}%`}</title>
                </rect>
              );
              x += w;
              return rect;
            });
          })()}
        </svg>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 10 }}>
          {pf.items.map((i, idx) => (
            <span key={i.symbol} style={{ fontSize: 12, color: '#8b94a7' }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 5,
                background: PALETTE[idx % PALETTE.length] }} />
              {i.name} {(i.weight * 100).toFixed(1)}%
            </span>
          ))}
        </div>
      </section>

      <section className="card">
        <p className="panel-title">보유 종목</p>
        <p className="panel-desc">
          토스 <code>/api/v1/holdings</code> + 환율 API. 손익은 세전, 거래 통화 기준.
        </p>
        <table>
          <thead>
            <tr>
              <th>종목</th>
              <th>수량</th>
              <th>평단가</th>
              <th>현재가</th>
              <th>평가금액(₩)</th>
              <th>수익률</th>
              <th>일간</th>
            </tr>
          </thead>
          <tbody>
            {pf.items.map((i) => {
              const dir = upDown(i.profitRate);
              const dDir = upDown(i.dailyRate);
              return (
                <tr key={i.symbol}>
                  <td>
                    <div className="mname">
                      <span>{i.name}</span>
                      <small><span className={`badge ${i.market}`}>{i.symbol}</span></small>
                    </div>
                  </td>
                  <td>{i.quantity.toLocaleString('ko-KR', { maximumFractionDigits: 6 })}</td>
                  <td>{money(i.avgPrice, i.currency)}</td>
                  <td>{money(i.lastPrice, i.currency)}</td>
                  <td style={{ fontWeight: 600 }}>{krw(i.marketValueKrw)}</td>
                  <td style={{ color: COLOR[dir], fontWeight: 600 }}>{signPct(i.profitRate)}</td>
                  <td style={{ color: COLOR[dDir] }}>{signPct(i.dailyRate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
