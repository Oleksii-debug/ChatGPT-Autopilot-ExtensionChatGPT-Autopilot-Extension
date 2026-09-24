CHATGPT АВТОПІЛОТ 0.9.19 — DIAGNOSTIC-DERIVED ORDINARY SESSION LIVENESS / POST-SEND EVIDENCE PRESERVATION

СТАТУС 0.9.19
- Реальні 0.9.13 diagnostics із TAB_NAVIGATION_URL_MISMATCH / receiver restore faults привели до нового bounded-recovery hardening: safe Ordinary AMBIGUOUS deadline перевіряється ДО нового browser bind/transport round-trip.
- Після deadline той самий фізичний Send не повторюється; operation fail-safe завершується, Session продовжує наступний цикл за user-selected cadence.
- Post-submit evidence tab не retire-иться лише через navigation/receiver fault, тому recovery не churn-ить exact conversation ownership.
- Fresh launch / -> /c/<conversation> може бути verified за concrete conversation + empty composer + active generation ще до появи semantic user-message history; non-fresh recovery лишається fail-closed.
- Permanent diagnostic-derived reliability gate проганяє одну Ordinary fresh-chat Session понад 230 verified sends із submit/receiver/navigation/composer/rate-limit/tab-close faults і перевіряє at-most-once Send + max one owned open-close tab.
- 0.9.18 Trusted Script, Browser Agent, Scenario Work та Orchestration V2 збережені.
- Вкладка «Сеанси» показує read-only загальний стан: звичайні сеанси, сценарні слоти, ролі оркестрації й завдання агента з їхніх наявних durable сховищ. Одне внутрішнє ONE_PASS виконання сценарію не відображається як окрема завершена робота. Лічильник Send читається лише з підтверджених Core-ефектів; UI оновлює видимий стан кожні п'ять секунд без голосового оголошення кожного опитування.
- Вкладка «Спрощені сесії» використовує той самий Core: один ChatGPT URL та один промпт, або чотири комбінації спільних/різних URL і промптів. Підтримує один прохід або роботу по колу, керування запуском/паузою/продовженням/зупинкою, JSON імпорт/експорт і діагностику. Спільний URL+промпт дозволяє до 1 000 000 логічних циклів з одним фізичним task object. Ознака спрощеної сесії зберігається в Core й переносному JSON.
- Exact automated qualification: 947/947 Node tests PASS, 27/27 reliability PASS, Chromium gates PASS; physical Windows/NVDA/real UKF AIS acceptance still not claimed.

CHATGPT АВТОПІЛОТ 0.9.18 — TRUSTED SCRIPT APPROVAL / NETWORK-GUARDED DOM FALLBACK

СТАТУС 0.9.18
- Browser Agent отримує opt-in Trusted Script fallback для legacy/нестандартних UI, які не піддаються DOM/ARIA/native/vision tools.
- AI-authored JavaScript ніколи не виконується тихо: кожен script потребує окремого owner approval навіть при Agent approvalMode=ALLOW_ALL.
- Approval прив'язаний до exact tab URL/origin; перед execution live origin перевіряється повторно після debugger attach.
- Trusted Script source показується в доступній approval-панелі, але після виконання redacted із durable history; audit зберігає purpose/origin/evidence без raw code.
- Network/storage/credential/dynamic-code/extension/navigation та persistent callback primitives блокуються parser policy; під час CDP Runtime.evaluate всі network requests вкладки тимчасово блокуються fail-closed.
- Trusted Script лишається DOM/UI fallback, а не загальним arbitrary-code або network execution channel.
- Exact automated qualification: 941/941 Node tests PASS, reliability PASS, real Chromium network-guarded Trusted Script E2E PASS; physical Windows/NVDA/real UKF AIS acceptance still not claimed.

CHATGPT АВТОПІЛОТ 0.9.17 — VISUAL DRAG/TYPE + PER-AGENT AI ROUTING

