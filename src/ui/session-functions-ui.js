const FUNCTION_DEFS = [
  { id: 'ordinary_send', label: 'Звичайні надсилання', description: 'Базова робота Session: надсилання промтів у звичайному режимі.', defaultEnabled: true },
  { id: 'batch_chat', label: 'Паралельна робота з чатами', description: 'Працювати одночасно з кількома чатами та після завершення слота запускати наступне завдання.', defaultEnabled: false },
  { id: 'prompt_cadence', label: 'Додаткові промти', description: 'Використовувати Промт 2 і Промт 3 на заданих номерах успішних стандартних надсилань.', defaultEnabled: false },
  { id: 'drive_source', label: 'Джерело Google Drive', description: 'Підтягувати актуальний промт або інше налаштоване джерело з Google Drive.', defaultEnabled: false },
];

const $ = id => document.getElementById(id);
const runtimeAvailable = () => Boolean(globalThis.chrome?.runtime?.sendMessage);
async function core(command, payload = {}) {
  if (!runtimeAvailable()) throw new Error('Core runtime is not available yet.');
  const response = await globalThis.chrome.runtime.sendMessage({ channel: 'autopilot-ui', command, payload });
  if (!response || response.ok !== true) throw new Error(response?.error?.message || 'Core command failed.');
  return response.data;
}

function currentSessionId() {
  return document.querySelector('#session-list button[aria-current="page"]')?.id?.replace(/^session-select-/, '') || '';
}

function ensurePanel() {
  if ($('session-functions-region')) return $('session-functions-region');
  const anchor = $('configuration-heading')?.parentElement;
  if (!anchor) return null;
  const section = document.createElement('section');
  section.id = 'session-functions-region';
  section.setAttribute('aria-labelledby', 'session-functions-heading');
  const heading = document.createElement('h3');
  heading.id = 'session-functions-heading';
  heading.textContent = 'Функції цієї Session';
  const help = document.createElement('p');
  help.id = 'session-functions-help';
  help.textContent = 'Увімкніть тільки ті можливості, які повинні брати участь у цій Session. Налаштування вимкнених функцій не запускаються.';
  section.append(heading, help);
  const fieldset = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = 'Активні функції';
  fieldset.append(legend);
  for (const definition of FUNCTION_DEFS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `session-function-${definition.id}`;
    input.dataset.sessionFunction = definition.id;
    label.append(input, document.createTextNode(` ${definition.label}`));
    fieldset.append(label);
    const description = document.createElement('p');
    description.id = `session-function-${definition.id}-help`;
    description.textContent = definition.description;
    description.className = 'session-function-description';
    fieldset.append(description);
    input.addEventListener('change', () => {
      void saveFunctions().catch(error => {
        input.checked = !input.checked;
        setStatus(error.message);
      });
      syncModuleVisibility();
    });
  }
  const status = document.createElement('p');
  status.id = 'session-functions-status';
  status.setAttribute('role', 'status');
  status.tabIndex = 0;
  status.textContent = 'Функції ще не завантажено.';
  fieldset.append(status);
  section.append(fieldset);
  anchor.after(section);
  return section;
}

function setStatus(message) {
  const target = $('session-functions-status');
  if (target) target.textContent = message;
}

function syncModuleVisibility() {
  const enabled = id => Boolean($(`session-function-${id}`)?.checked);
  const batch = $('batch-chat-flow-section');
  if (batch) batch.hidden = !enabled('batch_chat');
  const cadence = $('prompt-cadence-region');
  if (cadence) cadence.hidden = !enabled('prompt_cadence');
  const drive = $('drive-source-region');
  if (drive) drive.hidden = !enabled('drive_source');
}

async function saveFunctions() {
  const sessionId = currentSessionId();
  if (!sessionId) throw new Error('Спочатку виберіть Session.');
  const enabled = {};
  for (const definition of FUNCTION_DEFS) enabled[definition.id] = Boolean($(`session-function-${definition.id}`)?.checked);
  const result = await core('SET_SESSION_FUNCTIONS', { sessionId, enabled });
  setStatus('Функції Session збережено.');
  applySnapshot(result);
}

function applySnapshot(result) {
  const functions = result?.activeFunctions || {};
  for (const definition of FUNCTION_DEFS) {
    const input = $(`session-function-${definition.id}`);
    if (input) input.checked = functions[definition.id]?.enabled === true;
  }
  syncModuleVisibility();
}

async function loadFunctions() {
  const panel = ensurePanel();
  const sessionId = currentSessionId();
  if (!panel || !sessionId || $('session-editor')?.hidden) {
    if (panel) panel.hidden = true;
    return;
  }
  panel.hidden = false;
  try {
    const result = await core('GET_SESSION_FUNCTIONS', { sessionId });
    applySnapshot(result);
  } catch (error) {
    setStatus(error.message);
  }
}

let lastSessionId = '';
async function sync() {
  const sessionId = currentSessionId();
  if (!sessionId || $('session-editor')?.hidden) return;
  ensurePanel();
  if (sessionId !== lastSessionId) {
    lastSessionId = sessionId;
    await loadFunctions();
  } else {
    syncModuleVisibility();
  }
}

const observer = new MutationObserver(() => { void sync(); });
observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
document.addEventListener('click', () => setTimeout(() => { void sync(); }, 0), true);
void sync();
