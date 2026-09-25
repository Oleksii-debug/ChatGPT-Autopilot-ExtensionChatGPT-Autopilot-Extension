$ErrorActionPreference = 'Stop'
$configDir = Join-Path $PSScriptRoot 'config'
$keyFile = Join-Path $configDir 'compatible-key.dpapi'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
Write-Host 'Ключ буде зашифровано Windows DPAPI для ПОТОЧНОГО Windows-користувача.'
Write-Host 'Він використовується тільки Gateway як Bearer key для OpenAI-compatible upstream.'
Write-Host 'Chrome-розширення, JSON-профілі та diagnostics цей ключ не отримують.'
$secure = Read-Host 'Введіть API key для OpenAI-compatible сервера' -AsSecureString
if ($secure.Length -le 0) { throw 'Порожній ключ не збережено.' }
$encrypted = ConvertFrom-SecureString -SecureString $secure
Set-Content -LiteralPath $keyFile -Value $encrypted -Encoding ASCII -NoNewline
Write-Host "Ключ збережено у DPAPI-файлі: $keyFile"
Write-Host 'Розшифрувати його зможе тільки цей Windows-користувач у своєму Windows-профілі.'
