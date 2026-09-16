const $ = id => document.getElementById(id);
const runtimeAvailable = () => Boolean(globalThis.chrome?.runtime?.sendMessage);

async function core(command, payload = {}) {
  if (!runtimeAvailable()) throw new Error('Core runtime is not available yet.');
  const response = await chrome.runtime.sendMessage({ channel: 'autopilot-ui', command, payload });
  if (!response || response.ok !== true) throw new Error(response?.error?.message || 'Core command failed.');
  return response.data;
}

function currentSessionId() {
  return document.querySelector('#session-list button[aria-current="page"]')?.id?.replace(/^session-select-/, '') || null;
}

function makeField(labelText, id, type = 'text', value = '') {
  const wrapper = document.createElement('div');
  const label = document.createElement('label'); label.htmlFor = id; label.textContent = labelText;
  const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  input.id = id;
  if (type !== 'textarea') { input.type = type; input.inputMode = type === 'number' ? 'numeric' : undefined; }
  input.value = value;
  wrapper.append(label, input);
  return { wrapper, input };
}

function buildPanel() {
  if ($('batch-chat-flow-section')) return;
  const editor = $('session-editor');
  const anchor = editor?.querySelector('#configuration-heading')?.parentElement;
  if (!anchor) return;

  const section = document.createElement('section');
  section.id = 'batch-chat-flow-section';
  section.setAttribute('aria-labelledby', 'batch-chat-flow-heading');

  const heading = document.createElement('h3'); heading.id = 'batch-chat-flow-heading'; heading.textContent = 'Пакетна робота з чатами';
  const help = document.createElement('p');
  help.id = 'batch-chat-flow-help';
  help.textContent = 'Одна Session працює з заданою кількістю чатів одночасно. Кожне завдання: Стартовий промт → вибрана кількість разів «Постійний промт» → Завершальний промт. Після завершення слот перевидається наступному новому чату.';

  const enabled = document.createElement('label');
  const enabledInput = document.createElement('input'); enabledInput.id = 'batch-chat-flow-enabled'; enabledInput.type = 'checkbox';
  enabled.append(enabledInput, document.createTextNode(' Увімкнути пакетний режим'));

  const seed = makeField('Звичайне посилання ChatGPT для створення нових чатів', 'batch-chat-flow-seed', 'url');
  const concurrency = makeField('Кількість чатів одночасно', 'batch-chat-flow-concurrency', 'number', '5');
  concurrency.input.min = '1'; concurrency.input.max = '50'; concurrency.input.step = '1';
  const total = makeField('Загальна кількість завдань', 'batch-chat-flow-total', 'number', '100');
  total.input.min = '1'; total.input.max = '100000'; total.input.step = '1';
  const interval = makeField('Інтервал запуску наступного чату, секунд', 'batch-chat-flow-interval', 'number', '10');
  interval.input.min = '0'; interval.input.max = '86400'; interval.input.step = '1';
  const primary = makeField('Стартовий промт', 'batch-chat-flow-primary', 'textarea'); primary.input.rows = 8;
  const cont = makeField('Постійний промт', 'batch-chat-flow-continue', 'textarea', 'продовжуй'); cont.input.rows = 4;
  const count = makeField('Кількість вставлень Постійного промту', 'batch-chat-flow-count', 'number', '10');
  count.input.min = '0'; count.input.max = '1000000'; count.input.step = '1';
  const final = makeField('Завершальний промт', 'batch-chat-flow-final', 'textarea'); final.input.rows = 8;

  const actions = document.createElement('div');
  const save = document.createElement('button'); save.id = 'batch-chat-flow-save'; save.type = 'button'; save.textContent = 'Зберегти пакетну роботу';
  const start = document.createElement('button'); start.id = 'batch-chat-flow-start'; start.type = 'button'; start.textContent = 'Запустити пакетну роботу';
  const status = document.createElement('p'); status.id = 'batch-chat-flow-status'; status.setAttribute('role', 'status'); status.tabIndex = 0; status.textContent = 'Пакетний режим не завантажено.';
  actions.append(save, start, status);

  section.append(heading, help, enabled, seed.wrapper, concurrency.wrapper, total.wrapper, interval.wrapper, primary.wrapper, cont.wrapper, count.wrapper, final.wrapper, actions);
  anchor.after(section);

  save.addEventListener('click', async () => {
    const sessionId = currentSessionId();
    if (!sessionId) { status.textContent = 'Спочатку виберіть Session.'; return; }
    try {
      const data = await core('SET_BATCH_CHAT_FLOW', {
        sessionId,
        config: {
          enabled: enabledInput.checked,
          seedUrl: seed.input.value.trim(),
          concurrency: Number(concurrency.input.value),
          totalTasks: Number(total.input.value),
          startIntervalMs: Number(interval.input.value) * 1000,
          primaryPrompt: primary.input.value,
          continuePrompt: cont.input.value,
          continueCount: Number(count.input.value),
          finalPrompt: final.input.value,
        },
      });
      status.textContent = `Збережено. Активних слотів: ${data.activeTaskCount}; усього завдань: ${data.totalTasks}.`;
      status.focus();
    } catch (error) { status.textContent = error.message; status.focus(); }
  });

  start.addEventListener('click', async () => {
    const sessionId = currentSessionId();
    if (!sessionId) { status.textContent = 'Спочатку виберіть Session.'; return; }
    try {
      const data = await core('START_BATCH_CHAT_FLOW', { sessionId });
      status.textContent = `Пакетну роботу запущено. Одночасно чатів: ${data.config.concurrency}. Завдання: ${data.config.totalTasks}.`;
      status.focus();
    } catch (error) { status.textContent = error.message; status.focus(); }
  });

  void loadPanelData();
}

async function loadPanelData() {
  const sessionId = currentSessionId();
  if (!sessionId) return;
  try {
    const data = await core('GET_BATCH_CHAT_FLOW', { sessionId });
    const config = data.config || {};
    $('batch-chat-flow-enabled').checked = config.enabled === true;
    $('batch-chat-flow-seed').value = config.seedUrl || '';
    $('batch-chat-flow-concurrency').value = config.concurrency ?? 5;
    $('batch-chat-flow-total').value = config.totalTasks ?? 100;
    $('batch-chat-flow-interval').value = Math.floor((config.startIntervalMs || 0) / 1000);
    $('batch-chat-flow-primary').value = config.primaryPrompt || '';
    $('batch-chat-flow-continue').value = config.continuePrompt || 'продовжуй';
    $('batch-chat-flow-count').value = config.continueCount ?? 10;
    $('batch-chat-flow-final').value = config.finalPrompt || '';
    $('batch-chat-flow-status').textContent = config.enabled
      ? `Поточний стан: ${data.runState}. Завершено ${data.completedTasks} з ${data.totalTasks}. Наступний номер: ${data.nextOrdinal}.`
      : 'Пакетний режим вимкнений.';
  } catch (error) {
    $('batch-chat-flow-status').textContent = error.message;
  }
}

function install() {
  buildPanel();
  const list = $('session-list');
  if (list && !list.dataset.batchFlowObserver) {
    list.dataset.batchFlowObserver = '1';
    new MutationObserver(() => { buildPanel(); void loadPanelData(); }).observe(list, { childList: true, subtree: true });
  }
  chrome?.runtime?.onMessage?.addListener(message => {
    if (message?.channel === 'autopilot-core' && message?.type === 'STATUS_CHANGED') void loadPanelData();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
