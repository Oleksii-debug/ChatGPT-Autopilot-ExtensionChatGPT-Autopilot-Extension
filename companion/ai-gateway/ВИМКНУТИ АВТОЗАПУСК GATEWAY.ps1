$ErrorActionPreference = 'Stop'
$linkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'ChatGPT Автопілот AI Gateway.lnk'
if (Test-Path $linkPath) {
  Remove-Item -LiteralPath $linkPath -Force
  Write-Host 'Автозапуск AI Gateway вимкнено.'
} else {
  Write-Host 'Автозапуск AI Gateway уже вимкнений.'
}
