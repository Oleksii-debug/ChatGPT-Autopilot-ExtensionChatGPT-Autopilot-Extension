$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'runtime-state\gateway.pid'
if (-not (Test-Path $pidFile)) {
  Write-Host 'PID-файл Gateway не знайдено. Можливо, Gateway уже зупинено.'
  exit 0
}
$rawPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
$gatewayPid = 0
if (-not [int]::TryParse($rawPid, [ref]$gatewayPid) -or $gatewayPid -le 0) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  throw 'PID-файл пошкоджений; його видалено.'
}
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $gatewayPid" -ErrorAction SilentlyContinue
if (-not $processInfo) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Процес Gateway уже не працює; stale PID-файл видалено.'
  exit 0
}
$commandLine = [string]$processInfo.CommandLine
if ($commandLine -notmatch 'gateway\.mjs') {
  throw "Відмова: PID $gatewayPid існує, але це не схоже на ChatGPT Автопілот gateway.mjs. Процес НЕ завершено."
}
Stop-Process -Id $gatewayPid -Force
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "AI Gateway зупинено (PID $gatewayPid)."
