'use client';

import { useEffect, useState } from 'react';
import { AlertFeed } from '@/components/AlertFeed';
import { BitgakPanel } from '@/components/BitgakPanel';
import { PaperPanel } from '@/components/PaperPanel';
import { PortfolioPanel } from '@/components/PortfolioPanel';
import { PriceChart } from '@/components/PriceChart';
import { QuoteTable } from '@/components/QuoteTable';
import { signPct, upDown } from '@/lib/format';
import type { ChartInterval, Market, PriceAlert } from '@/lib/types';
import { useDashboardStream } from '@/lib/useDashboardStream';

const STATUS_TEXT = {
  connecting: 'SSE 연결 중…',
  live: '실시간 수신 중',
  error: 'API 서버(4000) 연결 실패',
} as const;

const COLOR = { up: '#ef5350', down: '#5b8def', flat: '#e8ecf4' } as const;

type Tab = Market | 'PF' | 'PAPER' | 'BITGAK';

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'KR', label: '국내', hint: 'KRX 09:00–15:30' },
  { key: 'US', label: '미국', hint: '23:30–06:00 KST' },
  { key: 'PF', label: '포트폴리오', hint: '내 계좌' },
  { key: 'PAPER', label: '페이퍼', hint: '가상 매매' },
  { key: 'BITGAK', label: '빗각', hint: '추세선 시각화' },
];

/** 구버전 알림에는 market 필드가 없으므로 심볼로 추정합니다 (KRX = 6자리 숫자) */
const alertMarket = (a: PriceAlert): Market => a.market ?? (/^\d{6}$/.test(a.symbol) ? 'KR' : 'US');