СТАТУС 0.9.17
- Browser Agent visual computer-use тепер має click_at + drag_at + type_at поверх screenshot-turn observation.
- Coordinate targets fail-closed на stale/viewport shift і повторно перевіряються після debugger attach перед native input.
- Agent може окремо успадкувати або override-нути primary/strong/hybrid provider/model без зміни глобального Router runtime.
- Prompt-first Agent UX лишається основним; model/provider, budgets, schedule і approval є optional policy.
- Real Chromium qualification включає canvas click, drag-and-drop і coordinate editor typing.
- 0.9.17 не заявляється фізично перевіреним на Windows/NVDA/real UKF AIS; exact QA у QA-0.9.17.txt.

CHATGPT АВТОПІЛОТ 0.9.16 — VISION COMPUTER-USE / COORDINATE NATIVE INPUT

СТАТУС 0.9.16
- Browser Agent vision тепер має `click_at`: screenshot-turn → bounded viewport coordinates → live target proof → native Chrome mouse input.
- Default consequential approval поширено на coordinate target; pure visual/canvas target потребує approval, якщо owner явно не вибрав ALLOW_ALL.
- Real Chromium smoke перевіряє visual-only canvas coordinate click.
- Розробка продовжує 0.9.14 без нового runtime: Browser Agent отримує ширші browser capabilities поверх того самого AI Router/Gateway і durable job manager.
- Додані consequential-action approval boundary, TOCTOU-safe form identity, targeted Enter/Space, multi-tab tools, tracked download/upload, on-demand vision, effect verification, deterministic wait_for_change та owner notifications capability.
- Download wait і wait_for_change не витрачають model calls під час детермінованого очікування: обидва є durable runtime work і переживають manager restart; нова owner instruction перериває очікування й одразу змушує AI перепланувати.
- 0.9.16 ще не заявляється фізично перевіреним на Windows/NVDA/real UKF AIS; exact QA фіксується у QA-0.9.16.txt.

CHATGPT АВТОПІЛОТ 0.9.14 — AGENT PLATFORM MVP / SECONDS + MILLION CYCLES / SCENARIO HARDENING

СТАТУС 0.9.14
- Prompt-first Browser Agent: користувач описує задачу природною мовою; AI є planner/operator, Autopilot надає browser tools, durable runtime, budgets, permissions, scheduling, recovery та kill switch.
- Agent підтримує fast multi-step burst, follow-up owner instructions, DOM/ARIA observation, click/fill/select/check/batch/key/scroll/navigation/back/reload/wait/done і native CDP click fallback.
- Optional policy: token/model-call/time/action/cost budgets; ONCE / CONTINUOUS / INTERVAL, absolute start/end, daily active window, cold-restart alarms.
- Generic site permissions є optional і origin-scoped; adopted user tabs не закриваються як agent-owned.
- Ordinary Session minimum interval тепер може бути у секундах або хвилинах; старі minute values зберігають той самий cadence.
- Shared URL + shared prompt підтримує до 1 000 000 logical cycles без матеріалізації мільйона Task objects.
- Scenario Work / «Двійки» / «Аудитор + група» отримали write-ahead cleanup, owner lifecycle epoch, dependency validation і timeout/replacement stall fixes.
- Orchestration V2 managed-tab cleanup став transactional: tabs.remove failure не губить ownership.
- Mixed-load gate одночасно перевіряє Ordinary + Agent + Scenario + Orchestration; Stop останньої Session має alarm-driven physical tab retirement із backoff, тому transient close failure не створює безстрокову orphan-вкладку.
- Exact automated qualification фіксується у QA-0.9.14.txt після фінального freeze. Physical Windows/Chrome/NVDA owner run не підміняється автоматизованими тестами.

CHATGPT АВТОПІЛОТ 0.9.13 — SESSION LIVENESS / PHYSICAL TAB RETIREMENT HARDENING

