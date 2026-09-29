$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'ЗУПИНИТИ GATEWAY.ps1')
Start-Sleep -Milliseconds 500
& (Join-Path $PSScriptRoot 'ЗАПУСТИТИ GATEWAY.ps1')
