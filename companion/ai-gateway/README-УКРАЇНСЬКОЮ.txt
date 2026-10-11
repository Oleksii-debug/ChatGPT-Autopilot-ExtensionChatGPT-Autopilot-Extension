CHATGPT АВТОПІЛОТ — AI GATEWAY 0.7.0

НАЙПРОСТІШЕ
Запустіть «ВСТАНОВИТИ AI GATEWAY.cmd».
Скрипт встановить/оновить Gateway у:
%LOCALAPPDATA%\ChatGPT-Autopilot\AI-Gateway
і не стиратиме config/runtime/logs у вже встановленій папці.

NODE.JS
Окремо встановлювати Node.js не обов'язково. Якщо Node 20+ не знайдено, installer може завантажити
official portable Node.js v24.15.0 Windows x64 з nodejs.org. ZIP приймається тільки після SHA256:
cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62

ПРОВАЙДЕРИ
- Ollama: локальна модель, default http://127.0.0.1:11434.
- OpenAI API: API key зберігається поза Chrome.
- OpenAI-compatible / LM Studio: default http://127.0.0.1:1234/v1. Remote compatible API підтримується лише через HTTPS.

OPENAI KEY ДЛЯ AUTOSTART
«НАЛАШТУВАТИ OPENAI API КЛЮЧ.ps1» зберігає ключ як Windows DPAPI ciphertext.
Розшифрування доступне поточному Windows-користувачу. Plaintext передається тільки дочірньому Gateway process.

OPENAI-COMPATIBLE KEY ДЛЯ AUTOSTART
«НАЛАШТУВАТИ OPENAI-COMPATIBLE API КЛЮЧ.ps1» зберігає Bearer key як Windows DPAPI ciphertext
у config\compatible-key.dpapi. One-click і hidden autostart launcher розшифровують його тільки на час запуску Gateway.
«ВИДАЛИТИ ЗБЕРЕЖЕНИЙ OPENAI-COMPATIBLE КЛЮЧ.ps1» видаляє цей credential.

OPENAI-COMPATIBLE ENDPOINT
«НАЛАШТУВАТИ OPENAI-COMPATIBLE АДРЕСУ.ps1» зберігає endpoint у config\gateway-settings.json.
HTTP дозволений тільки для localhost/loopback (LM Studio та інші локальні сервери). Для будь-якого remote host Gateway вимагає HTTPS, щоб Bearer key не міг піти відкритим HTTP. URL із вбудованими credentials/query/fragment відхиляються.
Старий «НАЛАШТУВАТИ LM STUDIO АДРЕСУ.ps1» залишено як wrapper для сумісності.

КІЛЬКА OPENAI-COMPATIBLE ENDPOINT-ІВ
«ДОДАТИ OPENAI-COMPATIBLE ENDPOINT.ps1» додає або оновлює до 16 endpoint-ів у локальному
config\gateway-settings.json. Для кожного задаються endpointId, baseUrl та необовʼязкове імʼя env-змінної з Bearer key.
Ключі у JSON не зберігаються. Extension і route pool використовують тільки endpointId. Після зміни перезапустіть Gateway.
Для автоматизованого запуску той самий bounded registry можна передати через AUTOPILOT_COMPATIBLE_ENDPOINTS_JSON.

МІСТРАЛЬ ДЛЯ АГЕНТА
Після встановлення Gateway запустіть «НАЛАШТУВАТИ MISTRAL API.ps1» у Windows.
Візьміть власний API key зі свого документа провайдера на Drive і введіть його
у захищеному запиті скрипта. Ключ шифрується Windows DPAPI для вашого користувача;
у ZIP, профіль розширення та маршрути моделей він не входить.
У вкладці моделей натисніть «Перевірити Gateway»: окремий статус «Містраль»
покаже, чи завантажено ключ. Далі «Додати Містраль» → «Отримати моделі цього
постачальника» → виберіть модель, ролі й політику вартості, увімкніть маршрут
та збережіть. Агент користується наявним AI Router і лише дозволеними маршрутами.

ОДИН КЛІК
Після встановлення «ЗАПУСТИТИ GATEWAY.cmd» запускає Gateway приховано.
«ПЕРЕВІРИТИ GATEWAY.ps1» перевіряє localhost health.
«ЗУПИНИТИ GATEWAY.cmd» / «ПЕРЕЗАПУСТИТИ GATEWAY.cmd» керують лише процесом із власного PID-файлу.

АВТОЗАПУСК
«УВІМКНУТИ АВТОЗАПУСК GATEWAY.ps1» створює shortcut у Startup поточного Windows-користувача.
«ВИМКНУТИ АВТОЗАПУСК GATEWAY.ps1» прибирає його.

БЕЗПЕКА / ПРИВЯЗКА CHROME
Gateway bind only 127.0.0.1; Host header має бути loopback; звичайні web-page origins відхиляються.
Chrome-розширення не отримують доступ автоматично: спочатку локально запустіть «ВІДКРИТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ.ps1».
Скрипт відкриває одноразове 5-хвилинне pairing-вікно. Перший реальний запит від валідного chrome-extension://<32-char-id>
привязується у config\extension-origin.json, після чого інші extension-origin відхиляються. OPTIONS/preflight сам по собі не привязує.
Для зміни Chrome installation/profile використовуйте «СКИНУТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ.ps1», потім відкрийте нове pairing-вікно.
Пошкоджений pairing-файл обробляється fail-closed. Local CLI/no-Origin діагностика залишається доступною.
API key не повертається через /health або /status. /health і /status показують лише безпечний extensionPairing status.

AI MANAGER
Extension 0.7.0 має primary/strong/hybrid-auto/hybrid-rules, report collection, handoff, restart recovery,
decision history і optional strong-call cost guards.
Extension 0.7.0 також має opt-in TUNE_SESSION для bounded session timings; prompts/URLs/tasks через цю дію не змінюються.


ЦЕНТРАЛЬНА FIFO-ЧЕРГА
- Усі /complete запити від усіх Chrome-профілів виконуються по одному в порядку надходження.
- За замовчуванням можна чекати максимум 32 pending inference.
- Змінити межу: AUTOPILOT_AI_MAX_PENDING=1..256 у середовищі Gateway.
- Переповнення повертає HTTP 429 / AI_INFERENCE_QUEUE_FULL; активний і вже queued inference не губляться.
- Поточний стан видно в /health та /status: inferenceQueue.active / pending / maxPending.
