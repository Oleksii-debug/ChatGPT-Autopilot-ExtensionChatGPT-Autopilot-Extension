$ErrorActionPreference = 'Stop'
$configDir = Join-Path $PSScriptRoot 'config'
$pairingFile = Join-Path $configDir 'extension-origin.json'
$windowFile = Join-Path $configDir 'pairing-window.json'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null

if (Test-Path -LiteralPath $pairingFile) {
  Write-Host 'Gateway уже привязаний до Chrome-розширення.' -ForegroundColor Yellow
  Write-Host 'Щоб змінити розширення/Chrome-профіль, спочатку запустіть:'
  Write-Host 'СКИНУТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ.ps1'
  exit 2
}

$now = [DateTimeOffset]::UtcNow
$expires = $now.AddMinutes(5)
$payload = [ordered]@{
  openedAtUnixMs = $now.ToUnixTimeMilliseconds()
  expiresAtUnixMs = $expires.ToUnixTimeMilliseconds()
  openedAtUtc = $now.ToString('o')
} | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($windowFile, $payload + [Environment]::NewLine, $utf8NoBom)

Write-Host ''
Write-Host 'Вікно привязки відкрито на 5 хвилин.' -ForegroundColor Green
Write-Host 'Тепер у потрібному Chrome-профілі відкрийте ChatGPT Автопілот і натисніть «Перевірити локальний Gateway».'
Write-Host 'Перший реальний запит від Chrome-розширення буде привязаний; після цього вікно закриється автоматично.'
Write-Host ('Вікно діє до UTC: ' + $expires.ToString('u'))
