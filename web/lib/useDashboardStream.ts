'use client';

import { useEffect, useRef, useState } from 'react';
import type { DashboardSummary, PriceAlert } from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';
const ALERT_MAX = 40;

export type ConnState = 'connecting' | 'live' | 'error';

/**
 * 브라우저는 Kafka 에 직접 붙을 수 없으므로 API 서버의 SSE 엔드포인트를 구독합니다.
 *  - snapshot 이벤트: Redis 시세 스냅샷 + focus 종목 1분봉 (2초 주기)
 *  - alert 이벤트   : Redis Pub/Sub 으로 흘러온 가격 알림 (발생 즉시)
 * focus 종목이 바뀌면 EventSource 를 다시 연결합니다.
 */
export function useDashboardStream(focus?: string) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [state, setState] = useState<ConnState>('connecting');
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    // 새로고침 시 Pub/Sub 으로는 과거 알림을 받을 수 없으므로, 최근 알림은 REST 로 한 번 채웁니다.
    fetch(`${API_BASE}/api/alerts`)
      .then((r) => r.json())
      .then((rows: PriceAlert[]) => {
        rows.forEach((a) => seen.current.add(a.alertId));
        setAlerts(rows.slice(0, ALERT_MAX));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const url = new URL(`${API_BASE}/api/stream`);
    if (focus) url.searchParams.set('focus', focus);
    const es = new EventSource(url);

    es.addEventListener('open', () => setState('live'));
    es.addEventListener('snapshot', (e) => {
      setState('live');
      setSummary(JSON.parse((e as MessageEvent).data) as DashboardSummary);
    });
    es.addEventListener('alert', (e) => {
      const alert = JSON.parse((e as MessageEvent).data) as PriceAlert;
      if (seen.current.has(alert.alertId)) return;
      seen.current.add(alert.alertId);
      setAlerts((prev) => [alert, ...prev].slice(0, ALERT_MAX));
    });
    es.addEventListener('error', () => setState('error'));

    return () => es.close();
  }, [focus]);

  return { summary, alerts, state };
}
