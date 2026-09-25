$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NODE-HELPER.ps1')

function Gateway-IsRunning {
  try {
    $health = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:17621/health' -TimeoutSec 2
    return $health.ok -eq $true
  } catch { return $false }
}

if (Gateway-IsRunning) {
  Write-Host 'AI Gateway уже працює на 127.0.0.1:17621.'
  exit 0
}

$nodeExe = Ensure-AutopilotNodeExe
$configFile = Join-Path $PSScriptRoot 'config\gateway-settings.json'
if (Test-Path $configFile) {
  try {
    $cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    if ($cfg.compatibleBaseUrl) { $env:COMPATIBLE_BASE_URL = [string]$cfg.compatibleBaseUrl }
  } catch {}
}

$openAiKeyFile = Join-Path $PSScriptRoot 'config\openai-key.dpapi'
$compatibleKeyFile = Join-Path $PSScriptRoot 'config\compatible-key.dpapi'
$openAiPtr = [IntPtr]::Zero
$compatiblePtr = [IntPtr]::Zero
try {
  if (Test-Path $openAiKeyFile) {
    $encrypted = Get-Content -LiteralPath $openAiKeyFile -Raw
    $secure = ConvertTo-SecureString $encrypted
    $openAiPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($openAiPtr)
    Write-Host 'OpenAI API key: завантажено із Windows DPAPI.'
  } else {
    Write-Host 'OpenAI API key: не збережений.'
  }
  if (Test-Path $compatibleKeyFile) {
    $encryptedCompatible = Get-Content -LiteralPath $compatibleKeyFile -Raw
    $secureCompatible = ConvertTo-SecureString $encryptedCompatible
    $compatiblePtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCompatible)
    $env:COMPATIBLE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($compatiblePtr)
    Write-Host 'OpenAI-compatible API key: завантажено із Windows DPAPI.'
  } else {
    Write-Host 'OpenAI-compatible API key: не збережений. Локальна Ollama/LM Studio без ключа все одно можуть працювати.'
  }
  Start-Process -FilePath $nodeExe -ArgumentList @((Join-Path $PSScriptRoot 'gateway.mjs')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
}
finally {
  if ($openAiPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($openAiPtr) }
  if ($compatiblePtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($compatiblePtr) }
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:COMPATIBLE_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:COMPATIBLE_BASE_URL -ErrorAction SilentlyContinue
}

for ($i=0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (Gateway-IsRunning) {
    Write-Host 'AI Gateway запущено успішно.'
    exit 0
  }
}
throw 'AI Gateway не відповів протягом 10 секунд після запуску.'
