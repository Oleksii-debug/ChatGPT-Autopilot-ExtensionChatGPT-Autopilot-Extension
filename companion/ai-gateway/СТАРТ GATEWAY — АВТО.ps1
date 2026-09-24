$ErrorActionPreference = 'Stop'

# Autostart deliberately reuses the same launcher and credential-binding path as
# manual startup. Keep credential decryption and provider binding authority in one place.
$launcher = Join-Path $PSScriptRoot 'ЗАПУСТИТИ GATEWAY.ps1'
if (-not (Test-Path -LiteralPath $launcher)) { exit 4 }

try {
  & $launcher -NonInteractive
  if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  exit 0
}
catch {
  exit 3
}
