import { config } from '../config.js';
import type { PriceAlert } from '../types.js';

/**
 * 슬랙 Incoming Webhook 발송.
 *  - webhook URL 이 설정되지 않았으면 조용히 건너뜁니다 (파이프라인은 슬랙 없이도 완결)
 *  - 발송 실패가 컨슈머를 멈추면 안 되므로 에러는 로그만 남깁니다
 */

const SEVERITY_EMOJI = { INFO: 'ℹ️', WARN: '⚠️', CRITICAL: '🚨' } as const;
const TYPE_LABEL = { SURGE: '급등', PLUNGE: '급락', SPIKE: '단기 급변동' } as const;

const SEVERITY_RANK = { INFO: 0, WARN: 1, CRITICAL: 2 } as const;

export function slackEnabled(alert: Pick<PriceAlert, 'market' | 'severity'>): boolean {
  return (
    Boolean(config.slack.webhookUrl) &&
    config.slack.markets.includes(alert.market) &&
    SEVERITY_RANK[alert.severity] >= SEVERITY_RANK[config.slack.minSeverity]
  );
}

export async function sendSlackAlert(alert: PriceAlert): Promise<void> {
  if (!slackEnabled(alert)) return;

  const priceText =
    alert.currency === 'KRW'
      ? `${Math.round(alert.price).toLocaleString('ko-KR')}원`
      : `$${alert.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const body = {
    text: `${SEVERITY_EMOJI[alert.severity]} [${TYPE_LABEL[alert.type]}] ${alert.message}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `${SEVERITY_EMOJI[alert.severity]} *[${TYPE_LABEL[alert.type]}] ${alert.name} (${alert.symbol})*\n` +
            `${alert.message}\n` +
            `현재가 ${priceText} · 등락률 ${alert.changeRate >= 0 ? '+' : ''}${(alert.changeRate * 100).toFixed(2)}%`,
        },
      },
    ],
  };

  try {
    const res = await fetch(config.slack.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[slack] 발송 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.error('[slack] 발송 실패:', (err as Error).message);
  }
}
