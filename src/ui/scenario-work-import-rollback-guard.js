const IMPORT_FAILURE_PREFIX = 'Імпорт не виконано; часткові сценарії прибрано:';
const IMPORT_BUTTON_IDS = [
  'import-scenario-work-profile-button',
  'import-start-scenario-work-profile-button',
];

function scenarioList(data = {}) {
  return Array.isArray(data?.scenarios) ? data.scenarios : [];
}

function scenarioId(item) {
  return typeof item?.id === 'string' ? item.id : '';
}

export function classifyScenarioWorkRollback(beforeIds, data = {}) {
  if (!Array.isArray(beforeIds)) return { status: 'AMBIGUOUS', residuals: [] };
  const baseline = new Set(beforeIds.filter(Boolean));
  const residuals = scenarioList(data).filter(item => {
    const id = scenarioId(item);
    return id && !baseline.has(id);
  });
  return {
    status: residuals.length ? 'RESIDUAL' : 'VERIFIED_REMOVED',
    residuals,
  };
}

function residualLabel(item) {
  const id = scenarioId(item) || 'unknown-id';
  const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : id;
  const state = item?.runtime?.runState || 'UNKNOWN';
  const pending = item?.runtime?.deletePending === true ? ', deletePending' : '';
  return `${name} (${id}; ${state}${pending})`;
}

export function scenarioWorkRollbackTruthMessage(result, importError = '') {
  const reason = String(importError || '').trim();
  const suffix = reason ? ` Причина імпорту: ${reason}` : '';
  if (result?.status === 'VERIFIED_REMOVED') {
    return `Імпорт не виконано; rollback перевірено: часткових сценаріїв не залишилося.${suffix}`;
  }
  if (result?.status === 'RESIDUAL') {
    const residuals = Array.isArray(result.residuals) ? result.residuals : [];
    const sample = residuals.slice(0, 5).map(residualLabel).join('; ');
    const more = residuals.length > 5 ? `; ще ${residuals.length - 5}` : '';
    return `Імпорт не виконано; rollback НЕ завершено. Залишилися часткові сценарії: ${sample || 'невідомі'}${more}. Перевірте/видаліть їх перед повторним імпортом.${suffix}`;
  }
  return `Імпорт не виконано; стан rollback НЕ ПІДТВЕРДЖЕНО. Не вважайте часткові сценарії видаленими; перевірте список сценаріїв.${suffix}`;
}

async function runtimeCore(command, payload = {}) {
  const response = await globalThis.chrome.runtime.sendMessage({ channel: 'autopilot-ui', command, payload });
  if (!response || response.ok !== true) throw new Error(response?.error?.message || 'Core command failed.');
  return response.data;
}

function announce(root, message) {
  const announcer = root.getElementById('live-announcer');
  if (!announcer) return;
  announcer.textContent = '';
  const schedule = typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : (callback) => queueMicrotask(callback);
  schedule(() => { announcer.textContent = message; });
}

export function installScenarioWorkImportRollbackGuard({ core = runtimeCore, root = globalThis.document } = {}) {
  if (!root) return { installed: false };
  const preview = root.getElementById('scenario-work-profile-preview');
  const buttons = IMPORT_BUTTON_IDS.map(id => root.getElementById(id)).filter(Boolean);
  const Observer = globalThis.MutationObserver;
  if (!preview || !buttons.length || typeof Observer !== 'function') return { installed: false };

  let baselineIds = null;
  let replayButtonId = '';
  let baselineCaptureInFlight = false;
  let verificationInFlight = false;

  async function captureBaselineAndReplay(event) {
    const button = event.currentTarget;
    if (replayButtonId === button.id) {
      replayButtonId = '';
      return;
    }
    if (button.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (baselineCaptureInFlight) return;

    baselineCaptureInFlight = true;
    button.disabled = true;
    try {
      const data = await core('LIST_SCENARIO_WORK');
      baselineIds = scenarioList(data).map(scenarioId).filter(Boolean);
      replayButtonId = button.id;
      button.disabled = false;
      button.click();
    } catch (error) {
      baselineIds = null;
      button.disabled = false;
      const message = `Імпорт не запущено: не вдалося зафіксувати початковий список сценаріїв (${error.message}).`;
      preview.textContent = message;
      announce(root, message);
    } finally {
      baselineCaptureInFlight = false;
    }
  }

  async function verifyRollback(importError) {
    if (verificationInFlight) return;
    verificationInFlight = true;
    const baseline = baselineIds;
    baselineIds = null;
    preview.textContent = 'Імпорт не виконано; перевіряю фактичний стан rollback…';
    try {
      if (!Array.isArray(baseline)) {
        const ambiguous = scenarioWorkRollbackTruthMessage({ status: 'AMBIGUOUS', residuals: [] }, importError);
        preview.textContent = ambiguous;
        announce(root, ambiguous);
        return;
      }
      const data = await core('LIST_SCENARIO_WORK');
      const result = classifyScenarioWorkRollback(baseline, data);
      const message = scenarioWorkRollbackTruthMessage(result, importError);
      preview.textContent = message;
      announce(root, message);
    } catch (error) {
      const message = `${scenarioWorkRollbackTruthMessage({ status: 'AMBIGUOUS', residuals: [] }, importError)} Перевірка завершилася помилкою: ${error.message}`;
      preview.textContent = message;
      announce(root, message);
    } finally {
      verificationInFlight = false;
    }
  }

  const observer = new Observer(() => {
    const message = String(preview.textContent || '');
    if (!message.startsWith(IMPORT_FAILURE_PREFIX)) return;
    const importError = message.slice(IMPORT_FAILURE_PREFIX.length).trim();
    void verifyRollback(importError);
  });
  observer.observe(preview, { childList: true, characterData: true, subtree: true });

  for (const button of buttons) button.addEventListener('click', captureBaselineAndReplay, { capture: true });
  return { installed: true, observer };
}

if (globalThis.document && globalThis.chrome?.runtime?.sendMessage) {
  installScenarioWorkImportRollbackGuard();
}
