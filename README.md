# 토스 시세 실시간 파이프라인 — Kafka + Redis Lab

토스증권 Open API 로 국내·미국 주식 시세를 폴링해서 **Kafka**로 흘리고,
**Redis**로 실시간 캐싱·1분봉 롤업·가격 알림을 처리한 뒤, **SSE**로 브라우저에 밀어주는 학습용 프로젝트입니다.

> 토스 Open API 는 REST 만 제공합니다 (웹소켓 없음). 그 한계를 **producer 가
> "폴링 → 스트림" 변환기**가 되어 메우는 구조 자체가 이 프로젝트의 핵심 학습 포인트입니다.

---

## 1. 아키텍처

```
 토스증권 Open API                  ┌──────────────────────┐
 (REST, 3초 폴링)                   │    quote-worker      │  Kafka Consumer Group A
      │                       ┌───▶│  최신가 캐싱·1분봉 롤업 │──▶ Redis Hash / ZSET
      ▼                       │    └──────────────────────┘        (누적 · 유실 불가)
┌────────────┐   ┌────────┐  │
│  producer  │──▶│ Kafka  │──┤
│ 폴링→틱 발행 │   │ topic  │  │    ┌──────────────────────┐
└────────────┘   └────────┘  │    │     alert-worker     │  Kafka Consumer Group B
  파티션 키                    └───▶│  급등락·급변동 탐지     │──▶ Redis Pub/Sub
  = symbol                         └──────────────────────┘        (즉시 · 유실 허용)
                                              │
                                              ▼
                                   ┌──────────────────┐
                                   │   API (Express)  │  Redis 구독 → SSE 중계
                                   └──────────────────┘
                                              │  Server-Sent Events
                                              ▼
                                   ┌──────────────────┐
                                   │ Next.js 대시보드  │  시세 테이블 · 캔들 차트 · 알림 피드
                                   └──────────────────┘
```

**같은 틱을 두 개의 컨슈머 그룹이 독립적으로 소비합니다.** 각자 offset 을 따로 관리하므로
alert 워커를 껐다 켜도 시세 캐싱에는 아무 영향이 없습니다. 나중에 자동매매 워커를 추가할 때도
**기존 코드를 한 줄도 건드리지 않고** Consumer Group C 를 붙이면 됩니다.

---

## 2. 기술 선택 근거

| 요구사항 | 판단 | 선택 |
|---|---|---|
| 폴링한 시세로 캔들을 만들려면 틱이 유실되면 안 됨 | 보존·재처리 필수 | **Kafka** |
| 하나의 틱을 시세 캐싱·알림·(향후) 자동매매가 각자 소비 | 다중 독립 소비자 | **Kafka** |
| 롤업 로직 수정 시 과거 틱부터 재계산 | offset replay | **Kafka** |
| 같은 종목의 틱은 순서가 지켜져야 캔들이 맞음 | 파티션 내 순서 보장 | **Kafka (파티션 키 = symbol)** |
| 최신가를 빠르게 조회 | 키-값 캐시 | **Redis Hash** |
| 등락률 랭킹 | 정렬된 조회 | **Redis ZSET** |
| 가격 알림을 지금 보고 있는 화면에 즉시 | 놓쳐도 무방 | **Redis Pub/Sub** |
| 새로고침 시 최근 알림 복원 | Pub/Sub 은 저장 안 됨 | **Redis List (보완)** |
| 같은 알림 반복 발송 방지 | 원자적 선점 + TTL | **Redis SET NX EX** |
| 브라우저에 실시간 push | Kafka 직접 연결 불가 | **SSE (API 서버 중계)** |

---

## 3. 사전 준비 — 토스증권 Open API 키

1. 토스증권 계좌 개설 후 **WTS 로그인 → 설정 → Open API** 에서 `client_id` / `client_secret` 발급
2. 같은 화면의 **허용 IP 관리**에 API 를 호출할 PC 의 공인 IP 등록 (미등록 IP 는 403)
3. 발급받은 키를 `.env` 의 `TOSS_CLIENT_ID` / `TOSS_CLIENT_SECRET` 에 입력

시세 조회는 계좌 헤더 없이 토큰만으로 호출됩니다. **이 프로젝트는 주문 API 를 호출하지 않습니다.**

### Rate Limit 메모

- `/api/v1/prices` 는 **한 번의 호출로 최대 200종목** 배치 조회 → 폴링 1회 = API 1회
- 한도는 토큰 버킷(초당 ~10회 수준). 3초 폴링이면 여유가 큽니다
- 429 응답 시 `Retry-After` 헤더를 읽어 대기 후 재시도합니다 (`lib/toss.ts`)

