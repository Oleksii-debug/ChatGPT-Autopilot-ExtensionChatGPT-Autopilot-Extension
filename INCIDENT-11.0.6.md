# 11.0.6 — сценарний incident, 2026-10-01T08:36:06+02:00

Усі чотири отримані звіти — 11.0.4. Для нового15-chat профілю збережений стан:11 сценаріїв без вкладки з TAB_RESOURCE_CAPACITY_WAIT;2 сценарії з verified Send очікують завершення відповіді;2 STOPPED сценарії утримують вкладки. У1000-event зрізі523 згадки capacity error. Знімок має4 bound IDs; повний історичний максимум5 з цього зрізу не доведений.

## Причини та рішення

1. У11.0.4 був прихований resident cap3, прив'язаний до executor concurrency. Це суперечить15 одночасним чатам з вкладкою на всю послідовність. Resident Scenario identity тепер обмежена durable participant bindings, а profile concurrency регулює лише одночасні операції. Ordinary transient budget рахується окремо. Duplicate binding та write-before-navigation збережено.
2. Запланований logical launch запускав45-minute deadline, ще до фізичної вкладки. Нова черга має deadline0; відкритий, але не підтверджений Send має durable hard deadline. Verified Send, як раніше, прив'язує response deadline до доказового Send.
3. cleanupManagedSession приймав forceSafe, але не використовував його. При PRE_SEND_WAIT/SUBMITTING/AMBIGUOUS він закривав вкладку, лишав unsafe sessionSTOPPED і не міг завершити очищення. Authorized timeout/owner retirement тепер persistently fences session, settles effect FAILED_SAFE без успішного лічильника, звільняє її lease й закриває точну власну вкладку. Retired cleanup obligations відновлюються після restart.
4. Semantic selector визначавdata-turn role лише середarticle абоlegacyauthor candidates. Додано окреміdata-turn selectors, deduplication та correlation збережені. ЖивийDOM у звітах відсутній, тому це не доведена єдина причина response misses.
5. Завершення за вичерпаного replacement budget залишало generation+1 без створеного нового чату і показувало0 completedResponses. Завершення тепер зберігає фактичне generation.

## Перевірено

699 regression checks PASS; final Scenario/Core409 PASS; integration67 PASS.15×3 simple prompts =45 verified Sends/45 completedResponses in simulated Chrome, restart, another focused window; no excess tracked tabs. Full17-turn cycles і35/45-minute policies пройшли регресії. Приватні prompts/URLs та сирі reports не публікуються.

## Межі

Report counters distinguish verified Send from assistant completion. Ordinary67 verified counter supported by37 retained Send outcomes; older events rotated out. Live ChatGPT latency, account/model throttling та фізичнийWindows/NVDA не перевірені. Немає твердження, що весь Agent runtime або ПК freeze повністю кваліфіковано. Новий live report11.0.6 потрібний для перевірки поведінки у профілях користувача.
