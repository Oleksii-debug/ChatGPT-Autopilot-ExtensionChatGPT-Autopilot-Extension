$ErrorActionPreference = 'Stop'
$configDir = Join-Path $PSScriptRoot 'config'
$pairingFile = Join-Path $configDir 'extension-origin.json'
$windowFile = Join-Path $configDir 'pairing-window.json'

$removed = $false
foreach ($file in @($pairingFile, $windowFile)) {
  if (Test-Path -LiteralPath $file) {
    Remove-Item -LiteralPath $file -Force
    $removed = $true
  }
}

if ($removed) {
  Write-Host 'Привязку Chrome-розширення та незавершене pairing-вікно скинуто.' -ForegroundColor Green
} else {
  Write-Host 'Збереженої привязки не було.'
}
Write-Host 'Для нової привязки запустіть «ВІДКРИТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ.ps1», а потім перевірте Gateway з потрібного Chrome-профілю.'
