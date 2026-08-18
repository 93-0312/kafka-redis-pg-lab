'use client';

import { clock, money, signPct, upDown } from '@/lib/format';
import type { QuoteRow } from '@/lib/types';

const COLOR = { up: '#ef5350', down: '#5b8def', flat: '#8b94a7' } as const;

export function QuoteTable({
  rows,
  focus,
  onFocus,
}: {
  rows: QuoteRow[];
  focus: string | null;
  onFocus: (symbol: string) => void;
}) {
  if (rows.length === 0) {
    return <div className="empty">아직 시세가 없습니다. producer 를 실행해 주세요.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>종목</th>
          <th>현재가</th>
          <th>등락률</th>
          <th>전일 대비</th>
          <th>체결 시각</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((q) => {
          const dir = upDown(q.changeRate);
          return (
            <tr
              key={q.symbol}
              onClick={() => onFocus(q.symbol)}
              style={{ cursor: 'pointer', background: q.symbol === focus ? '#1a2130' : undefined }}
              title="클릭하면 차트가 이 종목으로 바뀝니다"
            >
              <td>
                <div className="mname">
                  <span>{q.name}</span>
                  <small>
                    <span className={`badge ${q.market}`}>{q.symbol}</span>
                  </small>
                </div>
              </td>
              <td style={{ fontWeight: 600 }}>{money(q.price, q.currency)}</td>
              <td style={{ color: COLOR[dir], fontWeight: 600 }}>{signPct(q.changeRate)}</td>
              <td style={{ color: COLOR[dir] }}>
                {q.change === 0 ? '-' : money(Math.abs(q.change), q.currency)}
              </td>
              <td style={{ color: '#8b94a7' }}>{clock(q.tradedAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
