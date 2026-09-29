param(
  [string]$RootId = 'workspace',
  [string]$Path = ''
)

$ErrorActionPreference = 'Stop'
if ($RootId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { throw 'RootId має некоректний формат.' }
if ([string]::IsNullOrWhiteSpace($Path)) {
  $Path = Read-Host 'Введіть повний шлях до папки, яку Agent може читати'
}
$resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw 'Вказаний шлях не є папкою.' }

$configPath = Join-Path $PSScriptRoot 'config\native-companion.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Native Companion config не знайдено. Спочатку встановіть Native Companion.' }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$roots = @($config.roots | Where-Object { $_.rootId -ne $RootId })
$roots += [pscustomobject]@{ rootId = $RootId; path = $resolved }
if ($roots.Count -gt 64) { throw 'Підтримується не більше 64 дозволених папок.' }
$config.roots = $roots
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

Write-Host "Готово. RootId '$RootId' тепер вказує на: $resolved"
Write-Host 'Agent не отримує доступу до інших папок через цей root.'
