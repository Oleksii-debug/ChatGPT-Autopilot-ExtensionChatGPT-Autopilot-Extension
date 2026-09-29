$ErrorActionPreference = 'Stop'
$keyFile = Join-Path $PSScriptRoot 'config\compatible-key.dpapi'
if (Test-Path $keyFile) {
  Remove-Item -LiteralPath $keyFile -Force
  Write-Host 'Збережений OpenAI-compatible API key видалено.'
} else {
  Write-Host 'Збереженого OpenAI-compatible API key немає.'
}
