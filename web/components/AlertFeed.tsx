'use client';

import { clock, signPct } from '@/lib/format';
import type { PriceAlert } from '@/lib/types';

const TYPE_LABEL: Record<PriceAlert['type'], string> = {
  SURGE: '급등',
  PLUNGE: '급락',
  SPIKE: '단기 급변동',
};

export function AlertFeed({ alerts }: { alerts: PriceAlert[] }) {
  if (alerts.length === 0) {
    return <div className="empty">아직 발생한 가격 알림이 없습니다.</div>;
  }

  return (
    <div className="feed">
      {alerts.map((a) => (
        <div key={a.alertId} className={`alert ${a.severity}`}>
          <div className="head">
            <span className="type">{TYPE_LABEL[a.type]}</span>
            <span>{clock(a.detectedAt)}</span>
          </div>
          <div className="msg">{a.message}</div>
          <div className="who">
            {a.name}({a.symbol}) · {signPct(a.changeRate)}
          </div>
        </div>
      ))}
    </div>
  );
}