СТАТУС 0.9.13
- Hotfix після реального нічного Ordinary-session інциденту 0.9.10. Користувацький інтервал запуску не змінюється: хвилини/каденс повністю лишаються під контролем користувача.
- Ordinary SUBMISSION_UNCERTAIN більше не може нескінченно тримати всю Session в AMBIGUOUS. Перевірка bounded; після вичерпання доказового вікна старий фізичний Send НЕ повторюється, операція fail-safe завершується, а Session переходить до наступного нормального циклу.
- Fresh-root / -> /c/<conversation> recovery зберігає точну ownership вкладки; open-close не створює orphan duplicate tab. TAB_NAVIGATION_TIMEOUT/TAB_NAVIGATION_URL_MISMATCH скидають мертву extension-owned вкладку, щоб retry міг створити чисту.
- Lifecycle уніфіковано: Pause -> Continue, Pause -> Start, Stop -> Start і Stop -> Continue/Resume дозволені. Невизначений Send при Pause/Stop не стирається; продовження входить у recovery замість blind resend.
- Busy-check залишається user-configured. Значення 3 означає повторну перевірку busy/generating chat приблизно через 3 секунди; це не cadence Session і не обмеження тривалості відповіді ChatGPT.
- Exact automated qualification наведено у QA-0.9.13.txt. Фізичний owner Windows/Chrome/NVDA run не підміняється автоматизованими тестами.

AUTOMATED EVIDENCE 0.9.13
- Final counts recorded in QA-0.9.13.txt after package qualification.
- Includes dedicated 6-Ordinary-Session virtual-night liveness regression with injected ambiguous Send and dead-tab timeout faults.
- Native Chromium phased interaction and keyboard/accessibility gates are required before release packaging is accepted.

--- ІСТОРИЧНИЙ СТАН 0.9.10 НИЖЧЕ ---

CHATGPT АВТОПІЛОТ 0.9.10 — НІЧНИЙ MIXED-LOAD HARDENING / ПАРАЛЕЛЬНІ ORDINARY + SCENARIO

СТАТУС 0.9.10
- Це installable candidate зовнішнього multi-agent orchestration harness поверх перевіреного Autopilot Core.
- Autopilot лишається deterministic runtime/control plane. Reasoning виконує Coordinator ChatGPT; одноразові Worker ChatGPT chats виконують окремі задачі; GitHub є зовнішньою технічною правдою та machine-readable control plane.
- 0.9.10 продовжує 0.9.8 і спеціально harden-ить нічний mixed-load: кілька Ordinary Sessions + кілька Scenario-managed Sessions в одному Chrome-профілі без старого profile-wide starvation/barrier. Будь-яка unattended Session після SEND_CLICK_UNCERTAIN/SUBMISSION_UNCERTAIN тепер verification-only: blind resend заборонено як для Scenario/Orchestration, так і для Ordinary. Exact observed /c/<conversation> identity зберігається для recovery.
- Перероблено профільне виконання: до 10 незалежних Session operations працюють паралельно за замовчуванням (технічна межа 32); 5 ordinary + 5 scenario-managed окремо протестовано. Chrome tab I/O не тримає serialized state-update queue; стартові / та /g/<slug> отримують окремі owned tabs, а збій однієї вкладки не блокує інші.
- Старий 90-секундний cross-session barrier і profile-wide Send lock прибрані з сучасного submit path. Exact-once/restart safety належать durable operation кожної Session. Резервна глобальна пауза після ChatGPT rate limit за замовчуванням 0 хв (вимкнена); якщо власник задав >0, profile.rateLimitUntil є спільним і повторна детекція не продовжує його. Технічний retry сеансу та серверне обмеження лишаються окремими. Під час міграції старе системне значення 5 хв стає 0 і пов'язаний active gate очищається; інші збережені значення >0 зберігаються. Для старого сховища неможливо відрізнити вручну задані рівно 5 хв від системного default, тому обидва випадки мігрують до 0; після міграції явно обране значення зберігається.
- Exact 0.9.10 qualification наведено у QA-0.9.10.txt; окремо перевіряються same-conversation ownership conflict, Ordinary ambiguous-send verification-only та bounded scenario recovery. Фізичний owner Windows/Chrome/NVDA/API-key run все ще не можна підміняти автоматизованими тестами.
- Physical owner-Chrome/Windows multi-day acceptance ще НЕ заявлено як PASS.

