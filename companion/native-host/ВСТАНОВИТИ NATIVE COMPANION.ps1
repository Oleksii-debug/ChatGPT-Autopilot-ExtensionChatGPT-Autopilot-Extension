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

$copyNames = @(
  'host.mjs',
  'host-core.mjs',
  'filesystem-provider.mjs',
  'filesystem-host-provider.mjs',
  'filesystem-read-surface.mjs',
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

# Preflight the complete packaged payload before touching an existing active installation.
foreach ($name in $copyNames) {
  $src = Join-Path $source $name
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
    throw "Пакет Native Companion неповний: відсутній обов'язковий файл: $name"
  }
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

foreach ($name in @($copyNames | Where-Object { $_ -like '*.mjs' })) {
  $sourceModule = Join-Path $source $name
  & $nodeExe --check $sourceModule
  if ($LASTEXITCODE -ne 0) {
    throw "Перевірка синтаксису Native Companion не пройдена: $name"
  }
}

# Validate the existing local configuration before any active installation bytes are changed.
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

# Compile the launcher in a disposable staging directory before touching the registered target.
$stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ChatGPT-Autopilot-Native-Companion-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
$stagedLauncher = Join-Path $stagingDir 'autopilot-native-host.exe'
try {
  Add-Type -Path (Join-Path $source 'NativeHostLauncher.cs') -OutputAssembly $stagedLauncher -OutputType ConsoleApplication
} catch {
  if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
  }
  throw "Не вдалося підготувати Native Companion launcher: $($_.Exception.Message)"
}

New-Item -ItemType Directory -Path $target, $runtime, $configDir, $credentialsDir -Force | Out-Null
foreach ($name in $copyNames) {
  $src = Join-Path $source $name
  Copy-Item -LiteralPath $src -Destination (Join-Path $target $name) -Force
}

$installedNode = Join-Path $runtime 'node.exe'
Copy-Item -LiteralPath $nodeExe -Destination $installedNode -Force

$launcherExe = Join-Path $target 'autopilot-native-host.exe'
try {
  Copy-Item -LiteralPath $stagedLauncher -Destination $launcherExe -Force
} finally {
  if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
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
