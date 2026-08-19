# 토스 시세 파이프라인 (kafka-redis-pg-lab)

토스증권 Open API 시세 → Kafka → 워커들 → Redis/Postgres → 대시보드/슬랙.
**페이퍼 트레이딩 전용 — 실주문 API(/api/v1/orders)는 절대 호출하지 않는다.**

## 세션 역할 구분

- **텔레그램 채널 세션(터미널)**: 조회·모니터링·백테스트 위주로 응답. 코드 수정·git push 는
  사용자가 명시적으로 요청할 때만. 답장은 짧고 한국어로.
- **데스크톱 세션**: 기능 개발·리팩터링 담당.

## 자주 쓰는 조회

```bash
# 페이퍼 리더보드 (전략 5개 성적)
curl -s http://localhost:4000/api/paper

# 파이프라인 건강 상태 (워커 7종 생존 + 컨슈머 진행률)
curl -s http://localhost:4000/api/health

# 시세 스냅샷
curl -s "http://localhost:4000/api/summary?focus=005930&interval=1d"

# 백테스트 (날짜는 KST)
cd services && npm run backtest -- --from 2026-08-19 --to 2026-08-19
cd services && npm run backtest -- --sweep meanrevert   # 파라미터 스윕

# Redis 직접 조회
docker exec pglab-redis redis-cli hgetall mkt:quote:005930
docker exec pglab-redis redis-cli lrange mkt:paper:meanrevert:trades 0 5

# 히스토리 (Postgres)
docker exec pglab-postgres psql -U mktlab -d mktlab -c "SELECT symbol, count(*) FROM ticks GROUP BY symbol;"

# 아침 브리핑 수동 발송 / 테스트·타입체크
cd services && npm run report
cd services && npm run typecheck && npm test
```

## 아키텍처 요약

- `services/src/producer` — 토스 /api/v1/prices 3초 폴링 → Kafka `market.ticks` (파티션 키=symbol)
- `services/src/workers/quote.ts` — 최신가 캐시(mkt:quote:*) + 1분봉 롤업(mkt:candle:*)
- `services/src/workers/alert.ts` — 급등락·반등 알림 → Redis Pub/Sub + 슬랙(국장 CRITICAL만)
- `services/src/workers/strategy.ts` — 전략 5개 동시 평가 → `paper.orders` 토픽
- `services/src/workers/paper-exec.ts` — 가상 체결 (전략별 독립 1억 계좌, 비용 모델 포함)
- `services/src/workers/history.ts` — Postgres `ticks` 영구 적재 (백테스트 데이터)
- `services/src/backtest` — 히스토리 재생 엔진 (라이브와 같은 순수 함수 사용)
- `services/src/domain` — 순수 함수만 (인프라 import 금지, 테스트 대상)
- `web/` — Next.js 대시보드 (localhost:3000), API 는 localhost:4000

전략 규칙은 `services/src/domain/strategy.ts` 의 STRATEGIES 테이블 한 곳에 모여 있다.

## 핵심 규칙 (수정 시 반드시 유지)

1. **실주문 금지** — 자동매매 전환은 사용자가 명시 승인해야 하며 paper-exec 체결부 교체로만 한다
2. 진입은 크로싱(임계값을 "새로" 돌파하는 순간)만, 당일 첫 틱 진입 금지 (갭 배제)
3. 정규장 한정 진입 (KR 09:00~15:19 동시호가 제외 / US 09:30~16:00 ET), 청산은 항상 허용
4. 지표는 as-of (해당일 이전 일봉만) — 선견 편향 금지
5. 라이브와 백테스트는 같은 순수 함수를 공유해야 한다 (동작 분기 금지)
6. 안전장치 제거 금지: 일일 킬 스위치(-2%), 시간 청산(6h), VI 필터, 멱등 처리, 거래비용
7. 날짜·시간은 항상 KST 명시 (Postgres 는 UTC — CURRENT_DATE 함정 두 번 겪음)

## 운영

- 백엔드는 `services`에서 `npm run dev` (tsx watch — 코드·루트 .env 저장 시 자동 재시작)
- 작업 스케줄러: 평일 8:50 자동 시작, 로그온 시 장중이면 시작, 월~토 7:30 아침 브리핑
- 슬랙: 기본 채널(시장 알림) / 페이퍼 채널(체결·킬스위치·브리핑, SLACK_PAPER_WEBHOOK_URL)
- 비밀값은 루트 `.env` (커밋 금지), 로그는 `logs/`
- 커밋 메시지는 한국어, 작업 단위마다 커밋 후 push (원격: github.com/93-0312/kafka-redis-pg-lab)