MULTI-AGENT ORCHESTRATION V2
- Coordinator chat живе bounded window і має durable generation/turn identity. За замовчуванням maxCoordinatorTurns = 10, але policy конфігурована.
- Кожен coordinator turn зобов'язаний заново перевіряти live GitHub; chat history не є authoritative project state.
- Coordinator single-flight: один project/profile не має двох reasoning turns одночасно. Completion/watchdog/recovery events durable і coalesce-яться.
- Coordinator prompt не надсилається повторно, якщо exact turnId уже має positively verified Send. Ambiguous/unresolved Core operation лишається fail-safe authority.
- Після вичерпання turn limit створюється fresh coordinator generation; старий chat стає historical, новий отримує master prompt + bounded machine handoff, а не весь transcript.

COMPLETION-DRIVEN ROLLING WORKER POOL
- Нові production workers за замовчуванням запускаються у fresh ChatGPT chats: одна independent task -> один disposable chat.
- Worker lifecycle durable: QUEUED, LAUNCHING, ACTIVE/BUSY, COMPLETED, FAILED/BLOCKED, RATE_LIMITED, STALE/CANDIDATE, CANCELLED, SUPERSEDED, MANUAL_REVIEW.
- Завершення будь-якого worker створює WORKER_TERMINAL event і якнайшвидше будить coordinator; система не чекає найповільнішого worker і не працює фіксованими batch waves.
- Coordinator може повернути zero tasks / NO_ACTION. Новий coordinator tick не означає нові workers.
- desiredActiveWorkers адаптивний, але ніколи не перевищує user-configured absoluteMaxWorkers.
- Dependencies, exact-once task identity, not-before/expiry та exclusive conflict_key блокують небезпечний duplicate/conflicting launch.
- CONTINUE_EXISTING_WORKER дозволений лише як explicit task mode; default — FRESH_CHAT.

5-ХВИЛИННИЙ WATCHDOG = RECONCILE, НЕ SPAWN
- Watchdog за замовчуванням ~5 хвилин і служить self-healing/reconciliation.
- Він перевіряє durable coordinator/worker state, pending events, rate-limit/backoff, stale-probe evidence і scheduling deadlines.
- Watchdog може wake coordinator, але не створює work сам і не зобов'язує coordinator створити work.
- Нормальна відповідь coordinator: NO_ACTION / KEEP_RUNNING / tasks=[].
- Completion event має operational priority; якщо completion і watchdog збігаються, вони входять в один single-flight turn.

SELF-HEALING / BACKPRESSURE
- Worker не вважається dead лише через довгий runtime. Healthy BUSY probe продовжує резервувати slot.
- Повторні probe failures після stale threshold створюють лише WORKER_STALE_CANDIDATE event; Autopilot не запускає blind replacement. Coordinator мусить перевірити live GitHub.
- Worker/coordinator RATE_LIMITED створює project-level backpressure і bounded retry; queued workers не fan-out-яться у гарантований rate limit.
- Watchdog під час coordinator backoff coalesce-иться і не створює секундний hot-loop.
- Lost tab hint не стирає durable coordinator/worker chat URL; completion probe може відкрити/перевикористати conversation URL без duplicate Send.

CONTROL V2 — DIRECT CHAT PRIMARY + GITHUB FALLBACK
- Основний канал: завершена відповідь ChatGPT coordinator закінчується strict CHATGPT_AUTOPILOT_CONTROL_V2 JSON block, який Autopilot застосовує напряму. GitHub є durable mirror/fallback; extension читає його read-only через https://api.github.com/*.
- GitHub write token у Chrome-розширенні не потрібен і не зберігається.
- Exact marker: <!-- CHATGPT_AUTOPILOT_CONTROL_V2 -->; schema_version = 2.
- Control містить project_id, monotonic revision, coordinator_generation, generated_at/expires_at, mode та validated actions.
- Allowlisted actions: NO_ACTION, SET_DESIRED_CONCURRENCY, ADD_TASKS, CANCEL_QUEUED_TASKS, SUPERSEDE_TASKS, PAUSE, RESUME, ROTATE_COORDINATOR, CONTROL_NOTE.
- Remote control integers/IDs/schema fail closed; malformed control не породжує tasks.
- Read-only «Перевірити GitHub control» працює до запуску coordinator і не мутує runtime/Sessions.

