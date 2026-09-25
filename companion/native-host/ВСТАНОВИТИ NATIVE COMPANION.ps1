param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$installRoot = Join-Path $env:LOCALAPPDATA 'ChatGPT-Autopilot\Native-Companion'
$versionsRoot = Join-Path $installRoot 'versions'
$regKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\org.chatgpt_autopilot.companion'
$hostName = 'org.chatgpt_autopilot.companion'

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

# Preflight the complete packaged payload before touching any registered installation.
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

$origin = "chrome-extension://$ExtensionId/"
$hadRegistration = Test-Path -LiteralPath $regKey
$currentManifestPath = $null
$existingConfigDir = $null
$existingConfig = $null
$configPath = $null

# Resolve the currently registered version only as a state source. Never write into it.
if ($hadRegistration) {
  try {
    $currentManifestPath = [string](Get-Item -LiteralPath $regKey).GetValue('')
  } catch {
    throw "Не вдалося прочитати чинну реєстрацію Native Companion: $($_.Exception.Message)"
  }
  if ([string]::IsNullOrWhiteSpace($currentManifestPath) -or -not (Test-Path -LiteralPath $currentManifestPath -PathType Leaf)) {
    throw 'Чинна реєстрація Native Companion пошкоджена: manifest не знайдено.'
  }
  try {
    $currentManifest = Get-Content -LiteralPath $currentManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "Чинний Native Companion manifest пошкоджений: $($_.Exception.Message)"
  }
  if ([string]$currentManifest.name -ne $hostName -or [string]::IsNullOrWhiteSpace([string]$currentManifest.path)) {
    throw 'Чинний Native Companion manifest має неочікувану ідентичність.'
  }
  $registeredLauncher = [IO.Path]::GetFullPath([string]$currentManifest.path)
  if (-not (Test-Path -LiteralPath $registeredLauncher -PathType Leaf)) {
    throw 'Чинний Native Companion launcher відсутній.'
  }
  $registeredBase = [IO.Path]::GetFullPath((Split-Path -LiteralPath $registeredLauncher -Parent))
  $rootFull = [IO.Path]::GetFullPath($installRoot)
  $rootPrefix = $rootFull.TrimEnd('\') + '\'
  if ($registeredBase -ne $rootFull -and -not $registeredBase.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Чинна Native Companion інсталяція лежить поза очікуваним локальним коренем.'
  }
  $candidateConfigDir = Join-Path $registeredBase 'config'
  if (Test-Path -LiteralPath $candidateConfigDir -PathType Container) {
    $existingConfigDir = $candidateConfigDir
  }
}

# Legacy pre-versioned installations are accepted only as a local migration source.
if (-not $existingConfigDir) {
  $legacyConfigDir = Join-Path $installRoot 'config'
  if (Test-Path -LiteralPath $legacyConfigDir -PathType Container) {
    $existingConfigDir = $legacyConfigDir
  }
}

if ($existingConfigDir) {
  $configPath = Join-Path $existingConfigDir 'native-companion.json'
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    try {
      $existingConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      throw "Існуючий Native Companion config пошкоджений: $($_.Exception.Message)"
    }
  }
}

# Compile the launcher in disposable staging before publishing a versioned target.
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

$installationId = [guid]::NewGuid().ToString('N')
$target = Join-Path $versionsRoot $installationId
$runtime = Join-Path $target 'runtime'
$configDir = Join-Path $target 'config'
$credentialsDir = Join-Path $configDir 'credentials'
$published = $false

