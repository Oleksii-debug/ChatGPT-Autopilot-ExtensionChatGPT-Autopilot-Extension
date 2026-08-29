const STATE = Object.freeze({
  RUNNING:'ПРАЦЮЄ', RECOVERING:'ВІДНОВЛЮЄТЬСЯ', PAUSED:'ПРИЗУПИНЕНО', STOPPED:'ЗУПИНЕНО', ERROR:'ПОМИЛКА',
  RATE_LIMITED:'ТИМЧАСОВЕ ОБМЕЖЕННЯ', RETRY_WAIT:'ОЧІКУВАННЯ ПОВТОРНОЇ СПРОБИ', MANUAL_REVIEW:'ПОТРІБНА РУЧНА ПЕРЕВІРКА',
  SUBMISSION_UNCERTAIN:'РЕЗУЛЬТАТ ВІДПРАВЛЕННЯ НЕВИЗНАЧЕНИЙ', IDLE:'ОЧІКУЄ', BUSY:'ЧАТ ЗАЙНЯТИЙ', READY:'ГОТОВО',
  CHECKING:'ПЕРЕВІРКА', INSERTING:'ВСТАВЛЕННЯ', INSERTED:'ВСТАВЛЕНО', PRE_SEND_WAIT:'ОЧІКУВАННЯ ПЕРЕД ВІДПРАВЛЕННЯМ',
  SUBMITTING:'ВІДПРАВЛЕННЯ', SENT_VERIFIED:'ВІДПРАВЛЕННЯ ПІДТВЕРДЖЕНО', AMBIGUOUS:'НЕВИЗНАЧЕНИЙ РЕЗУЛЬТАТ',
  FAILED_SAFE:'БЕЗПЕЧНО ЗУПИНЕНО', NONE:'НЕМАЄ', UNKNOWN:'НЕВІДОМО', TEMPORARY_ERROR:'ТИМЧАСОВА ПОМИЛКА',
  AUTH_REQUIRED:'ПОТРІБЕН ВХІД', UNKNOWN_UI:'НЕВІДОМИЙ СТАН ІНТЕРФЕЙСУ'
});