---

## 4. 실행 방법

### 사전 준비

- Docker / Docker Compose, Node.js 20 이상

```bash
cp .env.example .env   # 그리고 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 입력
docker compose up -d   # Kafka + Redis + Kafka UI
```

### 의존성 설치 & 토픽 생성

```bash
cd services && npm install && npm run setup && cd ..
cd web && npm install && cd ..
```

### 실행 (watch 모드 권장)

```bash
cd services && npm run dev   # 백엔드 4개 프로세스 (api·quote·alert·producer)
cd web && npm run dev        # 대시보드 (localhost:3000)
```

또는 한 번에: `./run-all.sh` (Git Bash)

`npm run dev` 는 **`src/` 와 `.env` 를 감시**해서 바뀐 순간 해당 프로세스를 자동 재시작합니다.
`.env` 에서 알림 임계값이나 종목을 바꿔도 껐다 켤 필요가 없습니다.
Kafka/Redis(docker)는 인프라라 계속 떠 있으면 되고, 대시보드는 Next.js HMR 이 알아서 반영합니다.

프로세스를 하나씩 따로 띄우고 싶으면 (watch 없이):

```bash
cd services && npm run api        # ① API + SSE   (localhost:4000)
cd services && npm run quote      # ② 시세 워커 (캐싱 + 1분봉 롤업)
cd services && npm run alert      # ③ 알림 워커 (급등락·급변동 탐지 + 슬랙)
cd services && npm run producer   # ④ 토스 API 폴링 → Kafka 발행
```

- 대시보드: http://localhost:3000
- Kafka UI: http://localhost:8080

### 화면만 먼저 보고 싶다면 (토스 키·Kafka 불필요)

```bash
docker compose up -d redis
cd services && npm run seed && npm run api    # 다른 터미널에서 cd web && npm run dev
```

### 장 운영 시간 참고

- KRX 정규장: 평일 09:00–15:30 (KST)
- 미국 정규장: 평일 23:30–06:00 (KST, 서머타임 기준 22:30–05:00)
- 장이 닫혀 있으면 가격이 변하지 않은 틱이 흐릅니다. 저녁에 실습한다면 미국 종목이 살아 움직입니다.

---

## 5. 반드시 해봐야 할 실습 3가지

### 실습 ① 파티션 키를 없애면 캔들이 틀어진다

`.env` 에서 `PRODUCER_PARTITION_KEY=random` 으로 바꾸고 producer 를 재시작합니다.
같은 종목의 틱이 여러 파티션으로 흩어지고, Kafka 는 **파티션 안에서만 순서를 보장**하므로
1분봉의 시가/종가가 실제 순서와 다르게 잡히기 시작합니다.
`symbol` 로 되돌리고 `npm run replay` 하면 정상 캔들로 재생성됩니다.

### 실습 ② 컨슈머를 죽였다 살려도 데이터가 안 샌다

quote 워커를 `Ctrl+C` 로 종료하고 1분 뒤 다시 실행합니다. producer 는 계속 돌고 있었지만
**끊긴 지점부터 이어서 처리**되어 캔들에 구멍이 나지 않습니다. `npm run lag` 로 확인하세요.
같은 일을 Redis Pub/Sub 으로 했다면 그 1분의 틱은 영구 소실 → 캔들에 빈 구간이 생깁니다.

### 실습 ③ 과거 시점부터 재처리 (Kafka 를 쓰는 진짜 이유)

캔들 롤업 로직을 바꿨다고 가정합니다 (`domain/quotes.ts` 의 `mergeCandle`).

```bash
# quote 워커 먼저 종료 (컨슈머 그룹이 활성이면 오프셋 변경 불가)
npm run replay   # Redis 초기화 + offset 을 earliest 로 리셋
npm run quote    # 지난 틱 전체로 캔들을 처음부터 재생성
```

**토스 API 를 다시 호출하지 않고** 재계산합니다. REST 폴링 결과를 Kafka 에 넣어둔 보상이 여기서 나옵니다.

---

## 6. Redis 를 쓰는 지점

