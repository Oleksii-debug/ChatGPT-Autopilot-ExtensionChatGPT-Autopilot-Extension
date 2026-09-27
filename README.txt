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

BINDING ACCESSIBILITY ARCHITECTURE LAW

Autopilot is currently a browser extension, so do NOT force WebView2 into the extension itself. Its present UI must use semantic HTML/native browser controls where practical and must expose a complete, keyboard-operable accessibility tree through Chrome/Windows UI Automation so NVDA receives real names, roles, state, focus and text.

Critical Agent, Models, Sessions, Scenario Work, Orchestration, approvals, diagnostics, errors, budgets and status information must be real selectable/copyable text. No required control or state may exist only in canvas/custom drawing, color, pointer location or mouse-only interaction.

If a separate standalone Windows Autopilot shell is introduced later, its binding primary UI architecture is **WebView2 + semantic HTML + a correctly exposed Windows UI Automation host**. The existing Core, scheduler, Agent runtime, model routing, recovery, persistence and browser-control authorities must remain presentation-neutral and must not be rewritten merely to change the shell.

This is not a visual-design freeze. Layout and styling may evolve later. The binding requirement is semantic accessibility, keyboard completeness, copyable text and physical NVDA qualification of the exact delivered Windows/Chrome build. Automated accessibility checks support but do not replace physical NVDA acceptance.