const EXACT = new Map([
  ['ChatGPT Autopilot','ChatGPT Автопілот'], ['Ready.','Готово.'], ['Master pause','Призупинити все'], ['Resume after master pause','Продовжити все'],
  ['Session navigation','Навігація сеансами'], ['Sessions','Сеанси'], ['Create session','Створити сеанс'],
  ['Keyboard and startup behavior','Клавіатура та поведінка після запуску'],
  ['Use Tab and Shift+Tab to move, Enter or Space to activate buttons, and Space to change checkboxes or radio buttons. No extension-specific global keyboard shortcuts are assigned.','Для переходу між елементами використовуйте Tab і Shift+Tab. Для натискання кнопок — Enter або Пробіл, для прапорців і перемикачів — Пробіл. Окремих глобальних гарячих клавіш розширення не призначено.'],
  ['Sessions left RUNNING or RECOVERING resume automatically when Chrome starts. PAUSED and STOPPED Sessions do not auto-resume.','Запущені сеанси та сеанси у відновленні автоматично продовжують роботу після запуску Chrome. Призупинені та зупинені сеанси автоматично не запускаються.'],
  ['Session','Сеанс'], ['Configuration errors','Помилки налаштування'], ['Configuration','Налаштування'], ['Session name','Назва сеансу'],
  ['Prompt mode','Режим промптів'], ['One shared prompt for all tasks','Один спільний промпт для всіх завдань'], ['Unique prompt for each task','Окремий промпт для кожного завдання'],
  ['Shared prompt for all enabled tasks','Спільний промпт для всіх увімкнених завдань'], ['Default prompt for empty task prompts','Промпт за замовчуванням для порожніх завдань'],
  ['Apply default prompt to empty tasks','Застосувати промпт за замовчуванням до порожніх завдань'], ['Run mode','Режим роботи'], ['One pass','Один прохід'], ['Continuous monitor','Постійна робота по колу'],
  ['Tasks','Завдання'], ['Add task','Додати завдання'], ['Up to 50 tasks per session.','До 50 завдань у кожному сеансі.'], ['Timing and behavior','Час і поведінка'],
  ['Minimum interval between actual sends, minutes','Мінімальний інтервал між фактичними відправленнями, хвилини'], ['Busy-chat checks do not consume this interval.','Перевірка зайнятого чату не використовує цей інтервал.'],
  ['Delay after prompt insertion before Send, seconds','Затримка після вставлення промпту перед відправленням, секунди'], ['Delay before checking the next task when current chat is busy, seconds','Затримка перед перевіркою наступного завдання, якщо поточний чат зайнятий, секунди'],
  ['Retry/backoff wait','Очікування перед повторною спробою'], ['Retry/backoff unit','Одиниця часу очікування'], ['Seconds','Секунди'], ['Minutes','Хвилини'],
  ['Used after temporary failures and after the exact Too many requests acknowledgement. The Session resumes automatically when the saved wait expires.','Використовується після тимчасових помилок і після підтвердження повідомлення «Забагато запитів». Коли заданий час очікування мине, сеанс автоматично продовжить роботу.'],
  ['Retry policy','Політика повторних спроб'], ['Bounded safe retries','Безпечні повторні спроби з обмеженням'], ['Manual review after temporary failure','Ручна перевірка після тимчасової помилки'],
  ['Busy chat behavior','Поведінка, коли чат зайнятий'], ['Skip immediately to next enabled task','Одразу перейти до наступного увімкненого завдання'], ['Tab strategy','Режим вкладок'],
  ['Keep task tabs open','Тримати вкладки завдань відкритими'], ['Use one worker tab for this session','Використовувати одну робочу вкладку для цього сеансу'], ['Open and close per task','Відкривати й закривати вкладку для кожного завдання'],
  ['Controls','Керування'], ['Save session','Зберегти сеанс'], ['Start','Запустити'], ['Pause','Призупинити'], ['Resume','Продовжити'], ['Stop','Зупинити'],
  ['No runtime command has been issued.','Команди керування ще не виконувалися.'], ['Status','Стан'], ['Log','Журнал'], ['Core retains a bounded session log.','Програма зберігає обмежений журнал подій сеансу.'],
  ['0 Core log entries shown.','Показано 0 записів журналу.'], ['Session log','Журнал сеансу'], ['Clear log','Очистити журнал'], ['No session selected','Сеанс не вибрано'],
  ['Create or open a session to configure automation.','Створіть або відкрийте сеанс, щоб налаштувати автоматизацію.'], ['Delete session?','Видалити сеанс?'],
  ['This removes the selected session configuration.','Буде видалено налаштування вибраного сеансу.'], ['Delete session','Видалити сеанс'], ['Cancel','Скасувати'],
  ['Not available','Немає даних'], ['New session','Новий сеанс'], ['Unnamed session','Сеанс без назви'], ['Connected to Core.','З’єднання з ядром встановлено.'],
  ['Rename','Перейменувати'], ['Duplicate','Дублювати'], ['Delete','Видалити'], ['Task removed.','Завдання видалено.'], ['Session name is required.','Вкажіть назву сеансу.'],
  ['Add at least one task.','Додайте щонайменше одне завдання.'], ['Shared prompt is required.','Вкажіть спільний промпт.'],
  ['Minimum send interval must be at least 1 minute.','Мінімальний інтервал між відправленнями має бути не менше 1 хвилини.'], ['Pre-send delay must be between 1 and 30 seconds.','Затримка перед відправленням має бути від 1 до 30 секунд.'],
  ['Busy-check delay must be between 1 and 30 seconds.','Затримка перевірки зайнятого чату має бути від 1 до 30 секунд.'], ['Retry backoff must be between 5 seconds and 60 minutes.','Очікування перед повторною спробою має бути від 5 секунд до 60 хвилин.'],
  ['Fix these configuration errors','Виправте ці помилки налаштування'], ['Session saved.','Сеанс збережено.'], ['Session created.','Сеанс створено.'], ['Edit the session name, then save.','Змініть назву сеансу, потім збережіть.'],
  ['Session duplicated.','Сеанс продубльовано.'], ['Session deleted.','Сеанс видалено.'], ['Shared prompt mode selected.','Вибрано режим спільного промпту.'], ['Unique prompt mode selected.','Вибрано режим окремих промптів.'],
  ['Session state','Стан сеансу'], ['Current task','Поточне завдання'], ['Current task status','Стан поточного завдання'], ['Operation phase','Етап операції'], ['Last action','Остання дія'],
  ['Last action time','Час останньої дії'], ['Last successful send','Останнє успішне відправлення'], ['Next allowed Send','Наступне дозволене відправлення'], ['Retry or backoff until','Повторна спроба не раніше'],
  ['Manual review reason','Причина ручної перевірки'], ['Enabled tasks','Увімкнені завдання'], ['Last error','Остання помилка'], ['None','Немає'],
  ['Core runtime is not available yet.','Ядро програми ще недоступне.'], ['Core command failed.','Не вдалося виконати команду ядра.'], ['Core returned an unexpected master-pause state.','Ядро повернуло неочікуваний стан загального призупинення.']
]);

