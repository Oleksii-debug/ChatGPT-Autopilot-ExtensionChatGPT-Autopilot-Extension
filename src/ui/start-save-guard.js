const SAVE_WAIT_TIMEOUT_MS = 3000;
const SAVE_POLL_INTERVAL_MS = 50;

let startInFlight = false;
let bypassNextStart = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function currentSessionId() {
  const current = document.querySelector('#session-list [aria-current="page"]');
  const prefix = 'session-select-';
  if (!current?.id?.startsWith(prefix)) return '';
  return current.id.slice(prefix.length);
}

async function core(command, payload = {}) {
  const response = await chrome.runtime.sendMessage({ channel: 'autopilot-ui', command, payload });
  if (!response || response.ok !== true) throw new Error(response?.error?.message || 'Core command failed.');
  return response.data;
}

function report(message) {
  const result = document.getElementById('command-result');
  const appStatus = document.getElementById('app-status');
  const announcer = document.getElementById('live-announcer');
  if (result) result.textContent = message;
  if (appStatus) appStatus.textContent = message;
  if (announcer) {
    announcer.textContent = '';
    requestAnimationFrame(() => { announcer.textContent = message; });
  }
}

function validationFailed() {
  return Boolean(document.querySelector('#session-editor [aria-invalid="true"]'));
}

async function waitForSavedVersion(sessionId, previousVersion) {
  const deadline = Date.now() + SAVE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (validationFailed()) return false;
    const data = await core('GET_SESSION', { sessionId });
    if (Number(data?.session?.version) > Number(previousVersion)) return true;
    await sleep(SAVE_POLL_INTERVAL_MS);
  }
  return false;
}

async function saveBeforeStart(event) {
  if (bypassNextStart) {
    bypassNextStart = false;
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  if (startInFlight) return;

  const startButton = document.getElementById('start-session-button');
  const saveButton = document.getElementById('save-session-button');
  const sessionId = currentSessionId();
  if (!startButton || !saveButton || !sessionId) {
    report('Запуск скасовано: не вдалося визначити поточний сеанс. Відкрийте потрібний сеанс і повторіть запуск.');
    return;
  }

  startInFlight = true;
  startButton.disabled = true;
  try {
    const before = await core('GET_SESSION', { sessionId });
    const previousVersion = Number(before?.session?.version || 0);

    saveButton.click();
    const saved = await waitForSavedVersion(sessionId, previousVersion);
    if (!saved) {
      if (!validationFailed()) {
        report('Запуск скасовано: поточні налаштування не вдалося зберегти. Перевірте повідомлення про помилку і повторіть запуск.');
      }
      return;
    }

    await sleep(100);
    bypassNextStart = true;
    startButton.disabled = false;
    startButton.click();
  } catch (error) {
    report(`Запуск скасовано: ${error.message}`);
  } finally {
    startInFlight = false;
    if (!bypassNextStart) startButton.disabled = false;
  }
}

document.getElementById('start-session-button')?.addEventListener('click', saveBeforeStart, { capture: true });
