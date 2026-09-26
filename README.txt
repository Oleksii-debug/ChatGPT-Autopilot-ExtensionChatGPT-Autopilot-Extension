10 ПІЛОТ — CURRENT RELEASE CANDIDATE

ПРИЗНАЧЕННЯ
- Один поточний продукт ChatGPT Автопілот без паралельних user-facing версій.
- Технічна версія Chrome/package: 10.0.0.
- User-facing номер дня: 10.
- Архів для користувача: «10 Пілот HHMM DDMM.zip».
- У межах 2026-09-26 номер 10 не змінюється; нові виправлення змінюють тільки часову мітку архіву.
- Наступний календарний день розвитку використовує наступний цілий номер.

ПОТОЧНА КОНВЕРГЕНЦІЯ
- ChatGPT Work acknowledgement/recovery після реального SUBMISSION_UNCERTAIN.
- CHAT_CYCLE: одна послідовність промптів = один фізичний чат.
- Scenario Work JSON: шаблон / імпорт / експорт.
- Спрощені сесії: звична компактна форма поверх чинного Core.
- Інтерфейс очищено від tutorial-пояснень; залишено runtime/status та критичні safety-попередження.
- Release packaging формує окреме дружнє ім'я архіву без старих user-facing номерів.

СТАН
- Це candidate, доки exact-head CI та installed Chrome acceptance не завершені.
- HUMAN_TESTED=false.
- OWNER_WINDOWS_CHROME_VERIFIED=false.
