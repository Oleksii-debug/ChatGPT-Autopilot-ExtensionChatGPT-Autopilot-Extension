$ErrorActionPreference = 'Stop'
$configDir = Join-Path $PSScriptRoot 'config'
$configFile = Join-Path $configDir 'gateway-settings.json'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$existing = @{}
if (Test-Path $configFile) {
  try { $existing = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json -AsHashtable }
  catch { throw 'gateway-settings.json пошкоджений. Виправте або видаліть файл перед зміною endpoint registry.' }
}

$endpointId = (Read-Host 'Короткий endpoint ID (наприклад local, team-a або backup)').Trim()
if ($endpointId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'Endpoint ID: 1-64 символи; дозволені латинські літери, цифри, крапка, _ та -.' }
$base = (Read-Host 'OpenAI-compatible API base URL').Trim()
$uri = $null
if (-not [Uri]::TryCreate($base, [UriKind]::Absolute, [ref]$uri)) { throw 'Некоректна абсолютна URL-адреса.' }
if ($uri.Scheme -notin @('http','https')) { throw 'Дозволено лише http:// або https://.' }
if (-not [string]::IsNullOrEmpty($uri.UserInfo)) { throw 'Не вставляйте API key/login у URL.' }
if (-not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) { throw 'Base URL не повинен містити query або fragment.' }
$hostName = $uri.Host.ToLowerInvariant()
$isLoopback = $hostName -in @('127.0.0.1','localhost','::1','[::1]')
if ($uri.Scheme -eq 'http' -and -not $isLoopback) { throw 'Віддалений OpenAI-compatible API повинен використовувати HTTPS.' }
$apiKeyEnv = (Read-Host 'Імʼя env-змінної з Bearer key (Enter = endpoint без ключа)').Trim()
if ($apiKeyEnv -and $apiKeyEnv -notmatch '^[A-Z_][A-Z0-9_]{0,127}$') { throw 'Імʼя env-змінної має містити лише A-Z, 0-9 та _ і не починатися з цифри.' }

$items = @()
if ($existing.ContainsKey('compatibleEndpoints') -and $null -ne $existing['compatibleEndpoints']) {
  foreach ($item in @($existing['compatibleEndpoints'])) {
    if ([string]$item['endpointId'] -ne $endpointId) { $items += $item }
  }
}
$items += [ordered]@{ endpointId = $endpointId; baseUrl = $uri.AbsoluteUri.TrimEnd('/'); apiKeyEnv = $apiKeyEnv }
if ($items.Count -gt 16) { throw 'Gateway підтримує максимум 16 OpenAI-compatible endpoint-ів.' }
$existing['compatibleEndpoints'] = $items
$existing | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configFile -Encoding UTF8
Write-Host "Endpoint '$endpointId' збережено. Перезапустіть Gateway, щоб застосувати зміни."
Write-Host 'API key не записувався у JSON. Gateway прочитає його лише з указаної env-змінної.'