| 자료구조 | 키 | 용도 | 이유 |
|---|---|---|---|
| Hash | `mkt:quote:{symbol}` | 종목별 최신 시세 | 대시보드가 바로 읽는 캐시 |
| SET | `mkt:symbols` | 종목 인덱스 | SCAN 을 피하기 위한 인덱스 |
| ZSET | `mkt:rank:changeRate` | 등락률 랭킹 | 정렬된 조회 O(log N) |
| Hash | `mkt:candle:{symbol}:{date}` | 1분봉 (field=HHmm, value=OHLC JSON) | 차트용 시계열 |
| String + TTL | `mkt:spike:{symbol}` | 급변 감시 윈도우 시작가 | `SET NX EX` 로 윈도우당 1회 고정 |
| String + TTL | `mkt:alertmark:{symbol}:{rule}` | 알림 쿨다운 | `SET NX EX` 성공 = 첫 알림 → 중복 발송 방지 |
| **Pub/Sub** | `mkt:alerts` | 실시간 알림 | 지금 보고 있는 사람에게만 |
| List | `mkt:alerts:recent` | 최근 알림 200건 | Pub/Sub 은 저장이 안 되므로 보완 |
| String + TTL | `mkt:processed:{group}:{eventId}` | 멱등 처리 | Kafka 는 at-least-once → 중복 반영 방지 |

**쿨다운(SET NX EX) 패턴이 이 프로젝트의 실무 포인트입니다.** 알림 봇이 같은 조건으로 도배되는 것을
막는 표준 수법이고, 나중에 자동매매에서 **중복 주문 방지**로 그대로 재사용됩니다.

---

## 7. 프로젝트 구조

```
.
├── docker-compose.yml          # Kafka(KRaft) + Redis + Kafka UI
├── run-all.sh                  # 전체 프로세스 한 번에 실행
├── services/                   # Node.js + TypeScript 백엔드
│   └── src/
│       ├── config.ts           # 환경변수 집중 관리
│       ├── types.ts            # TickEvent / QuoteSnapshot / PriceAlert 스키마
│       ├── domain/             # 순수 함수 (인프라 없이 테스트 가능)
│       │   ├── quotes.ts       #   등락률·1분봉 롤업·전일종가 선택
│       │   ├── alerts.ts       #   알림 규칙 (계단·급변)
│       │   └── domain.test.ts  #   단위 테스트 13개
│       ├── lib/
│       │   ├── toss.ts         #   토스 Open API 클라이언트 (토큰 캐싱·429 재시도)
│       │   ├── kafka.ts        #   Kafka 클라이언트
│       │   ├── redis.ts        #   Redis 클라이언트 (명령/구독 분리)
│       │   └── keys.ts         #   Redis 키 네이밍 집중 관리
│       ├── producer/           # 토스 API 폴링 → Kafka 발행
│       ├── workers/            # quote / alert 컨슈머
│       ├── api/                # Express REST + SSE
│       └── tools/              # 토픽 생성 / lag / replay / seed
└── web/                        # Next.js 15 대시보드 (차트 라이브러리 무의존)
```

`domain/` 아래는 Kafka 도 Redis 도 토스 API 도 import 하지 않습니다. 그래서 인프라 없이 테스트가 돌아갑니다:

```bash
cd services && npm test      # 13 passing
```

---

## 8. 알려진 한계 (의도적으로 남겨둔 것)

- **REST 폴링의 한계** — 진짜 체결 단위 틱이 아니라 폴링 시점 스냅샷입니다. 1분봉의 고가/저가는
  폴링 주기 사이의 움직임을 놓칠 수 있습니다
- **인증/인가 없음** — SSE 를 인터넷에 노출한다면 권한 검증이 필요합니다
- **Kafka 단일 브로커** — 운영은 최소 3대. `replicationFactor=1` 은 학습용
- **Dead Letter Queue 없음** — 파싱 실패 메시지가 컨슈머를 막을 수 있습니다
- **Redis 영속성 의존** — 캔들이 Redis 에만 있습니다. 실전이라면 일 마감 시 DB 적재가 필요합니다

---

## 9. 페이퍼 트레이딩

**실주문을 내지 않는** 가상 매매 파이프라인입니다. 대시보드의 "페이퍼" 탭에서 확인합니다.

**전략 5개가 각자 독립된 1억원 가상계좌로 같은 시장을 동시에 매매**하며, 페이퍼 탭의
리더보드(수익률 순)에서 전략별 성적을 비교할 수 있습니다. 규칙은 `domain/strategy.ts` 한 파일에 모여 있습니다.

| 전략 | 컨셉 | 진입 | 청산 |
|---|---|---|---|
| meanrevert | 평균회귀 | 전일 대비 -2% | ±1.5% |
| momentum | 추세추종 | 전일 대비 +2% | ±1.5% |
| deepdip | 낙폭과대 | 전일 대비 -4% | ±3% |
| scalper | 초단타 | 1분 내 +0.3% 급등 | ±0.5% |
| highbreak | 신고가돌파 | 당일 고가 갱신+상승 중 | +2% / -1% |

