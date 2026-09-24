$ErrorActionPreference = 'Stop'
$host.UI.RawUI.WindowTitle = 'ChatGPT Автопілот — AI Gateway'
function Pause-End { Read-Host 'Натисніть Enter для виходу' | Out-Null }

Write-Host ''
Write-Host 'CHATGPT АВТОПІЛОТ — AI GATEWAY 0.7.0'
Write-Host '1 — Запустити Gateway для локальної Ollama'
Write-Host '2 — Запустити Gateway з OpenAI API'
Write-Host '3 — Запустити Gateway для LM Studio / OpenAI-compatible'
Write-Host '4 — Перевірити Gateway'
Write-Host '5 — Підготувати portable Node (без окремої інсталяції Node.js)'
Write-Host '6 — Безпечно зберегти OpenAI API key через Windows DPAPI'
Write-Host '7 — Налаштувати OpenAI-compatible endpoint (LM Studio / remote HTTPS API)'
Write-Host '8 — Увімкнути автозапуск Gateway разом із Windows-входом'
Write-Host '9 — Вимкнути автозапуск Gateway'
Write-Host '10 — Безпечно зберегти API key для OpenAI-compatible через Windows DPAPI'
Write-Host '11 — Видалити збережений OpenAI-compatible API key'
Write-Host '12 — Відкрити 5-хвилинне вікно привязки Chrome-розширення'
Write-Host '13 — Скинути привязку Chrome-розширення'
Write-Host '14 — Додати або оновити OpenAI-compatible endpoint у route pool'
Write-Host '0 — Вихід'
$choice = Read-Host 'Виберіть режим'

switch ($choice.Trim()) {
  '1' { & (Join-Path $PSScriptRoot 'ЗАПУСТИТИ — ЛОКАЛЬНИЙ ШІ.ps1') }
  '2' { & (Join-Path $PSScriptRoot 'ЗАПУСТИТИ — OPENAI API.ps1') }
  '3' { & (Join-Path $PSScriptRoot 'ЗАПУСТИТИ — LM STUDIO або OPENAI-COMPATIBLE.ps1') }
  '4' { & (Join-Path $PSScriptRoot 'ПЕРЕВІРИТИ GATEWAY.ps1'); Pause-End }
  '5' { & (Join-Path $PSScriptRoot 'ПІДГОТУВАТИ PORTABLE NODE.ps1'); Pause-End }
  '6' { & (Join-Path $PSScriptRoot 'НАЛАШТУВАТИ OPENAI API КЛЮЧ.ps1'); Pause-End }
  '7' { & (Join-Path $PSScriptRoot 'НАЛАШТУВАТИ OPENAI-COMPATIBLE АДРЕСУ.ps1'); Pause-End }
  '8' { & (Join-Path $PSScriptRoot 'УВІМКНУТИ АВТОЗАПУСК GATEWAY.ps1'); Pause-End }
  '9' { & (Join-Path $PSScriptRoot 'ВИМКНУТИ АВТОЗАПУСК GATEWAY.ps1'); Pause-End }
  '10' { & (Join-Path $PSScriptRoot 'НАЛАШТУВАТИ OPENAI-COMPATIBLE API КЛЮЧ.ps1'); Pause-End }
  '11' { & (Join-Path $PSScriptRoot 'ВИДАЛИТИ ЗБЕРЕЖЕНИЙ OPENAI-COMPATIBLE КЛЮЧ.ps1'); Pause-End }
  '12' { & (Join-Path $PSScriptRoot 'ВІДКРИТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ.ps1'); Pause-End }
  '13' { & (Join-Path $PSScriptRoot 'СКИНУТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ.ps1'); Pause-End }
  '14' { & (Join-Path $PSScriptRoot 'ДОДАТИ OPENAI-COMPATIBLE ENDPOINT.ps1'); Pause-End }
  '0' { exit 0 }
  default { Write-Host 'Невідомий пункт меню.'; Pause-End; exit 1 }
}
