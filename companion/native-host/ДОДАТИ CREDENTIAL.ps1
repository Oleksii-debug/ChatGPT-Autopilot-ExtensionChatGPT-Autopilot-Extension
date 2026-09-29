param(
  [string]$CredentialId = '',
  [string]$Scope = '',
  [string]$Username = ''
)

$ErrorActionPreference = 'Stop'
$configDir = Join-Path $PSScriptRoot 'config'
$credentialsDir = Join-Path $configDir 'credentials'
$storePath = Join-Path $configDir 'credentials.json'
New-Item -ItemType Directory -Path $configDir, $credentialsDir -Force | Out-Null

if ([string]::IsNullOrWhiteSpace($CredentialId)) { $CredentialId = Read-Host 'Credential ID, наприклад ais-main' }
if ($CredentialId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { throw 'Credential ID має некоректний формат.' }
if ([string]::IsNullOrWhiteSpace($Scope)) { $Scope = Read-Host 'Дозволений origin або origins через кому, наприклад https://ais.example.edu' }
$scopes = @($Scope.Split(',') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
if ($scopes.Count -lt 1 -or $scopes.Count -gt 64) { throw 'Потрібен хоча б один і не більше 64 scopes.' }
foreach ($entry in $scopes) {
  if ($entry -notmatch '^https://(?:\*\.)?[A-Za-z0-9.-]+(?::\d+)?$' -and $entry -notmatch '^http://(?:localhost|127\.0\.0\.1)(?::\d+)?$') {
    throw "Некоректний credential scope: $entry"
  }
}
if ([string]::IsNullOrWhiteSpace($Username)) { $Username = Read-Host 'Логін / username' }

$secret = Read-Host 'Пароль або секрет' -AsSecureString
$encrypted = ConvertFrom-SecureString $secret
$secretName = "$CredentialId.dpapi"
$secretPath = Join-Path $credentialsDir $secretName
[IO.File]::WriteAllText($secretPath, $encrypted, [Text.UTF8Encoding]::new($false))

$store = $null
if (Test-Path -LiteralPath $storePath) {
  try { $store = Get-Content -LiteralPath $storePath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw "Credential store пошкоджений: $($_.Exception.Message)" }
}
if (-not $store) { $store = [pscustomobject]@{ schemaVersion = 1; credentials = @() } }
if ([int]$store.schemaVersion -ne 1) { throw 'Непідтримувана версія credential store.' }

$items = @($store.credentials | Where-Object { $_.credentialId -ne $CredentialId })
$items += [pscustomobject]@{
  credentialId = $CredentialId
  kind = 'username-password'
  scope = $scopes
  username = $Username
  secretFile = $secretName
  enabled = $true
  expiresAt = $null
}
if ($items.Count -gt 256) { throw 'Credential store підтримує не більше 256 записів.' }
$next = [pscustomobject]@{ schemaVersion = 1; credentials = $items }
$temp = "$storePath.tmp"
[IO.File]::WriteAllText($temp, ($next | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temp -Destination $storePath -Force

Write-Host "Credential '$CredentialId' збережено через Windows DPAPI для поточного Windows-користувача."
Write-Host 'Пароль не записаний у JSON і не повинен передаватися моделі.'
