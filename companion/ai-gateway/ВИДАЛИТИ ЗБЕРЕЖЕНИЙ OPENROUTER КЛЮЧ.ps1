$ErrorActionPreference = 'Stop'
$keyFile = Join-Path $PSScriptRoot 'config\provider-keys\OPENROUTER_API_KEY.dpapi'
if (Test-Path -LiteralPath $keyFile) {
  Remove-Item -LiteralPath $keyFile -Force
  Write-Host 'Збережений ключ OpenRouter видалено.'
} else {
  Write-Host 'Збереженого ключа OpenRouter немає.'
}
Write-Host 'Щоб запущений Gateway перестав використовувати старий ключ, перезапустіть його.'