CANONICAL CORE / RECOVERY
- Другого scheduler немає. V2 materializes лише canonical one-task Sessions/Tasks; існуючий scheduler/executor є єдиною browser Send authority.
- Cold start: спочатку Core recovery + deterministic alarms + orchestration reconciliation, потім тільки дозволяються sends.
- Restart між worker completion event і coordinator turn не губить event.
- Restart під coordinator/worker rate-limit зберігає той самий lease/worker і retry deadline.
- Duplicate control revision, exact_once_key та already-delivered coordinator turn не виконуються вдруге після restart.
- SUBMITTING/AMBIGUOUS та інші unresolved operations не стираються disable/rotation/control changes.
- Дві активні Session не можуть одночасно володіти тією самою concrete /c/<conversation> identity: same-conversation bind serialized вузько по conversation key; друга Session fail-safe блокується без глобального profile lock.
- Emergency STOP відкликає future orchestration authority, але не фальсифікує recovery evidence.

OBSERVABILITY / ACCESSIBILITY
- Options містить keyboard/NVDA-friendly V2 section: enable, project/control identity, master coordinator prompt, desired/max workers, watchdog, max coordinator turns, stale threshold, timings, Test control, Apply now, Emergency STOP.
- Status показує coordinator generation/URL/turns/lease, desired/effective/max workers, worker counts, pending events, control revision, watchdog/provider/backoff state.
- Raw secrets та величезні transcripts у status не показуються.

СЦЕНАРНА РОБОТА
- Окрема верхня вкладка з форматами «Цикли в чаті», «Двійки», «Аудитор + група», «Стан».
- Кожен сценарний хід виконується через canonical Core Session/Task; окремого Send engine немає.
- Крок промпта може повторюватися задану кількість разів; кілька кроків утворюють коло; після заданої кількості кіл можна створити нове покоління чатів.
- У двійках зберігається точне партнерство. У режимі «Аудитор + група» аудитор не переходить далі, поки не завершилися всі працівники поточного кола.
- Тайм-аут відповіді, заміна одного учасника або всієї команди, спеціальний аварійний промпт аудитору та bootstrap нового учасника є частиною durable state machine.
- Роль, conversation URL, покоління, коло, крок, повтор і recovery state зберігаються після service-worker restart.
- Scenario-managed Session не має окремого Send-двигуна і не отримує пріоритет над ordinary: обидва класи входять у спільний паралельний runtime; окремо перевірено 5+5 одночасно.
- Dependency-blocked slot не матеріалізує Core Session/tab. Auditor first_audit snapshot незмінний через correction/replacement; worker/auditor correction+replacement мають bounded budget і fail-safe STOP замість нескінченного churn.

LEGACY REMOTE DISPATCH V1
- Попередній Remote Dispatch V1 код лишено як compatibility path, але його не можна enable одночасно з Orchestration V2.
- Новий development authority — V2. Не будувати нові orchestration features поверх legacy sessions[] dispatch waves.

КАНОНІЧНА КООРДИНАЦІЯ
- GitHub Issue #121: active Orchestration V2 / GitHub control checkpoints.
- Drive: 08_MULTI_AGENT_ORCHESTRATION_V2 — ChatGPT Autopilot Extension.
- Drive 07_REMOTE_DISPATCH_V1 позначено SUPERSEDED.
- Paused AI/model integration: GitHub Issue #120.

AUTOMATED EVIDENCE 0.9.10
- AI + Orchestration + Scenario + Parallelism: 340/340 PASS.
- Legacy AI Manager: 18/18 PASS.
- Core + integration: 248/248 PASS.
- ChatGPT interaction: 112/112 PASS.
- UI: 61/61 PASS.
- Release gates: 14/14 PASS.
- Reliability: 22/22 PASS in six isolated Node processes.
- TOTAL: 815/815 PASS.
- Native Chromium phased-interaction smoke: PASS.
- Chromium keyboard/mode/accessibility smoke: PASS.
- Multi-orchestra manager includes create/select/rename/pause/resume/delete/zero-state, namespaced runtime/config/alarms and duplicate-project isolation.
- Physical-repair lineage retained: strict fresh-root Send proof, uncertain-send conversation rebinding, compatibility control parser and corruption-safe emergency STOP.
- Chrome Web Store package gate now verifies root manifest, icons, MV3 CSP, no remote script/eval/new Function, deterministic packaging and Store-specific asset presence.
- UI visual/accessibility gate now covers responsive layout, visible focus, forced-colors, reduced-motion, WCAG-AA light-palette contrast and per-orchestra action availability.
- Final syntax/JSON/privacy scans and deterministic 0.9.10 packaging are release gates; точні результати фіксуються в QA-0.9.10.txt.

