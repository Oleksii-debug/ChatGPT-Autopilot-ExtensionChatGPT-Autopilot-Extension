CHATGPT AUTOPILOT — NATIVE COMPANION V1

ПРИЗНАЧЕННЯ

Native Companion — один локальний міст між Chrome-розширенням і Windows.
Він не створює другий scheduler, Agent runtime або recovery engine.

V1 ВМІЄ

1. protocol/version handshake;
2. health;
3. список capabilities;
4. читання UTF-8 текстових файлів лише з папок, які власник явно додав;
5. CredentialBroker: показувати Agent лише opaque credential refs і, тільки під час дозволеного виконання, локально розкривати DPAPI-секрет для потрібного origin.

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

CREDENTIALS

Запустіть «ДОДАТИ CREDENTIAL.ps1».
Вкажіть Credential ID, дозволений HTTPS origin (або кілька через кому), username і пароль.
Пароль зберігається окремо через Windows DPAPI для поточного Windows-користувача.
Agent/модель отримує лише CredentialRef. Пароль розкривається тільки в локальній execution boundary під час credential-fill і не повинен потрапляти в prompt/history.

Owner policy ALLOW/ASK/DENY визначає, чи може Agent використати credential на конкретному сайті.
«ВИДАЛИТИ CREDENTIAL.ps1» видаляє metadata та відповідний DPAPI-файл.

ЩО ДАЛІ

Browser credential action використовує цей самий Broker для автономного заповнення login forms; жодного другого локального сервісу не створюється.
