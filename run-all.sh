#!/usr/bin/env bash
# 백엔드 4개 프로세스 + 프론트 개발서버를 한 번에 띄웁니다.
# Ctrl+C 한 번으로 전부 정리됩니다.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[run-all] .env 를 생성했습니다."
fi

if ! grep -q '^TOSS_CLIENT_ID=.\+' .env; then
  echo "[run-all] .env 에 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 를 먼저 채워 주세요."
  exit 1
fi

echo "[run-all] Kafka/Redis 상태 확인..."
docker compose up -d
until docker compose exec -T redis redis-cli ping >/dev/null 2>&1; do
  echo "  Redis 대기 중..."; sleep 2
done
echo "[run-all] Kafka 브로커 대기 중 (최대 60초)..."
for _ in $(seq 1 30); do
  if docker compose exec -T kafka /opt/kafka/bin/kafka-broker-api-versions.sh \
      --bootstrap-server localhost:9092 >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# 기존 백엔드 워커 정리 (중복 스택 = Kafka 유령 멤버 → CPU 폭주 방지)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/kill-stack.ps1 2>/dev/null || true

( cd services && npm run setup )

PIDS=()
cleanup() {
  echo -e "\n[run-all] 종료 중..."
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# watch 모드: 코드(src/)나 .env 가 바뀌면 해당 프로세스가 자동 재시작됩니다.
# .env 수정 후 껐다 켤 필요 없습니다.
( cd services && npm run dev )        & PIDS+=($!)
( cd web && npm run dev )             & PIDS+=($!)

echo ""
echo "  대시보드   http://localhost:3000"
echo "  API        http://localhost:4000/api/summary"
echo "  Kafka UI   http://localhost:8080"
echo ""
wait
