import {
  SelectionActionContractVersion,
  SelectionActionSourceKind,
  normalizeSelectionActionRequestV1,
} from '../core/selection-action.js';
import { buildQuickCommandSessionPlanV1 } from '../core/quick-command-runtime.js';

const MAX_SOURCE_TEXT = 100000;
const sourceKind = document.getElementById('source-kind');
const sourceText = document.getElementById('source-text');
const sourceUri = document.getElementById('source-uri');
const operation = document.getElementById('operation');
const captureButton = document.getElementById('capture-source');
const runButton = document.getElementById('run-command');
const optionsButton = document.getElementById('open-options');
const status = document.getElementById('status');
const captureHelp = document.getElementById('capture-help');
let capturedSource = null;

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
    func: (requestedKind, maxSourceText) => {
      const uri = String(globalThis.location?.href || '');
      const text = requestedKind === 'SELECTION'
        ? String(globalThis.getSelection?.()?.toString() || '')
        : String(globalThis.document?.body?.innerText || '');
      const capturedAt = new Date().toISOString();
      if (text.length > maxSourceText) {
        return { tooLarge: true, textLength: text.length, uri, capturedAt };
      }
      return { tooLarge: false, text, uri, capturedAt };
    },
    args: [kind, MAX_SOURCE_TEXT],
  });
  const value = results?.[0]?.result;
  if (!value || typeof value.capturedAt !== 'string') {
    throw new Error('Не вдалося прочитати поточну сторінку.');
  }
  return value;
}

function resetSourceState() {
  capturedSource = null;
  sourceText.value = '';
  sourceUri.value = '';
  sourceText.readOnly = sourceKind.value !== SelectionActionSourceKind.CLIPBOARD;
}

function updateSourceHelp({ reset = false } = {}) {
  if (reset) resetSourceState();
  if (sourceKind.value === SelectionActionSourceKind.CLIPBOARD) {
    captureHelp.textContent = 'Натисніть «Захопити джерело», потім вставте текст у поле через Ctrl+V. Буфер не читається автоматично.';
    sourceText.readOnly = false;
    return;
  }
  sourceText.readOnly = true;
  captureHelp.textContent = 'Захоплення виконується тільки після натискання цієї кнопки. Захоплений текст не редагується, щоб зберегти точне походження.';
}

sourceKind.addEventListener('change', () => updateSourceHelp({ reset: true }));

captureButton.addEventListener('click', async () => {
  try {
    if (sourceKind.value === SelectionActionSourceKind.CLIPBOARD) {
      capturedSource = null;
      sourceUri.value = '';
      sourceText.readOnly = false;
      sourceText.focus();
      announce('Вставте текст з буфера обміну через Ctrl+V. Поточний текст буде точно прив’язано під час запуску.');
      return;
    }
    setBusy(true);
    announce('Захоплення джерела…');
    const kind = sourceKind.value;
    const captured = await captureCurrentTab(kind);
    if (captured.tooLarge) {
      throw new Error('Текст джерела перевищує 100000 символів. Скоротіть джерело або виберіть менший фрагмент.');
    }
    if (!captured.text.trim()) {
      throw new Error(kind === SelectionActionSourceKind.SELECTION
        ? 'На сторінці немає виділеного тексту.'
        : 'Текст поточної сторінки порожній.');
    }
    capturedSource = Object.freeze({
      kind,
      text: captured.text,
      uri: captured.uri || '',
      capturedAt: captured.capturedAt,
    });
    sourceText.value = capturedSource.text;
    sourceText.readOnly = true;
    sourceUri.value = capturedSource.uri;
    announce('Джерело захоплено і прив’язано до точного часу та типу.', true);
  } catch (error) {
    capturedSource = null;
    sourceText.value = '';
    sourceUri.value = '';
    announce('Не вдалося захопити джерело: ' + (error?.message || 'невідома помилка'), true);
  } finally {
    setBusy(false);
  }
});

runButton.addEventListener('click', async () => {
  let createdSessionId = '';
  try {
    const createdAt = new Date().toISOString();
    let rawSource;

    if (sourceKind.value === SelectionActionSourceKind.CLIPBOARD) {
      const text = sourceText.value;
      if (!text.trim()) throw new Error('Вставте текст джерела через Ctrl+V.');
      if (text.length > MAX_SOURCE_TEXT) {
        throw new Error('Текст буфера перевищує 100000 символів. Скоротіть його перед запуском.');
      }
      rawSource = {
        schemaVersion: SelectionActionContractVersion,
        sourceId: 'quick-source-' + crypto.randomUUID(),
        kind: SelectionActionSourceKind.CLIPBOARD,
        capturedAt: createdAt,
        text,
      };
    } else {
      if (!capturedSource || capturedSource.kind !== sourceKind.value) {
        throw new Error('Після вибору джерела натисніть «Захопити джерело» ще раз.');
      }
      rawSource = {
        schemaVersion: SelectionActionContractVersion,
        sourceId: 'quick-source-' + crypto.randomUUID(),
        kind: capturedSource.kind,
        capturedAt: capturedSource.capturedAt,
        text: capturedSource.text,
      };
      if (capturedSource.uri) rawSource.uri = capturedSource.uri;
    }

    setBusy(true);
    announce('Створення одноразового сеансу…');

    const request = normalizeSelectionActionRequestV1({
      schemaVersion: SelectionActionContractVersion,
      requestId: crypto.randomUUID(),
      source: rawSource,
      operation: operation.value,
      ownerInstruction: '',
      target: {},
      createdAt,
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
