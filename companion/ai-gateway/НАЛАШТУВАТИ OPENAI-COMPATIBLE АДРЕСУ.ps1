$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NODE-HELPER.ps1')

$configDir = Join-Path $PSScriptRoot 'config'
$configFile = Join-Path $configDir 'gateway-settings.json'
$presetTool = Join-Path $PSScriptRoot 'provider-presets.mjs'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null

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

$normalizedBase = $uri.AbsoluteUri.TrimEnd('/')
$nodeExe = Ensure-AutopilotNodeExe
& $nodeExe $presetTool '--apply-default' $configFile $normalizedBase | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Не вдалося зберегти OpenAI-compatible адресу в канонічному реєстрі Gateway.' }

Write-Host ('Збережено OpenAI-compatible адресу: ' + $normalizedBase)
