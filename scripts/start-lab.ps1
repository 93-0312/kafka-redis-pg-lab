# 토스 시세 파이프라인 자동 시작 스크립트 (작업 스케줄러용)
#  - 이미 실행 중이면(포트 4000) 아무것도 하지 않습니다
#  - -GuardTime: 평일 08:30~15:40 (KRX 장 시간대)일 때만 실행 (로그온 트리거용)
#  - 백엔드/웹은 숨김 창으로 띄우고 로그는 logs\ 에 남깁니다
param([switch]$GuardTime)

$Root = Split-Path $PSScriptRoot -Parent
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir ("start-lab-{0:yyyyMMdd}.log" -f (Get-Date))
function Write-Log($msg) { "$(Get-Date -Format 'HH:mm:ss') $msg" | Add-Content -Encoding utf8 $Log }

Write-Log "---- start-lab 호출 (GuardTime=$GuardTime) ----"

# 1) 이미 실행 중이면 스킵
if (Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue) {
  Write-Log "이미 실행 중(포트 4000) - 스킵"
  exit 0
}

# 2) 시간 가드: 국장(평일 08:30~15:40) + 미장(대략 22:00~익일 06:10, 서머타임 포함 여유)
#    유의미 구간 = 월~금 08:30 이후 전부 + 화~토 새벽 06:10 까지 (금요일 미장이 토요일 새벽에 끝남)
if ($GuardTime) {
  $now = Get-Date
  $d = $now.DayOfWeek
  $t = $now.TimeOfDay
  $daySession = ($d -in 'Monday','Tuesday','Wednesday','Thursday','Friday') -and $t -ge [TimeSpan]'08:30'
  $usTail     = ($d -in 'Tuesday','Wednesday','Thursday','Friday','Saturday') -and $t -le [TimeSpan]'06:10'
  if (-not ($daySession -or $usTail)) {
    Write-Log "장외 시간($d $($now.ToString('HH:mm'))) - 스킵"
    exit 0
  }
}

# 3) Docker 엔진 확인. 안 떠 있으면 Docker Desktop 을 켜고 최대 3분 대기
docker info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Log "Docker 엔진 미기동 - Docker Desktop 시작 시도"
  $dd = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  if (Test-Path $dd) { Start-Process $dd | Out-Null }
  $waited = 0
  while ($waited -lt 180) {
    Start-Sleep -Seconds 5; $waited += 5
    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
  }
  docker info 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Log "Docker 기동 실패(3분 초과) - 중단"; exit 1 }
  Write-Log "Docker 기동 완료 (${waited}초)"
}

# 4) Kafka/Redis 컨테이너 + 토픽
Set-Location $Root
docker compose up -d 2>&1 | Out-Null
Write-Log "docker compose up 완료"
Set-Location (Join-Path $Root 'services')
cmd /c "npm run setup" 2>&1 | Out-Null
Write-Log "토픽 확인 완료"

# 5) 백엔드(6 프로세스) + 웹, 숨김 창으로. 로그는 logs\backend.log / logs\web.log
Start-Process cmd -WorkingDirectory (Join-Path $Root 'services') `
  -ArgumentList "/c npm run dev >> `"$LogDir\backend.log`" 2>&1" -WindowStyle Hidden
Start-Process cmd -WorkingDirectory (Join-Path $Root 'web') `
  -ArgumentList "/c npm run dev >> `"$LogDir\web.log`" 2>&1" -WindowStyle Hidden
Write-Log "백엔드/웹 기동 요청 완료 - http://localhost:3000"
exit 0
