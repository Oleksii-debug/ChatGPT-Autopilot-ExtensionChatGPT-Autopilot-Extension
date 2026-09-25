param(
  [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NODE-HELPER.ps1')

function Gateway-IsRunning {
  try {
    $health = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:17621/health' -TimeoutSec 2
    return $health.ok -eq $true
  } catch { return $false }
}

function Import-DpapiEnvironmentKey {
  param(
    [Parameter(Mandatory=$true)][string]$KeyFile,
    [Parameter(Mandatory=$true)][string]$EnvName,
    [Parameter(Mandatory=$true)][string]$Label
  )
  if ($EnvName -notmatch '^[A-Z_][A-Z0-9_]{0,127}$') { throw "Некоректне ім'я змінної середовища для ключа: $EnvName" }
  if (-not (Test-Path -LiteralPath $KeyFile)) { return $false }
  $encrypted = Get-Content -LiteralPath $KeyFile -Raw
  $secure = ConvertTo-SecureString $encrypted
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    Set-Item -Path "Env:$EnvName" -Value $plain
  }
  finally {
    if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  }
  Write-Host "${Label}: ключ завантажено із Windows DPAPI."
  return $true
}

if (Gateway-IsRunning) {
  Write-Host 'AI Gateway уже працює на 127.0.0.1:17621.'
  exit 0
}

if ($NonInteractive) {
  $nodeExe = Ensure-AutopilotNodeExe -NonInteractive
  if (-not $nodeExe) { exit 2 }
} else {
  $nodeExe = Ensure-AutopilotNodeExe
}

$configFile = Join-Path $PSScriptRoot 'config\gateway-settings.json'
$cfg = $null
if (Test-Path -LiteralPath $configFile) {
  try {
    $cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    if ($cfg.compatibleBaseUrl) { $env:COMPATIBLE_BASE_URL = [string]$cfg.compatibleBaseUrl }
  } catch {
    throw 'gateway-settings.json пошкоджений. Виправте або видаліть його перед запуском Gateway.'
  }
}

$openAiKeyFile = Join-Path $PSScriptRoot 'config\openai-key.dpapi'
$compatibleKeyFile = Join-Path $PSScriptRoot 'config\compatible-key.dpapi'
$providerKeysDir = Join-Path $PSScriptRoot 'config\provider-keys'
$presetTool = Join-Path $PSScriptRoot 'provider-presets.mjs'

# Validate every stored named-provider credential binding before decrypting any secret.
# The Node helper owns the same binding registry used by gateway.mjs.
$namedCredentialPlan = @()
if (Test-Path -LiteralPath $providerKeysDir) {
  $planOutput = @(& $nodeExe $presetTool '--credential-plan' $configFile $providerKeysDir 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $detail = (($planOutput | ForEach-Object { [string]$_ }) -join ' ').Trim()
    if (-not $detail) { $detail = 'невідома помилка перевірки credential binding' }
    throw "Збережені ключі постачальників не пройшли перевірку прив'язки: $detail"
  }
  try {
    $planText = (($planOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Trim()
    if ($planText) {
      $parsedPlan = $planText | ConvertFrom-Json
      if ($null -ne $parsedPlan) { $namedCredentialPlan = @($parsedPlan) }
    }
  } catch {
    throw 'Не вдалося прочитати перевірений план завантаження ключів постачальників.'
  }
}

$loadedEnvNames = New-Object 'System.Collections.Generic.HashSet[string]'
try {
  if (Import-DpapiEnvironmentKey -KeyFile $openAiKeyFile -EnvName 'OPENAI_API_KEY' -Label 'OpenAI API') {
    [void]$loadedEnvNames.Add('OPENAI_API_KEY')
  } else {
    Write-Host 'OpenAI API key: не збережений.'
  }

  if (Import-DpapiEnvironmentKey -KeyFile $compatibleKeyFile -EnvName 'COMPATIBLE_API_KEY' -Label 'OpenAI-compatible API') {
    [void]$loadedEnvNames.Add('COMPATIBLE_API_KEY')
  } else {
    Write-Host 'OpenAI-compatible API key: не збережений. Локальна Ollama/LM Studio без ключа все одно можуть працювати.'
  }

  foreach ($binding in $namedCredentialPlan) {
    $apiKeyEnv = ([string]$binding.apiKeyEnv).Trim()
    $endpointId = ([string]$binding.endpointId).Trim()
    if ($apiKeyEnv -notmatch '^[A-Z_][A-Z0-9_]{0,127}$') { throw "Перевірений план містить некоректне ім'я змінної ключа: $apiKeyEnv" }
    if ($loadedEnvNames.Contains($apiKeyEnv)) { throw "Перевірений план дублює credential ref: $apiKeyEnv" }
    $namedKeyFile = Join-Path $providerKeysDir ($apiKeyEnv + '.dpapi')
    if (Import-DpapiEnvironmentKey -KeyFile $namedKeyFile -EnvName $apiKeyEnv -Label ("Постачальник " + $endpointId)) {
      [void]$loadedEnvNames.Add($apiKeyEnv)
    }
  }

  Start-Process -FilePath $nodeExe -ArgumentList @((Join-Path $PSScriptRoot 'gateway.mjs')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
}
finally {
  foreach ($envName in $loadedEnvNames) {
    Remove-Item -Path "Env:$envName" -ErrorAction SilentlyContinue
  }
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
