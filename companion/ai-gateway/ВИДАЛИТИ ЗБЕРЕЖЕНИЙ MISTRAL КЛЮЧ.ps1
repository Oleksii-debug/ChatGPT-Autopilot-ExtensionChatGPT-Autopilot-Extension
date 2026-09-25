$ErrorActionPreference = 'Stop'
$keyFile = Join-Path $PSScriptRoot 'config\provider-keys\MISTRAL_API_KEY.dpapi'
if (Test-Path -LiteralPath $keyFile) {
  Remove-Item -LiteralPath $keyFile -Force
  Write-Host 'Збережений ключ Містраль видалено.'
} else {
  Write-Host 'Збереженого ключа Містраль немає.'
}
Write-Host 'Щоб запущений Gateway перестав використовувати старий ключ, перезапустіть його.'
