11 ПІЛОТ HIGH — 11.0.4 — ОБМЕЖЕННЯ НАВАНТАЖЕННЯ ТА ЧИТАННЯ ВІДПОВІДЕЙ

У сценарній роботі одна вкладка залишається відкритою протягом усіх налаштованих промптів і відповідей. Перевірка відповіді не закриває та не відкриває чат заново.
Вкладка закривається після завершення циклу або налаштованого таймауту очікування відповіді. Якщо задано 35 чи 45 хвилин, ознака streaming не продовжує цей таймаут. Новий чат відкривається після підтвердженого закриття старого, у збереженому робочому вікні, згідно з бюджетом замін.
Після паузи сценарій продовжує ту саму послідовність. Явний Stop або видалення сценарію залишається окремою командою завершення.

Кожен новий сценарний промпт має унікальну службову мітку кроку. Вона допомагає зіставити відповідь після зміни ідентифікаторів у ChatGPT. Прогрес змінюється тільки після підтвердженої, стабільної відповіді за поточним повідомленням. Остання отримана відповідь зберігається локально разом із прогресом.
Помилка відповіді може пройти один Retry і одне перезавантаження тієї самої вкладки; її фізична заміна до таймауту не виконується. Заморожена вкладка очікується без перемикання фокусу та частих перезавантажень. Якщо Chrome вивантажив документ, застосовується одне обмежене відновлення; якщо вкладка справді зникла, відновлюється точний збережений URL.
Нові сценарні запуски тримають до трьох власних робочих вкладок одночасно на профіль (або менше за налаштуванням). Решта слотів чекає завершення циклу. Бюджет також враховує тимчасові вкладки спрощених сеансів. Наявні сценарні чати не закриваються достроково: нові відкриття чекають, поки їх стане менше ліміту. Chrome знову може сам звільняти пам'ять власних вкладок розширення.

Спрощені сеанси з open-close зберігають правило закриття після підтвердженого Send. High збережено: три спроби вибрати високий рівень, потім попередня поведінка продовження з поточним рівнем, якщо High недоступний.

Оновлення зі збереженням стану:
1. Зупиніть або призупиніть старий Пілот.
2. Розпакуйте архів і замініть файли в тій самій папці, з якої Chrome уже завантажує розширення High.
3. У chrome://extensions натисніть «Оновити» на тій самій картці. Не встановлюйте другу копію як окреме розширення.
4. Повторіть для кожного профілю Chrome. Якщо акаунт вийшов із ChatGPT, увійдіть вручну.

Датована історія, докази зі звітів і відомі межі перевірки: HISTORY-2026-09-30.md, CHANGES-11.0.4.txt, QA-11.0.4.txt.

ІСТОРИЧНІ НОТАТКИ 11.0.0

ПРИЗНАЧЕННЯ
- Один поточний продукт ChatGPT Автопілот без паралельних user-facing версій.
- Технічна версія Chrome/package цього оновлення: 11.0.2.
- User-facing номер дня: 10.
- Архів для користувача: «10 Пілот HHMM DDMM.zip».
- У межах 2026-09-26 номер 10 не змінюється; нові виправлення змінюють тільки часову мітку архіву.
- Наступний календарний день розвитку використовує наступний цілий номер.

ПОТОЧНА КОНВЕРГЕНЦІЯ
- ChatGPT Work acknowledgement/recovery після реального SUBMISSION_UNCERTAIN.
- Scenario ChatGPT recovery: семантичний Retry -> bounded same-URL reload -> bounded same-URL reopen; browser unknown не є response timeout.
- CHAT_CYCLE: одна послідовність промптів = один фізичний чат.
- Scenario Work JSON: шаблон / імпорт / експорт.
- Спрощені сесії: звична компактна форма поверх чинного Core.
- Інтерфейс очищено від tutorial-пояснень; залишено runtime/status та критичні safety-попередження.
- Release packaging формує окреме дружнє ім'я архіву без старих user-facing номерів.

СТАН
- Це candidate, доки exact-head CI та installed Chrome acceptance не завершені.
- HUMAN_TESTED=false.
- OWNER_WINDOWS_CHROME_VERIFIED=false.

BINDING ACCESSIBILITY ARCHITECTURE LAW

Autopilot is currently a browser extension, so do NOT force WebView2 into the extension itself. Its present UI must use semantic HTML/native browser controls where practical and must expose a complete, keyboard-operable accessibility tree through Chrome/Windows UI Automation so NVDA receives real names, roles, state, focus and text.

Critical Agent, Models, Sessions, Scenario Work, Orchestration, approvals, diagnostics, errors, budgets and status information must be real selectable/copyable text. No required control or state may exist only in canvas/custom drawing, color, pointer location or mouse-only interaction.

If a separate standalone Windows Autopilot shell is introduced later, its binding primary UI architecture is **WebView2 + semantic HTML + a correctly exposed Windows UI Automation host**. The existing Core, scheduler, Agent runtime, model routing, recovery, persistence and browser-control authorities must remain presentation-neutral and must not be rewritten merely to change the shell.

This is not a visual-design freeze. Layout and styling may evolve later. The binding requirement is semantic accessibility, keyboard completeness, copyable text and physical NVDA qualification of the exact delivered Windows/Chrome build. Automated accessibility checks support but do not replace physical NVDA acceptance.
