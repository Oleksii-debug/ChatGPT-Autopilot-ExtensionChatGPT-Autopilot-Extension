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
    <h4 id="prompt-cadence-heading">Додаткові промти</h4>
    <p>Промт 1 — основний промт Session. Промт 2 і Промт 3 за потреби замінюють його на своїх номерах від одного спільного лічильника успішних надсилань.</p>

    <fieldset>
      <legend>Промт 2</legend>
      <label><input id="prompt2-enabled" type="checkbox"> Увімкнути промт 2</label>
      <div id="prompt2-fields" hidden>
        <label for="prompt2-text">Текст промту 2</label>
        <textarea id="prompt2-text" rows="5"></textarea>
        <label for="prompt2-every">Кожне N-те успішне надсилання</label>
        <input id="prompt2-every" type="number" min="2" max="1000000" step="1" value="30">
      </div>
    </fieldset>

    <fieldset>
      <legend>Промт 3</legend>
      <label><input id="prompt3-enabled" type="checkbox"> Увімкнути промт 3</label>
      <div id="prompt3-fields" hidden>
        <label for="prompt3-text">Текст промту 3</label>
        <textarea id="prompt3-text" rows="5"></textarea>
        <label for="prompt3-every">Кожне N-те успішне надсилання</label>
        <input id="prompt3-every" type="number" min="2" max="1000000" step="1" value="40">
      </div>
    </fieldset>

    <p>Якщо Промт 2 і Промт 3 припадають на один номер, Промт 3 має пріоритет. Робота з кількома чатами налаштовується окремою функцією «Паралельна робота з чатами».</p>
    <button id="prompt-cadence-save" type="button">Зберегти додаткові промти</button>
    <p id="prompt-cadence-status" role="status" tabindex="0">Налаштування ще не завантажено.</p>
  `;
  anchor.insertAdjacentElement('afterend', section);

  const toggle = (checkId, fieldsId) => $(checkId).addEventListener('change', () => {
    $(fieldsId).hidden = !$(checkId).checked;
  });
  toggle('prompt2-enabled', 'prompt2-fields');
  toggle('prompt3-enabled', 'prompt3-fields');
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
    const prompts = Array.isArray(config.prompts) ? config.prompts : [];
    const p2 = prompts[1] || { enabled: false, prompt: '', everyN: 30 };
    const p3 = prompts[2] || { enabled: false, prompt: '', everyN: 40 };
    $('prompt2-enabled').checked = p2.enabled === true;
    $('prompt2-fields').hidden = !p2.enabled;
    $('prompt2-text').value = p2.prompt || config.secondaryPrompt || '';
    $('prompt2-every').value = Number(p2.everyN || config.everyN) || 30;
    $('prompt3-enabled').checked = p3.enabled === true;
    $('prompt3-fields').hidden = !p3.enabled;
    $('prompt3-text').value = p3.prompt || '';
    $('prompt3-every').value = Number(p3.everyN) || 40;
    const count = Number(data?.verifiedSendCount) || 0;
    $('prompt-cadence-status').textContent = `Збережено. Успішних стандартних надсилань: ${count}.`;
  } catch (error) {
    $('prompt-cadence-status').textContent = error.message;
  }
}

function integerField(id, min = 1) {
  const value = Number($(id).value);
  if (!Number.isInteger(value) || value < min) throw new Error(`Поле «${id}» має бути цілим числом від ${min}.`);
  return value;
}

async function saveCurrent() {
  const sessionId = currentSessionId();
  if (!sessionId) return;
  try {
    const prompts = [
      { enabled: false, prompt: '', everyN: 10 },
      { enabled: $('prompt2-enabled').checked, prompt: $('prompt2-text').value, everyN: integerField('prompt2-every', 2) },
      { enabled: $('prompt3-enabled').checked, prompt: $('prompt3-text').value, everyN: integerField('prompt3-every', 2) },
    ];
    for (let index = 1; index < prompts.length; index += 1) {
      const rule = prompts[index];
      if (rule.enabled && !rule.prompt.trim()) {
        $(`prompt${index + 1}-text`)?.focus();
        throw new Error(`Введіть текст промту ${index + 1}.`);
      }
    }
    const data = await core('SET_PROMPT_CADENCE', {
      sessionId,
      config: { prompts, chatFlow: { enabled: false, mode: 'same-chat' } },
    });
    const count = Number(data?.verifiedSendCount) || 0;
    $('prompt-cadence-status').textContent = `Налаштування збережено. Успішних стандартних надсилань: ${count}.`;
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
