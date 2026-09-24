param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$target = Join-Path $env:LOCALAPPDATA 'ChatGPT-Autopilot\Native-Companion'
$runtime = Join-Path $target 'runtime'
$configDir = Join-Path $target 'config'
$credentialsDir = Join-Path $configDir 'credentials'
New-Item -ItemType Directory -Path $target, $runtime, $configDir, $credentialsDir -Force | Out-Null

$copyNames = @(
  'host.mjs',
  'host-core.mjs',
  'filesystem-provider.mjs',
  'credential-broker.mjs',
  'mcp-stdio-bridge.mjs',
  'windows-provider.mjs',
  'NativeHostLauncher.cs',
  'НАЛАШТУВАТИ ДОЗВОЛЕНУ ПАПКУ.ps1',
  'ДОДАТИ CREDENTIAL.ps1',
  'ВИДАЛИТИ CREDENTIAL.ps1',
  'ВИДАЛИТИ NATIVE COMPANION.ps1',
  'README-УКРАЇНСЬКОЮ.txt'
)
foreach ($name in $copyNames) {
  $src = Join-Path $source $name
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $target $name) -Force }
}

$nodeExe = $null
$portable = Join-Path (Split-Path $source -Parent) 'ai-gateway\runtime\node-v24.15.0-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $portable)) {
  $prepare = Join-Path (Split-Path $source -Parent) 'ai-gateway\ПІДГОТУВАТИ PORTABLE NODE.ps1'
  if (Test-Path -LiteralPath $prepare) {
    & $prepare
  }
}
if (Test-Path -LiteralPath $portable) {
  $nodeExe = $portable
} else {
  $system = Get-Command node -ErrorAction SilentlyContinue
  if ($system) {
    try { $major = [int]((& $system.Source -p "process.versions.node.split('.')[0]").Trim()) } catch { $major = 0 }
    if ($major -ge 20) { $nodeExe = $system.Source }
  }
}
if (-not $nodeExe) { throw 'Node.js 20+ не знайдено. Спочатку підготуйте portable Node через AI Gateway.' }
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $runtime 'node.exe') -Force

$launcherSource = Join-Path $target 'NativeHostLauncher.cs'
$launcherExe = Join-Path $target 'autopilot-native-host.exe'
if (Test-Path -LiteralPath $launcherExe) { Remove-Item -LiteralPath $launcherExe -Force }
Add-Type -Path $launcherSource -OutputAssembly $launcherExe -OutputType ConsoleApplication

$origin = "chrome-extension://$ExtensionId/"
$configPath = Join-Path $configDir 'native-companion.json'
$roots = @()
if (Test-Path -LiteralPath $configPath) {
  try {
    $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($existing.roots) { $roots = @($existing.roots) }
  } catch {
    throw "Існуючий Native Companion config пошкоджений: $($_.Exception.Message)"
  }
}
@{
  schemaVersion = 1
  allowedOrigin = $origin
  roots = $roots
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

$manifestPath = Join-Path $target 'org.chatgpt_autopilot.companion.json'
@{
  name = 'org.chatgpt_autopilot.companion'
  description = 'ChatGPT Autopilot Native Companion'
  path = $launcherExe
  type = 'stdio'
  allowed_origins = @($origin)
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$regKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\org.chatgpt_autopilot.companion'
New-Item -Path $regKey -Force | Out-Null
Set-Item -Path $regKey -Value $manifestPath

Write-Host ''
Write-Host 'Native Companion встановлено.'
Write-Host "Chrome extension ID: $ExtensionId"
Write-Host "Manifest: $manifestPath"
Write-Host 'За замовчуванням доступу до папок і credentials немає.'
Write-Host 'Для файлового доступу запустіть «НАЛАШТУВАТИ ДОЗВОЛЕНУ ПАПКУ.ps1» у встановленій папці.'
Write-Host 'Для автономного логіну додайте credential через «ДОДАТИ CREDENTIAL.ps1».'
Write-Host 'Після встановлення перезапустіть Chrome.'
