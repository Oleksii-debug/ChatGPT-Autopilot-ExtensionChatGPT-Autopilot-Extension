$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$target = Join-Path $env:LOCALAPPDATA 'ChatGPT-Autopilot\AI-Gateway'
New-Item -ItemType Directory -Path $target -Force | Out-Null

# Якщо вже встановлена версія з PID-контролем працює, безпечно зупиняємо її перед оновленням.
$existingStop = Join-Path $target 'ЗУПИНИТИ GATEWAY.ps1'
$existingPid = Join-Path $target 'runtime-state\gateway.pid'
if ((Test-Path -LiteralPath $existingStop) -and (Test-Path -LiteralPath $existingPid)) {
  try { & $existingStop } catch { Write-Warning "Не вдалося автоматично зупинити попередній Gateway: $($_.Exception.Message)" }
}

$preserve = @('config', 'runtime', 'logs')
Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
  if (-not ($preserve -contains $_.Name)) {
    $destination = Join-Path $target $_.Name
    if ($_.PSIsContainer) {
      Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }
  }
}

Write-Host "AI Gateway встановлено/оновлено у: $target"
Write-Host 'Ваші config/runtime/logs у цільовій папці не видалялись.'

& (Join-Path $target 'ПІДГОТУВАТИ PORTABLE NODE.ps1')

$auto = Read-Host 'Увімкнути автозапуск AI Gateway після входу в Windows? (т/н) [т]'
if ([string]::IsNullOrWhiteSpace($auto) -or $auto -match '^(т|t|y|yes|так)$') {
  & (Join-Path $target 'УВІМКНУТИ АВТОЗАПУСК GATEWAY.ps1')
}

& (Join-Path $target 'ЗАПУСТИТИ GATEWAY.ps1')
Write-Host ''
Write-Host 'Готово. Для першої привязки Chrome-розширення запустіть «ВІДКРИТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ.ps1».'
Write-Host 'Після цього протягом 5 хвилин у потрібному Chrome-профілі натисніть «Перевірити локальний Gateway» у ChatGPT Автопілот.'
