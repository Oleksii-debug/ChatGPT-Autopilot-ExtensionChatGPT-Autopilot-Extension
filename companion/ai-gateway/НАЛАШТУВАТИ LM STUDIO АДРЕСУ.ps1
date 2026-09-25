$ErrorActionPreference = 'Stop'
Write-Host 'Цей ярлик залишено для сумісності. Відкриваю універсальне налаштування OpenAI-compatible endpoint.'
& (Join-Path $PSScriptRoot 'НАЛАШТУВАТИ OPENAI-COMPATIBLE АДРЕСУ.ps1')
