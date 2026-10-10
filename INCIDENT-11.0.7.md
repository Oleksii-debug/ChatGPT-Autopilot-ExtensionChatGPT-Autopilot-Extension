# 11.0.7 — невідповідність Send і порожніх вкладок, 2026-10-01T16:25:46+02:00

Новий звіт від14:09:54 UTC — версія11.0.6,5 сценарних чатів.196 retained events дають6 local append acknowledgements, але0 підтверджених відповідей.4 immediate REPORT_URL_MISMATCH і41 identity-loss observations;5 stale-address reload actions. Перший чат після45-minute timeout фізично замінено; останній replacement read бачить1 user/current STEP_MARKER. Користувач повідомляє4 порожніх вкладки і1 чат із повідомленням. Ці спостереження не дозволяють стверджувати, що всі5 реальних надсилань підтверджені.

## Знайдено та змінено

1. Probe обирав bound document тільки за збереженим conversation URL. При іншій адресі він повертав recoverable identity loss. SAME_URL_RELOAD міг виконати tabs.update на старий URL, прибравши фактичний sending document. Для living mismatch цей destructive fallback вимкнено навіть для старих recovery ledgers.
2. Current owned tab тепер читається без навігації. Adapter дозволяє зміну конкретного conversation identity тільки з поточним унікальним APSTEP marker. Manager перевіряє exact tab ownership, task marker, verifiedSendAt та durable binding, потім атомарно оновлює task URL, operation target іhint. Ні Send count, ні completed turn не підвищуються від самої URL зміни. Wrong marker/root/auth не приймаються.
3. Раніше Scenario local user append міг дати SENT_VERIFIED без independent generation. Scenario-specific request flag тепер вимагає operation append, generation/new assistant таstable exclusive URL. URL-only fallback іrecovery empty-composer proof відключені для Scenario. Ordinary behavior збережена.
4. У старому diagnostics response read не мав observed URL/tab; додано безпечно скорочену фактичну адресу таtab ID, без prompt content.

## Межі доказів

Code hazard іsafe correction відтворені; причина drift на live ChatGPT не доведена, бо старий звіт не зберігав observed URL. DOM generation є сильнішим сигналом, але не server receipt. Старі positive Send acknowledgements з11.0.6 не перетворюються на proven server delivery й не переписуються без негативного доказу. Підтвердження assistant completion збережене окремо від Send.

## Перевірки

Regression703 PASS, integration68 PASS, final focus49 PASS.5 changed-URL tabs не перестворюються; wrong marker/auth відхиляються; optimistic/no-generation і URL-onlyScenario відхиляються.15×3 workflow і35/45-minute full-tab policy збережені. Windows/Chrome/NVDA іreal provider тут недоступні.

Release archive: releases/11.0.7/ChatGPT-Autopilot-11.0.7-HIGH-2026-10-01.zip. Source branch: release/11.0.7-scenario-response-identity, based on11.0.6. Private diagnostic attachment remains local, only aggregated findings are published.