НЕ ЗАЯВЛЕНО ЯК PHYSICAL PASS
- реальний owner Chrome -> GitHub API V2 control -> coordinator Send -> worker Send end-to-end;
- coordinator GitHub write action у конкретному ChatGPT account без ручної confirmation;
- багатогодинний/багатоденний Windows + Chrome multi-profile run;
- physical NVDA acceptance.

--- ІСТОРІЯ 0.7.0 ---

ЩО ЦЕ
0.7.0 зберігає перевірений multi-session автопілот, автономний AI Manager і AI Router та додає явну локальну привязку Chrome-розширення до Windows AI Gateway. Gateway більше не довіряє будь-якому chrome-extension:// origin.
Система може збирати результат web-worker після конкретного Send, передавати його локальній/слабшій моделі,
за правилами або AUTO підключати сильнішу модель, а потім передати короткий handoff у наступний web-prompt.

AI-КОНТУР
Chrome extension -> paired AI Gateway на 127.0.0.1:17621 -> Ollama / OpenAI-compatible local або remote HTTPS / OpenAI API.
API key OpenAI не зберігається у Chrome-розширенні.

ЦЕНТРАЛЬНА ЧЕРГА AI INFERENCE
Один Gateway може обслуговувати кілька Chrome-профілів. Усі /complete проходять через одну FIFO-чергу:
перший запит виконується, наступні чекають у порядку надходження. Це не дозволяє трьом профілям
одночасно забити локальну модель RAM/VRAM. Черга bounded: за замовчуванням максимум 32 pending;
AUTOPILOT_AI_MAX_PENDING дозволяє задати 1-256. При переповненні Gateway повертає HTTP 429
AI_INFERENCE_QUEUE_FULL, не гублячи вже прийняті запити. /health та /status показують active/pending/maxPending.

РЕЖИМИ AI ROUTER
1. PRIMARY — завжди основна модель.
2. STRONG — завжди сильна модель.
3. HYBRID AUTO — primary сама ставить [[ESCALATE]], коли потрібна strong.
4. HYBRID RULES — strong робить один review кожні N AI-запитів та/або N хвилин, потім повернення до primary.

HYBRID COST GUARDS
За бажанням можна задати:
- мінімум N хвилин між автоматичними strong-pass;
- максимум N автоматичних strong-pass за годину.
0 означає «без обмеження». Ручний одноразовий strong-pass лишається явною ручною дією.

AUTONOMOUS AI MANAGER
Manager реагує на verified Send, COMPLETE, repeated errors, recovery і нові web-worker reports.
Allowlisted actions: CONTINUE, HANDOFF_NEXT, safe RETRY_NOW, PAUSE_SESSION, RESUME_SESSION,
опційний RESTART_COMPLETED_SESSION тільки після normal one-pass COMPLETE. Manual Stop не перезапускається.

AI-КЕРУВАННЯ ТАЙМІНГАМИ СЕСІЇ
Окремий перемикач «Дозволити AI Manager змінювати тільки безпечні таймінги сесії» відкриває TUNE_SESSION.
Модель може змінити лише: minimum Send interval 1-1440 хв, pre-send 1-30 с, busy-check 1-30 с,
retry backoff 5-3600 с. Prompt, URL, task list, run mode, retry policy і rate-limit hold через TUNE_SESSION не змінюються.
SUBMITTING/AMBIGUOUS не тюняться. Зменшення інтервалу не скорочує вже встановлений nextAllowedSendAt.

DECISION HISTORY
У панелі зберігаються останні 50 рішень AI Manager; показуються останні 20.
Видно час, причину запуску, primary/strong route, summary та applied/skipped actions.

