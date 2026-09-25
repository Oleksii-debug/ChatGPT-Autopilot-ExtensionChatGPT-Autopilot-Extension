$ErrorActionPreference = 'Stop'
try {
  $health = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:17621/health' -TimeoutSec 5
  Write-Host 'Gateway працює.'
  Write-Host ('Провайдери: ' + ($health.providers -join ', '))
  Write-Host ('OpenAI API налаштовано в поточному процесі Gateway: ' + $health.openaiConfigured)
  Write-Host ('OpenAI-compatible upstream: ' + $health.compatibleBaseUrl)
}
catch {
  Write-Host 'Gateway не відповідає на 127.0.0.1:17621.'
  Write-Host $_.Exception.Message
  exit 1
}