const RUNTIME = [
  ['Session configuration saved','Налаштування сеансу збережено'], ['Session created','Сеанс створено'], ['Session duplicated','Сеанс продубльовано'], ['Session started','Сеанс запущено'],
  ['Session paused by master pause','Сеанс призупинено загальною паузою'], ['Session paused','Сеанс призупинено'], ['Session resumed into recovery','Сеанс продовжено в режимі відновлення'],
  ['Session resumed after master pause','Сеанс продовжено після загальної паузи'], ['Session resumed','Сеанс продовжено'], ['Session stopped; unresolved operation preserved','Сеанс зупинено; дані незавершеної операції збережено'],
  ['Session stopped','Сеанс зупинено'], ['Session remains paused for manual review after master resume','Сеанс залишається призупиненим: потрібна ручна перевірка'],
  ['Another active or unresolved session already owns one of these ChatGPT conversations','Інший активний або незавершений сеанс уже використовує один із цих чатів ChatGPT'],
  ['Resolve the uncertain send operation before starting','Спочатку розв’яжіть невизначений результат попереднього відправлення'], ['Resolve the uncertain send operation before duplicating','Спочатку розв’яжіть невизначений результат попереднього відправлення'],
  ['Resolve manual review before resuming','Перед продовженням завершіть ручну перевірку'], ['Enable at least one task before starting','Перед запуском увімкніть щонайменше одне завдання'],
  ['The same ChatGPT conversation cannot appear twice in one active session','Один і той самий чат ChatGPT не може двічі використовуватися в одному активному сеансі'], ['Session is already active','Сеанс уже активний'],
  ['Only an active session can be paused','Призупинити можна лише активний сеанс'], ['Only a paused session can be resumed','Продовжити можна лише призупинений сеанс'], ['Profile send arbiter is busy','Механізм черги відправлень профілю зайнятий'],
  ['Automatic execution temporarily unavailable; retry scheduled.','Автоматичне виконання тимчасово недоступне; повторну спробу заплановано.'], ['Insertion outcome was not confirmed; a safe retry was scheduled.','Результат вставлення не підтверджено; заплановано безпечну повторну спробу.'],
  ['Pre-submit operation was interrupted; a safe retry was scheduled.','Операцію перед відправленням перервано; заплановано безпечну повторну спробу.'], ['Interrupted pre-submit operation failed safe; retry scheduled.','Перервану операцію перед відправленням безпечно зупинено; повторну спробу заплановано.'],
  ['Interaction transport failed safely','Взаємодію з вкладкою безпечно зупинено через помилку'], ['Chat interaction failed safely. No result was recorded as sent.','Взаємодію з ChatGPT безпечно зупинено. Відправлення не зараховано як успішне.'],
  ['Stored state is corrupt','Збережений стан пошкоджено'], ['Stored state has an invalid schema version','Збережений стан має некоректну версію структури'], ['State was created by a newer extension version','Стан створено новішою версією розширення'],
  ['Session not found','Сеанс не знайдено'], ['Task not found','Завдання не знайдено'], ['Operation not found','Операцію не знайдено'], ['Outstanding operation exists','Існує незавершена операція'], ['No operation','Немає операції']
];

function actionLabel(value) {
  return ({Start:'Запуск', Pause:'Призупинення', Resume:'Продовження', Stop:'Зупинення', 'Clear log':'Очищення журналу', 'master pause':'загальне призупинення', 'master resume':'загальне продовження'})[value] || value;
}
function runtimeText(value) {
  let text = String(value ?? '');
  if (STATE[text]) return STATE[text];
  for (const [source,target] of RUNTIME) text = text.replaceAll(source,target);
  return text;
}
function taskTail(value) {
  if (value === ' enabled') return ' увімкнено';
  if (value === ' label, optional') return ': назва, необов’язково';
  if (value === ' ChatGPT URL') return ': посилання ChatGPT';
  return value;
}

