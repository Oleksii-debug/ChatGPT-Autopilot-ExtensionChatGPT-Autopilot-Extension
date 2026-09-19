CHATGPT AUTOPILOT — NATIVE COMPANION V1

ПРИЗНАЧЕННЯ

Native Companion — один локальний міст між Chrome-розширенням і Windows.
Він не створює другий scheduler, Agent runtime або recovery engine.

V1 ВМІЄ

1. protocol/version handshake;
2. health;
3. список capabilities;
4. читання UTF-8 текстових файлів лише з папок, які власник явно додав.

ВСТАНОВЛЕННЯ

1. Дізнайтеся ID встановленого Chrome-розширення.
2. Запустіть PowerShell-файл «ВСТАНОВИТИ NATIVE COMPANION.ps1» з параметром -ExtensionId.
3. Перезапустіть Chrome.
4. Якщо потрібне читання локальних файлів, запустіть у встановленій папці «НАЛАШТУВАТИ ДОЗВОЛЕНУ ПАПКУ.ps1».
5. Для кожної папки задайте RootId, наприклад workspace.

ПРАВА

За замовчуванням Native Companion не має жодного дозволеного filesystem root.
filesystem.readText приймає тільки RootId + відносний шлях.
Абсолютні шляхи, .., symlink/junction escape і файли поза дозволеним root блокуються.

ЩО ДАЛІ

Наступний шар — CredentialBroker. Він використовуватиме цей самий Companion і owner policy ALLOW/ASK/DENY для автономних логінів, не створюючи другого локального сервісу.
