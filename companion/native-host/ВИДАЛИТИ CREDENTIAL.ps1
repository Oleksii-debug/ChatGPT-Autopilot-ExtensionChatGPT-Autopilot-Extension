param([string]$CredentialId = '')

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($CredentialId)) { $CredentialId = Read-Host 'Credential ID для видалення' }
if ($CredentialId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { throw 'Credential ID має некоректний формат.' }

$storePath = Join-Path $PSScriptRoot 'config\credentials.json'
$credentialsDir = Join-Path $PSScriptRoot 'config\credentials'
if (-not (Test-Path -LiteralPath $storePath)) { Write-Host 'Credential store відсутній.'; exit 0 }
$store = Get-Content -LiteralPath $storePath -Raw -Encoding UTF8 | ConvertFrom-Json
$found = @($store.credentials | Where-Object { $_.credentialId -eq $CredentialId })
$store.credentials = @($store.credentials | Where-Object { $_.credentialId -ne $CredentialId })
$temp = "$storePath.tmp"
[IO.File]::WriteAllText($temp, ($store | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temp -Destination $storePath -Force
foreach ($item in $found) {
  if ($item.secretFile -and $item.secretFile -notmatch '[\\/]') {
    Remove-Item -LiteralPath (Join-Path $credentialsDir ([string]$item.secretFile)) -Force -ErrorAction SilentlyContinue
  }
}
Write-Host "Credential '$CredentialId' видалено."
