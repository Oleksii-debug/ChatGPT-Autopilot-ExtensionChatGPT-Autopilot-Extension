$ErrorActionPreference = 'Stop'
$configDir = Join-Path $PSScriptRoot 'config'
$configFile = Join-Path $configDir 'gateway-settings.json'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$existing = @{}
if (Test-Path $configFile) {
  try { $existing = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json -AsHashtable }
  catch { $existing = @{} }
}
$base = Read-Host 'OpenAI-compatible API base URL [Enter = http://127.0.0.1:1234/v1]'
if ([string]::IsNullOrWhiteSpace($base)) { $base = 'http://127.0.0.1:1234/v1' }
$uri = $null
if (-not [Uri]::TryCreate($base.Trim(), [UriKind]::Absolute, [ref]$uri)) { throw 'Некоректна абсолютна URL-адреса.' }
if ($uri.Scheme -notin @('http','https')) { throw 'Дозволено лише http:// або https://.' }
if (-not [string]::IsNullOrEmpty($uri.UserInfo)) { throw 'Не вставляйте API key/login у URL. Зберігайте ключ окремо через DPAPI.' }
if (-not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) { throw 'Base URL не повинен містити query або fragment.' }
$hostName = $uri.Host.ToLowerInvariant()
$isLoopback = $hostName -in @('127.0.0.1','localhost','::1','[::1]')
if ($uri.Scheme -eq 'http' -and -not $isLoopback) { throw 'Віддалений OpenAI-compatible API повинен використовувати HTTPS. HTTP дозволений лише для localhost/loopback.' }
$existing['compatibleBaseUrl'] = $uri.AbsoluteUri.TrimEnd('/')
$existing | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding UTF8
Write-Host ('Збережено OpenAI-compatible адресу: ' + $existing['compatibleBaseUrl'])
