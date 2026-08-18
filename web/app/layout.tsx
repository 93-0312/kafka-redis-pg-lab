import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '토스 시세 실시간 파이프라인 · Kafka + Redis Lab',
  description: '토스증권 Open API 시세를 Kafka 로 흘리고, Redis 로 실시간 캐싱·알림을 처리하는 학습용 프로젝트',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
