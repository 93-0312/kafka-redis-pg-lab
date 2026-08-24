# 기존 백엔드 워커 스택 정리 (중복 실행 방지).
# 같은 groupId 워커가 두 세트 붙으면 Kafka 컨슈머 그룹이 무한 리밸런싱 →
# 유령 멤버 누적 → 브로커 OOM → CPU 폭주 (2026-08-24 실장애). 시작 전에 반드시 정리한다.
$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -match 'kafka-redis-pg-lab\services' }
if ($procs) {
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "[kill-stack] 기존 백엔드 워커 $($procs.Count)개 정리"
  Start-Sleep -Seconds 2
} else {
  Write-Host "[kill-stack] 기존 워커 없음"
}
