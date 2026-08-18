'use client';

import { useEffect, useState } from 'react';
import { clock, money, signPct, upDown } from '@/lib/format';
import type { PaperSummary, PaperStrategySummary } from '@/lib/types';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';
const REFRESH_MS = 5_000;

const COLOR = { up: '#ef5350', down: '#5b8def', flat: '#e8ecf4' } as const;

const krw = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;
const signKrw = (n: number): string => `${n >= 0 ? '+' : '-'}${krw(Math.abs(n))}`;

/** 전략 리더보드 카드 (서브탭 역할) */
function StrategyCard({
  s,
  rank,
  active,
  onClick,
}: {
  s: PaperStrategySummary;
  rank: number;
  active: boolean;
  onClick: () => void;
}) {
  const dir = upDown(s.totals.totalRate);
  return (
    <button
      onClick={onClick}
      className="card"
      style={{
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        borderColor: active ? 'rgba(91, 141, 239, 0.65)' : undefined,
        background: active ? 'rgba(91, 141, 239, 0.10)' : undefined,
      }}
    >
      <div className="label">
        {rank}위 · {s.label}
      </div>
      <div className="value" style={{ color: COLOR[dir], fontSize: 20 }}>
        {signPct(s.totals.totalRate)}
      </div>
      <div className="hint">
        {signKrw(s.totals.totalPnl)} · 포지션 {s.positions.length} · 체결 {s.totals.tradeCount}
      </div>
    </button>
  );
}

export function PaperPanel() {
  const [pf, setPf] = useState<PaperSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/paper`);
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) {
          setError(json.error ?? `조회 실패 (${res.status})`);
          return;
        }
        setError(null);
        setPf(json as PaperSummary);
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
  if (!pf || pf.strategies.length === 0) return <div className="empty">페이퍼 계좌 불러오는 중…</div>;

  const cur =
    pf.strategies.find((s) => s.strategyId === selected) ?? pf.strategies[0]!;
  const t = cur.totals;

  return (
    <>
      <p className="panel-desc" style={{ marginBottom: 8 }}>
        전략 {pf.strategies.length}개가 각자 <strong>1억원</strong>으로 같은 시장을 동시에 매매합니다
        (수익률 순 정렬). 카드를 클릭하면 상세가 바뀝니다.
      </p>
      <section className="grid-kpi" style={{ marginBottom: 14 }}>
        {pf.strategies.map((s, i) => (
          <StrategyCard
            key={s.strategyId}
            s={s}
            rank={i + 1}
            active={s.strategyId === cur.strategyId}
            onClick={() => setSelected(s.strategyId)}
          />
        ))}
      </section>

      <section className="card" style={{ marginBottom: 12 }}>
        <p className="panel-title">{cur.label} 전략</p>
        <p className="panel-desc">{cur.description}</p>
        <div className="grid-kpi" style={{ marginTop: 8 }}>
          <div className="card">
            <div className="label">총자산 (가상)</div>
            <div className="value">{krw(t.equity)}</div>
            <div className="hint">시작 {krw(t.initialCash)}</div>
          </div>
          <div className="card">
            <div className="label">총손익</div>
            <div className="value" style={{ color: COLOR[upDown(t.totalPnl)] }}>{signKrw(t.totalPnl)}</div>
            <div className="hint" style={{ color: COLOR[upDown(t.totalPnl)] }}>{signPct(t.totalRate)}</div>
          </div>
          <div className="card">
            <div className="label">실현 손익</div>
            <div className="value" style={{ color: COLOR[upDown(t.realizedPnl)] }}>
              {signKrw(t.realizedPnl)}
            </div>
            <div className="hint">청산 완료분 누계</div>
          </div>
          <div className="card">
            <div className="label">현금</div>
            <div className="value">{krw(t.cash)}</div>
            <div className="hint">포지션 {krw(t.positionsValue)}</div>
          </div>
        </div>
      </section>

      <div className="cols">
        <section className="card">
          <p className="panel-title">보유 포지션</p>
          <p className="panel-desc">
            strategy-worker → <code>paper.orders</code> → 체결 시뮬레이터. 실주문 없음.
          </p>
          {cur.positions.length === 0 ? (
            <div className="empty">보유 포지션이 없습니다. 진입 조건 대기 중…</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>종목</th>
                  <th>수량</th>
                  <th>평단가</th>
                  <th>현재가</th>
                  <th>평가금액</th>
                  <th>평가손익</th>
                </tr>
              </thead>
              <tbody>
                {cur.positions.map((p) => {
                  const d = upDown(p.unrealizedRate);
                  return (
                    <tr key={p.symbol}>
                      <td>
                        <div className="mname">
                          <span>{p.name}</span>
                          <small><span className={`badge ${p.market}`}>{p.symbol}</span></small>
                        </div>
                      </td>
                      <td>{p.quantity.toLocaleString('ko-KR')}</td>
                      <td>{money(p.avgPrice, p.currency)}</td>
                      <td>{money(p.lastPrice, p.currency)}</td>
                      <td style={{ fontWeight: 600 }}>{money(p.marketValue, p.currency)}</td>
                      <td style={{ color: COLOR[d], fontWeight: 600 }}>{signPct(p.unrealizedRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <p className="panel-title">체결 내역</p>
          <p className="panel-desc">전략의 판단 근거(reason)가 함께 기록됩니다</p>
          {cur.trades.length === 0 ? (
            <div className="empty">아직 체결이 없습니다.</div>
          ) : (
            <div className="feed">
              {cur.trades.map((tr) => (
                <div
                  key={tr.tradeId}
                  className={`alert ${tr.status === 'REJECTED' ? 'WARN' : tr.side === 'BUY' ? 'INFO' : 'CRITICAL'}`}
                >
                  <div className="head">
                    <span className="type">
                      {tr.status === 'REJECTED' ? '거부' : tr.side === 'BUY' ? '매수' : '매도'}
                    </span>
                    <span>{clock(tr.filledAt)}</span>
                  </div>
                  <div className="msg">
                    {tr.name} {tr.quantity.toLocaleString('ko-KR')}주 @ {money(tr.price, tr.currency ?? 'KRW')}
                    {tr.realizedPnl !== undefined && (
                      <span style={{ color: COLOR[upDown(tr.realizedPnl)], marginLeft: 6 }}>
                        ({signKrw(tr.realizedPnl)})
                      </span>
                    )}
                    {tr.rejectReason && <span style={{ marginLeft: 6 }}>— {tr.rejectReason}</span>}
                  </div>
                  <div className="who">{tr.reason}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <p className="panel-desc" style={{ marginTop: 10 }}>
        ⚠️ {pf.strategyNote}
      </p>
    </>
  );
}
