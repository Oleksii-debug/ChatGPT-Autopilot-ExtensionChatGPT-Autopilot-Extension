import {
  SelectionActionContractVersion,
  SelectionActionSourceKind,
  normalizeSelectionActionRequestV1,
} from '../core/selection-action.js';
import { buildQuickCommandSessionPlanV1 } from '../core/quick-command-runtime.js';

const sourceKind = document.getElementById('source-kind');
const sourceText = document.getElementById('source-text');
const sourceUri = document.getElementById('source-uri');
const operation = document.getElementById('operation');
const captureButton = document.getElementById('capture-source');
const runButton = document.getElementById('run-command');
const optionsButton = document.getElementById('open-options');
const status = document.getElementById('status');
const captureHelp = document.getElementById('capture-help');

function announce(message, focus = false) {
  status.textContent = message;
  if (focus) status.focus();
}

function setBusy(busy) {
  captureButton.disabled = busy;
  runButton.disabled = busy;
  optionsButton.disabled = busy;
  sourceKind.disabled = busy;
  operation.disabled = busy;
}

async function core(command, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    channel: 'autopilot-ui',
    command,
    payload,
  });
  if (!response || response.ok !== true) {
    throw new Error(response?.error?.message || 'Core command failed');
  }
  return response.data;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !Number.isInteger(tab.id)) throw new Error('Активну вкладку не знайдено.');
  return tab;
}

async function captureCurrentTab(kind) {
  const tab = await getActiveTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: requestedKind => {
      const uri = String(globalThis.location?.href || '');
      if (requestedKind === 'SELECTION') {
        const text = String(globalThis.getSelection?.()?.toString() || '').slice(0, 100000);
        return { text, uri };
      }
      const text = String(globalThis.document?.body?.innerText || '').slice(0, 100000);
      return { text, uri };
    },
    args: [kind],
  });
  const value = results?.[0]?.result;
  if (!value || typeof value.text !== 'string') {
    throw new Error('Не вдалося прочитати поточну сторінку.');
  }
  return value;
}

function updateSourceHelp() {
  if (sourceKind.value === SelectionActionSourceKind.CLIPBOARD) {
    captureHelp.textContent = 'Натисніть «Захопити джерело», потім вставте текст у поле через Ctrl+V. Буфер не читається автоматично.';
    sourceUri.value = '';
    return;
  }
  captureHelp.textContent = 'Захоплення виконується тільки після натискання цієї кнопки.';
}

sourceKind.addEventListener('change', updateSourceHelp);

captureButton.addEventListener('click', async () => {
  try {
    if (sourceKind.value === SelectionActionSourceKind.CLIPBOARD) {
      sourceUri.value = '';
      sourceText.focus();
      announce('Вставте текст з буфера обміну через Ctrl+V.');
      return;
    }
    setBusy(true);
    announce('Захоплення джерела…');
    const captured = await captureCurrentTab(sourceKind.value);
    if (!captured.text.trim()) {
      throw new Error(sourceKind.value === SelectionActionSourceKind.SELECTION
        ? 'На сторінці немає виділеного тексту.'
        : 'Текст поточної сторінки порожній.');
    }
    sourceText.value = captured.text;
    sourceUri.value = captured.uri || '';
    announce('Джерело захоплено.', true);
  } catch (error) {
    announce('Не вдалося захопити джерело: ' + (error?.message || 'невідома помилка'), true);
  } finally {
    setBusy(false);
  }
});

runButton.addEventListener('click', async () => {
  let createdSessionId = '';
  try {
    const text = sourceText.value;
    if (!text.trim()) throw new Error('Введіть або захопіть текст джерела.');
    if (sourceKind.value === SelectionActionSourceKind.CURRENT_PAGE && !sourceUri.value) {
      throw new Error('Для поточної сторінки спочатку натисніть «Захопити джерело».');
    }

    setBusy(true);
    announce('Створення одноразового сеансу…');

    const capturedAt = new Date().toISOString();
    const rawSource = {
      schemaVersion: SelectionActionContractVersion,
      sourceId: 'quick-source-' + crypto.randomUUID(),
      kind: sourceKind.value,
      capturedAt,
      text,
    };
    if (sourceUri.value) rawSource.uri = sourceUri.value;

    const request = normalizeSelectionActionRequestV1({
      schemaVersion: SelectionActionContractVersion,
      requestId: crypto.randomUUID(),
      source: rawSource,
      operation: operation.value,
      ownerInstruction: '',
      target: {},
      createdAt: capturedAt,
    });
    const plan = buildQuickCommandSessionPlanV1(request);
    const created = await core('CREATE_SESSION', { config: plan.sessionConfig });
    createdSessionId = created?.session?.id || plan.sessionConfig.id;
    await core('START_SESSION', { sessionId: createdSessionId });
    announce('Швидку дію запущено. Результат з’явиться у новому чаті ChatGPT.', true);
  } catch (error) {
    const prefix = createdSessionId
      ? 'Сеанс створено, але запуск не вдався. Його можна відновити у повних налаштуваннях. '
      : 'Швидку дію не запущено. ';
    announce(prefix + (error?.message || 'Невідома помилка.'), true);
  } finally {
    setBusy(false);
  }
});

optionsButton.addEventListener('click', async () => {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (error) {
    announce('Не вдалося відкрити налаштування: ' + (error?.message || 'невідома помилка'), true);
  }
});

updateSourceHelp();
sourceKind.focus();