try {
  # All publication writes before the registry flip are confined to this new inactive target.
  New-Item -ItemType Directory -Path $target, $runtime, $configDir, $credentialsDir -Force | Out-Null
  foreach ($name in $copyNames) {
    $src = Join-Path $source $name
    Copy-Item -LiteralPath $src -Destination (Join-Path $target $name) -Force
  }

  $installedNode = Join-Path $runtime 'node.exe'
  Copy-Item -LiteralPath $nodeExe -Destination $installedNode -Force

  $launcherExe = Join-Path $target 'autopilot-native-host.exe'
  Copy-Item -LiteralPath $stagedLauncher -Destination $launcherExe -Force

  # Preserve only the known local state families; never copy arbitrary trees from a prior version.
  if ($existingConfigDir) {
    foreach ($stateName in @('credentials.json', 'mcp-commands.json')) {
      $stateSource = Join-Path $existingConfigDir $stateName
      if (Test-Path -LiteralPath $stateSource -PathType Leaf) {
        Copy-Item -LiteralPath $stateSource -Destination (Join-Path $configDir $stateName) -Force
      }
    }
    $oldCredentialsDir = Join-Path $existingConfigDir 'credentials'
    if (Test-Path -LiteralPath $oldCredentialsDir -PathType Container) {
      foreach ($secretFile in @(Get-ChildItem -LiteralPath $oldCredentialsDir -File -Filter '*.dpapi')) {
        if ($secretFile.Name -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.dpapi$') {
          Copy-Item -LiteralPath $secretFile.FullName -Destination (Join-Path $credentialsDir $secretFile.Name) -Force
        }
      }
    }
  }

  $configPath = Join-Path $configDir 'native-companion.json'
  if ($existingConfig) {
    if ($existingConfig.PSObject.Properties.Name -contains 'allowedOrigin') {
      $existingConfig.allowedOrigin = $origin
    } else {
      $existingConfig | Add-Member -NotePropertyName allowedOrigin -NotePropertyValue $origin
    }
    if ($existingConfig.PSObject.Properties.Name -contains 'schemaVersion') {
      $existingConfig.schemaVersion = 1
    } else {
      $existingConfig | Add-Member -NotePropertyName schemaVersion -NotePropertyValue 1
    }
    $existingConfig | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $configPath -Encoding UTF8
  } else {
    @{
      schemaVersion = 1
      allowedOrigin = $origin
      roots = @()
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8
  }

  # Re-check copied JavaScript bytes, so staging corruption cannot be published.
  foreach ($name in @($copyNames | Where-Object { $_ -like '*.mjs' })) {
    & $installedNode --check (Join-Path $target $name)
    if ($LASTEXITCODE -ne 0) {
      throw "Перевірка staged Native Companion не пройдена: $name"
    }
  }

  $manifestPath = Join-Path $target 'org.chatgpt_autopilot.companion.json'
  @{
    name = $hostName
    description = 'ChatGPT Autopilot Native Companion'
    path = $launcherExe
    type = 'stdio'
    allowed_origins = @($origin)
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  # Ensure the staged config and manifest are readable before changing Chrome's single pointer.
  $null = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $stagedManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$stagedManifest.name -ne $hostName -or [string]$stagedManifest.path -ne $launcherExe) {
    throw 'Staged Native Companion manifest не пройшов перевірку ідентичності.'
  }

  # Atomic authority point: until this succeeds, any prior registered version remains untouched and active.
  New-Item -Path $regKey -Force | Out-Null
  Set-Item -Path $regKey -Value $manifestPath
  $published = $true
} catch {
  if (-not $published -and (Test-Path -LiteralPath $target)) {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not $hadRegistration -and -not $published -and (Test-Path -LiteralPath $regKey)) {
    Remove-Item -LiteralPath $regKey -Recurse -Force -ErrorAction SilentlyContinue
  }
  throw
} finally {
  if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host 'Native Companion встановлено.'
Write-Host "Chrome extension ID: $ExtensionId"
Write-Host "Manifest: $manifestPath"
Write-Host "Versioned install: $target"
Write-Host 'Попередню зареєстровану версію не змінено і не видалено автоматично.'
Write-Host 'За замовчуванням доступу до папок і credentials немає.'
Write-Host 'Для файлового доступу запустіть «НАЛАШТУВАТИ ДОЗВОЛЕНУ ПАПКУ.ps1» у новій встановленій папці.'
Write-Host 'Для автономного логіну додайте credential через «ДОДАТИ CREDENTIAL.ps1».'
Write-Host 'Після встановлення перезапустіть Chrome.'
