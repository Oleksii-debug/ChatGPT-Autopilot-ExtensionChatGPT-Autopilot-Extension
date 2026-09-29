$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NODE-HELPER.ps1')
$nodeExe = Ensure-AutopilotNodeExe
Write-Host 'Запускаю ChatGPT Автопілот AI Gateway на 127.0.0.1:17621...'
Write-Host 'Ollama за замовчуванням очікується на http://127.0.0.1:11434.'
& $nodeExe (Join-Path $PSScriptRoot 'gateway.mjs')
