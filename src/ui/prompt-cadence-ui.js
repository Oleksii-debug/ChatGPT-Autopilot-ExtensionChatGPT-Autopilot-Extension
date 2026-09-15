const LAST_SESSION_KEY = 'chatgpt-autopilot-last-session';
const REGION_ID = 'prompt-cadence-region';

const $ = id => document.getElementById(id);

async function core(command, payload = {}) {
  const response = await chrome.runtime.sendMessage({ channel: 'autopilot-ui', command, payload });
  if (!response || response.ok !== true) throw new Error(response?.error?.message || 'Core command failed.');
  return response.data;
}

function currentSessionId() {
  try { return localStorage.getItem(LAST_SESSION_KEY) || ''; } catch { return ''; }
}

function ensureRegion() {
  if ($(REGION_ID)) return $(REGION_ID);
  const anchor = $('unique-default-container') || $('shared-prompt-container');
  if (!anchor?.parentElement) return null;

  const section = document.createElement('section');
  section.id = REGION_ID;
  section.setAttribute('aria-labelledby', 'prompt-cadence-heading');
  section.innerHTML = `
    <h4 id="prompt-cadence-heading">Другий prompt за лічильником</h4>
    <label><input id="prompt-cadence-enabled" type="checkbox"> Увімкнути другий prompt</label>
    <div id="prompt-cadence-fields" hidden>
      <label for="prompt-cadence-text">Другий prompt</label>
      <textarea id="prompt-cadence-text" rows="6"></textarea>
      <label for="prompt-cadence-every">Використовувати його кожен N-й успішний запуск</label>
      <input id="prompt-cadence-every" type="number" min="2" max="1000000" step="1" inputmode="numeric" value="10" aria-describedby="prompt-cadence-help">
      <p id="prompt-cadence-help">Наприклад, 30 означає: 1–29 — основний prompt, 30 — другий, потім цикл повторюється. Часові налаштування сесії не змінюються.</p>
    </div>
    <button id="prompt-cadence-save" type="button">Зберегти правило другого prompt-а</button>
    <p id="prompt-cadence-status" role="status" tabindex="0">Правило ще не завантажено.</p>
  `;
  anchor.insertAdjacentElement('afterend', section);

  $('prompt-cadence-enabled').addEventListener('change', () => {
    $('prompt-cadence-fields').hidden = !$('prompt-cadence-enabled').checked;
  });
  $('prompt-cadence-save').addEventListener('click', saveCurrent);
  return section;
}

async function loadCurrent() {
  const region = ensureRegion();
  const sessionId = currentSessionId();
  if (!region || !sessionId || $('session-editor')?.hidden) {
    if (region) region.hidden = true;
    return;
  }
  region.hidden = false;
  try {
    const data = await core('GET_PROMPT_CADENCE', { sessionId });
    const config = data?.config || {};
    $('prompt-cadence-enabled').checked = config.enabled === true;
    $('prompt-cadence-fields').hidden = config.enabled !== true;
    $('prompt-cadence-text').value = config.secondaryPrompt || '';
    $('prompt-cadence-every').value = Number(config.everyN) || 10;
    const count = Number(data?.verifiedSendCount) || 0;
    $('prompt-cadence-status').textContent = `Збережено. Успішно відправлених prompt-ів у лічильнику: ${count}.`;
  } catch (error) {
    $('prompt-cadence-status').textContent = error.message;
  }
}

async function saveCurrent() {
  const sessionId = currentSessionId();
  if (!sessionId) return;
  const enabled = $('prompt-cadence-enabled').checked;
  const secondaryPrompt = $('prompt-cadence-text').value;
  const everyN = Number($('prompt-cadence-every').value);
  if (enabled && !secondaryPrompt.trim()) {
    $('prompt-cadence-status').textContent = 'Введіть другий prompt або вимкніть правило.';
    $('prompt-cadence-text').focus();
    return;
  }
  if (!Number.isInteger(everyN) || everyN < 2) {
    $('prompt-cadence-status').textContent = 'N має бути цілим числом від 2.';
    $('prompt-cadence-every').focus();
    return;
  }
  try {
    const data = await core('SET_PROMPT_CADENCE', {
      sessionId,
      config: { enabled, secondaryPrompt, everyN },
    });
    const count = Number(data?.verifiedSendCount) || 0;
    $('prompt-cadence-status').textContent = enabled
      ? `Правило збережено: кожен ${everyN}-й успішний запуск використовує другий prompt. Поточний лічильник: ${count}.`
      : `Другий prompt вимкнено. Поточний лічильник збережено: ${count}.`;
  } catch (error) {
    $('prompt-cadence-status').textContent = error.message;
  }
}

let lastSessionId = '';
async function syncIfNeeded() {
  const sessionId = currentSessionId();
  const visible = !$('session-editor')?.hidden;
  if (!visible) {
    if ($(REGION_ID)) $(REGION_ID).hidden = true;
    return;
  }
  ensureRegion();
  if (sessionId && sessionId !== lastSessionId) {
    lastSessionId = sessionId;
    await loadCurrent();
  }
}

const observer = new MutationObserver(() => { void syncIfNeeded(); });
observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
document.addEventListener('click', () => setTimeout(() => { void syncIfNeeded(); }, 0), true);
void syncIfNeeded();
