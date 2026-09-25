$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NODE-HELPER.ps1')
$nodeExe = Ensure-AutopilotNodeExe
$configFile = Join-Path $PSScriptRoot 'config\gateway-settings.json'
$base = 'http://127.0.0.1:1234/v1'
if (Test-Path $configFile) {
  try {
    $cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    if ($cfg.compatibleBaseUrl) { $base = [string]$cfg.compatibleBaseUrl }
  } catch {}
}
$env:COMPATIBLE_BASE_URL = $base.TrimEnd('/')
$keyFile = Join-Path $PSScriptRoot 'config\compatible-key.dpapi'
$ptr = [IntPtr]::Zero
try {
  if (Test-Path $keyFile) {
    $encrypted = Get-Content -LiteralPath $keyFile -Raw
    $secure = ConvertTo-SecureString $encrypted
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $env:COMPATIBLE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    Write-Host 'OpenAI-compatible API key: завантажено із Windows DPAPI.'
  } else {
    $useKey = Read-Host 'Сервер вимагає API key? (т/н) [н]'
    if ($useKey -match '^(т|t|y|yes|так)$') {
      $secure = Read-Host 'Введіть API key. Для постійного/autostart режиму скористайтесь окремим DPAPI-налаштуванням' -AsSecureString
      $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      $env:COMPATIBLE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
  }
  Write-Host "OpenAI-compatible upstream: $env:COMPATIBLE_BASE_URL"
  Write-Host 'Запускаю ChatGPT Автопілот AI Gateway на 127.0.0.1:17621...'
  & $nodeExe (Join-Path $PSScriptRoot 'gateway.mjs')
}
finally {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  Remove-Item Env:COMPATIBLE_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:COMPATIBLE_BASE_URL -ErrorAction SilentlyContinue
}