```
market.ticks ──▶ strategy-worker (Consumer Group C)   ← 기존 워커는 그대로, 소비자만 추가
                     │  진입/청산 판단 (domain/strategy.ts 순수 함수)
                     ▼
               paper.orders 토픽
                     │
                     ▼
               paper-exec-worker  ← 주문 가격에 전량 체결로 시뮬레이션
                     │              멱등 처리 = 중복 주문 방지 (자동매매의 핵심 안전장치)
                     ▼
               Redis 가상 계좌 (현금·포지션·체결 기록)
```

- 초기 자금: 첫 실행 시 **실제 포트폴리오 평가금액**에서 시작 (`PAPER_INITIAL_CASH` 로 재정의 가능)
- 전략(학습용 예제, 투자 조언 아님): `PAPER_STRATEGY=meanrevert`(급락 매수) | `momentum`(돌파 매수),
  진입·익절·손절·비중·쿨다운 전부 `.env` 로 조정
- 안전장치: 종목당 중복 주문 방지(SET NX), 재진입 쿨다운, 최대 포지션 수, 오래된 시세로 매매 금지
- 전략↔체결을 토픽으로 분리했으므로, 자동매매로 갈 때 **paper-exec 의 체결부만 토스 주문 API 로 교체**하면
  전략 코드는 한 줄도 바뀌지 않습니다

계좌 초기화(처음부터 다시): `redis-cli` 로 `mkt:paper:*` 삭제 또는 `npm run reset` (시세 캐시도 함께 초기화됨)

---

## 10. 시세 히스토리 (Postgres)

`history-worker`(Consumer Group D)가 `market.ticks` 를 **Postgres 에 영구 적재**합니다.
백테스트·전략 학습의 데이터 기반입니다.

- Kafka 토픽 보존은 **30일** — 싱크가 죽어 있던 기간을 Kafka 재생으로 복구할 수 있는 보험
- 멱등 처리는 Redis SET NX 가 아니라 **DB 제약**(event_id PK + `ON CONFLICT DO NOTHING`)으로 —
  같은 문제를 푸는 두 방식을 비교해 볼 수 있는 지점입니다
- 처음 켜면 `fromBeginning` 으로 토픽에 남아 있는 과거 틱을 전부 백필합니다

```bash
docker exec pglab-postgres psql -U mktlab -d mktlab \
  -c "SELECT symbol, count(*) FROM ticks GROUP BY symbol;"
```

---

## 11. 백테스트

Postgres 히스토리를 **라이브와 동일한 순수 함수**(`decide`/`positionSize`/`CtxTracker`)에
재생합니다. 로직이 하나뿐이라 "백테스트와 실전이 다르게 동작"하는 사고가 구조적으로 없습니다.

```bash
npm run backtest                                  # 전체 히스토리 × 전략 5개
npm run backtest -- --from 2026-08-18 --to 2026-08-19
npm run backtest -- --markets KR                  # 국장만
npm run backtest -- --trades meanrevert           # 체결 내역까지 출력
npm run backtest -- --sweep meanrevert            # 진입/익절/손절 150개 조합 스윕
```

리포트: 수익률 · 실현손익 · MDD(최대 낙폭) · 체결/청산 수 · 승률 · 미청산 포지션.

**단순화 주의점** — 주문→체결 지연 없음(같은 틱 즉시 체결), 환율은 고정 근사값, 수수료·슬리피지 미반영.
그리고 스윕 상위 조합일수록 **과적합** 가능성이 큽니다. 학습 구간과 다른 구간으로 재검증(walk-forward)한 뒤,
최종 검증은 페이퍼 트레이딩으로 하세요.

---

## 12. 다음 단계 로드맵

1. ~~**알림 봇**~~ ✅ — alert 워커가 슬랙 웹훅으로 발송 (`SLACK_WEBHOOK_URL`, 시장 필터 지원)
2. ~~**포트폴리오 대시보드**~~ ✅ — `/api/portfolio` (holdings + 환율 환산, Redis 30초 캐시) + 포트폴리오 탭
3. ~~**페이퍼 트레이딩**~~ ✅ — 전략 5개 × 독립 1억 계좌 + 리더보드 (국장+미장, 환율 처리)
4. ~~**히스토리 싱크**~~ ✅ — Kafka 30일 보존 + Postgres 영구 적재
5. ~~**백테스트 하네스**~~ ✅ — 히스토리 재생 + 파라미터 스윕 (`npm run backtest`)
6. **자동매매** — 페이퍼 트레이딩을 충분히(수 주) 돌려 검증한 뒤 `/api/v1/orders` 연결

---

## 라이선스

MIT. 학습용으로 자유롭게 수정해서 쓰세요.