export default function Page() {
  const [tab, setTab] = useState<Tab>('KR');
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const [chartInterval, setChartInterval] = useState<ChartInterval>('1m');
  const { summary, alerts, state } = useDashboardStream(focus, chartInterval);

  const market: Market = tab === 'PF' || tab === 'PAPER' || tab === 'BITGAK' ? 'KR' : tab;
  const quotes = (summary?.quotes ?? []).filter((q) => q.market === market);
  const tabAlerts = alerts.filter((a) => alertMarket(a) === market);

  // 탭 전환 시 현재 focus 가 다른 시장이면 이 탭의 1위 종목으로 차트를 옮깁니다.
  useEffect(() => {
    if (tab === 'PF' || tab === 'PAPER' || tab === 'BITGAK' || !summary) return;
    const inTab = quotes.some((q) => q.symbol === summary.focus);
    if (!inTab && quotes[0]) setFocus(quotes[0].symbol);
  }, [tab, summary]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = {
    symbols: quotes.length,
    up: quotes.filter((q) => q.changeRate > 0).length,
    down: quotes.filter((q) => q.changeRate < 0).length,
    flat: quotes.filter((q) => q.changeRate === 0).length,
  };

  const focusQuote = quotes.find((q) => q.symbol === summary?.focus);

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>토스 시세 실시간 파이프라인</h1>
          <div className="sub">
            토스 Open API 폴링 → Kafka <code>market.ticks</code> → quote 워커 / alert 워커 → Redis → SSE → 이 화면
          </div>
        </div>
        <span className="status">
          <span className={`dot ${state}`} />
          {STATUS_TEXT[state]}
        </span>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            <small>{t.hint}</small>
          </button>
        ))}
      </nav>

      {tab === 'PF' ? (
        <PortfolioPanel />
      ) : tab === 'PAPER' ? (
        <PaperPanel />
      ) : tab === 'BITGAK' ? (
        <BitgakPanel />
      ) : (
        <>
      <section className="grid-kpi">
        <div className="card">
          <div className="label">추적 종목</div>
          <div className="value">{totals.symbols}</div>
          <div className="hint">{market === 'KR' ? '국내 (KRX)' : '미국 (NYSE·NASDAQ)'}</div>
        </div>
        <div className="card">
          <div className="label">상승</div>
          <div className="value" style={{ color: '#ef5350' }}>{totals.up}</div>
          <div className="hint">전일 종가 대비</div>
        </div>
        <div className="card">
          <div className="label">하락</div>
          <div className="value" style={{ color: '#5b8def' }}>{totals.down}</div>
          <div className="hint">전일 종가 대비</div>
        </div>
        <div className="card">
          <div className="label">보합</div>
          <div className="value">{totals.flat}</div>
          <div className="hint">변동 없음</div>
        </div>
        <div className="card">
          <div className="label">가격 알림</div>
          <div className="value">{tabAlerts.length.toLocaleString('ko-KR')}</div>
          <div className="hint">Redis Pub/Sub 수신</div>
        </div>
      </section>

      <section className="card" style={{ marginBottom: 12 }}>
        <p className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {focusQuote ? `${focusQuote.name} ${chartInterval === '1d' ? '일봉' : '1분봉'}` : '차트'}
          {focusQuote && (
            <span style={{ color: COLOR[upDown(focusQuote.changeRate)], fontSize: 13 }}>
              {signPct(focusQuote.changeRate)}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
            {(['1m', '1d'] as const).map((iv) => (
              <button
                key={iv}
                className={`tab ${chartInterval === iv ? 'active' : ''}`}
                style={{ padding: '3px 12px', fontSize: 12 }}
                onClick={() => setChartInterval(iv)}
              >
                {iv === '1m' ? '분' : '일'}
              </button>
            ))}
          </span>
        </p>
        <p className="panel-desc">
          {chartInterval === '1d'
            ? '토스 일봉 80개. 노랑 곡선은 MA20(20일), 보라는 볼린저밴드(20일, 2σ).'
            : '틱 스트림을 롤업한 당일 1분봉. 노랑 곡선은 MA20(20분), 보라는 볼린저밴드(20분, 2σ), 노랑 점선은 전략 기준선인 일MA20, 회색 점선은 전일 종가.'}
          {summary?.indicators && (
            <span style={{ marginLeft: 8 }}>
              {summary.indicators.rsi14 !== null && (
                <span
                  className="badge KR"
                  style={{ marginRight: 6 }}
                  title="RSI(14) — 30 이하 과매도 / 70 이상 과열"
                >
                  RSI {summary.indicators.rsi14.toFixed(0)}
                </span>
              )}
              {summary.indicators.atrPct !== null && (
                <span className="badge US" title="ATR(14) — 하루 평균 변동폭 (종가 대비 %)">
                  ATR {summary.indicators.atrPct.toFixed(1)}%
                </span>
              )}
            </span>
          )}
        </p>
        {focusQuote ? (
          <PriceChart
            data={summary?.candles ?? []}
            currency={focusQuote.currency}
            prevClose={focusQuote.prevClose}
            indicators={summary?.indicators}
            interval={summary?.interval ?? chartInterval}
          />
        ) : (
          <div className="empty">차트를 불러오는 중…</div>
        )}
      </section>

      <div className="cols">
        <section className="card">
          <p className="panel-title">실시간 시세</p>
          <p className="panel-desc">
            등락률 순 정렬. 행을 클릭하면 차트가 해당 종목으로 바뀝니다.
          </p>
          <QuoteTable rows={quotes} focus={summary?.focus ?? null} onFocus={(s) => setFocus(s)} />
        </section>

        <section className="card">
          <p className="panel-title">실시간 가격 알림</p>
          <p className="panel-desc">
            alert 워커가 등락률 계단·급변동을 탐지 → Pub/Sub 발행 → SSE 로 즉시 push
          </p>
          <AlertFeed alerts={tabAlerts} />
        </section>
      </div>
        </>
      )}

      <footer className="note">
        <strong>왜 Kafka와 Redis를 같이 쓰는가</strong>
        <br />
        토스 Open API 는 REST 폴링만 제공하므로 producer 가 폴링 결과를 스트림으로 변환합니다.
        하나의 틱을 시세 캐싱·알림·(향후) 자동매매가 각자 소비하고, 롤업 로직 수정 시 과거 틱부터
        재계산해야 합니다 → <code>Kafka</code>
        <br />
        최신가 조회와 실시간 알림은 빠르면 되고 일부 유실돼도 무방합니다 → <code>Redis</code>
        <br />
        브라우저는 Kafka 프로토콜을 말할 수 없으므로 API 서버가 <code>SSE</code>로 중계합니다.
      </footer>
    </main>
  );
}
