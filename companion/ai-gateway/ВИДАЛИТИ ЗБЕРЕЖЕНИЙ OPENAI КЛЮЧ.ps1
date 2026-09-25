$ErrorActionPreference = 'Stop'
$keyFile = Join-Path $PSScriptRoot 'config\openai-key.dpapi'
if (Test-Path $keyFile) {
  Remove-Item -LiteralPath $keyFile -Force
  Write-Host 'Збережений DPAPI OpenAI key видалено.'
} else {
  Write-Host 'Збереженого OpenAI key немає.'
}
