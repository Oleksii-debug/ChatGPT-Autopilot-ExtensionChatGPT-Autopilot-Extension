$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NODE-HELPER.ps1')

$configDir = Join-Path $PSScriptRoot 'config'
$configFile = Join-Path $configDir 'gateway-settings.json'
$providerKeysDir = Join-Path $configDir 'provider-keys'
$keyFile = Join-Path $providerKeysDir 'OPENROUTER_API_KEY.dpapi'
$presetTool = Join-Path $PSScriptRoot 'provider-presets.mjs'

New-Item -ItemType Directory -Path $providerKeysDir -Force | Out-Null
Write-Host 'OpenRouter буде додано як окремий сумісний постачальник через захищений локальний Gateway.'
Write-Host 'Ключ буде зашифровано Windows DPAPI для поточного Windows-користувача.'
Write-Host 'Ключ не записується у JSON, профілі розширення, журнали або репозиторій.'

$secure = Read-Host 'Введіть API key OpenRouter' -AsSecureString
if ($secure.Length -le 0) { throw 'Порожній ключ не збережено.' }
$encrypted = ConvertFrom-SecureString -SecureString $secure
$tempKey = "$keyFile.$PID.tmp"
try {
  Set-Content -LiteralPath $tempKey -Value $encrypted -Encoding ASCII -NoNewline
  Move-Item -LiteralPath $tempKey -Destination $keyFile -Force
}
finally {
  Remove-Item -LiteralPath $tempKey -Force -ErrorAction SilentlyContinue
}

$nodeExe = Ensure-AutopilotNodeExe
& $nodeExe $presetTool '--apply-openrouter' $configFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Не вдалося додати профіль OpenRouter до налаштувань Gateway.' }

Write-Host 'Профіль OpenRouter додано: захищене з’єднання, окремий ключ, окремий ідентифікатор постачальника.'
Write-Host "Зашифрований ключ збережено локально: $keyFile"

$restart = Join-Path $PSScriptRoot 'ПЕРЕЗАПУСТИТИ GATEWAY.ps1'
if (Test-Path -LiteralPath $restart) {
  & $restart
  if ($LASTEXITCODE -ne 0) { throw 'Профіль збережено, але Gateway не вдалося перезапустити.' }
}