WINDOWS AI GATEWAY — НАЙПРОСТІШИЙ ЗАПУСК
Gateway постачається окремим ZIP. Найпростіше:
1. Розпакувати ZIP Gateway.
2. Запустити «ВСТАНОВИТИ AI GATEWAY.cmd».
3. Він копіює Gateway у %LOCALAPPDATA%\ChatGPT-Autopilot\AI-Gateway.
4. Якщо Node.js 20+ відсутній, скрипт завантажує pinned official portable Node.js v24.15.0 Windows x64
   з nodejs.org і перевіряє SHA256 ДО розпакування.
5. За бажанням увімкнути автозапуск.
6. Запустити «ВІДКРИТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ.ps1».
7. Протягом 5 хвилин у потрібному Chrome-профілі натиснути «Перевірити локальний Gateway».


ПРИВЯЗКА CHROME ДО GATEWAY
- Без Origin локальні CLI/PowerShell diagnostics залишаються доступними.
- Звичайний web-origin блокується.
- Непривязане Chrome-розширення отримує GATEWAY_PAIRING_REQUIRED.
- Локальний скрипт відкриває pairing-вікно лише на 5 хвилин.
- OPTIONS/preflight не створює привязку; привязує тільки перший реальний request від валідного 32-char Chrome extension ID.
- Після привязки інші extension IDs отримують GATEWAY_EXTENSION_NOT_PAIRED.
- Pairing state лежить у config і переживає оновлення Gateway; пошкоджений state fail-closed.
- Для іншого Chrome installation/profile є явний reset script.

OPENAI API KEY
Для unattended OpenAI API:
- у встановленій папці запустіть «НАЛАШТУВАТИ OPENAI API КЛЮЧ.ps1»;
- ключ зберігається як Windows DPAPI ciphertext для поточного Windows-користувача;
- plaintext передається тільки процесу Gateway при запуску;
- Chrome extension, JSON session profiles і diagnostics ключ не отримують.

OPENAI-COMPATIBLE API KEY
Для generic OpenAI-compatible API (не лише локального LM Studio) можна окремо запустити
«НАЛАШТУВАТИ OPENAI-COMPATIBLE API КЛЮЧ.ps1». Ключ зберігається як Windows DPAPI ciphertext
у config\compatible-key.dpapi, автоматично підхоплюється one-click та Windows autostart Gateway і видаляється
із environment батьківського PowerShell після запуску. Окремий скрипт видаляє збережений compatible key.

OLLAMA / LM STUDIO
Ollama default: http://127.0.0.1:11434.
LM Studio/OpenAI-compatible default: http://127.0.0.1:1234/v1.
Адресу compatible server змінюйте через «НАЛАШТУВАТИ OPENAI-COMPATIBLE АДРЕСУ.ps1». Для remote API дозволено лише HTTPS; HTTP дозволений тільки localhost/loopback. Старий LM Studio script лишено як alias для сумісності.

AUTOSTART / STOP / RESTART
- «УВІМКНУТИ АВТОЗАПУСК GATEWAY.ps1» створює shortcut у Windows Startup.
- «ВИМКНУТИ АВТОЗАПУСК GATEWAY.ps1» прибирає його.
- «ЗУПИНИТИ GATEWAY.cmd» використовує PID-файл і не завершує process, якщо command line не схожий на gateway.mjs.
- «ПЕРЕЗАПУСТИТИ GATEWAY.cmd» робить safe stop/start.

WEB-WORKER REPORTS / RECOVERY
- Report прив'язаний до assistant-message baseline конкретного verified Send.
- Старий assistant response не приймається як новий report.
- Streaming response poll-иться bounded time.
- Pending report jobs і AI events durable у chrome.storage та survive Chrome restart.
- Gateway/model failure не губить queue; retry має bounded exponential backoff.

RATE LIMIT
Benign «Забагато запитів» -> «Зрозуміло»: якщо модалка зникла, SAME request/SAME tab продовжується одразу.
Налаштовуваний cooldown застосовується тільки як fallback, якщо блокування не зникло або повернулось.

ВАЖЛИВА МЕЖА
Автоматизовані тести не є фізичним Windows/Chrome/Ollama/OpenAI acceptance на конкретному ПК.
Gateway installer/DPAPI/Startup scripts статично перевірені, але фізичний Windows PASS потребує запуску користувачем.