export function translateText(value) {
  const input = String(value ?? '');
  const leading = input.match(/^\s*/)?.[0] ?? '';
  const trailing = input.match(/\s*$/)?.[0] ?? '';
  const text = input.trim();
  if (!text) return input;
  if (EXACT.has(text)) return `${leading}${EXACT.get(text)}${trailing}`;
  if (STATE[text]) return `${leading}${STATE[text]}${trailing}`;
  let m;
  if ((m=text.match(/^Open session (.+)$/))) return `${leading}Відкрити сеанс ${m[1]}${trailing}`;
  if ((m=text.match(/^Rename session (.+)$/))) return `${leading}Перейменувати сеанс ${m[1]}${trailing}`;
  if ((m=text.match(/^Duplicate session (.+)$/))) return `${leading}Дублювати сеанс ${m[1]}${trailing}`;
  if ((m=text.match(/^Delete session (.+)\. This removes the selected session configuration\.$/))) return `${leading}Видалити сеанс «${m[1]}». Буде видалено його налаштування.${trailing}`;
  if ((m=text.match(/^Delete session (.+)$/))) return `${leading}Видалити сеанс ${m[1]}${trailing}`;
  if ((m=text.match(/^Session: (.+)$/))) return `${leading}Сеанс: ${m[1]}${trailing}`;
  if ((m=text.match(/^State: ([A-Z_]+)\.$/))) return `${leading}Стан: ${STATE[m[1]] || m[1]}.${trailing}`;
  if ((m=text.match(/^(\d+) enabled tasks\.$/))) return `${leading}Увімкнених завдань: ${m[1]}.${trailing}`;
  if ((m=text.match(/^Task (\d+)(.*)$/))) return `${leading}Завдання ${m[1]}${taskTail(m[2])}${trailing}`;
  if ((m=text.match(/^Prompt for Task (\d+)$/))) return `${leading}Промпт для завдання ${m[1]}${trailing}`;
  if ((m=text.match(/^Remove Task (\d+)$/))) return `${leading}Видалити завдання ${m[1]}${trailing}`;
  if ((m=text.match(/^Task limit reached: 50\.$/))) return `${leading}Досягнуто межі: 50 завдань.${trailing}`;
  if ((m=text.match(/^Up to 50 tasks per session\. (\d+) configured\.$/))) return `${leading}До 50 завдань у сеансі. Налаштовано: ${m[1]}.${trailing}`;
  if ((m=text.match(/^Task (\d+) added\.$/))) return `${leading}Додано завдання ${m[1]}.${trailing}`;
  if ((m=text.match(/^Task (\d+) URL is required\.$/))) return `${leading}Для завдання ${m[1]} потрібно вказати посилання.${trailing}`;
  if ((m=text.match(/^Task (\d+) must use a valid https:\/\/chatgpt\.com URL\.$/))) return `${leading}Для завдання ${m[1]} потрібно вказати коректне посилання https://chatgpt.com.${trailing}`;
  if ((m=text.match(/^Prompt for Task (\d+) is required in unique mode\.$/))) return `${leading}У режимі окремих промптів для завдання ${m[1]} потрібно вказати промпт.${trailing}`;
  if ((m=text.match(/^(\d+) configuration errors?\.$/))) return `${leading}Помилок налаштування: ${m[1]}.${trailing}`;
  if ((m=text.match(/^(\d+) Core log entr(?:y|ies) shown\.$/))) return `${leading}Показано записів журналу: ${m[1]}.${trailing}`;
  if ((m=text.match(/^Core acknowledged (.+)\. Current state: ([A-Z_]+)\.$/))) return `${leading}Команду «${actionLabel(m[1])}» виконано. Поточний стан: ${STATE[m[2]] || m[2]}.${trailing}`;
  if ((m=text.match(/^Core acknowledged (.+)\.$/))) return `${leading}Команду «${actionLabel(m[1])}» виконано.${trailing}`;
  if ((m=text.match(/^Command failed: (.+)$/))) return `${leading}Не вдалося виконати команду: ${runtimeText(m[1])}${trailing}`;
  if ((m=text.match(/^Retry\/backoff unit changed to (minutes|seconds)\. Current wait is ([0-9.]+) (minutes|seconds)\.$/))) return `${leading}Одиницю часу змінено на ${m[1] === 'minutes' ? 'хвилини' : 'секунди'}. Поточне очікування: ${m[2]}.${trailing}`;
  if ((m=text.match(/^Default prompt applied to (\d+) empty tasks?\.$/))) return `${leading}Промпт за замовчуванням застосовано до порожніх завдань: ${m[1]}.${trailing}`;
  return `${leading}${runtimeText(text)}${trailing}`;
}

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent=node.parentElement;
    if (!parent || ['SCRIPT','STYLE','TEXTAREA'].includes(parent.tagName)) return;
    const next=translateText(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue=next;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  translateElement(node);
  for (const child of node.childNodes) translateNode(child);
}
function translateElement(element) {
  for (const attr of ['aria-label','title']) {
    if (!element.hasAttribute(attr)) continue;
    const oldValue=element.getAttribute(attr), newValue=translateText(oldValue);
    if (oldValue !== newValue) element.setAttribute(attr,newValue);
  }
}
export function installUkrainianUi(doc=document) {
  doc.documentElement.lang='uk';
  doc.title='ChatGPT Автопілот';
  translateNode(doc.body);
  const observer=new MutationObserver((mutations)=>{
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') translateNode(mutation.target);
      else if (mutation.type === 'childList') for (const node of mutation.addedNodes) translateNode(node);
      else if (mutation.type === 'attributes') translateElement(mutation.target);
    }
  });
  observer.observe(doc.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','title']});
  return observer;
}
if (typeof document !== 'undefined' && document.body) installUkrainianUi(document);
