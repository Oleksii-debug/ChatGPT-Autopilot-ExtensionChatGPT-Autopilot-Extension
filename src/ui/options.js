import { focusAfterLifecycleSuccess } from './focus-policy.js';
import { translateText } from './uk-localization.js';
import { extractChatGptUrls, mergeBulkUrls, parsePortableJson, parseStrictBoundedInteger } from './config-tools.js';

const MAX_PHYSICAL_TASKS = 1000;
const MAX_TASKS = 1_000_000;
const VISIBLE_LOG_LIMIT = 100;
const STATUS_REFRESH_DELAY_MS = 750;
const DRAFT_SAVE_DELAY_MS = 250;
const DIAGNOSTIC_SNAPSHOT_DELAY_MS = 10000;
const DRAFT_KEY_PREFIX = 'chatgpt-autopilot-draft:';
const LAST_SESSION_KEY = 'chatgpt-autopilot-last-session';
const ui = {
  sessions: [],
  sessionListSignature: '',
  selectedSessionId: null,
  selected: null,
  deleteReturnFocus: null,
  pendingPortableProfile: null,
  pendingPortablePreview: null,
  pendingOrchestrationProfile: null,
  orchestrationV2Config: null,
  orchestrationV2Orchestras: [],
  selectedOrchestraId: '',
  scenarioWorkScenarios: [],
  selectedScenarioWorkId: '',
  selectedScenarioWork: null,
  browserAgentJobs: [],
  selectedBrowserAgentId: '',
  selectedBrowserAgent: null,
};

const $ = (id) => document.getElementById(id);
const announce = (text) => { $('live-announcer').textContent = ''; requestAnimationFrame(() => { $('live-announcer').textContent = text; }); };
const formatTime = (value) => value ? new Date(value).toLocaleString() : 'Not available';
const runtimeAvailable = () => Boolean(globalThis.chrome?.runtime?.sendMessage);
const UI_MODE_KEY = 'chatgpt-autopilot-ui-mode';
const UI_MODES = new Set(['sessions', 'orchestration', 'scenario-work', 'agent', 'ai']);
const ORCHESTRATION_PANEL_KEY = 'chatgpt-autopilot-orchestration-panel';
const ORCHESTRATION_PANELS = ['orchestras', 'settings', 'state'];
const SCENARIO_WORK_PANEL_KEY = 'chatgpt-autopilot-scenario-work-panel';
const SCENARIO_WORK_PANELS = ['cycle', 'pairs', 'group', 'state'];
let orchestrationV2ActionEpoch = 0;
function beginOrchestrationV2Action() { orchestrationV2ActionEpoch += 1; return orchestrationV2ActionEpoch; }
function setOrchestrationPanel(panel, { focus = false } = {}) {
  const next = ORCHESTRATION_PANELS.includes(panel) ? panel : 'orchestras';
  storageSet(ORCHESTRATION_PANEL_KEY, next);
  document.querySelectorAll('[data-orchestration-panel]').forEach(element => {
    element.hidden = element.dataset.orchestrationPanel !== next;
  });
  for (const value of ORCHESTRATION_PANELS) {
    const tab = $(`orchestration-v2-tab-${value}`);
    if (!tab) continue;
    tab.setAttribute('aria-selected', value === next ? 'true' : 'false');
    tab.tabIndex = value === next ? 0 : -1;
  }
  if (focus) $(`orchestration-v2-tab-${next}`)?.focus();
}


function setScenarioWorkPanel(panel, { focus = false } = {}) {
  const next = SCENARIO_WORK_PANELS.includes(panel) ? panel : 'cycle';
  storageSet(SCENARIO_WORK_PANEL_KEY, next);
  document.querySelectorAll('[data-scenario-work-panel]').forEach(element => {
    element.hidden = element.dataset.scenarioWorkPanel !== next;
  });
  for (const value of SCENARIO_WORK_PANELS) {
    const tab = $(`scenario-work-tab-${value}`);
    if (!tab) continue;
    tab.setAttribute('aria-selected', value === next ? 'true' : 'false');
    tab.tabIndex = value === next ? 0 : -1;
  }
  if (focus) $(`scenario-work-tab-${next}`)?.focus();
}

function setUiMode(mode, { focus = false } = {}) {
  const next = UI_MODES.has(mode) ? mode : 'sessions';
  storageSet(UI_MODE_KEY, next);
  document.querySelectorAll('[data-app-mode]').forEach((element) => {
    element.hidden = element.dataset.appMode !== next;
  });
  document.querySelector('.layout')?.classList.toggle('single-column', next !== 'sessions');
  for (const value of UI_MODES) {
    const tab = $(`mode-${value}`);
    if (!tab) continue;
    tab.setAttribute('aria-selected', value === next ? 'true' : 'false');
    tab.tabIndex = value === next ? 0 : -1;
  }
  if (focus) $(`mode-${next}`)?.focus();
}

async function loadProfileSettings() {
  try {
    const data = await core('GET_PROFILE_SETTINGS');
    const minutes = Number(data?.rateLimitCooldownMinutes || 5);
    $('rate-limit-cooldown-minutes').value = String(minutes);
    $('rate-limit-setting-status').textContent = `Current fallback rate-limit pause: ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  } catch (error) {
    $('rate-limit-setting-status').textContent = `Could not load fallback rate-limit pause: ${error.message}`;
  }
}

async function saveProfileSettings() {
  const minutes = Number($('rate-limit-cooldown-minutes').value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
    $('rate-limit-setting-status').textContent = 'Enter a whole number from 1 to 120 minutes.';
    $('rate-limit-cooldown-minutes').focus();
    return;
  }
  try {
    const data = await core('UPDATE_PROFILE_SETTINGS', { rateLimitCooldownMinutes: minutes });
    $('rate-limit-setting-status').textContent = `Saved fallback: if “Too many requests” remains after acknowledgement, this Chrome profile waits ${data.rateLimitCooldownMinutes} minute${data.rateLimitCooldownMinutes === 1 ? '' : 's'} and then retries automatically.`;
    announce('Rate-limit pause saved.');
  } catch (error) {
    $('rate-limit-setting-status').textContent = `Could not save fallback rate-limit pause: ${error.message}`;
  }
}

function orchestrationV2SettingsFromForm() {
  const integer = (id, min, max, label) => parseStrictBoundedInteger($(id).value, { min, max, label });
  const enabled = $('orchestration-v2-enabled').checked;
  const absoluteMaxWorkers = integer('orchestration-v2-max-workers', 1, 200, 'Макс. workers');
  const defaultDesiredWorkers = integer('orchestration-v2-desired-workers', 0, 200, 'Старт workers');
  if (defaultDesiredWorkers > absoluteMaxWorkers) throw new Error('Старт workers не може перевищувати локальний максимум.');
  const controlIssueRaw = $('orchestration-v2-control-issue').value.trim();
  const controlCommentRaw = $('orchestration-v2-control-comment').value.trim();
  return {
    ...(ui.orchestrationV2Config || {}),
    enabled,
    projectId: $('orchestration-v2-project-id').value.trim(),
    targetRepository: $('orchestration-v2-target-repository').value.trim(),
    controlRepository: $('orchestration-v2-control-repository').value.trim(),
    controlIssueNumber: controlIssueRaw ? integer('orchestration-v2-control-issue', 1, Number.MAX_SAFE_INTEGER, 'Control Issue') : 0,
    controlCommentId: controlCommentRaw ? integer('orchestration-v2-control-comment', 0, Number.MAX_SAFE_INTEGER, 'Control comment') : 0,
    bootstrapPinnedControlFirst: $('orchestration-v2-bootstrap-pinned-control').checked,
    coordinatorAgentProviderId: $('orchestration-v2-coordinator-provider').value,
    workerAgentProviderId: $('orchestration-v2-worker-provider').value,
    coordinatorLaunchUrl: $('orchestration-v2-coordinator-url').value.trim(),
    masterCoordinatorPrompt: $('orchestration-v2-master-prompt').value.trim(),
    coordinatorTickPrompt: $('orchestration-v2-tick-prompt').value.trim(),
    masterPromptVersion: integer('orchestration-v2-prompt-version', 1, 100000, 'Prompt version'),
    // Reserved compatibility field: no runtime behavior in Orchestration V2. Keep fail-closed.
    fallbackUniversalPromptEnabled: false,
    defaultDesiredWorkers,
    absoluteMaxWorkers,
    maxLaunchesPerWindow: integer('orchestration-v2-max-launches-window', 0, 10000, 'Запусків за вікно'),
    launchWindowSeconds: integer('orchestration-v2-launch-window', 10, 86400, 'Вікно'),
    minimumWorkerLaunchIntervalMs: integer('orchestration-v2-min-launch-gap', 0, 3600, 'Пауза між стартами') * 1000,
    workerProbeIntervalSeconds: integer('orchestration-v2-worker-probe', 30, 600, 'Перевірка workers'),
    watchdogIntervalSeconds: integer('orchestration-v2-watchdog', 60, 3600, 'Watchdog'),
    maxCoordinatorTurns: integer('orchestration-v2-max-turns', 1, 1000, 'Turns координатора'),
    staleWorkerAfterSeconds: integer('orchestration-v2-stale-worker', 300, 86400, 'Stale worker'),
    workerPreSendDelayMs: integer('orchestration-v2-worker-pre-send', 1, 30, 'Worker pre-send') * 1000,
    workerBusyCheckDelayMs: integer('orchestration-v2-worker-busy', 1, 30, 'Worker busy-check') * 1000,
    workerRetryBackoffMs: integer('orchestration-v2-worker-retry', 5, 3600, 'Worker retry') * 1000,
    coordinatorPreSendDelayMs: integer('orchestration-v2-coordinator-pre-send', 1, 30, 'Coordinator pre-send') * 1000,
    coordinatorRetryBackoffMs: integer('orchestration-v2-coordinator-retry', 5, 3600, 'Coordinator retry') * 1000,
  };
}

function syncOrchestrationV2ActionAvailability({ busy = false } = {}) {
  const selected = (ui.orchestrationV2Orchestras || []).find(item => item.id === ui.selectedOrchestraId) || null;
  const hasSelected = Boolean(selected);
  $('new-orchestration-v2-orchestra-button').disabled = Boolean(busy);
  $('rename-orchestration-v2-orchestra-button').disabled = Boolean(busy) || !hasSelected;
  $('start-orchestration-v2-orchestra-button').disabled = Boolean(busy) || !hasSelected || selected?.ownerPaused === true;
  $('pause-orchestration-v2-orchestra-button').disabled = Boolean(busy) || !hasSelected || selected?.ownerPaused === true;
  $('resume-orchestration-v2-orchestra-button').disabled = Boolean(busy) || !hasSelected || selected?.ownerPaused !== true;
  $('delete-orchestration-v2-orchestra-button').disabled = Boolean(busy) || !hasSelected;
  for (const id of ['save-orchestration-v2-button', 'save-start-orchestration-v2-button', 'test-orchestration-v2-button', 'run-orchestration-v2-button', 'stop-orchestration-v2-button', 'export-orchestration-v2-profile-button']) {
    $(id).disabled = Boolean(busy) || !hasSelected;
  }
  $('import-orchestration-v2-profile-button').disabled = Boolean(busy) || !ui.pendingOrchestrationProfile;
  $('configure-orchestration-v2-hierarchy-button').disabled = Boolean(busy) || !hasSelected;
  $('authorize-orchestration-v2-drive-button').disabled = Boolean(busy);
  $('orchestration-v2-tab-settings').disabled = Boolean(busy) || !hasSelected;
  $('orchestration-v2-tab-state').disabled = Boolean(busy) || !hasSelected;
}

function setOrchestrationV2Busy(busy) {
  syncOrchestrationV2ActionAvailability({ busy: Boolean(busy) });
}

function renderOrchestrationV2Orchestras(data = {}) {
  const orchestras = Array.isArray(data.orchestras) ? data.orchestras : [];
  ui.orchestrationV2Orchestras = clone(orchestras);
  ui.selectedOrchestraId = data.selectedId || '';
  const list = $('orchestration-v2-orchestra-list');
  const previous = list.value;
  list.replaceChildren();
  for (const item of orchestras) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name}${item.ownerPaused ? ' — пауза' : ''}`;
    option.selected = item.id === ui.selectedOrchestraId;
    list.append(option);
  }
  if (!list.value && previous && orchestras.some(item => item.id === previous)) list.value = previous;
  const selected = orchestras.find(item => item.id === ui.selectedOrchestraId) || null;
  $('orchestration-v2-orchestra-name').value = selected?.name || '';
  $('orchestration-v2-orchestra-summary').textContent = selected
    ? `${selected.name}. Локальна пауза: ${selected.ownerPaused ? 'так' : 'ні'}. Оркестрів: ${orchestras.length}.`
    : 'Оркестри ще не створені. Створіть новий оркестр або завантажте JSON-файл.';
  syncOrchestrationV2ActionAvailability();
}

function renderOrchestrationV2Status(data = {}) {
  renderOrchestrationV2Orchestras(data);
  const config = data.config || {};
  const runtime = data.runtime || {};
  const coordinator = runtime.coordinator || {};
  const provider = runtime.provider || {};
  const counts = runtime.workerCounts || {};
  ui.orchestrationV2Config = clone(config);
  if (data.driveOAuth) ui.orchestrationDriveOAuth = clone(data.driveOAuth);
  const driveOAuth = data.driveOAuth || ui.orchestrationDriveOAuth || {};
  $('orchestration-v2-drive-auth-status').textContent = driveOAuth.configured
    ? 'Google Drive OAuth налаштовано. Авторизація виконується лише після явного натискання кнопки; автоматичний poll не відкриває вікна входу.'
    : driveOAuth.clientIdPresent
      ? 'Google Drive OAuth неповний: у manifest немає scope drive.file.'
      : 'Google Drive OAuth ще не налаштовано реальним client ID. Drive-керування fail-closed і не запускає Workers.';
  $('orchestration-v2-enabled').checked = config.enabled === true;
  $('orchestration-v2-project-id').value = config.projectId || '';
  $('orchestration-v2-target-repository').value = config.targetRepository || '';
  $('orchestration-v2-control-repository').value = config.controlRepository || '';
  $('orchestration-v2-control-issue').value = config.controlIssueNumber ? String(config.controlIssueNumber) : '';
  $('orchestration-v2-control-comment').value = config.controlCommentId ? String(config.controlCommentId) : '';
  $('orchestration-v2-bootstrap-pinned-control').checked = config.bootstrapPinnedControlFirst === true;
  $('orchestration-v2-coordinator-provider').value = config.coordinatorAgentProviderId || 'chatgpt-browser';
  $('orchestration-v2-worker-provider').value = config.workerAgentProviderId || 'chatgpt-browser';
  $('orchestration-v2-coordinator-url').value = config.coordinatorLaunchUrl || 'https://chatgpt.com/';
  $('orchestration-v2-master-prompt').value = config.masterCoordinatorPrompt || '';
  $('orchestration-v2-tick-prompt').value = config.coordinatorTickPrompt || '';
  $('orchestration-v2-prompt-version').value = String(config.masterPromptVersion ?? 1);
  $('orchestration-v2-desired-workers').value = String(config.defaultDesiredWorkers ?? 5);
  $('orchestration-v2-max-workers').value = String(config.absoluteMaxWorkers ?? 8);
  $('orchestration-v2-max-launches-window').value = String(config.maxLaunchesPerWindow ?? 0);
  $('orchestration-v2-launch-window').value = String(config.launchWindowSeconds ?? 300);
  $('orchestration-v2-min-launch-gap').value = String(Math.round((config.minimumWorkerLaunchIntervalMs ?? 0) / 1000));
  $('orchestration-v2-worker-probe').value = String(config.workerProbeIntervalSeconds ?? 30);
  $('orchestration-v2-watchdog').value = String(config.watchdogIntervalSeconds ?? 300);
  $('orchestration-v2-max-turns').value = String(config.maxCoordinatorTurns ?? 10);
  $('orchestration-v2-stale-worker').value = String(config.staleWorkerAfterSeconds ?? 3600);
  $('orchestration-v2-worker-pre-send').value = String(Math.round((config.workerPreSendDelayMs ?? 8000) / 1000));
  $('orchestration-v2-worker-busy').value = String(Math.round((config.workerBusyCheckDelayMs ?? 2000) / 1000));
  $('orchestration-v2-worker-retry').value = String(Math.round((config.workerRetryBackoffMs ?? 60000) / 1000));
  $('orchestration-v2-coordinator-pre-send').value = String(Math.round((config.coordinatorPreSendDelayMs ?? 8000) / 1000));
  $('orchestration-v2-coordinator-retry').value = String(Math.round((config.coordinatorRetryBackoffMs ?? 60000) / 1000));
  const leaseText = coordinator.lease ? `turn ${coordinator.lease.turnId || '?'} / ${coordinator.lease.reason || 'reason unknown'}` : 'немає';
  const providerText = provider.lastFetchAt ? new Date(provider.lastFetchAt).toLocaleString() : 'ще не було';
  const ownerPauseText = data.ownerPaused ? 'Локальна пауза власника: так.' : 'Локальна пауза власника: ні.';
  $('orchestration-v2-status').textContent = data.orchestra == null
    ? 'Оркестр не вибрано.'
    : config.enabled
      ? `Orchestration V2 увімкнено. ${ownerPauseText} GitHub mode: ${runtime.mode || 'RUN'}. Coordinator: ${coordinator.status || 'IDLE'}. GitHub fetch: ${providerText}.${provider.lastFetchError ? ` Помилка: ${provider.lastFetchError}.` : ''}`
      : `Orchestration V2 вимкнено. ${ownerPauseText} Нові coordinator/worker sends не створюються.`;
  const backpressureText = runtime.backpressureUntil && runtime.backpressureUntil > Date.now() ? new Date(runtime.backpressureUntil).toLocaleString() : 'немає';
  const launchPolicy = runtime.launchPolicy || {};
  const launchLimitText = config.maxLaunchesPerWindow ? String(config.maxLaunchesPerWindow) : 'без ліміту';
  const controlCommentText = config.controlCommentId ? `pinned ${config.controlCommentId}` : (provider.canonicalCommentId ? `auto → ${provider.canonicalCommentId}` : 'auto');
  const controlSourceText = runtime.lastAppliedControlSource || 'ще не застосовано';
  const scalarProviders = Array.isArray(runtime.hierarchy?.providers) ? runtime.hierarchy.providers : [];
  const driveScalarText = scalarProviders.length
    ? scalarProviders.map(item => {
      const revision = item.lastAcceptedRevision || 'ще немає';
      const error = item.lastErrorCode ? `, помилка ${item.lastErrorCode}` : '';
      return `${item.nodeId}: revision ${revision}, slots ${item.lastRequestedSlotCount || 0}/${item.maxSlots || 0}${error}`;
    }).join('; ')
    : 'не налаштовано';
  $('orchestration-v2-runtime').textContent = `Coordinator ${coordinator.generation || 1}: turns ${coordinator.turnsUsed || 0}/${coordinator.maxTurns || config.maxCoordinatorTurns || 10}. Workers: queued ${counts.QUEUED || 0}, active ${counts.ACTIVE || 0}, busy ${counts.BUSY || 0}, complete ${counts.COMPLETED || 0}, failed ${counts.FAILED || 0}. Concurrency ${runtime.effectiveDesiredWorkers ?? 0}/${runtime.hardMaxWorkers ?? config.absoluteMaxWorkers ?? 0}. Launch window ${launchPolicy.launchesInWindow ?? 0}/${launchLimitText}. Control ${controlCommentText}. Revision ${runtime.lastAppliedControlRevision || 0}. Джерело керування: ${controlSourceText}. Backpressure: ${backpressureText}. Drive scalar: ${driveScalarText}.`;
}

async function loadOrchestrationV2Status() {
  const epoch = orchestrationV2ActionEpoch;
  try {
    const data = await core('GET_ORCHESTRATION_V2_STATUS');
    if (epoch !== orchestrationV2ActionEpoch) return;
    renderOrchestrationV2Status(data);
  } catch (error) {
    if (epoch !== orchestrationV2ActionEpoch) return;
    $('orchestration-v2-status').textContent = `Не вдалося завантажити Orchestration V2: ${error.message}`;
  }
}

async function createOrchestrationV2Orchestra() {
  beginOrchestrationV2Action();
  try {
    setOrchestrationV2Busy(true);
    const name = $('orchestration-v2-orchestra-name').value.trim() || 'Новий оркестр';
    const data = await core('CREATE_ORCHESTRATION_V2_ORCHESTRA', { name });
    renderOrchestrationV2Status(data);
    setOrchestrationPanel('settings');
    announce('Новий оркестр створено.');
  } catch (error) { $('orchestration-v2-orchestra-summary').textContent = `Не вдалося створити оркестр: ${error.message}`; }
  finally { setOrchestrationV2Busy(false); }
}
async function selectOrchestrationV2Orchestra() {
  beginOrchestrationV2Action();
  const id = $('orchestration-v2-orchestra-list').value;
  if (!id) return;
  try { renderOrchestrationV2Status(await core('SELECT_ORCHESTRATION_V2_ORCHESTRA', { id })); }
  catch (error) { $('orchestration-v2-orchestra-summary').textContent = `Не вдалося вибрати оркестр: ${error.message}`; }
}
async function renameOrchestrationV2Orchestra() {
  beginOrchestrationV2Action();
  const id = ui.selectedOrchestraId; const name = $('orchestration-v2-orchestra-name').value.trim();
  if (!id || !name) return;
  try { renderOrchestrationV2Status(await core('RENAME_ORCHESTRATION_V2_ORCHESTRA', { id, name })); announce('Оркестр перейменовано.'); }
  catch (error) { $('orchestration-v2-orchestra-summary').textContent = `Не вдалося перейменувати: ${error.message}`; }
}
async function startOrchestrationV2Orchestra() {
  beginOrchestrationV2Action();
  if (!ui.selectedOrchestraId) return;
  try {
    setOrchestrationV2Busy(true);
    $('orchestration-v2-status').textContent = 'Запускаю Coordinator-cycle зараз…';
    const data = await core('START_ORCHESTRATION_V2_ORCHESTRA', { id: ui.selectedOrchestraId });
    renderOrchestrationV2Status(data.status || data);
    setOrchestrationPanel('state');
    announce('Оркестр запущено. Перший Coordinator-cycle розпочато зараз.');
  } catch (error) {
    $('orchestration-v2-orchestra-summary').textContent = `Запуск не виконано: ${error.message}`;
    announce('Не вдалося запустити оркестр.');
  } finally { setOrchestrationV2Busy(false); }
}

async function pauseOrchestrationV2Orchestra() {
  beginOrchestrationV2Action();
  if (!ui.selectedOrchestraId) return;
  try { renderOrchestrationV2Status(await core('PAUSE_ORCHESTRATION_V2_ORCHESTRA', { id: ui.selectedOrchestraId })); announce('Оркестр призупинено локально. Налаштування можна змінити.'); }
  catch (error) { $('orchestration-v2-orchestra-summary').textContent = `Пауза не виконана: ${error.message}`; }
}
async function resumeOrchestrationV2Orchestra() {
  beginOrchestrationV2Action();
  if (!ui.selectedOrchestraId) return;
  try { renderOrchestrationV2Status(await core('RESUME_ORCHESTRATION_V2_ORCHESTRA', { id: ui.selectedOrchestraId })); announce('Оркестр продовжено; recovery/reconciliation запущено зараз.'); }
  catch (error) { $('orchestration-v2-orchestra-summary').textContent = `Продовження не виконано: ${error.message}`; }
}
async function deleteOrchestrationV2Orchestra() {
  beginOrchestrationV2Action();
  if (!ui.selectedOrchestraId) return;
  try {
    const data = await core('DELETE_ORCHESTRATION_V2_ORCHESTRA', { id: ui.selectedOrchestraId });
    renderOrchestrationV2Status(data);
    setOrchestrationPanel('orchestras');
    announce('Оркестр видалено.');
  } catch (error) { $('orchestration-v2-orchestra-summary').textContent = `Видалення не виконано: ${error.message}`; }
}

async function saveOrchestrationV2Settings() {
  beginOrchestrationV2Action();
  try {
    setOrchestrationV2Busy(true);
    const settings = orchestrationV2SettingsFromForm();
    const data = await core('UPDATE_ORCHESTRATION_V2_SETTINGS', { settings });
    renderOrchestrationV2Status(data.status || { config: data.config });
    announce(data.startedNow ? 'Orchestration V2 збережено й перший Coordinator-cycle запущено зараз.' : 'Orchestration V2 збережено.');
  } catch (error) {
    $('orchestration-v2-status').textContent = `Не вдалося зберегти Orchestration V2: ${error.message}`;
    announce('Помилка Orchestration V2.');
  } finally { setOrchestrationV2Busy(false); }
}

async function saveAndStartOrchestrationV2Now() {
  beginOrchestrationV2Action();
  try {
    setOrchestrationV2Busy(true);
    $('orchestration-v2-enabled').checked = true;
    const settings = { ...orchestrationV2SettingsFromForm(), enabled: true };
    $('orchestration-v2-status').textContent = 'Зберігаю налаштування й запускаю Coordinator-cycle зараз…';
    const data = await core('SAVE_AND_START_ORCHESTRATION_V2', { settings });
    renderOrchestrationV2Status(data.status || data);
    setOrchestrationPanel('state');
    announce('Налаштування збережено. Оркестр запущено зараз.');
  } catch (error) {
    $('orchestration-v2-status').textContent = `Не вдалося зберегти й запустити оркестр: ${error.message}`;
    announce('Помилка запуску оркестру.');
  } finally { setOrchestrationV2Busy(false); }
}

async function testOrchestrationV2Control() {
  try {
    setOrchestrationV2Busy(true);
    const settings = orchestrationV2SettingsFromForm();
    $('orchestration-v2-status').textContent = 'Перевіряю GitHub control read-only…';
    const result = await core('TEST_ORCHESTRATION_V2_CONTROL', { settings });
    const selected = result?.selected;
    if (selected?.control) {
      $('orchestration-v2-status').textContent = `GitHub control доступний: revision ${selected.control.revision}, coordinator generation ${selected.control.coordinator_generation}, comment ${selected.commentId || result.commentId || 'discovery'}. Жоден worker/Session не створено.`;
    } else {
      const diagnostic = result?.diagnostics?.[0]?.message || 'Для цього project/generation валідного control зараз немає.';
      $('orchestration-v2-status').textContent = `GitHub endpoint доступний, але executable control не вибрано: ${diagnostic}`;
    }
    announce('Перевірку GitHub control завершено.');
  } catch (error) {
    $('orchestration-v2-status').textContent = `GitHub control test не виконано: ${error.message}`;
    announce('Помилка перевірки GitHub control.');
  } finally { setOrchestrationV2Busy(false); }
}

async function runOrchestrationV2Now() {
  beginOrchestrationV2Action();
  try {
    setOrchestrationV2Busy(true);
    $('orchestration-v2-status').textContent = 'Виконую completion/watchdog reconciliation зараз…';
    await core('RUN_ORCHESTRATION_V2_NOW');
    await loadOrchestrationV2Status();
    announce('Orchestration V2 reconciliation завершено.');
  } catch (error) {
    $('orchestration-v2-status').textContent = `Orchestration V2 cycle не виконано: ${error.message}`;
  } finally { setOrchestrationV2Busy(false); }
}

async function emergencyStopOrchestrationV2() {
  beginOrchestrationV2Action();
  try {
    setOrchestrationV2Busy(true);
    const data = await core('EMERGENCY_STOP_ORCHESTRATION_V2');
    renderOrchestrationV2Status(data.status || { config: data.config });
    announce('Emergency STOP V2 застосовано. Нові sends заборонені; recovery evidence збережено.');
  } catch (error) {
    $('orchestration-v2-status').textContent = `Emergency STOP не виконано: ${error.message}`;
  } finally { setOrchestrationV2Busy(false); }
}

async function onOrchestrationProfileFileChange() {
  ui.pendingOrchestrationProfile = null;
  syncOrchestrationV2ActionAvailability();
  const file = $('orchestration-v2-profile-file').files?.[0];
  if (!file) { $('orchestration-v2-profile-preview').textContent = 'Файл не вибрано.'; return; }
  try {
    const profile = JSON.parse(await file.text());
    const data = await core('PREVIEW_ORCHESTRATION_V2_PROFILE', { profile });
    ui.pendingOrchestrationProfile = profile;
    const preview = data.preview || {};
    const comment = preview.controlCommentId ? `comment ${preview.controlCommentId}` : 'auto comment';
    const launch = preview.maxLaunchesPerWindow ? `${preview.maxLaunchesPerWindow}/${preview.launchWindowSeconds}s` : 'без window limit';
    const bootstrap = preview.bootstrapPinnedControlFirst ? 'раннє закріплене керування: так' : 'раннє закріплене керування: ні';
    const hierarchy = preview.hierarchy
      ? `; ієрархія ${preview.hierarchy.nodeCount} вузлів, ${preview.hierarchy.rootCount} коренів, ${preview.hierarchy.promptProfileCount} профілів промтів, epoch ${preview.hierarchy.controlEpoch}`
      : '';
    $('orchestration-v2-profile-preview').textContent = `${preview.projectId || 'Проєкт'}; workers ${preview.initialWorkers ?? 0}/${preview.maxActiveWorkers ?? 0}; launch ${launch}, gap ${preview.minimumLaunchIntervalSeconds ?? 0}s; ${preview.coordinatorProviderId || '?'} → ${preview.workerProviderId || '?'}; Issue ${preview.controlIssueNumber || 0}, ${comment}; ${bootstrap}${hierarchy}.`;
    syncOrchestrationV2ActionAvailability();
  } catch (error) {
    $('orchestration-v2-profile-preview').textContent = `Помилка: ${error.message}`;
  }
}

async function importOrchestrationProfile() {
  beginOrchestrationV2Action();
  if (!ui.pendingOrchestrationProfile) return;
  try {
    setOrchestrationV2Busy(true);
    const data = await core('IMPORT_ORCHESTRATION_V2_PROFILE', { profile: ui.pendingOrchestrationProfile });
    const status = data.status || await core('GET_ORCHESTRATION_V2_STATUS');
    renderOrchestrationV2Status(status);
    $('orchestration-v2-profile-preview').textContent = `Імпортовано: ${data.preview?.name || status.orchestra?.name || 'оркестр'}. Оркестр створено/оновлено і залишено вимкненим до ручного запуску.`;
    ui.pendingOrchestrationProfile = null;
    $('orchestration-v2-profile-file').value = '';
    syncOrchestrationV2ActionAvailability();
    $('orchestration-v2-orchestra-summary').focus?.();
    announce('JSON оркестру імпортовано. Автоматичного запуску не було.');
  } catch (error) {
    $('orchestration-v2-profile-preview').textContent = `Імпорт не виконано: ${error.message}`;
  } finally { setOrchestrationV2Busy(false); }
}

async function exportOrchestrationProfile() {
  try {
    const data = await core('EXPORT_ORCHESTRATION_V2_PROFILE', { name: ui.orchestrationV2Config?.projectId || 'Orchestration' });
    downloadJson(data.profile, `${safeFileName(data.profile.name || 'Orchestration')}-orchestration.json`);
  } catch (error) {
    $('orchestration-v2-profile-preview').textContent = `Експорт не виконано: ${error.message}`;
  }
}

function orchestrationHierarchyDomainsFromForm() {
  const lines = $('orchestration-v2-hierarchy-domains').value
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error('Додайте хоча б одного Manager у форматі ID | область відповідальності.');
  return lines.map((line, index) => {
    const separator = line.indexOf('|');
    if (separator <= 0 || separator >= line.length - 1) {
      throw new Error(`Рядок ${index + 1}: потрібен формат ID | область відповідальності.`);
    }
    const id = line.slice(0, separator).trim();
    const scope = line.slice(separator + 1).trim();
    if (!id || !scope) throw new Error(`Рядок ${index + 1}: ID та область не можуть бути порожніми.`);
    return { id, scope };
  });
}

function orchestrationDriveScalarSourcesFromForm(domains) {
  const lines = $('orchestration-v2-hierarchy-drive-sources').value
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return {};
  const allowed = new Set(domains.map(domain => String(domain.id || '').trim().toLowerCase()));
  const out = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const separator = line.indexOf('|');
    if (separator <= 0 || separator >= line.length - 1) {
      throw new Error(`Drive рядок ${index + 1}: потрібен формат Manager ID | Google Drive файл.`);
    }
    const managerId = line.slice(0, separator).trim().toLowerCase();
    const source = line.slice(separator + 1).trim();
    if (!allowed.has(managerId)) {
      throw new Error(`Drive рядок ${index + 1}: Manager ${managerId || '?'} не знайдений у списку вище.`);
    }
    if (Object.hasOwn(out, managerId)) {
      throw new Error(`Drive рядок ${index + 1}: Manager ${managerId} уже має Drive-файл.`);
    }
    if (!source) throw new Error(`Drive рядок ${index + 1}: файл не може бути порожнім.`);
    out[managerId] = source;
  }
  return out;
}


function orchestrationDriveFolderSourcesFromForm(domains) {
  const lines = $('orchestration-v2-hierarchy-drive-folders').value
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return {};
  const allowed = new Set(domains.map(domain => String(domain.id || '').trim().toLowerCase()));
  const out = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const separator = line.indexOf('|');
    if (separator <= 0 || separator >= line.length - 1) {
      throw new Error('Drive folder рядок ' + (index + 1) + ': потрібен формат Manager ID | Google Drive папка.');
    }
    const managerId = line.slice(0, separator).trim().toLowerCase();
    const source = line.slice(separator + 1).trim();
    if (!allowed.has(managerId)) {
      throw new Error('Drive folder рядок ' + (index + 1) + ': Manager ' + (managerId || '?') + ' не знайдений у списку вище.');
    }
    if (Object.hasOwn(out, managerId)) {
      throw new Error('Drive folder рядок ' + (index + 1) + ': Manager ' + managerId + ' уже має dispatch-папку.');
    }
    if (!source) throw new Error('Drive folder рядок ' + (index + 1) + ': папка не може бути порожньою.');
    out[managerId] = source;
  }
  return out;
}

async function authorizeOrchestrationDrive() {
  beginOrchestrationV2Action();
  try {
    setOrchestrationV2Busy(true);
    $('orchestration-v2-drive-auth-status').textContent = 'Відкриваю авторизацію Google Drive…';
    await core('AUTHORIZE_ORCHESTRATION_V2_DRIVE');
    $('orchestration-v2-drive-auth-status').textContent = 'Google Drive авторизовано для Autopilot.';
    announce('Google Drive авторизовано.');
    await loadOrchestrationV2Status();
  } catch (error) {
    $('orchestration-v2-drive-auth-status').textContent = `Авторизацію Drive не виконано: ${error.message}`;
    announce('Авторизацію Google Drive не виконано.');
  } finally {
    setOrchestrationV2Busy(false);
  }
}

async function configureOrchestrationHierarchyTemplate() {
  beginOrchestrationV2Action();
  try {
    setOrchestrationV2Busy(true);
    const domains = orchestrationHierarchyDomainsFromForm();
    const workersPerManager = parseStrictBoundedInteger(
      $('orchestration-v2-hierarchy-workers').value,
      { min: 1, max: 40, label: 'Workers на одного Manager' },
    );
    const driveScalarSources = orchestrationDriveScalarSourcesFromForm(domains);
    const drivePollMinutes = parseStrictBoundedInteger(
      $('orchestration-v2-hierarchy-drive-poll').value,
      { min: 1, max: 1440, label: 'Інтервал перевірки Drive, хв' },
    );
    const data = await core('CONFIGURE_ORCHESTRATION_V2_HIERARCHY_TEMPLATE', {
      domains,
      workersPerManager,
      includeIntegrationManager: $('orchestration-v2-hierarchy-integration').checked,
      includeQaRedTeam: $('orchestration-v2-hierarchy-qa').checked,
      driveScalarSources,
      driveScalarPollIntervalMs: drivePollMinutes * 60 * 1000,
    });
    renderOrchestrationV2Status(data.status || await core('GET_ORCHESTRATION_V2_STATUS'));
    const hierarchy = data.hierarchy || {};
    $('orchestration-v2-hierarchy-template-status').textContent =
      `Створено ${hierarchy.nodeCount || 0} вузлів: Managers ${hierarchy.managerCount || 0}, Workers ${hierarchy.workerCount || 0}, Drive-керованих Managers ${hierarchy.driveScalarProviderCount || 0}, профілів промтів ${hierarchy.promptProfileCount || 0}. Оркестр не запущено.`;
    announce('Ієрархію оркестру створено. Автоматичного запуску не було.');
  } catch (error) {
    $('orchestration-v2-hierarchy-template-status').textContent = `Ієрархію не створено: ${error.message}`;
    announce('Помилка створення ієрархії.');
  } finally {
    setOrchestrationV2Busy(false);
  }
}

function remoteDispatchSettingsFromForm() {
  const integer = (id, min, max, label) => {
    const value = Number($(id).value);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: введіть ціле число ${min}-${max}.`);
    return value;
  };
  const enabled = $('remote-dispatch-enabled').checked;
  const rawIssue = $('remote-dispatch-issue').value.trim();
  const issueNumber = rawIssue ? integer('remote-dispatch-issue', 1, Number.MAX_SAFE_INTEGER, 'Issue number') : 0;
  return {
    enabled,
    intakePaused: $('remote-dispatch-intake-paused').checked,
    provider: 'github-issue',
    projectId: $('remote-dispatch-project-id').value.trim(),
    repository: $('remote-dispatch-repository').value.trim(),
    issueNumber,
    minimumPollIntervalSeconds: integer('remote-dispatch-poll', 180, 3600, 'GitHub poll interval'),
    fallbackEnabled: $('remote-dispatch-fallback-enabled').checked,
    fallbackSessionId: $('remote-dispatch-fallback-session').value,
    fallbackAfterSeconds: integer('remote-dispatch-fallback-after', 180, 86400, 'Fallback threshold'),
    autoStart: $('remote-dispatch-auto-start').checked,
  };
}

function setRemoteDispatchBusy(busy) {
  for (const id of ['save-remote-dispatch-button', 'test-remote-dispatch-button', 'run-remote-dispatch-button']) $(id).disabled = Boolean(busy);
}

function renderRemoteFallbackSessionOptions(selectedId = '') {
  const select = $('remote-dispatch-fallback-session');
  const wanted = selectedId || select.value || '';
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'Не запускати fallback Session'; select.append(none);
  for (const session of (ui.sessions || []).filter(item => !item.managedKind)) {
    const option = document.createElement('option');
    option.value = session.id;
    option.textContent = session.name || session.id;
    select.append(option);
  }
  if ([...select.options].some(option => option.value === wanted)) select.value = wanted;
}

function renderRemoteDispatchStatus(data = {}) {
  const config = data.config || {};
  const feed = data.feed || {};
  const ledger = data.ledger || {};
  const runtime = data.runtime || {};
  $('remote-dispatch-enabled').checked = config.enabled === true;
  $('remote-dispatch-intake-paused').checked = config.intakePaused === true;
  $('remote-dispatch-project-id').value = config.projectId || '';
  $('remote-dispatch-repository').value = config.repository || '';
  $('remote-dispatch-issue').value = config.issueNumber ? String(config.issueNumber) : '121';
  $('remote-dispatch-poll').value = String(config.minimumPollIntervalSeconds || 300);
  $('remote-dispatch-fallback-enabled').checked = config.fallbackEnabled !== false;
  renderRemoteFallbackSessionOptions(config.fallbackSessionId || '');
  $('remote-dispatch-fallback-after').value = String(config.fallbackAfterSeconds || 900);
  $('remote-dispatch-auto-start').checked = config.autoStart !== false;
  const state = !config.enabled ? 'вимкнено' : config.intakePaused ? 'intake на паузі' : 'увімкнено';
  const fetchText = ledger.lastFetchAt ? new Date(ledger.lastFetchAt).toLocaleString() : 'ще не було';
  const expiry = feed.expiresAt ? new Date(feed.expiresAt).toLocaleString() : 'немає';
  $('remote-dispatch-status').textContent = `Remote Dispatch ${state}. Останній GitHub poll: ${fetchText}.${ledger.lastFetchError ? ` Помилка: ${ledger.lastFetchError}.` : ''}`;
  $('remote-dispatch-runtime').textContent = `Dispatch: ${feed.dispatchId || 'немає'}; revision: ${feed.strategyRevision || 0}; придатний зараз: ${feed.applicable ? 'так' : `ні (${feed.reason || 'немає cache'})`}; expires: ${expiry}; remote Sessions: ${runtime.remoteSessionCount || 0}; активних: ${runtime.activeRemoteSessionCount || 0}; fallback: ${ledger.fallbackActive ? 'активний' : 'неактивний'}.`;
}

async function loadRemoteDispatchStatus() {
  try { renderRemoteDispatchStatus(await core('GET_REMOTE_DISPATCH_STATUS')); }
  catch (error) { $('remote-dispatch-status').textContent = `Не вдалося завантажити Remote Dispatch: ${error.message}`; }
}

async function saveRemoteDispatchSettings() {
  try {
    setRemoteDispatchBusy(true);
    const settings = remoteDispatchSettingsFromForm();
    const data = await core('UPDATE_REMOTE_DISPATCH_SETTINGS', { settings });
    renderRemoteDispatchStatus(data.status || { config: data.settings });
    announce('Remote Dispatch збережено.');
  } catch (error) {
    $('remote-dispatch-status').textContent = `Не вдалося зберегти Remote Dispatch: ${error.message}`;
    announce('Помилка Remote Dispatch.');
  } finally { setRemoteDispatchBusy(false); }
}

async function testRemoteDispatchFeed() {
  try {
    setRemoteDispatchBusy(true);
    const settings = remoteDispatchSettingsFromForm();
    $('remote-dispatch-status').textContent = 'Перевіряю GitHub dispatch feed без запуску…';
    const data = await core('TEST_REMOTE_DISPATCH_FEED', { settings });
    $('remote-dispatch-status').textContent = data.selected
      ? `Feed валідний. Dispatch ${data.selected.dispatchId}, revision ${data.selected.strategyRevision}, expires ${new Date(data.selected.expiresAt).toLocaleString()}.`
      : `GitHub доступний, але валідного dispatch для project_id не знайдено. Діагностик: ${(data.diagnostics || []).length}.`;
  } catch (error) { $('remote-dispatch-status').textContent = `Перевірка feed не пройшла: ${error.message}`; }
  finally { setRemoteDispatchBusy(false); }
}

async function runRemoteDispatchNow() {
  try {
    setRemoteDispatchBusy(true);
    $('remote-dispatch-status').textContent = 'Отримую та застосовую Remote Dispatch…';
    const data = await core('RUN_REMOTE_DISPATCH_NOW');
    await loadRemoteDispatchStatus();
    announce(`Remote Dispatch: ${data?.remote?.kind || 'цикл завершено'}.`);
  } catch (error) { $('remote-dispatch-status').textContent = `Remote Dispatch не застосовано: ${error.message}`; }
  finally { setRemoteDispatchBusy(false); }
}

const LOCAL_AI_DEFAULT_URLS = Object.freeze({
  ollama: 'http://127.0.0.1:11434',
  'openai-compatible': 'http://127.0.0.1:1234/v1',
});

function localAiSettingsFromForm() {
  const providerType = $('local-ai-provider').value;
  const timeoutSeconds = Number($('local-ai-timeout').value);
  if (!['ollama', 'openai-compatible'].includes(providerType)) throw new Error('Оберіть тип локального AI-сервера.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 600) {
    throw new Error('Тайм-аут має бути цілим числом від 5 до 600 секунд.');
  }
  return {
    enabled: $('local-ai-enabled').checked,
    providerType,
    baseUrl: $('local-ai-base-url').value.trim(),
    model: $('local-ai-model').value.trim(),
    timeoutSeconds,
  };
}

function setLocalAiBusy(busy) {
  for (const id of ['save-local-ai-button', 'test-local-ai-button', 'run-local-ai-test-button']) {
    $(id).disabled = Boolean(busy);
  }
}

function renderLocalAiModels(models = []) {
  const datalist = $('local-ai-model-list');
  datalist.replaceChildren();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    datalist.append(option);
  }
}

async function loadLocalAiSettings() {
  try {
    const data = await core('GET_LOCAL_AI_SETTINGS');
    const settings = data?.settings || {};
    $('local-ai-enabled').checked = settings.enabled === true;
    $('local-ai-provider').value = settings.providerType || 'ollama';
    $('local-ai-base-url').value = settings.baseUrl || LOCAL_AI_DEFAULT_URLS[$('local-ai-provider').value];
    $('local-ai-model').value = settings.model || '';
    $('local-ai-timeout').value = String(settings.timeoutSeconds || 90);
    $('local-ai-status').textContent = settings.enabled
      ? 'Налаштування локального ШІ завантажено. Перевірте підключення перед використанням.'
      : 'Локальний ШІ вимкнено. Налаштування можна перевірити без увімкнення.';
  } catch (error) {
    $('local-ai-status').textContent = `Не вдалося завантажити налаштування локального ШІ: ${error.message}`;
  }
}

async function saveLocalAiSettings() {
  try {
    const settings = localAiSettingsFromForm();
    setLocalAiBusy(true);
    const data = await core('UPDATE_LOCAL_AI_SETTINGS', { settings });
    const saved = data.settings;
    $('local-ai-base-url').value = saved.baseUrl;
    $('local-ai-status').textContent = `Налаштування збережено: ${saved.providerType}, модель ${saved.model || 'ще не вибрана'}.`;
    announce('Налаштування локального ШІ збережено.');
  } catch (error) {
    $('local-ai-status').textContent = `Не вдалося зберегти локальний ШІ: ${error.message}`;
    announce('Не вдалося зберегти налаштування локального ШІ.');
  } finally {
    setLocalAiBusy(false);
  }
}

async function testLocalAiConnection() {
  try {
    const settings = localAiSettingsFromForm();
    setLocalAiBusy(true);
    $('local-ai-status').textContent = 'Перевіряю локальний AI-сервер…';
    const data = await core('TEST_LOCAL_AI_CONNECTION', { settings });
    const result = data.result;
    renderLocalAiModels(result.models || []);
    if (!$('local-ai-model').value && result.models?.length === 1) $('local-ai-model').value = result.models[0];
    const modelNote = result.configuredModel
      ? (result.configuredModelAvailable === false ? ' Вказаної моделі немає у списку сервера.' : ' Вказану модель знайдено.')
      : ' Виберіть модель зі списку або введіть назву вручну.';
    $('local-ai-status').textContent = `Підключення успішне. Знайдено моделей: ${result.models.length}.${modelNote}`;
    announce('Локальний AI-сервер відповідає.');
  } catch (error) {
    renderLocalAiModels([]);
    $('local-ai-status').textContent = `Помилка підключення локального ШІ: ${error.message}`;
    announce('Локальний AI-сервер недоступний.');
  } finally {
    setLocalAiBusy(false);
  }
}

async function runLocalAiTestPrompt() {
  const prompt = $('local-ai-test-prompt').value.trim();
  if (!prompt) {
    $('local-ai-status').textContent = 'Введіть тестовий запит до локальної моделі.';
    $('local-ai-test-prompt').focus();
    return;
  }
  try {
    const settings = localAiSettingsFromForm();
    setLocalAiBusy(true);
    $('local-ai-test-response').textContent = '';
    $('local-ai-status').textContent = 'Локальна модель генерує відповідь…';
    const data = await core('RUN_LOCAL_AI_PROMPT', { settings, prompt });
    $('local-ai-test-response').textContent = data.result.text;
    $('local-ai-status').textContent = `Локальна модель відповіла: ${data.result.model}.`;
    announce('Отримано відповідь від локальної моделі.');
  } catch (error) {
    $('local-ai-status').textContent = `Локальна модель не виконала запит: ${error.message}`;
    announce('Помилка локальної моделі.');
  } finally {
    setLocalAiBusy(false);
  }
}

function onLocalAiProviderChanged() {
  const provider = $('local-ai-provider').value;
  const current = $('local-ai-base-url').value.trim();
  const knownDefaults = new Set(Object.values(LOCAL_AI_DEFAULT_URLS));
  if (!current || knownDefaults.has(current)) $('local-ai-base-url').value = LOCAL_AI_DEFAULT_URLS[provider];
  renderLocalAiModels([]);
}


function aiRouterSettingsFromForm() {
  const integer = (id, min, max, label) => {
    const value = Number($(id).value);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: введіть ціле число ${min}-${max}.`);
    return value;
  };
  return {
    enabled: $('ai-router-enabled').checked,
    gatewayUrl: $('ai-router-gateway-url').value.trim(),
    timeoutSeconds: integer('ai-router-timeout', 5, 900, 'Тайм-аут'),
    mode: $('ai-router-mode').value,
    primary: {
      provider: $('ai-router-primary-provider').value,
      model: $('ai-router-primary-model').value.trim(),
    },
    strong: {
      provider: $('ai-router-strong-provider').value,
      model: $('ai-router-strong-model').value.trim(),
    },
    strongEveryNRequests: integer('ai-router-every-n', 0, 10000, 'Інтервал сильної моделі за кількістю запитів'),
    strongEveryMinutes: integer('ai-router-every-minutes', 0, 10080, 'Інтервал сильної моделі за часом'),
    strongMinGapMinutes: integer('ai-router-strong-min-gap', 0, 1440, 'Мінімальний інтервал між автоматичними сильними проходами'),
    strongMaxPerHour: integer('ai-router-strong-max-hour', 0, 1000, 'Максимум автоматичних сильних проходів за годину'),
    carryStrongResultToPrimary: $('ai-router-carry-strong').checked,
    fallbackToStrongOnPrimaryError: $('ai-router-fallback-strong').checked,
    keepPrimaryIfStrongFails: $('ai-router-keep-primary').checked,
    handoffMaxChars: integer('ai-router-handoff-max', 1000, 50000, 'Розмір handoff'),
  };
}

function setAiRouterBusy(busy) {
  for (const id of [
    'save-ai-router-button', 'test-ai-gateway-button', 'reset-ai-router-runtime-button',
    'ai-router-primary-models-button', 'ai-router-strong-models-button',
    'run-ai-router-test-button', 'run-ai-router-strong-button',
  ]) $(id).disabled = Boolean(busy);
}

function renderAiRouterRuntime(runtime = {}) {
  const started = Number(runtime.startedAt || 0) ? new Date(runtime.startedAt).toLocaleString() : 'ще не стартував';
  const lastStrong = Number(runtime.lastStrongAt || 0)
    ? new Date(runtime.lastStrongAt).toLocaleString()
    : 'ще не запускалась';
  const strongLastHour = (Array.isArray(runtime.strongHistoryAt) ? runtime.strongHistoryAt : []).filter(at => Date.now() - Number(at || 0) < 60 * 60_000).length;
  $('ai-router-runtime').textContent = `Старт циклу: ${started}; запитів: ${Number(runtime.requestCount || 0)}; основна модель: ${Number(runtime.primaryCount || 0)}; сильна модель: ${Number(runtime.strongCount || 0)}; сильних за останню годину: ${strongLastHour}; останній маршрут: ${runtime.lastRoute || 'немає'}; остання сильна: ${lastStrong}.`;
}

const OPENAI_MODEL_PRESETS = Object.freeze([
  Object.freeze({ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol — найсильніша для складного reasoning і coding' }),
  Object.freeze({ id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra — баланс якості, швидкості та вартості' }),
  Object.freeze({ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna — швидка та економна для масових задач' }),
]);

function uniqueModelIds(models = []) {
  return [...new Set((Array.isArray(models) ? models : []).map(value => String(value || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function fillModelSelect(id, provider, models = [], selected = '') {
  const select = $(id);
  const wanted = String(selected || '').trim();
  select.replaceChildren();

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = provider === 'openai' ? 'Оберіть OpenAI модель' : 'Оновіть список і оберіть модель';
  select.append(empty);

  const seen = new Set();
  if (provider === 'openai') {
    const group = document.createElement('optgroup');
    group.label = 'Рекомендовані OpenAI';
    for (const preset of OPENAI_MODEL_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      group.append(option);
      seen.add(preset.id);
    }
    select.append(group);
  }

  const discovered = uniqueModelIds(models).filter(model => !seen.has(model));
  if (discovered.length) {
    const group = document.createElement('optgroup');
    group.label = provider === 'openai' ? 'Моделі, доступні API-акаунту' : 'Моделі сервера';
    for (const model of discovered) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      group.append(option);
    }
    select.append(group);
  }

  if (wanted && ![...select.options].some(option => option.value === wanted)) {
    const option = document.createElement('option');
    option.value = wanted;
    option.textContent = `${wanted} — збережена модель`;
    select.append(option);
  }
  select.value = wanted;
}

function resetAiRouterModelSlot(slot, { preserve = false } = {}) {
  const primary = slot === 'primary';
  const providerId = primary ? 'ai-router-primary-provider' : 'ai-router-strong-provider';
  const modelId = primary ? 'ai-router-primary-model' : 'ai-router-strong-model';
  const selected = preserve ? $(modelId).value : '';
  fillModelSelect(modelId, $(providerId).value, [], selected);
}

async function loadAiRouterSettings() {
  try {
    const data = await core('GET_AI_ROUTER_SETTINGS');
    const settings = data.settings || {};
    $('ai-router-enabled').checked = settings.enabled === true;
    $('ai-router-gateway-url').value = settings.gatewayUrl || 'http://127.0.0.1:17621';
    $('ai-router-timeout').value = String(settings.timeoutSeconds || 180);
    $('ai-router-mode').value = settings.mode || 'primary';
    $('ai-router-primary-provider').value = settings.primary?.provider || 'ollama';
    $('ai-router-strong-provider').value = settings.strong?.provider || 'openai';
    fillModelSelect('ai-router-primary-model', $('ai-router-primary-provider').value, [], settings.primary?.model || '');
    fillModelSelect('ai-router-strong-model', $('ai-router-strong-provider').value, [], settings.strong?.model || '');
    $('ai-router-every-n').value = String(settings.strongEveryNRequests ?? 10);
    $('ai-router-every-minutes').value = String(settings.strongEveryMinutes ?? 120);
    $('ai-router-strong-min-gap').value = String(settings.strongMinGapMinutes ?? 0);
    $('ai-router-strong-max-hour').value = String(settings.strongMaxPerHour ?? 0);
    $('ai-router-carry-strong').checked = settings.carryStrongResultToPrimary !== false;
    $('ai-router-fallback-strong').checked = settings.fallbackToStrongOnPrimaryError !== false;
    $('ai-router-keep-primary').checked = settings.keepPrimaryIfStrongFails !== false;
    $('ai-router-handoff-max').value = String(settings.handoffMaxChars || 12000);
    renderAiRouterRuntime(data.runtime || {});
    $('ai-router-status').textContent = settings.enabled
      ? 'AI-координатор увімкнено. Перевірте Gateway і моделі.'
      : 'AI-координатор вимкнено; налаштування збережені.';
  } catch (error) {
    $('ai-router-status').textContent = `Не вдалося завантажити AI-координатор: ${error.message}`;
  }
}

async function saveAiRouterSettings() {
  try {
    setAiRouterBusy(true);
    const settings = aiRouterSettingsFromForm();
    const data = await core('UPDATE_AI_ROUTER_SETTINGS', { settings });
    $('ai-router-status').textContent = `AI-координатор збережено: режим ${data.settings.mode}.`;
    announce('Налаштування AI-координатора збережено.');
  } catch (error) {
    $('ai-router-status').textContent = `Не вдалося зберегти AI-координатор: ${error.message}`;
  } finally {
    setAiRouterBusy(false);
  }
}

async function testAiGateway() {
  try {
    setAiRouterBusy(true);
    const settings = aiRouterSettingsFromForm();
    $('ai-router-status').textContent = 'Перевіряю локальний AI Gateway…';
    const data = await core('TEST_AI_GATEWAY', { settings });
    const result = data.result || {};
    const providerStatus = Array.isArray(result.providerStatus) ? result.providerStatus : [];
    const providerText = providerStatus.length
      ? providerStatus.map(item => `${item.provider}: ${item.ok ? `готовий (${item.models || 0} моделей)` : (item.configured === false ? 'не налаштований' : 'недоступний')}`).join('; ')
      : ((result.providers || []).join(', ') || 'не вказано');
    const compatibleCredential = result.compatibleApiKeyConfigured
      ? 'compatible key завантажений у Gateway'
      : 'compatible key не збережений (для локального сервера без авторизації це нормально)';
    const compatibleEndpoint = result.compatibleBaseUrl ? `OpenAI-compatible endpoint: ${result.compatibleBaseUrl}` : 'OpenAI-compatible endpoint не повідомлено';
    const openaiStatus = result.openaiConfigured ? 'налаштований у Windows DPAPI / Gateway' : 'не налаштований';
    $('ai-router-openai-key-status').textContent = `OpenAI API key: ${openaiStatus}.`;
    $('ai-router-status').textContent = `Gateway ${result.version || ''} працює. ${providerText}. OpenAI API: ${result.openaiConfigured ? 'ключ налаштований у Gateway' : 'ключ ще не налаштований у Gateway'}. ${compatibleEndpoint}; ${compatibleCredential}.`;
    announce('AI Gateway відповідає.');
  } catch (error) {
    $('ai-router-openai-key-status').textContent = 'OpenAI API key: не вдалося перевірити, бо Gateway недоступний.';
    $('ai-router-status').textContent = `AI Gateway недоступний: ${error.message}`;
  } finally {
    setAiRouterBusy(false);
  }
}

async function loadAiRouterModels(slot) {
  const primary = slot === 'primary';
  const providerId = primary ? 'ai-router-primary-provider' : 'ai-router-strong-provider';
  const modelId = primary ? 'ai-router-primary-model' : 'ai-router-strong-model';
  const provider = $(providerId).value;
  const selectedBefore = $(modelId).value;
  try {
    setAiRouterBusy(true);
    const settings = aiRouterSettingsFromForm();
    $('ai-router-status').textContent = `Отримую список моделей ${provider}…`;
    const data = await core('LIST_AI_ROUTER_MODELS', { settings, provider });
    const models = data.result?.models || [];
    fillModelSelect(modelId, provider, models, selectedBefore);
    if (!$(modelId).value && models.length === 1) $(modelId).value = models[0];
    const recommended = provider === 'openai' ? ' Рекомендовані GPT-5.6 також доступні у верхній групі списку.' : '';
    $('ai-router-status').textContent = `Знайдено моделей ${provider}: ${models.length}.${recommended}`;
  } catch (error) {
    fillModelSelect(modelId, provider, [], selectedBefore);
    $('ai-router-status').textContent = `Не вдалося отримати список моделей: ${error.message}`;
  } finally {
    setAiRouterBusy(false);
  }
}

async function runAiRouterPrompt(forceStrong = false) {
  const prompt = $('ai-router-test-prompt').value.trim();
  if (!prompt) {
    $('ai-router-status').textContent = 'Введіть тестове завдання AI-координатору.';
    $('ai-router-test-prompt').focus();
    return;
  }
  try {
    setAiRouterBusy(true);
    const settings = aiRouterSettingsFromForm();
    $('ai-router-test-response').textContent = '';
    $('ai-router-status').textContent = forceStrong ? 'Запускаю сильну модель…' : 'AI-координатор виконує завдання…';
    const data = await core('RUN_AI_ROUTED_PROMPT', { settings, prompt, forceStrong });
    const result = data.result;
    $('ai-router-test-response').textContent = result.text;
    renderAiRouterRuntime(result.runtime || {});
    const primary = result.primary ? `${result.primary.provider}/${result.primary.model}` : 'не викликалась';
    const strong = result.strong ? `${result.strong.provider}/${result.strong.model}` : 'не викликалась';
    $('ai-router-status').textContent = `Готово. Маршрут: ${result.route}; причина: ${result.trigger}; основна: ${primary}; сильна: ${strong}.`;
    announce(`AI-координатор завершив запит через ${result.route === 'strong' ? 'сильну' : 'основну'} модель.`);
  } catch (error) {
    $('ai-router-status').textContent = `AI-координатор не виконав завдання: ${error.message}`;
  } finally {
    setAiRouterBusy(false);
  }
}

async function resetAiRouterRuntime() {
  try {
    setAiRouterBusy(true);
    const data = await core('RESET_AI_ROUTER_RUNTIME');
    renderAiRouterRuntime(data.runtime || {});
    $('ai-router-status').textContent = 'Лічильники та контекст гібриду скинуто.';
  } catch (error) {
    $('ai-router-status').textContent = `Не вдалося скинути лічильники: ${error.message}`;
  } finally {
    setAiRouterBusy(false);
  }
}

function aiManagerSettingsFromForm() {
  const integer = (id, min, max, label) => {
    const value = Number($(id).value);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: введіть ціле число ${min}-${max}.`);
    return value;
  };
  return {
    enabled: $('ai-manager-enabled').checked,
    autoApplySafeActions: $('ai-manager-auto-apply').checked,
    triggerEveryNSends: integer('ai-manager-every-n', 0, 10000, 'Інтервал AI Manager за Send'),
    triggerEveryMinutes: integer('ai-manager-every-minutes', 0, 10080, 'Інтервал AI Manager за часом'),
    triggerOnComplete: $('ai-manager-on-complete').checked,
    triggerOnErrors: $('ai-manager-on-errors').checked,
    errorThreshold: integer('ai-manager-error-threshold', 1, 100, 'Поріг помилок'),
    appendHandoffToNextPrompt: $('ai-manager-handoff-enabled').checked,
    allowRestartCompletedOnePass: $('ai-manager-restart-completed').checked,
    allowSessionTuning: $('ai-manager-session-tuning').checked,
    handoffMaxChars: integer('ai-manager-handoff-max', 500, 50000, 'Максимальний handoff'),
    contextMaxChars: integer('ai-manager-context-max', 2000, 100000, 'Максимальний контекст'),
    failureRetrySeconds: integer('ai-manager-failure-retry', 10, 3600, 'Повтор AI Manager після помилки'),
    maxPendingEvents: 200,
    captureWebReports: $('ai-manager-capture-web-reports').checked,
    triggerOnWebReport: $('ai-manager-on-web-report').checked,
    webReportPollSeconds: integer('ai-manager-report-poll', 5, 3600, 'Інтервал перевірки web-звіту'),
    webReportMaxWaitMinutes: integer('ai-manager-report-max-wait', 1, 1440, 'Максимальний час очікування web-звіту'),
    webReportMaxChars: integer('ai-manager-report-max-chars', 1000, 100000, 'Максимальний web-звіт'),
  };
}

function setAiManagerBusy(busy) {
  for (const id of ['save-ai-manager-button', 'run-ai-manager-now-button', 'reset-ai-manager-runtime-button']) {
    $(id).disabled = Boolean(busy);
  }
}

function renderAiManagerRuntime(runtime = {}) {
  const last = Number(runtime.lastDecisionAt || 0) ? new Date(runtime.lastDecisionAt).toLocaleString() : 'ще не було';
  const error = runtime.lastError ? `; остання помилка: ${runtime.lastError}` : '';
  $('ai-manager-runtime').textContent = `Подій у черзі: ${(runtime.pendingEvents || []).length}; очікується web-звітів: ${(runtime.pendingReports || []).length}; Send від останнього аналізу: ${Number(runtime.sentSinceDecision || 0)}; рішень: ${Number(runtime.decisionCount || 0)}; оброблено подій: ${Number(runtime.processedEventCount || 0)}; останній аналіз: ${last}; маршрут: ${runtime.lastDecisionRoute || 'немає'}; висновок: ${runtime.lastDecisionSummary || 'немає'}${error}`;

  const history = $('ai-manager-history');
  history.textContent = '';
  const entries = Array.isArray(runtime.decisionHistory) ? runtime.decisionHistory.slice(-20).reverse() : [];
  if (!entries.length) {
    const li = document.createElement('li');
    li.textContent = 'Рішень ще немає.';
    history.appendChild(li);
    return;
  }
  for (const item of entries) {
    const li = document.createElement('li');
    const when = Number(item.at || 0) ? new Date(item.at).toLocaleString() : 'час невідомий';
    const applied = Array.isArray(item.applied) && item.applied.length
      ? item.applied.map(action => `${action.type}${action.sessionId ? ` (${action.sessionId})` : ''}`).join(', ')
      : 'немає';
    const skipped = Array.isArray(item.skipped) && item.skipped.length
      ? item.skipped.map(action => `${action.type}${action.reason ? ` — ${action.reason}` : ''}`).join(', ')
      : 'немає';
    li.textContent = `${when}; причина: ${item.dueReason || 'невідомо'}; маршрут: ${item.route || 'невідомо'}; висновок: ${item.summary || 'без тексту'}; застосовано: ${applied}; пропущено: ${skipped}.`;
    history.appendChild(li);
  }
}

async function loadAiManagerSettings() {
  try {
    const data = await core('GET_AI_MANAGER_SETTINGS');
    const settings = data.settings || {};
    $('ai-manager-enabled').checked = settings.enabled === true;
    $('ai-manager-auto-apply').checked = settings.autoApplySafeActions !== false;
    $('ai-manager-every-n').value = String(settings.triggerEveryNSends ?? 10);
    $('ai-manager-every-minutes').value = String(settings.triggerEveryMinutes ?? 120);
    $('ai-manager-on-complete').checked = settings.triggerOnComplete !== false;
    $('ai-manager-on-errors').checked = settings.triggerOnErrors !== false;
    $('ai-manager-error-threshold').value = String(settings.errorThreshold ?? 3);
    $('ai-manager-handoff-enabled').checked = settings.appendHandoffToNextPrompt !== false;
    $('ai-manager-restart-completed').checked = settings.allowRestartCompletedOnePass === true;
    $('ai-manager-session-tuning').checked = settings.allowSessionTuning === true;
    $('ai-manager-handoff-max').value = String(settings.handoffMaxChars ?? 8000);
    $('ai-manager-context-max').value = String(settings.contextMaxChars ?? 24000);
    $('ai-manager-failure-retry').value = String(settings.failureRetrySeconds ?? 60);
    $('ai-manager-capture-web-reports').checked = settings.captureWebReports !== false;
    $('ai-manager-on-web-report').checked = settings.triggerOnWebReport !== false;
    $('ai-manager-report-poll').value = String(settings.webReportPollSeconds ?? 30);
    $('ai-manager-report-max-wait').value = String(settings.webReportMaxWaitMinutes ?? 60);
    $('ai-manager-report-max-chars').value = String(settings.webReportMaxChars ?? 20000);
    renderAiManagerRuntime(data.runtime || {});
    $('ai-manager-status').textContent = settings.enabled
      ? 'Автономний AI Manager увімкнено. Для роботи також має бути увімкнений AI-координатор вище.'
      : 'AI Manager вимкнено; налаштування збережені.';
  } catch (error) {
    $('ai-manager-status').textContent = `Не вдалося завантажити AI Manager: ${error.message}`;
  }
}

async function saveAiManagerSettings() {
  try {
    setAiManagerBusy(true);
    const settings = aiManagerSettingsFromForm();
    const data = await core('UPDATE_AI_MANAGER_SETTINGS', { settings });
    $('ai-manager-status').textContent = data.settings.enabled ? 'AI Manager увімкнено.' : 'AI Manager збережено вимкненим.';
    announce('Налаштування автономного AI Manager збережено.');
  } catch (error) {
    $('ai-manager-status').textContent = `Не вдалося зберегти AI Manager: ${error.message}`;
  } finally {
    setAiManagerBusy(false);
  }
}

async function runAiManagerNow() {
  try {
    setAiManagerBusy(true);
    await core('UPDATE_AI_MANAGER_SETTINGS', { settings: aiManagerSettingsFromForm() });
    $('ai-manager-status').textContent = 'AI Manager аналізує поточний стан…';
    const data = await core('RUN_AI_MANAGER_NOW');
    await loadAiManagerSettings();
    const decision = data.decision?.summary || data.error || data.kind || 'аналіз завершено';
    $('ai-manager-status').textContent = `AI Manager: ${decision}. Застосовано дій: ${(data.applied || []).length}; пропущено: ${(data.skipped || []).length}.`;
    announce('AI Manager завершив аналіз.');
  } catch (error) {
    $('ai-manager-status').textContent = `AI Manager не виконав аналіз: ${error.message}`;
  } finally {
    setAiManagerBusy(false);
  }
}

async function resetAiManagerRuntime() {
  try {
    setAiManagerBusy(true);
    const data = await core('RESET_AI_MANAGER_RUNTIME');
    renderAiManagerRuntime(data.runtime || {});
    $('ai-manager-status').textContent = 'Чергу, лічильники й історію рішень AI Manager скинуто.';
  } catch (error) {
    $('ai-manager-status').textContent = `Не вдалося скинути AI Manager: ${error.message}`;
  } finally {
    setAiManagerBusy(false);
  }
}


const SCENARIO_WORK_MODE_LABELS = Object.freeze({
  CHAT_CYCLE: 'Цикли в чаті',
  PAIRS: 'Двійки',
  AUDITOR_GROUP: 'Аудитор + група',
  AUDITOR_PIPELINE: 'FIRST → аудитор → SECOND',
});
const SCENARIO_WORK_MODE_PANELS = Object.freeze({
  CHAT_CYCLE: 'cycle',
  PAIRS: 'pairs',
  AUDITOR_GROUP: 'group',
  AUDITOR_PIPELINE: 'group',
});

function scenarioWorkInt(id, min, max, label) {
  return parseStrictBoundedInteger($(id).value, { min, max, label });
}

function setScenarioWorkBusy(busy) {
  for (const id of [
    'new-scenario-cycle-button', 'new-scenario-pairs-button', 'new-scenario-group-button', 'new-scenario-pipeline-button',
    'save-scenario-work-button', 'start-scenario-work-button', 'pause-scenario-work-button',
    'resume-scenario-work-button', 'stop-scenario-work-button', 'delete-scenario-work-button',
    'scenario-work-run-now',
  ]) {
    const element = $(id);
    if (element) element.disabled = busy;
  }
  if (!busy) syncScenarioWorkButtons();
}

function syncScenarioWorkButtons() {
  const item = ui.selectedScenarioWork;
  const state = item?.runtime?.runState || '';
  const has = Boolean(item);
  const running = state === 'RUNNING';
  const paused = state === 'PAUSED';
  $('save-scenario-work-button').disabled = !has || running || paused;
  $('start-scenario-work-button').disabled = !has || running || paused;
  $('pause-scenario-work-button').disabled = !has || !running;
  $('resume-scenario-work-button').disabled = !has || !paused;
  $('stop-scenario-work-button').disabled = !has || (!running && !paused);
  $('delete-scenario-work-button').disabled = !has || running;
  $('scenario-work-run-now').disabled = !has || !running;
}

function clearScenarioWorkState() {
  ui.selectedScenarioWorkId = '';
  ui.selectedScenarioWork = null;
  $('scenario-work-name').value = '';
  $('scenario-work-mode-label').textContent = 'Формат не вибрано.';
  $('scenario-work-state').replaceChildren();
  $('scenario-work-summary').textContent = 'Сценарій не вибрано.';
  syncScenarioWorkButtons();
}

function addScenarioStateLine(term, value) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = String(value ?? '—');
  $('scenario-work-state').append(dt, dd);
}

function scenarioParticipantsForUi(runtime = {}) {
  if (runtime.mode === 'CHAT_CYCLE') return runtime.chat ? [runtime.chat] : [];
  if (runtime.mode === 'PAIRS') {
    return Object.values(runtime.pairs || {}).flatMap(pair => [pair.auditor, pair.worker].filter(Boolean));
  }
  if (runtime.mode === 'AUDITOR_GROUP') {
    return [runtime.group?.auditor, ...Object.values(runtime.group?.workers || {})].filter(Boolean);
  }
  if (runtime.mode === 'AUDITOR_PIPELINE') {
    return [runtime.auditor, ...Object.values(runtime.firstSlots || {}), ...Object.values(runtime.secondSlots || {})].filter(Boolean);
  }
  return [];
}

function renderScenarioWorkState(item) {
  const box = $('scenario-work-state');
  box.replaceChildren();
  if (!item) {
    addScenarioStateLine('Стан', 'Сценарій не вибрано');
    return;
  }
  const runtime = item.runtime || {};
  addScenarioStateLine('Стан', runtime.runState || 'STOPPED');
  addScenarioStateLine('Формат', SCENARIO_WORK_MODE_LABELS[item.config?.mode] || item.config?.mode || '—');
  addScenarioStateLine('Покоління', runtime.generation ?? 1);
  addScenarioStateLine('Фаза', runtime.phase || '—');
  if (runtime.mode === 'CHAT_CYCLE') {
    addScenarioStateLine('Коло', `${runtime.round ?? 0}/${item.config?.roundsPerGeneration ?? 0}`);
    addScenarioStateLine('Крок промпта', `${(runtime.stepIndex ?? 0) + 1}`);
    addScenarioStateLine('Повтор кроку', `${(runtime.repeatIndex ?? 0) + 1}`);
  } else if (runtime.mode === 'AUDITOR_GROUP') {
    addScenarioStateLine('Коло групи', `${runtime.group?.round ?? 0}/${item.config?.roundsPerGeneration ?? 0}`);
  } else if (runtime.mode === 'PAIRS') {
    const rounds = Object.values(runtime.pairs || {}).map(pair => `№${pair.index}: ${pair.round ?? 0}`).join('; ');
    addScenarioStateLine('Кола двійок', rounds || '—');
  } else if (runtime.mode === 'AUDITOR_PIPELINE') {
    const first = Object.values(runtime.firstSlots || {});
    const second = Object.values(runtime.secondSlots || {});
    const firstVerified = first.filter(slot => slot.state === 'COMPLETE').length;
    const secondVerified = second.filter(slot => slot.state === 'COMPLETE').length;
    const completed = new Set(runtime.completedTaskIds || []);
    for (const slot of [...first, ...second]) if (slot.state === 'COMPLETE' && slot.taskId) completed.add(slot.taskId);
    const dependencyBlocked = [...first, ...second].filter(slot => slot.state === 'READY' && (slot.dependencies || []).some(id => !completed.has(id))).length;
    addScenarioStateLine('Раунд pipeline', runtime.round ?? 1);
    addScenarioStateLine('FIRST перевірено', `${firstVerified}/${first.length}`);
    addScenarioStateLine('SECOND перевірено', `${secondVerified}/${second.length}`);
    addScenarioStateLine('Заблоковано залежностями', dependencyBlocked);
    addScenarioStateLine('Allocation', runtime.allocation?.allocationId || 'ще не перевірена');
    addScenarioStateLine('Оренда аудитора', runtime.auditorLease?.active === true ? 'активна' : 'вільна');
    addScenarioStateLine('Невалідних результатів воркерів', runtime.diagnostics?.invalidWorkerResults || 0);
    addScenarioStateLine('Невалідних allocation аудитора', runtime.diagnostics?.invalidAuditorAllocations || 0);
    addScenarioStateLine('Відсічено повторних аудиторів', runtime.diagnostics?.duplicateAuditorPrevented || 0);
  }
  addScenarioStateLine('Створено робіт', runtime.totalLaunches ?? 0);
  addScenarioStateLine('Завершено відповідей', runtime.totalCompletedTurns ?? 0);
  if (runtime.lastError) addScenarioStateLine('Остання помилка', runtime.lastError);
  const participants = scenarioParticipantsForUi(runtime);
  if (participants.length) {
    addScenarioStateLine('Учасники', participants.map(participant => {
      const role = participant.role === 'AUDITOR' ? 'аудитор' : participant.role === 'WORKER' ? 'розробник' : 'чат';
      const index = participant.index ? ` ${participant.index}` : '';
      const chat = participant.chatUrl ? 'чат збережено' : 'новий чат';
      return `${role}${index}: ${participant.state || 'NEW'}, ${participant.stage || 'NONE'}, ${chat}`;
    }).join(' | '));
  }
}

function createScenarioCycleStep(step = {}, index = 0) {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'settings-group scenario-cycle-step';
  fieldset.dataset.scenarioStep = 'true';
  fieldset.dataset.stepId = step.id || `step-${index + 1}`;
  const legend = document.createElement('legend');
  legend.textContent = `Промпт ${index + 1}`;
  const repeatId = `scenario-step-repeat-${crypto.randomUUID()}`;
  const promptId = `scenario-step-prompt-${crypto.randomUUID()}`;
  const repeatLabel = document.createElement('label');
  repeatLabel.htmlFor = repeatId;
  repeatLabel.textContent = 'Скільки разів поспіль';
  const repeat = document.createElement('input');
  repeat.id = repeatId;
  repeat.type = 'number';
  repeat.min = '1';
  repeat.max = '10000';
  repeat.step = '1';
  repeat.inputMode = 'numeric';
  repeat.value = String(step.repeat ?? 1);
  repeat.dataset.scenarioStepRepeat = 'true';
  const promptLabel = document.createElement('label');
  promptLabel.htmlFor = promptId;
  promptLabel.textContent = 'Текст промпта';
  const prompt = document.createElement('textarea');
  prompt.id = promptId;
  prompt.rows = 5;
  prompt.value = step.prompt ?? '';
  prompt.dataset.scenarioStepPrompt = 'true';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Видалити цей промпт';
  remove.addEventListener('click', () => {
    const container = $('scenario-cycle-steps');
    if (container.querySelectorAll('[data-scenario-step]').length <= 1) {
      announce('У циклі має залишатися щонайменше один промпт.');
      return;
    }
    const nextFocus = fieldset.nextElementSibling?.querySelector?.('textarea, input, button')
      || fieldset.previousElementSibling?.querySelector?.('textarea, input, button')
      || $('scenario-cycle-add-step');
    fieldset.remove();
    renumberScenarioCycleSteps();
    nextFocus?.focus();
    announce('Промпт видалено.');
  });
  fieldset.append(legend, repeatLabel, repeat, promptLabel, prompt, remove);
  return fieldset;
}

function renumberScenarioCycleSteps() {
  [...$('scenario-cycle-steps').querySelectorAll('[data-scenario-step]')].forEach((row, index) => {
    const legend = row.querySelector('legend');
    if (legend) legend.textContent = `Промпт ${index + 1}`;
  });
}

function renderScenarioCycleSteps(steps = []) {
  const container = $('scenario-cycle-steps');
  container.replaceChildren();
  const actual = steps.length ? steps : [{ prompt: 'Продовжуй.', repeat: 1 }];
  actual.forEach((step, index) => container.append(createScenarioCycleStep(step, index)));
  renumberScenarioCycleSteps();
}

function readScenarioCycleSteps() {
  const rows = [...$('scenario-cycle-steps').querySelectorAll('[data-scenario-step]')];
  if (!rows.length) throw new Error('Додайте щонайменше один промпт.');
  return rows.map((row, index) => {
    const prompt = row.querySelector('[data-scenario-step-prompt]')?.value || '';
    if (!prompt.trim()) throw new Error(`Промпт ${index + 1} порожній.`);
    return {
      id: row.dataset.stepId || `step-${index + 1}`,
      label: `Промпт ${index + 1}`,
      prompt,
      repeat: parseStrictBoundedInteger(row.querySelector('[data-scenario-step-repeat]')?.value, { min: 1, max: 10000, label: `Повторів промпта ${index + 1}` }),
    };
  });
}

function scenarioWorkConfigFromForm() {
  const current = ui.selectedScenarioWork;
  if (!current) throw new Error('Спочатку виберіть сценарій.');
  const mode = current.config?.mode;
  const common = {
    ...current.config,
    id: current.id,
    name: $('scenario-work-name').value.trim() || current.name || 'Сценарна робота',
    mode,
    roundsPerGeneration: scenarioWorkInt('scenario-work-rounds', 1, 10000, 'Кіл у поколінні'),
    maxGenerations: scenarioWorkInt('scenario-work-generations', 0, 10000, 'Кількість поколінь'),
    responseTimeoutMinutes: scenarioWorkInt('scenario-work-timeout', 1, 1440, 'Час очікування відповіді'),
    pollSeconds: scenarioWorkInt('scenario-work-poll', 5, 600, 'Інтервал перевірки'),
    minimumLaunchGapSeconds: scenarioWorkInt('scenario-work-launch-gap', 0, 3600, 'Інтервал між новими роботами'),
    preSendDelaySeconds: scenarioWorkInt('scenario-work-pre-send', 1, 30, 'Пауза перед надсиланням'),
    busyCheckDelaySeconds: scenarioWorkInt('scenario-work-busy-check', 1, 30, 'Повторна перевірка зайнятого чату'),
    retryBackoffSeconds: scenarioWorkInt('scenario-work-retry', 5, 3600, 'Повтор після технічної помилки'),
    timeoutPolicy: $('scenario-work-timeout-policy').value,
  };
  if (mode === 'CHAT_CYCLE') {
    return {
      ...common,
      launchUrl: $('scenario-cycle-url').value.trim(),
      restartCurrentRoundOnTimeout: $('scenario-cycle-restart-round-timeout').checked,
      steps: readScenarioCycleSteps(),
    };
  }
  const prefix = mode === 'PAIRS' ? 'scenario-pair' : 'scenario-group';
  const role = {
    auditorLaunchUrl: $(`${prefix}-auditor-url`).value.trim(),
    workerLaunchUrl: $(`${prefix}-worker-url`).value.trim(),
    auditorBootstrapPrompt: $(`${prefix}-auditor-bootstrap`).value,
    workerBootstrapPrompt: $(`${prefix}-worker-bootstrap`).value,
    auditorCyclePrompt: $(`${prefix}-auditor-cycle`).value,
    workerCyclePrompt: $(`${prefix}-worker-cycle`).value,
    timeoutAuditorPrompt: $(`${prefix}-timeout-auditor`).value,
    replacementAuditorPrompt: $(`${prefix}-replacement-auditor`).value,
  };
  if (mode === 'PAIRS') {
    return { ...common, ...role, pairCount: scenarioWorkInt('scenario-pair-count', 1, 100, 'Кількість двійок') };
  }
  if (mode === 'AUDITOR_PIPELINE') {
    return {
      ...common, ...role,
      firstCount: scenarioWorkInt('scenario-pipeline-first-count', 1, 100, 'Кількість FIRST-воркерів'),
      secondCount: scenarioWorkInt('scenario-pipeline-second-count', 0, 100, 'Кількість SECOND-воркерів'),
      barrierPolicy: $('scenario-pipeline-barrier-policy').value,
      auditTimeboxMinutes: scenarioWorkInt('scenario-pipeline-audit-timebox', 1, 1440, 'Ліміт до аудиту'),
      maxCorrectionAttempts: scenarioWorkInt('scenario-pipeline-max-corrections', 0, 10, 'Максимум виправлень'),
      firstWorkerPrompt: $('scenario-pipeline-first-prompt').value,
      secondWorkerPrompt: $('scenario-pipeline-second-prompt').value,
      auditorPrompt: $('scenario-pipeline-auditor-prompt').value,
      workerCorrectionPrompt: $('scenario-pipeline-worker-correction').value,
      auditorCorrectionPrompt: $('scenario-pipeline-auditor-correction').value,
    };
  }
  return { ...common, ...role, workerCount: scenarioWorkInt('scenario-group-worker-count', 1, 200, 'Кількість розробників') };
}

function fillScenarioWorkForm(item) {
  if (!item) { clearScenarioWorkState(); return; }
  ui.selectedScenarioWorkId = item.id;
  ui.selectedScenarioWork = clone(item);
  const config = item.config || {};
  $('scenario-work-name').value = item.name || config.name || '';
  $('scenario-work-mode-label').textContent = `Формат: ${SCENARIO_WORK_MODE_LABELS[config.mode] || config.mode || 'невідомий'}.`;
  $('scenario-work-rounds').value = String(config.roundsPerGeneration ?? 10);
  $('scenario-work-generations').value = String(config.maxGenerations ?? 0);
  $('scenario-work-timeout').value = String(config.responseTimeoutMinutes ?? 40);
  $('scenario-work-poll').value = String(config.pollSeconds ?? 15);
  $('scenario-work-launch-gap').value = String(config.minimumLaunchGapSeconds ?? 0);
  $('scenario-work-pre-send').value = String(config.preSendDelaySeconds ?? 10);
  $('scenario-work-busy-check').value = String(config.busyCheckDelaySeconds ?? 3);
  $('scenario-work-retry').value = String(config.retryBackoffSeconds ?? 30);
  $('scenario-work-timeout-policy').value = config.timeoutPolicy || 'REPLACE_MEMBER';
  $('scenario-pipeline-settings').hidden = config.mode !== 'AUDITOR_PIPELINE';
  if (config.mode === 'CHAT_CYCLE') {
    $('scenario-cycle-url').value = config.launchUrl || 'https://chatgpt.com/';
    $('scenario-cycle-restart-round-timeout').checked = config.restartCurrentRoundOnTimeout !== false;
    renderScenarioCycleSteps(config.steps || []);
  } else {
    const prefix = config.mode === 'PAIRS' ? 'scenario-pair' : 'scenario-group';
    if (config.mode === 'PAIRS') $('scenario-pair-count').value = String(config.pairCount ?? 1);
    else if (config.mode === 'AUDITOR_PIPELINE') {
      $('scenario-pipeline-first-count').value = String(config.firstCount ?? 10);
      $('scenario-pipeline-second-count').value = String(config.secondCount ?? 9);
      $('scenario-pipeline-barrier-policy').value = config.barrierPolicy || 'TIMEBOXED_AUDIT';
      $('scenario-pipeline-audit-timebox').value = String(config.auditTimeboxMinutes ?? 30);
      $('scenario-pipeline-max-corrections').value = String(config.maxCorrectionAttempts ?? 2);
      $('scenario-pipeline-first-prompt').value = config.firstWorkerPrompt || 'Є на Drive. Виконай поточний FIRST slot.';
      $('scenario-pipeline-second-prompt').value = config.secondWorkerPrompt || 'Є на Drive. Виконай поточний SECOND slot.';
      $('scenario-pipeline-auditor-prompt').value = config.auditorPrompt || 'Є на Drive. Проаудитуй поточний раунд і створи наступну allocation.';
      $('scenario-pipeline-worker-correction').value = config.workerCorrectionPrompt || '';
      $('scenario-pipeline-auditor-correction').value = config.auditorCorrectionPrompt || '';
    } else $('scenario-group-worker-count').value = String(config.workerCount ?? 5);
    $(`${prefix}-auditor-url`).value = config.auditorLaunchUrl || 'https://chatgpt.com/';
    $(`${prefix}-worker-url`).value = config.workerLaunchUrl || 'https://chatgpt.com/';
    $(`${prefix}-auditor-bootstrap`).value = config.auditorBootstrapPrompt || '';
    $(`${prefix}-worker-bootstrap`).value = config.workerBootstrapPrompt || '';
    $(`${prefix}-auditor-cycle`).value = config.auditorCyclePrompt || 'Є на Drive.';
    $(`${prefix}-worker-cycle`).value = config.workerCyclePrompt || 'Є на Drive.';
    $(`${prefix}-timeout-auditor`).value = config.timeoutAuditorPrompt || '';
    $(`${prefix}-replacement-auditor`).value = config.replacementAuditorPrompt || '';
  }
  renderScenarioWorkState(item);
  const panel = SCENARIO_WORK_MODE_PANELS[config.mode] || 'cycle';
  if (storageGet(SCENARIO_WORK_PANEL_KEY) !== 'state') setScenarioWorkPanel(panel);
  $('scenario-work-summary').textContent = `${item.name}. Стан: ${item.runtime?.runState || 'STOPPED'}.`;
  syncScenarioWorkButtons();
}

function renderScenarioWorkList(data = {}) {
  const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
  ui.scenarioWorkScenarios = scenarios.map(item => clone(item));
  const list = $('scenario-work-list');
  list.replaceChildren();
  for (const item of scenarios) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name} — ${SCENARIO_WORK_MODE_LABELS[item.config?.mode] || item.config?.mode || 'формат'}`;
    list.append(option);
  }
  const selected = data.selectedId && scenarios.some(item => item.id === data.selectedId)
    ? data.selectedId
    : (scenarios[0]?.id || '');
  list.value = selected;
  if (!selected) clearScenarioWorkState();
  return selected;
}

async function loadScenarioWork({ preservePanel = true } = {}) {
  try {
    const listData = await core('LIST_SCENARIO_WORK');
    const selected = renderScenarioWorkList(listData);
    if (!selected) return;
    const data = await core('GET_SCENARIO_WORK', { id: selected });
    fillScenarioWorkForm(data.scenario);
    if (!preservePanel) setScenarioWorkPanel(SCENARIO_WORK_MODE_PANELS[data.scenario?.config?.mode] || 'cycle');
  } catch (error) {
    $('scenario-work-summary').textContent = `Не вдалося завантажити сценарну роботу: ${error.message}`;
  }
}

async function openScenarioWork(id) {
  if (!id) { clearScenarioWorkState(); return; }
  try {
    const data = await core('SELECT_SCENARIO_WORK', { id });
    fillScenarioWorkForm(data.scenario);
  } catch (error) {
    $('scenario-work-summary').textContent = `Не вдалося відкрити сценарій: ${error.message}`;
  }
}

async function createScenarioWork(mode) {
  const label = SCENARIO_WORK_MODE_LABELS[mode] || 'Сценарна робота';
  try {
    setScenarioWorkBusy(true);
    const data = await core('CREATE_SCENARIO_WORK', { name: `Новий: ${label}`, mode });
    await loadScenarioWork({ preservePanel: false });
    if (data?.scenario?.id) await openScenarioWork(data.scenario.id);
    setScenarioWorkPanel(SCENARIO_WORK_MODE_PANELS[mode] || 'cycle');
    $('scenario-work-name').focus();
    announce(`Створено сценарій: ${label}.`);
  } catch (error) {
    $('scenario-work-summary').textContent = `Не вдалося створити сценарій: ${error.message}`;
  } finally { setScenarioWorkBusy(false); }
}

async function saveScenarioWork() {
  const id = ui.selectedScenarioWorkId;
  if (!id) return;
  try {
    setScenarioWorkBusy(true);
    const config = scenarioWorkConfigFromForm();
    const data = await core('UPDATE_SCENARIO_WORK', { id, config });
    fillScenarioWorkForm(data.scenario);
    await loadScenarioWork();
    announce('Сценарій збережено.');
  } catch (error) {
    $('scenario-work-summary').textContent = `Не вдалося зберегти сценарій: ${error.message}`;
    announce('Помилка збереження сценарію.');
  } finally { setScenarioWorkBusy(false); }
}

async function scenarioWorkLifecycle(command, successText) {
  const id = ui.selectedScenarioWorkId;
  if (!id) return;
  try {
    setScenarioWorkBusy(true);
    const data = await core(command, { id });
    fillScenarioWorkForm(data.scenario);
    await loadScenarioWork();
    if (command === 'START_SCENARIO_WORK' || command === 'RESUME_SCENARIO_WORK') setScenarioWorkPanel('state');
    announce(successText);
  } catch (error) {
    $('scenario-work-summary').textContent = `${successText} не виконано: ${error.message}`;
  } finally { setScenarioWorkBusy(false); }
}

async function deleteScenarioWork() {
  const id = ui.selectedScenarioWorkId;
  if (!id) return;
  try {
    setScenarioWorkBusy(true);
    await core('DELETE_SCENARIO_WORK', { id });
    await loadScenarioWork({ preservePanel: false });
    $('scenario-work-list').focus();
    announce('Сценарій видалено.');
  } catch (error) {
    $('scenario-work-summary').textContent = `Не вдалося видалити сценарій: ${error.message}`;
  } finally { setScenarioWorkBusy(false); }
}

async function runScenarioWorkNow() {
  try {
    setScenarioWorkBusy(true);
    await core('RUN_SCENARIO_WORK_NOW');
    await loadScenarioWork();
    setScenarioWorkPanel('state');
    announce('Стан сценарної роботи перевірено зараз.');
  } catch (error) {
    $('scenario-work-summary').textContent = `Не вдалося перевірити сценарну роботу: ${error.message}`;
  } finally { setScenarioWorkBusy(false); }
}


function browserAgentNameFromGoal(goal) {
  const text = String(goal || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 90) : 'Нове завдання агента';
}

function browserAgentInteger(id, min, max, label) {
  const value = Number($(id).value);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: введіть ціле число ${min}-${max}.`);
  return value;
}

function browserAgentNumber(id, min, max, label) {
  const value = Number($(id).value);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label}: введіть число ${min}-${max}.`);
  return value;
}

function browserAgentDateTimeLocalToEpoch(id) {
  const raw = $(id).value.trim();
  if (!raw) return 0;
  const value = new Date(raw).getTime();
  if (!Number.isFinite(value)) throw new Error('Некоректна дата або час у полі розкладу Agent.');
  return value;
}

function browserAgentEpochToDateTimeLocal(value) {
  const time = Number(value || 0);
  if (!time) return '';
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function browserAgentPolicyFromForm() {
  const scheduleStartAt = browserAgentDateTimeLocalToEpoch('agent-schedule-start');
  const scheduleEndAt = browserAgentDateTimeLocalToEpoch('agent-schedule-end');
  if (scheduleStartAt && scheduleEndAt && scheduleEndAt <= scheduleStartAt) throw new Error('Кінець розкладу Agent має бути пізніше початку.');
  const activeWindowStart = $('agent-active-window-start').value.trim();
  const activeWindowEnd = $('agent-active-window-end').value.trim();
  if (Boolean(activeWindowStart) !== Boolean(activeWindowEnd)) throw new Error('Для щоденного активного вікна вкажіть і початок, і кінець.');
  return {
    startUrl: $('agent-start-url').value.trim(),
    startFromActiveTab: true,
    maxSteps: browserAgentInteger('agent-max-steps', 1, 10000, 'Safety ceiling дій'),
    stepDelayMs: browserAgentInteger('agent-step-delay-ms', 0, 60000, 'Пауза між діями'),
    allowCrossOriginNavigation: $('agent-allow-cross-origin').checked,
    closeOwnedTabsOnStop: $('agent-close-tabs-on-stop').checked,
    approvalMode: $('agent-approval-mode').value,
    visionOnDemand: $('agent-vision-on-demand').checked,
    trustedScriptEnabled: $('agent-trusted-script-enabled').checked,
    repeatMode: $('agent-repeat-mode').value,
    intervalSeconds: browserAgentInteger('agent-interval-seconds', 1, 604800, 'Інтервал Agent'),
    scheduleStartAt,
    scheduleEndAt,
    activeWindowStart,
    activeWindowEnd,
    aiRoutingMode: $('agent-ai-routing-mode').value,
    aiPrimaryProvider: $('agent-ai-primary-provider').value,
    aiPrimaryModel: $('agent-ai-primary-model').value.trim(),
    aiStrongProvider: $('agent-ai-strong-provider').value,
    aiStrongModel: $('agent-ai-strong-model').value.trim(),
    maxModelCalls: browserAgentInteger('agent-max-model-calls', 0, 1000000, 'Model calls'),
    maxInputTokens: browserAgentInteger('agent-max-input-tokens', 0, 2000000000, 'Вхідні токени'),
    maxOutputTokens: browserAgentInteger('agent-max-output-tokens', 0, 2000000000, 'Вихідні токени'),
    maxTotalTokens: browserAgentInteger('agent-max-total-tokens', 0, 2000000000, 'Усі токени'),
    maxOutputTokensPerCall: browserAgentInteger('agent-max-output-per-call', 128, 200000, 'Output tokens на model call'),
    maxRuntimeMinutes: browserAgentInteger('agent-max-runtime-minutes', 0, 525600, 'Час роботи'),
    maxCostUsd: browserAgentNumber('agent-max-cost-usd', 0, 1000000, 'Бюджет USD'),
    inputPricePerMillionUsd: browserAgentNumber('agent-input-price', 0, 1000000, 'Ціна input'),
    outputPricePerMillionUsd: browserAgentNumber('agent-output-price', 0, 1000000, 'Ціна output'),
  };
}

function fillBrowserAgentPolicy(config = {}) {
  $('agent-start-url').value = config.startUrl || '';
  $('agent-max-steps').value = String(config.maxSteps ?? 500);
  $('agent-step-delay-ms').value = String(config.stepDelayMs ?? 0);
  $('agent-allow-cross-origin').checked = config.allowCrossOriginNavigation !== false;
  $('agent-close-tabs-on-stop').checked = config.closeOwnedTabsOnStop === true;
  $('agent-approval-mode').value = config.approvalMode === 'ALLOW_ALL' ? 'ALLOW_ALL' : 'CONSEQUENTIAL';
  $('agent-vision-on-demand').checked = config.visionOnDemand !== false;
  $('agent-trusted-script-enabled').checked = config.trustedScriptEnabled === true;
  $('agent-repeat-mode').value = ['ONCE','CONTINUOUS','INTERVAL'].includes(config.repeatMode) ? config.repeatMode : 'ONCE';
  $('agent-interval-seconds').value = String(config.intervalSeconds ?? 60);
  $('agent-schedule-start').value = browserAgentEpochToDateTimeLocal(config.scheduleStartAt);
  $('agent-schedule-end').value = browserAgentEpochToDateTimeLocal(config.scheduleEndAt);
  $('agent-active-window-start').value = config.activeWindowStart || '';
  $('agent-active-window-end').value = config.activeWindowEnd || '';
  $('agent-ai-routing-mode').value = ['inherit','primary','strong','hybrid-auto','hybrid-rules'].includes(config.aiRoutingMode) ? config.aiRoutingMode : 'inherit';
  $('agent-ai-primary-provider').value = ['inherit','ollama','openai','openai-compatible'].includes(config.aiPrimaryProvider) ? config.aiPrimaryProvider : 'inherit';
  $('agent-ai-primary-model').value = config.aiPrimaryModel || '';
  $('agent-ai-strong-provider').value = ['inherit','ollama','openai','openai-compatible'].includes(config.aiStrongProvider) ? config.aiStrongProvider : 'inherit';
  $('agent-ai-strong-model').value = config.aiStrongModel || '';
  $('agent-max-model-calls').value = String(config.maxModelCalls ?? 0);
  $('agent-max-input-tokens').value = String(config.maxInputTokens ?? 0);
  $('agent-max-output-tokens').value = String(config.maxOutputTokens ?? 0);
  $('agent-max-total-tokens').value = String(config.maxTotalTokens ?? 0);
  $('agent-max-output-per-call').value = String(config.maxOutputTokensPerCall ?? 4096);
  $('agent-max-runtime-minutes').value = String(config.maxRuntimeMinutes ?? 0);
  $('agent-max-cost-usd').value = String(config.maxCostUsd ?? 0);
  $('agent-input-price').value = String(config.inputPricePerMillionUsd ?? 0);
  $('agent-output-price').value = String(config.outputPricePerMillionUsd ?? 0);
}

function browserAgentStateLabel(value) {
  return ({ RUNNING: 'працює', PAUSED: 'пауза', STOPPED: 'зупинено', COMPLETED: 'завершено', ERROR: 'помилка', WAITING_PERMISSION: 'потрібен дозвіл сайту', WAITING_CAPABILITY: 'потрібен дозвіл capability', WAITING_APPROVAL: 'очікує підтвердження дії', WAITING_SCHEDULE: 'очікує розкладу' })[value] || value || 'невідомо';
}

function renderBrowserAgentJob(job) {
  ui.selectedBrowserAgent = job || null;
  const runtime = job?.runtime || {};
  const config = job?.config || {};
  const state = runtime.runState || 'STOPPED';
  const exists = Boolean(job);
  $('agent-pause-button').disabled = state !== 'RUNNING';
  $('agent-resume-button').disabled = !exists || !['PAUSED','STOPPED','WAITING_PERMISSION','WAITING_CAPABILITY','WAITING_SCHEDULE'].includes(state);
  $('agent-approve-action-button').disabled = state !== 'WAITING_APPROVAL';
  $('agent-reject-action-button').disabled = state !== 'WAITING_APPROVAL';
  $('agent-stop-button').disabled = !exists || state === 'STOPPED';
  $('agent-step-button').disabled = !exists || !['PAUSED','STOPPED','WAITING_PERMISSION','WAITING_CAPABILITY','WAITING_SCHEDULE'].includes(state);
  $('agent-run-now-button').disabled = !exists || state !== 'RUNNING';
  $('agent-delete-button').disabled = !exists || state === 'RUNNING';
  $('agent-send-follow-up-button').disabled = !exists;
  $('agent-save-policy-button').disabled = !exists || state === 'RUNNING';
  const pendingApproval = runtime.pendingApproval || null;
  $('agent-approval-panel').hidden = state !== 'WAITING_APPROVAL' || !pendingApproval;
  $('agent-approval-status').textContent = pendingApproval
    ? `${pendingApproval.reason || 'Потрібне підтвердження.'} Ціль: ${pendingApproval.targetName || pendingApproval.action?.type || 'дія'}.`
    : 'Немає дії, що очікує підтвердження.';
  const pendingScript = pendingApproval?.action?.type === 'trusted_script' ? String(pendingApproval.action.code || '') : '';
  $('agent-approval-script').hidden = !pendingScript;
  $('agent-approval-script').textContent = pendingScript ? `Мета: ${pendingApproval.action.purpose || 'DOM/UI fallback'}
Origin: ${pendingApproval.action.origin || ''}

${pendingScript}` : '';
  if (!job) {
    $('agent-status').textContent = 'Агент готовий до нового завдання.';
    $('agent-usage').textContent = 'Використання моделі: ще немає.';
    $('agent-history').textContent = 'Історії ще немає.';
    return;
  }
  const url = runtime.currentUrl || config.startUrl || 'активна вкладка';
  const result = runtime.resultSummary ? ` Результат: ${runtime.resultSummary}` : '';
  const error = runtime.lastError ? ` ${runtime.lastError}` : '';
  const cycles = Number(runtime.completedCycles || 0);
  const nextWake = Number(runtime.nextWakeAt || 0) > Date.now() ? ` Наступний запуск: ${new Date(runtime.nextWakeAt).toLocaleString()}.` : '';
  const capability = runtime.capabilityPermission ? ` Потрібна capability: ${runtime.capabilityPermission}.` : '';
  $('agent-status').textContent = `Стан: ${browserAgentStateLabel(state)}. Кроків: ${Number(runtime.stepCount || 0)}. Завершених циклів: ${cycles}. Поточна сторінка: ${url}.${nextWake}${capability}${result}${error}`;
  $('agent-usage').textContent = `Model calls: ${Number(runtime.modelCalls || 0)}; input tokens: ${Number(runtime.inputTokens || 0)}; output tokens: ${Number(runtime.outputTokens || 0)}; total tokens: ${Number(runtime.totalTokens || 0)}; орієнтовна вартість: $${Number(runtime.estimatedCostUsd || 0).toFixed(4)}.`;
  const history = Array.isArray(runtime.history) ? runtime.history : [];
  $('agent-history').textContent = history.length
    ? history.slice(-80).map((entry, index) => `${index + 1}. ${entry.at ? new Date(entry.at).toLocaleString() : ''} ${entry.type || 'event'}: ${entry.message || entry.action?.type || ''}`).join('\n')
    : 'Історії ще немає.';
  fillBrowserAgentPolicy(config);
}

function renderBrowserAgentList() {
  const list = $('agent-job-list');
  const selected = ui.selectedBrowserAgentId;
  list.replaceChildren();
  for (const job of ui.browserAgentJobs) {
    const option = document.createElement('option');
    option.value = job.id;
    option.textContent = `${job.config?.name || 'Завдання'} — ${browserAgentStateLabel(job.runtime?.runState)}`;
    option.selected = job.id === selected;
    list.append(option);
  }
}

async function loadBrowserAgentJobs({ selectId = '' } = {}) {
  try {
    const data = await core('LIST_BROWSER_AGENT_JOBS');
    ui.browserAgentJobs = Array.isArray(data?.jobs) ? data.jobs : [];
    ui.selectedBrowserAgentId = selectId || data?.selectedId || ui.selectedBrowserAgentId || ui.browserAgentJobs[0]?.id || '';
    if (ui.selectedBrowserAgentId && !ui.browserAgentJobs.some(job => job.id === ui.selectedBrowserAgentId)) ui.selectedBrowserAgentId = ui.browserAgentJobs[0]?.id || '';
    renderBrowserAgentList();
    const job = ui.browserAgentJobs.find(item => item.id === ui.selectedBrowserAgentId) || null;
    renderBrowserAgentJob(job);
  } catch (error) {
    $('agent-status').textContent = `Не вдалося завантажити Agent: ${error.message}`;
  }
}

async function selectBrowserAgentJob() {
  const id = $('agent-job-list').value;
  if (!id) { ui.selectedBrowserAgentId = ''; renderBrowserAgentJob(null); return; }
  try {
    const data = await core('SELECT_BROWSER_AGENT_JOB', { id });
    ui.selectedBrowserAgentId = id;
    renderBrowserAgentJob(data?.job || null);
    renderBrowserAgentList();
  } catch (error) { $('agent-status').textContent = `Не вдалося відкрити завдання: ${error.message}`; }
}

async function runBrowserAgentPrompt() {
  const goal = $('agent-prompt').value.trim();
  if (!goal) { $('agent-status').textContent = 'Опишіть, що Agent має зробити.'; $('agent-prompt').focus(); return; }
  try {
    $('agent-run-prompt-button').disabled = true;
    $('agent-status').textContent = 'Створюю завдання й запускаю Agent…';
    const created = await core('CREATE_BROWSER_AGENT_JOB', {
      name: browserAgentNameFromGoal(goal),
      goal,
      ...browserAgentPolicyFromForm(),
    });
    const id = created?.job?.id || created?.selectedId;
    if (!id) throw new Error('Core не повернув id завдання Agent.');
    ui.selectedBrowserAgentId = id;
    await core('START_BROWSER_AGENT_JOB', { id });
    await loadBrowserAgentJobs({ selectId: id });
    if (ui.selectedBrowserAgent?.runtime?.runState === 'WAITING_PERMISSION') {
      $('agent-permission-status').textContent = 'Потрібен дозвіл Chrome на сайт. Натисніть «Дозволити потрібний сайт».';
      $('agent-allow-current-site-button').focus();
    } else if (ui.selectedBrowserAgent?.runtime?.runState === 'WAITING_CAPABILITY') {
      $('agent-permission-status').textContent = `Потрібен додатковий дозвіл Chrome: ${ui.selectedBrowserAgent?.runtime?.capabilityPermission || 'capability'}.`;
      if (ui.selectedBrowserAgent?.runtime?.capabilityPermission === 'downloads') $('agent-allow-downloads-button').focus();
      else if (ui.selectedBrowserAgent?.runtime?.capabilityPermission === 'notifications') $('agent-allow-notifications-button').focus();
    } else {
      $('agent-status').focus?.();
    }
  } catch (error) {
    $('agent-status').textContent = `Agent не запущено: ${error.message}`;
  } finally { $('agent-run-prompt-button').disabled = false; }
}

async function browserAgentLifecycle(command) {
  const id = ui.selectedBrowserAgentId;
  if (!id) return;
  try {
    await core(command, { id });
    await loadBrowserAgentJobs({ selectId: id });
  } catch (error) { $('agent-status').textContent = `Команда Agent не виконана: ${error.message}`; }
}

async function sendBrowserAgentFollowUp() {
  const id = ui.selectedBrowserAgentId;
  const text = $('agent-follow-up').value.trim();
  if (!id || !text) { $('agent-follow-up').focus(); return; }
  try {
    await core('ADD_BROWSER_AGENT_INSTRUCTION', { id, text });
    $('agent-follow-up').value = '';
    await loadBrowserAgentJobs({ selectId: id });
    if (ui.selectedBrowserAgent?.runtime?.runState === 'RUNNING') await core('RUN_BROWSER_AGENT_BURST', { id });
    await loadBrowserAgentJobs({ selectId: id });
    announce('Уточнення передано Agent.');
  } catch (error) { $('agent-status').textContent = `Уточнення не передано: ${error.message}`; }
}

async function saveBrowserAgentPolicy() {
  const id = ui.selectedBrowserAgentId;
  if (!id) return;
  try {
    await core('UPDATE_BROWSER_AGENT_JOB', { id, config: browserAgentPolicyFromForm() });
    await loadBrowserAgentJobs({ selectId: id });
    announce('Політику Agent збережено.');
  } catch (error) { $('agent-status').textContent = `Політику не збережено: ${error.message}`; }
}

async function approveBrowserAgentAction() {
  const id = ui.selectedBrowserAgentId;
  if (!id) return;
  try {
    $('agent-approval-status').textContent = 'Підтверджую дію та продовжую Agent…';
    await core('APPROVE_BROWSER_AGENT_ACTION', { id });
    await loadBrowserAgentJobs({ selectId: id });
    announce('Дію Agent підтверджено.');
  } catch (error) { $('agent-approval-status').textContent = `Дію не підтверджено: ${error.message}`; }
}

async function rejectBrowserAgentAction() {
  const id = ui.selectedBrowserAgentId;
  if (!id) return;
  try {
    await core('REJECT_BROWSER_AGENT_ACTION', { id });
    await loadBrowserAgentJobs({ selectId: id });
    announce('Дію Agent відхилено; завдання поставлено на паузу.');
  } catch (error) { $('agent-approval-status').textContent = `Дію не відхилено: ${error.message}`; }
}

async function requestBrowserAgentPermission({ allSites = false } = {}) {
  try {
    if (!globalThis.chrome?.permissions?.request) throw new Error('Chrome permissions API недоступний.');
    let origins;
    if (allSites) origins = ['http://*/*', 'https://*/*'];
    else {
      const raw = ui.selectedBrowserAgent?.runtime?.currentUrl || ui.selectedBrowserAgent?.config?.startUrl || '';
      if (!raw) throw new Error('Спочатку запустіть Agent, щоб він визначив потрібний сайт.');
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Потрібен HTTP/HTTPS сайт.');
      origins = [`${url.origin}/*`];
    }
    const granted = await chrome.permissions.request({ origins });
    $('agent-permission-status').textContent = granted ? 'Дозвіл надано.' : 'Chrome не надав дозвіл.';
    if (granted && ui.selectedBrowserAgentId && ui.selectedBrowserAgent?.runtime?.runState === 'WAITING_PERMISSION') {
      await core('RESUME_BROWSER_AGENT_JOB', { id: ui.selectedBrowserAgentId });
      await loadBrowserAgentJobs({ selectId: ui.selectedBrowserAgentId });
    }
  } catch (error) { $('agent-permission-status').textContent = `Дозвіл не отримано: ${error.message}`; }
}

async function requestBrowserAgentCapability(permission) {
  try {
    if (!globalThis.chrome?.permissions?.request) throw new Error('Chrome permissions API недоступний.');
    const granted = await chrome.permissions.request({ permissions: [permission] });
    $('agent-permission-status').textContent = granted ? `Capability ${permission} дозволено.` : `Chrome не надав capability ${permission}.`;
    if (granted && ui.selectedBrowserAgentId && ui.selectedBrowserAgent?.runtime?.runState === 'WAITING_CAPABILITY'
      && ui.selectedBrowserAgent?.runtime?.capabilityPermission === permission) {
      await core('RESUME_BROWSER_AGENT_JOB', { id: ui.selectedBrowserAgentId });
      await loadBrowserAgentJobs({ selectId: ui.selectedBrowserAgentId });
    }
  } catch (error) { $('agent-permission-status').textContent = `Capability не дозволено: ${error.message}`; }
}

async function runBrowserAgentNow() {
  const id = ui.selectedBrowserAgentId;
  if (!id) return;
  try {
    await core('RUN_BROWSER_AGENT_BURST', { id });
    await loadBrowserAgentJobs({ selectId: id });
  } catch (error) { $('agent-status').textContent = `Agent cycle не виконано: ${error.message}`; }
}

async function deleteBrowserAgentJob() {
  const id = ui.selectedBrowserAgentId;
  if (!id) return;
  try {
    await core('DELETE_BROWSER_AGENT_JOB', { id });
    ui.selectedBrowserAgentId = '';
    await loadBrowserAgentJobs();
    announce('Завдання Agent видалено.');
  } catch (error) { $('agent-status').textContent = `Завдання не видалено: ${error.message}`; }
}

async function core(command, payload = {}) {
  if (!runtimeAvailable()) throw new Error('Core runtime is not available yet.');
  const response = await chrome.runtime.sendMessage({ channel: 'autopilot-ui', command, payload });
  if (!response || response.ok !== true) throw new Error(response?.error?.message || 'Core command failed.');
  return response.data;
}

function blankTask() {
  return { id: crypto.randomUUID(), enabled: true, label: '', url: '', promptOverride: '' };
}

function blankSession() {
  return {
    id: crypto.randomUUID(),
    version: 0,
    name: 'New session',
    promptMode: 'shared',
    urlMode: 'shared',
    sharedPrompt: '',
    defaultUniquePrompt: '',
    runMode: 'continuous',
    tasks: [blankTask()],
    configuredTaskCount: 1,
    minimumSendIntervalValue: 2,
    minimumSendIntervalUnit: 'minutes',
    minimumSendIntervalMinutes: 2,
    preSendDelaySeconds: 20,
    busyCheckDelaySeconds: 2,
    retryBackoffSeconds: 30,
    retryBackoffUnit: 'seconds',
    retryPolicy: 'safe',
    busyChatBehavior: 'skip-next',
    tabStrategy: 'open-close',
    runState: 'STOPPED',
    actionAvailability: { start: true, pause: false, resume: false, stop: false },
    status: {},
    log: [],
  };
}

function setAppStatus(text) {
  const status = $('app-status');
  if (status.textContent === text) return;
  status.textContent = text;
}
function setCommandResult(text) { $('command-result').textContent = text; }
function reportCommandResult(text) { setCommandResult(text); announce(text); }
function clone(value) { return structuredClone(value); }

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function storageRemove(key) {
  try { localStorage.removeItem(key); } catch { /* unavailable local draft storage */ }
}

function sessionListSignature(sessions) {
  return JSON.stringify((sessions || []).map(session => [session.id, session.name, session.displayRunState || session.runState, session.enabledTaskCount, session.completedTaskCount, session.successfulSendCount]));
}

async function loadSessions({ preserveFocus = true } = {}) {
  const active = preserveFocus ? document.activeElement : null;
  const activeId = preserveFocus ? active?.id || null : null;
  try {
    const data = await core('LIST_SESSIONS');
    const nextSessions = (Array.isArray(data?.sessions) ? data.sessions : []).filter(session => !session.managedKind);
    const nextSignature = sessionListSignature(nextSessions);
    ui.sessions = nextSessions;
    renderRemoteFallbackSessionOptions();
    if (nextSignature !== ui.sessionListSignature) {
      ui.sessionListSignature = nextSignature;
      renderSessionList();
    }
    setAppStatus('Connected to Core.');
    if (active?.isConnected) active.focus();
    else if (activeId) $(activeId)?.focus();
  } catch (error) {
    setAppStatus(error.message);
    if (!ui.sessionListSignature) renderSessionList();
  }
}

function renderSessionList() {
  const list = $('session-list');
  list.replaceChildren();
  for (const session of ui.sessions) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button'; open.id = `session-select-${session.id}`;
    open.textContent = session.name || 'Unnamed session';
    open.setAttribute('aria-label', `Open session ${session.name || 'Unnamed session'}`);
    open.addEventListener('click', () => openSession(session.id));
    const state = document.createElement('span');
    state.id = `session-state-${session.id}`; state.textContent = ` State: ${session.displayRunState || session.runState || 'STOPPED'}.`;
    const count = document.createElement('span');
    count.id = `session-enabled-count-${session.id}`; count.textContent = ` Successfully sent: ${session.successfulSendCount ?? 0}. Completed: ${session.completedTaskCount ?? 0}/${session.enabledTaskCount ?? 0}. Remaining: ${session.remainingTaskCount ?? session.enabledTaskCount ?? 0}.`;
    const sessionName = session.name || 'Unnamed session';
    const rename = button(`session-rename-${session.id}`, 'Rename', () => renameSession(session.id));
    rename.setAttribute('aria-label', `Rename session ${sessionName}`);
    const duplicate = button(`session-duplicate-${session.id}`, 'Duplicate', () => duplicateSession(session.id));
    duplicate.setAttribute('aria-label', `Duplicate session ${sessionName}`);
    const del = button(`session-delete-${session.id}`, 'Delete', (event) => openDeleteDialog(session.id, event.currentTarget));
    del.setAttribute('aria-label', `Delete session ${sessionName}`);
    li.append(open, state, count, rename, duplicate, del);
    list.append(li);
  }
  const total = ui.sessions.length;
  const running = ui.sessions.filter(s => ['RUNNING','RECOVERING'].includes(s.runState)).length;
  const completed = ui.sessions.filter(s => s.isCompleted).length;
  const paused = ui.sessions.filter(s => s.runState === 'PAUSED').length;
  const errors = ui.sessions.filter(s => s.runState === 'ERROR').length;
  const sent = ui.sessions.reduce((sum, s) => sum + Number(s.successfulSendCount || 0), 0);
  if ($('session-overview')) $('session-overview').textContent = `Sessions: ${total}. Running: ${running}. Completed: ${completed}. Paused: ${paused}. Errors: ${errors}. Successfully sent total: ${sent}.`;
  syncCurrentSessionMarker();
}

function syncCurrentSessionMarker() {
  document.querySelectorAll('#session-list [aria-current="page"]').forEach((element) => element.removeAttribute('aria-current'));
  if (ui.selectedSessionId) $(`session-select-${ui.selectedSessionId}`)?.setAttribute('aria-current', 'page');
}

function button(id, text, handler) {
  const b = document.createElement('button'); b.id = id; b.type = 'button'; b.textContent = text; b.addEventListener('click', handler); return b;
}

function portableDraftConfig(session) {
  return {
    id: session.id,
    version: session.version,
    name: session.name,
    promptMode: session.promptMode,
    urlMode: session.urlMode,
    sharedPrompt: session.sharedPrompt,
    defaultUniquePrompt: session.defaultUniquePrompt,
    runMode: session.runMode,
    tasks: clone(session.tasks || []),
    configuredTaskCount: Number(session.configuredTaskCount || session.tasks?.length || 1),
    minimumSendIntervalValue: session.minimumSendIntervalValue ?? session.minimumSendIntervalMinutes ?? 2,
    minimumSendIntervalUnit: session.minimumSendIntervalUnit || 'minutes',
    minimumSendIntervalMinutes: session.minimumSendIntervalMinutes,
    preSendDelaySeconds: session.preSendDelaySeconds,
    busyCheckDelaySeconds: session.busyCheckDelaySeconds,
    retryBackoffSeconds: session.retryBackoffSeconds,
    retryBackoffUnit: session.retryBackoffUnit,
    retryPolicy: session.retryPolicy,
    busyChatBehavior: session.busyChatBehavior,
    tabStrategy: session.tabStrategy,
  };
}

function restoreDraft(canonical) {
  const raw = storageGet(`${DRAFT_KEY_PREFIX}${canonical.id}`);
  if (!raw) return canonical;
  try {
    const saved = JSON.parse(raw);
    if (saved?.baseVersion !== canonical.version || saved?.config?.id !== canonical.id) {
      storageRemove(`${DRAFT_KEY_PREFIX}${canonical.id}`);
      return canonical;
    }
    const config = saved.config;
    $('draft-status').textContent = 'Unsaved draft restored from this browser.';
    return {
      ...canonical,
      ...clone(config),
      version: canonical.version,
      runState: canonical.runState,
      actionAvailability: canonical.actionAvailability,
      status: canonical.status,
      log: canonical.log,
    };
  } catch {
    storageRemove(`${DRAFT_KEY_PREFIX}${canonical.id}`);
    return canonical;
  }
}

function clearDraft(sessionId) {
  if (!sessionId) return;
  storageRemove(`${DRAFT_KEY_PREFIX}${sessionId}`);
  if (ui.selectedSessionId === sessionId) $('draft-status').textContent = 'No unsaved draft changes.';
}

let draftSaveTimer = null;
function persistCurrentDraft() {
  if (!ui.selected || $('session-editor').hidden) return;
  const selected = collectEditor();
  const saved = {
    baseVersion: selected.version,
    savedAt: Date.now(),
    config: portableDraftConfig(selected),
  };
  if (storageSet(`${DRAFT_KEY_PREFIX}${selected.id}`, JSON.stringify(saved))) {
    $('draft-status').textContent = 'Unsaved changes are protected locally in this browser.';
  }
}
function scheduleDraftPersistence() {
  if (!ui.selected) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(persistCurrentDraft, DRAFT_SAVE_DELAY_MS);
}

async function openSession(sessionId) {
  try {
    const data = await core('GET_SESSION', { sessionId });
    ui.selectedSessionId = sessionId;
    storageSet(LAST_SESSION_KEY, sessionId);
    syncCurrentSessionMarker();
    const canonical = clone(data.session);
    ui.selected = restoreDraft(canonical);
    renderEditor();
    $('session-heading').focus();
  } catch (error) { setAppStatus(error.message); announce(error.message); }
}

let lastRuntimeSignature = '';
async function refreshSelectedSessionStatus(sessionId) {
  if (!sessionId || sessionId !== ui.selectedSessionId || !ui.selected) return;
  try {
    const data = await core('GET_SESSION', { sessionId });
    if (sessionId !== ui.selectedSessionId || !data?.session) return;
    const latest = clone(data.session);
    ui.selected.version = latest.version;
    ui.selected.runState = latest.runState;
    ui.selected.actionAvailability = latest.actionAvailability;
    ui.selected.status = latest.status;
    ui.selected.log = latest.log;
    const signature = JSON.stringify([
      latest.version,
      latest.runState,
      latest.actionAvailability,
      latest.status,
      latest.log?.length || 0,
      latest.log?.at?.(-1)?.at || 0,
      latest.log?.at?.(-1)?.message || '',
    ]);
    if (signature !== lastRuntimeSignature) {
      lastRuntimeSignature = signature;
      renderStatus();
      renderLog();
      renderActions();
    }
  } catch (error) {
    setAppStatus(error.message);
    announce(error.message);
  }
}

function inferUrlMode(session) {
  if (session?.urlMode === 'shared' || session?.urlMode === 'unique') return session.urlMode;
  const urls = (session?.tasks || []).map((task) => String(task.url || '').trim()).filter(Boolean);
  if (urls.length <= 1) return 'shared';
  return new Set(urls).size === 1 ? 'shared' : 'unique';
}

function taskConfigurationModeFor(session) {
  const urlMode = inferUrlMode(session);
  const promptMode = session?.promptMode === 'unique' ? 'unique' : 'shared';
  if (urlMode === 'shared' && promptMode === 'shared') return 'same-url-shared-prompt';
  if (urlMode === 'shared' && promptMode === 'unique') return 'same-url-unique-prompts';
  if (urlMode === 'unique' && promptMode === 'shared') return 'unique-urls-shared-prompt';
  return 'unique-urls-unique-prompts';
}

function taskModeParts(mode = taskConfigurationModeFor(ui.selected)) {
  return {
    urlMode: mode.startsWith('same-url-') ? 'shared' : 'unique',
    promptMode: mode.endsWith('-shared-prompt') ? 'shared' : 'unique',
  };
}

function selectedTaskConfigurationMode() {
  return document.querySelector('input[name="taskConfigurationMode"]:checked')?.value
    || taskConfigurationModeFor(ui.selected);
}

function resizeTasks(rawCount) {
  if (!ui.selected) return;
  const requested = Math.min(MAX_TASKS, Math.max(1, Math.trunc(Number(rawCount) || 1)));
  const mode = selectedTaskConfigurationMode();
  const { urlMode, promptMode } = taskModeParts(mode);
  const compactShared = urlMode === 'shared' && promptMode === 'shared';
  const physicalCount = compactShared ? 1 : Math.min(MAX_PHYSICAL_TASKS, requested);
  const sharedUrl = $('shared-task-url')?.value || ui.selected.tasks?.[0]?.url || '';
  while (ui.selected.tasks.length < physicalCount) {
    const task = blankTask();
    if (urlMode === 'shared') task.url = sharedUrl;
    ui.selected.tasks.push(task);
  }
  if (ui.selected.tasks.length > physicalCount) ui.selected.tasks.length = physicalCount;
  ui.selected.tasks.forEach((task) => { task.enabled = true; });
  ui.selected.configuredTaskCount = compactShared ? requested : physicalCount;
  if ($('task-count')) $('task-count').value = String(ui.selected.configuredTaskCount);
}

function syncTaskModeVisibility() {
  const mode = selectedTaskConfigurationMode();
  const parts = taskModeParts(mode);
  if (ui.selected) {
    ui.selected.urlMode = parts.urlMode;
    ui.selected.promptMode = parts.promptMode;
  }
  $('shared-url-container').hidden = parts.urlMode !== 'shared';
  $('bulk-url-region').hidden = parts.urlMode !== 'unique';
  $('shared-prompt-container').hidden = parts.promptMode !== 'shared';
  $('unique-default-container').hidden = parts.promptMode !== 'unique';
}

function renderEditor() {
  if (!ui.selected) return;
  $('empty-state').hidden = true; $('session-editor').hidden = false;
  $('session-heading').textContent = `Session: ${ui.selected.name || 'Unnamed session'}`;
  $('session-name').value = ui.selected.name || '';
  ui.selected.urlMode = inferUrlMode(ui.selected);
  const mode = taskConfigurationModeFor(ui.selected);
  const modeRadio = document.querySelector(`input[name="taskConfigurationMode"][value="${CSS.escape(mode)}"]`);
  if (modeRadio) modeRadio.checked = true;
  $('shared-task-url').value = ui.selected.tasks?.[0]?.url || '';
  $('shared-prompt').value = ui.selected.sharedPrompt || '';
  $('default-unique-prompt').value = ui.selected.defaultUniquePrompt || '';
  $('task-count').value = String(Math.max(1, Number(ui.selected.configuredTaskCount || ui.selected.tasks?.length || 1)));
  $('run-mode-one-pass').checked = ui.selected.runMode === 'one-pass';
  $('run-mode-continuous').checked = ui.selected.runMode !== 'one-pass';
  const intervalUnit = ui.selected.minimumSendIntervalUnit === 'seconds' ? 'seconds' : 'minutes';
  $('minimum-send-interval-unit').value = intervalUnit;
  $('minimum-send-interval').value = ui.selected.minimumSendIntervalValue ?? (intervalUnit === 'seconds' ? (ui.selected.minimumSendIntervalSeconds ?? 120) : (ui.selected.minimumSendIntervalMinutes ?? 2));
  syncMinimumSendIntervalBounds();
  $('pre-send-delay').value = ui.selected.preSendDelaySeconds ?? 20;
  $('busy-check-delay').value = ui.selected.busyCheckDelaySeconds ?? 2;
  const retryBackoffSeconds = ui.selected.retryBackoffSeconds ?? 30;
  const retryBackoffUnit = ui.selected.retryBackoffUnit
    || (retryBackoffSeconds >= 60 && retryBackoffSeconds % 60 === 0 ? 'minutes' : 'seconds');
  $('retry-backoff-unit').value = retryBackoffUnit;
  $('retry-backoff').value = retryBackoffUnit === 'minutes' ? retryBackoffSeconds / 60 : retryBackoffSeconds;
  syncRetryBackoffBounds();
  document.querySelector(`input[name="retryPolicy"][value="${CSS.escape(ui.selected.retryPolicy || 'safe')}"]`)?.click();
  $('busy-chat-behavior').value = ui.selected.busyChatBehavior || 'skip-next';
  document.querySelector(`input[name="tabStrategy"][value="${CSS.escape(ui.selected.tabStrategy || 'keep-open')}"]`)?.click();
  syncTaskModeVisibility();
  renderTasks(); renderStatus(); renderLog(); renderActions();
}

function renderTasks(focusTaskId = null) {
  const list = $('task-list'); list.replaceChildren();
  const mode = selectedTaskConfigurationMode();
  const { urlMode, promptMode } = taskModeParts(mode);
  const physicalCount = ui.selected.tasks.length;
  const logicalCount = Math.max(1, Number(ui.selected.configuredTaskCount || physicalCount));
  $('generated-task-summary').textContent = urlMode === 'shared' && promptMode === 'shared'
    ? `${logicalCount} logical cycle${logicalCount === 1 ? '' : 's'} will use one shared ChatGPT link and one shared prompt. Only ${physicalCount} physical task definition is stored, so large counts do not create millions of fields.`
    : `${physicalCount} physical task editor${physicalCount === 1 ? '' : 's'} configured automatically. Distinct URL/prompt modes are limited to ${MAX_PHYSICAL_TASKS}.`;

  const count = physicalCount;

  if (urlMode === 'shared' && promptMode === 'shared') return;

  ui.selected.tasks.forEach((task, index) => {
    const ordinal = index + 1;
    const li = document.createElement('li'); li.id = `task-${task.id}`;
    const fieldset = document.createElement('fieldset'); fieldset.className = 'task-card';
    const legend = document.createElement('legend'); legend.id = `task-heading-${task.id}`; legend.textContent = `Task ${ordinal}`;
    fieldset.append(legend);
    if (urlMode === 'unique') {
      const urlInput = labeledInput(`task-url-${task.id}`, `Task ${ordinal} ChatGPT URL`, 'url', task.url || '', (value) => { task.url = value; scheduleDraftPersistence(); });
      urlInput.input.autocomplete = 'off'; urlInput.input.spellcheck = false;
      fieldset.append(urlInput.wrapper);
    }
    if (promptMode === 'unique') {
      const prompt = labeledTextarea(`task-prompt-${task.id}`, `Prompt for Task ${ordinal}`, task.promptOverride || '', (value) => { task.promptOverride = value; scheduleDraftPersistence(); });
      fieldset.append(prompt.wrapper);
    }
    li.append(fieldset); list.append(li);
  });
  if (focusTaskId) {
    const target = urlMode === 'unique' ? $(`task-url-${focusTaskId}`) : $(`task-prompt-${focusTaskId}`);
    target?.focus();
  }
}

function labeledInput(id, labelText, type, value, onInput) {
  const wrapper = document.createElement('div'); const label = document.createElement('label'); label.htmlFor = id; label.textContent = labelText;
  const input = document.createElement('input'); input.id = id; input.type = type; input.value = value; input.addEventListener('input', () => onInput(input.value)); wrapper.append(label, input); return { wrapper, input };
}
function labeledTextarea(id, labelText, value, onInput) {
  const wrapper = document.createElement('div'); const label = document.createElement('label'); label.htmlFor = id; label.textContent = labelText;
  const input = document.createElement('textarea'); input.id = id; input.rows = 6; input.value = value; input.addEventListener('input', () => onInput(input.value)); wrapper.append(label, input); return { wrapper, input };
}

function runBulkUrlImport(replace) {
  if (!ui.selected || inferUrlMode(ui.selected) !== 'unique') return;
  const urls = extractChatGptUrls($('bulk-task-urls').value).slice(0, MAX_PHYSICAL_TASKS);
  if (!urls.length) {
    $('bulk-task-result').textContent = 'No valid ChatGPT links were recognized.';
    $('bulk-task-result').focus();
    return;
  }
  const existing = replace ? [] : ui.selected.tasks;
  const result = mergeBulkUrls(existing, urls, { replace, maxTasks: MAX_PHYSICAL_TASKS });
  if (!result.tasks.length) return;
  ui.selected.tasks = result.tasks;
  ui.selected.tasks.forEach((task) => { task.enabled = true; });
  ui.selected.configuredTaskCount = ui.selected.tasks.length;
  $('task-count').value = String(ui.selected.configuredTaskCount);
  renderTasks();
  scheduleDraftPersistence();
  const truncated = result.truncated ? ` ${result.truncated} link(s) did not fit the ${MAX_PHYSICAL_TASKS}-physical-task limit.` : '';
  $('bulk-task-result').textContent = `${result.recognized} unique ChatGPT link(s) recognized; ${result.added} new task(s) created.${truncated}`;
  $('bulk-task-result').focus();
}

function collectEditor() {
  const s = ui.selected;
  s.name = $('session-name').value.trim();
  const mode = selectedTaskConfigurationMode();
  const parts = taskModeParts(mode);
  s.urlMode = parts.urlMode;
  s.promptMode = parts.promptMode;
  resizeTasks($('task-count').value);
  if (s.urlMode === 'shared') {
    const sharedUrl = $('shared-task-url').value.trim();
    s.tasks.forEach((task) => { task.url = sharedUrl; task.enabled = true; });
  } else {
    s.tasks.forEach((task) => { task.enabled = true; });
  }
  s.sharedPrompt = $('shared-prompt').value;
  s.defaultUniquePrompt = $('default-unique-prompt').value;
  s.runMode = document.querySelector('input[name="runMode"]:checked')?.value || 'continuous';
  s.configuredTaskCount = Number($('task-count').value);
  s.minimumSendIntervalValue = Number($('minimum-send-interval').value);
  s.minimumSendIntervalUnit = $('minimum-send-interval-unit').value === 'seconds' ? 'seconds' : 'minutes';
  s.minimumSendIntervalMinutes = s.minimumSendIntervalValue * (s.minimumSendIntervalUnit === 'seconds' ? 1 / 60 : 1);
  s.preSendDelaySeconds = Number($('pre-send-delay').value);
  s.busyCheckDelaySeconds = Number($('busy-check-delay').value);
  const retryBackoffUnit = $('retry-backoff-unit').value === 'minutes' ? 'minutes' : 'seconds';
  const retryBackoffAmount = Number($('retry-backoff').value);
  s.retryBackoffSeconds = retryBackoffAmount * (retryBackoffUnit === 'minutes' ? 60 : 1);
  s.retryBackoffUnit = retryBackoffUnit;
  s.retryPolicy = document.querySelector('input[name="retryPolicy"]:checked')?.value || 'safe';
  s.busyChatBehavior = $('busy-chat-behavior').value;
  s.tabStrategy = document.querySelector('input[name="tabStrategy"]:checked')?.value || 'keep-open';
  return s;
}

function validate(session) {
  clearErrors(); const errors = [];
  if (!session.name) errors.push(['session-name', 'Session name is required.']);
  const logicalTaskCount = Number(session.configuredTaskCount || session.tasks.length);
  const compactShared = session.urlMode === 'shared' && session.promptMode === 'shared';
  if (!(logicalTaskCount >= 1 && logicalTaskCount <= MAX_TASKS && Number.isInteger(logicalTaskCount))) errors.push(['task-count', `Task / cycle count must be a whole number between 1 and ${MAX_TASKS}.`]);
  if (!compactShared && logicalTaskCount > MAX_PHYSICAL_TASKS) errors.push(['task-count', `Separate URL/prompt modes support up to ${MAX_PHYSICAL_TASKS} physical tasks. Use one shared URL + one shared prompt for up to ${MAX_TASKS} cycles.`]);
  if (!(session.tasks.length >= 1 && session.tasks.length <= MAX_PHYSICAL_TASKS)) errors.push(['task-count', `Physical task count must be between 1 and ${MAX_PHYSICAL_TASKS}.`]);
  const hasEnabledTasks = session.tasks.some((task) => task.enabled);
  const sharedUrlMode = session.urlMode === 'shared';
  if (sharedUrlMode && hasEnabledTasks) {
    const url = session.tasks[0]?.url || '';
    if (!url) errors.push(['shared-task-url', 'ChatGPT link is required.']);
    else { try { const u = new URL(url); if (u.protocol !== 'https:' || !['chatgpt.com','www.chatgpt.com'].includes(u.hostname)) throw new Error(); } catch { errors.push(['shared-task-url', 'Use a valid https://chatgpt.com URL.']); } }
  }
  session.tasks.forEach((task, i) => {
    if (!task.enabled) return;
    if (!sharedUrlMode) {
      if (!task.url) errors.push([`task-url-${task.id}`, `Task ${i + 1} URL is required.`]);
      else { try { const u = new URL(task.url); if (u.protocol !== 'https:' || !['chatgpt.com','www.chatgpt.com'].includes(u.hostname)) throw new Error(); } catch { errors.push([`task-url-${task.id}`, `Task ${i + 1} must use a valid https://chatgpt.com URL.`]); } }
    }
    if (session.promptMode === 'unique' && !task.promptOverride.trim()) errors.push([`task-prompt-${task.id}`, `Prompt for Task ${i + 1} is required.`]);
  });
  if (hasEnabledTasks && session.promptMode === 'shared' && !session.sharedPrompt.trim()) errors.push(['shared-prompt', 'Shared prompt is required.']);
  const intervalUnit = session.minimumSendIntervalUnit === 'seconds' ? 'seconds' : 'minutes';
  const intervalMax = intervalUnit === 'seconds' ? 86400 : 1440;
  if (!(session.minimumSendIntervalValue >= 1 && session.minimumSendIntervalValue <= intervalMax)) errors.push(['minimum-send-interval', `Minimum send interval must be between 1 and ${intervalMax} ${intervalUnit}.`]);
  if (!(session.preSendDelaySeconds >= 1 && session.preSendDelaySeconds <= 30)) errors.push(['pre-send-delay', 'Pre-send delay must be between 1 and 30 seconds.']);
  if (!(session.busyCheckDelaySeconds >= 1 && session.busyCheckDelaySeconds <= 30)) errors.push(['busy-check-delay', 'Busy-check delay must be between 1 and 30 seconds.']);
  if (!(session.retryBackoffSeconds >= 5 && session.retryBackoffSeconds <= 3600)) errors.push(['retry-backoff', 'Retry backoff must be between 5 seconds and 60 minutes.']);
  errors.forEach(([id, message]) => markError(id, message));
  if (errors.length > 1) {
    const summary = $('form-error-summary'); summary.hidden = false; summary.className = 'error-summary';
    const heading = document.createElement('h3'); heading.textContent = 'Fix these configuration errors';
    const ul = document.createElement('ul'); errors.forEach(([id, message]) => { const li = document.createElement('li'); const a = document.createElement('a'); a.href = `#${id}`; a.textContent = message; a.addEventListener('click', (e) => { e.preventDefault(); $(id)?.focus(); }); li.append(a); ul.append(li); });
    summary.replaceChildren(heading, ul); summary.focus();
  } else if (errors.length === 1) $(errors[0][0])?.focus();
  return errors;
}
function markError(id, message) {
  const field = $(id); if (!field) return; const error = document.createElement('p'); error.id = `${id}-error`; error.className = 'field-error'; error.textContent = message; field.setAttribute('aria-invalid', 'true');
  const existing = field.getAttribute('aria-describedby'); field.setAttribute('aria-describedby', [existing, error.id].filter(Boolean).join(' ')); field.insertAdjacentElement('afterend', error);
}
function clearErrors() {
  document.querySelectorAll('.field-error').forEach((e) => e.remove()); document.querySelectorAll('[aria-invalid="true"]').forEach((e) => { e.removeAttribute('aria-invalid'); const d = (e.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && !x.endsWith('-error')); d.length ? e.setAttribute('aria-describedby', d.join(' ')) : e.removeAttribute('aria-describedby'); }); $('form-error-summary').hidden = true; $('form-error-summary').replaceChildren();
}

async function saveSession() {
  clearTimeout(draftSaveTimer);
  const session = collectEditor(); const errors = validate(session); if (errors.length) { persistCurrentDraft(); announce(`${errors.length} configuration error${errors.length === 1 ? '' : 's'}.`); return; }
  try {
    const data = await core('UPDATE_SESSION', { sessionId: session.id, expectedVersion: session.version, config: session });
    clearDraft(session.id);
    ui.selected = clone(data.session); announce('Session saved.'); await loadSessions(); renderEditor();
  } catch (error) { persistCurrentDraft(); setAppStatus(error.message); announce(error.message); }
}

async function createSession() {
  try {
    const data = await core('CREATE_SESSION', { config: blankSession() });
    await loadSessions({ preserveFocus: false });
  await loadOrchestrationV2Status();
  await loadScenarioWork();
  await loadBrowserAgentJobs();
  await loadRemoteDispatchStatus();
    await openSession(data.session.id);
    $('session-name').focus();
    $('session-name').select();
    announce('Session created.');
  } catch (error) { setAppStatus(error.message); announce(error.message); }
}
async function renameSession(id) { await openSession(id); $('session-name').focus(); $('session-name').select(); announce('Edit the session name, then save.'); }
async function duplicateSession(id) { try { const data = await core('DUPLICATE_SESSION', { sessionId: id }); await loadSessions({ preserveFocus: false }); await openSession(data.session.id); announce('Session duplicated.'); } catch (e) { setAppStatus(e.message); announce(e.message); } }

function openDeleteDialog(sessionId, returnFocus) {
  const session = ui.sessions.find((candidate) => candidate.id === sessionId);
  const sessionName = session?.name || 'Unnamed session';
  ui.pendingDeleteSessionId = sessionId;
  ui.deleteReturnFocus = returnFocus;
  $('delete-dialog-description').textContent = `Delete session ${sessionName}. This removes the selected session configuration.`;
  $('confirm-delete-button').setAttribute('aria-label', `Delete session ${sessionName}`);
  const d = $('delete-dialog'); d.hidden = false; $('confirm-delete-button').focus();
}
function closeDeleteDialog({ restoreFocus = true } = {}) {
  $('delete-dialog').hidden = true;
  $('confirm-delete-button').removeAttribute('aria-label');
  const target = ui.deleteReturnFocus;
  ui.pendingDeleteSessionId = null;
  ui.deleteReturnFocus = null;
  if (restoreFocus && target?.isConnected) target.focus();
}
function deleteFocusTargetId(sessionId) {
  const index = ui.sessions.findIndex((session) => session.id === sessionId);
  const next = index >= 0 ? ui.sessions[index + 1] || ui.sessions[index - 1] : null;
  return next ? `session-select-${next.id}` : 'create-session-button';
}
async function confirmDelete() {
  const id = ui.pendingDeleteSessionId;
  const focusTargetId = deleteFocusTargetId(id);
  try {
    await core('DELETE_SESSION', { sessionId: id });
    clearDraft(id);
    closeDeleteDialog({ restoreFocus: false });
    if (ui.selectedSessionId === id) { ui.selectedSessionId = null; ui.selected = null; storageRemove(LAST_SESSION_KEY); $('session-editor').hidden = true; $('empty-state').hidden = false; }
    await loadSessions({ preserveFocus: false });
  await loadRemoteDispatchStatus();
    ($(focusTargetId) || $('create-session-button')).focus();
    announce('Session deleted.');
  } catch (e) { setAppStatus(e.message); announce(e.message); }
}

function trapDialog(event) {
  if ($('delete-dialog').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeDeleteDialog(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [$('confirm-delete-button'), $('cancel-delete-button')]; const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

async function action(command, label) {
  if (!ui.selectedSessionId) return;
  try {
    const data = await core(command, { sessionId: ui.selectedSessionId });
    ui.selected = clone(data.session);
    renderEditor();
    const state = ui.selected?.runState || 'UNKNOWN';
    reportCommandResult(`Core acknowledged ${label}. Current state: ${state}.`);
    focusAfterLifecycleSuccess(command, $);
  } catch (error) {
    setAppStatus(error.message);
    reportCommandResult(`Command failed: ${error.message}`);
  }
}

async function masterAction(command, label, expectedMasterPaused) {
  try {
    const data = await core(command);
    if (data?.masterPaused !== expectedMasterPaused) throw new Error('Core returned an unexpected master-pause state.');
    await loadSessions();
    if (ui.selectedSessionId) await refreshSelectedSessionStatus(ui.selectedSessionId);
    reportCommandResult(`Core acknowledged ${label}.`);
  } catch (error) {
    setAppStatus(error.message);
    reportCommandResult(`Command failed: ${error.message}`);
  }
}

function renderActions() {
  const a = ui.selected.actionAvailability || {};
  $('start-session-button').disabled = !a.start;
  $('pause-session-button').disabled = !a.pause;
  $('resume-session-button').disabled = !a.resume;
  $('stop-session-button').disabled = !a.stop;
}
function renderStatus() {
  const s = ui.selected.status || {}; const dl = document.createElement('dl');
  const recovery = $('uncertain-recovery');
  const operationId = s.uncertainOperationId || '';
  if (recovery.dataset.operationId !== operationId) {
    recovery.dataset.operationId = operationId;
    $('uncertain-confirm').checked = false;
    $('uncertain-retry').disabled = true;
    $('uncertain-skip').disabled = true;
  }
  recovery.hidden = !operationId;
  [
    ['Session state', s.displayRunState || ui.selected.runState || 'STOPPED'],
    ['Successfully sent', String(s.successfulSendCount ?? 0)],
    ['Completed tasks', `${s.completedTaskCount ?? 0} / ${s.enabledTaskCount ?? ui.selected.tasks.filter((t) => t.enabled).length}`],
    ['Remaining tasks', String(s.remainingTaskCount ?? 0)],
    ['Completed time', s.isCompleted ? formatTime(s.completedAt) : 'Not available'],
    ['Current task', s.currentTaskLabel || s.currentTaskUrl || 'None'],
    ['Current task status', s.currentTaskStatus || 'IDLE'],
    ['Operation phase', s.operationPhase || 'NONE'],
    ['Last action', s.lastAction || 'None'],
    ['Last action time', formatTime(s.lastActionAt)],
    ['Last successful send', formatTime(s.lastSuccessfulSendAt)],
    ['Next allowed Send', formatTime(s.nextAllowedSendAt)],
    ['Retry or backoff until', formatTime(s.currentTaskRetryAt)],
    ['Manual review reason', s.currentTaskManualReviewReason || 'None'],
    ['Enabled tasks', String(s.enabledTaskCount ?? ui.selected.tasks.filter((t) => t.enabled).length)],
    ['Last error', s.lastError || 'None']
  ].forEach(([k,v]) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); });
  $('session-status-region').replaceChildren(dl);
}
function renderLog() {
  const entries = ui.selected.log || [];
  const visible = entries.slice(-VISIBLE_LOG_LIMIT);
  $('session-log-count').textContent = `${visible.length} of ${entries.length} Core log entr${entries.length === 1 ? 'y' : 'ies'} shown.`;
  $('session-log-region').textContent = visible.map((entry) => typeof entry === 'string' ? translateText(entry) : `${formatTime(entry.at)} — ${translateText(entry.message)}`).join('\n');
}

function onTaskConfigurationModeChange() {
  if (!ui.selected) return;
  const mode = selectedTaskConfigurationMode();
  const parts = taskModeParts(mode);
  ui.selected.urlMode = parts.urlMode;
  ui.selected.promptMode = parts.promptMode;
  resizeTasks($('task-count').value);
  if (parts.urlMode === 'shared') {
    const sharedUrl = $('shared-task-url').value || ui.selected.tasks.find((task) => task.url)?.url || '';
    $('shared-task-url').value = sharedUrl;
    ui.selected.tasks.forEach((task) => { task.url = sharedUrl; });
  }
  syncTaskModeVisibility();
  renderTasks();
  scheduleDraftPersistence();
  announce('Task configuration mode updated.');
}
function onTaskCountChange() {
  if (!ui.selected) return;
  resizeTasks($('task-count').value);
  if (inferUrlMode(ui.selected) === 'shared') {
    const sharedUrl = $('shared-task-url').value;
    ui.selected.tasks.forEach((task) => { task.url = sharedUrl; });
  }
  renderTasks();
  scheduleDraftPersistence();
  const logicalCount = Number(ui.selected.configuredTaskCount || ui.selected.tasks.length);
  announce(`${logicalCount} task${logicalCount === 1 ? '' : 's'} / cycle${logicalCount === 1 ? '' : 's'} configured.`);
}
function onSharedUrlInput() {
  if (!ui.selected) return;
  const value = $('shared-task-url').value;
  ui.selected.tasks.forEach((task) => { task.url = value; task.enabled = true; });
  scheduleDraftPersistence();
}
function syncMinimumSendIntervalBounds() {
  const seconds = $('minimum-send-interval-unit').value === 'seconds';
  const input = $('minimum-send-interval');
  input.min = '1';
  input.max = seconds ? '86400' : '1440';
  input.step = '1';
}
function onMinimumSendIntervalUnitChange() {
  syncMinimumSendIntervalBounds();
  scheduleDraftPersistence();
}

function syncRetryBackoffBounds() {
  const minutes = $('retry-backoff-unit').value === 'minutes';
  const input = $('retry-backoff');
  input.min = minutes ? '1' : '5';
  input.max = minutes ? '60' : '3600';
  input.step = '1';
}
function onRetryBackoffUnitChange() {
  const previousUnit = ui.selected?.retryBackoffUnit === 'minutes' ? 'minutes' : 'seconds';
  const nextUnit = $('retry-backoff-unit').value === 'minutes' ? 'minutes' : 'seconds';
  const amount = Number($('retry-backoff').value);
  const seconds = Number.isFinite(amount) ? amount * (previousUnit === 'minutes' ? 60 : 1) : 30;
  const nextAmount = nextUnit === 'minutes' ? Math.max(1, Math.ceil(seconds / 60)) : Math.max(5, seconds);
  $('retry-backoff').value = String(nextAmount);
  if (ui.selected) {
    ui.selected.retryBackoffUnit = nextUnit;
    ui.selected.retryBackoffSeconds = nextAmount * (nextUnit === 'minutes' ? 60 : 1);
  }
  syncRetryBackoffBounds();
  scheduleDraftPersistence();
  announce(`Retry/backoff unit changed to ${nextUnit}. Current wait is ${nextAmount} ${nextUnit}.`);
}
function applyDefaultPrompt() { const value = $('default-unique-prompt').value; let changed = 0; ui.selected.tasks.forEach((task) => { if (!task.promptOverride.trim()) { task.promptOverride = value; changed++; } }); renderTasks(); scheduleDraftPersistence(); announce(`Default prompt applied to ${changed} empty task${changed === 1 ? '' : 's'}.`); }

function setPortableImportEnabled(enabled, allowStart = false) {
  $('import-profile-button').disabled = !enabled;
  $('import-profile-start-button').disabled = !enabled || !allowStart;
}

async function onPortableProfileFileChange() {
  ui.pendingPortableProfile = null;
  ui.pendingPortablePreview = null;
  setPortableImportEnabled(false);
  const file = $('portable-profile-file').files?.[0];
  if (!file) {
    $('portable-profile-preview').textContent = 'No configuration file selected.';
    return;
  }
  try {
    const profile = parsePortableJson(await file.text());
    const data = await core('PREVIEW_PORTABLE_PROFILE', { profile });
    ui.pendingPortableProfile = profile;
    ui.pendingPortablePreview = data.preview;
    const preview = data.preview;
    $('portable-profile-preview').textContent = `Profile ${preview.profileName}: ${preview.sessionCount} Session(s), ${preview.taskCount} Task(s), ${preview.autoStartSessionCount} marked for automatic start.`;
    setPortableImportEnabled(true, preview.autoStartSessionCount > 0);
    $('portable-profile-preview').focus();
  } catch (error) {
    $('portable-profile-preview').textContent = `Configuration file error: ${error.message}`;
    $('portable-profile-preview').focus();
  }
}

async function importPortableProfile(confirmAutoStart) {
  if (!ui.pendingPortableProfile) return;
  try {
    const data = await core('IMPORT_PORTABLE_PROFILE', {
      profile: ui.pendingPortableProfile,
      confirmAutoStart,
    });
    const importedIds = data?.summary?.importedSessionIds || [];
    for (const id of importedIds) clearDraft(id);
    ui.sessionListSignature = '';
    await loadSessions({ preserveFocus: false });
  await loadRemoteDispatchStatus();
    if (importedIds[0]) await openSession(importedIds[0]);
    const started = data?.summary?.startedSessionIds?.length || 0;
    reportCommandResult(`Portable configuration imported: ${importedIds.length} Session(s). ${started} Session(s) started.`);
  } catch (error) {
    setAppStatus(error.message);
    reportCommandResult(`Import failed: ${error.message}`);
  }
}

function safeFileName(value) {
  return String(value || 'ChatGPT-Autopilot-profile').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 100) || 'ChatGPT-Autopilot-profile';
}
function downloadJson(data, fileName) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
async function exportPortableProfile() {
  try {
    const data = await core('EXPORT_PORTABLE_PROFILE', { profileName: 'ChatGPT Автопілот — експорт' });
    downloadJson(data.profile, `${safeFileName(data.profile.profileName)}.json`);
    reportCommandResult(`Exported ${data.profile.sessions.length} Session(s) to JSON.`);
  } catch (error) {
    setAppStatus(error.message);
    reportCommandResult(`Export failed: ${error.message}`);
  }
}

function downloadText(data, fileName) {
  const blob = new Blob([String(data || '')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function diagnosticFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `ChatGPT-Автопілот-діагностика-${stamp}.txt`;
}

async function downloadDiagnosticReport() {
  try {
    const extensionVersion = globalThis.chrome?.runtime?.getManifest?.().version || 'невідомо';
    const data = await core('GET_DIAGNOSTIC_REPORT', { extensionVersion });
    downloadText(data.report, diagnosticFileName());
    const message = 'Діагностичний звіт завантажено.';
    $('diagnostic-report-status').textContent = message;
    reportCommandResult(message);
  } catch (error) {
    const message = `Не вдалося завантажити діагностичний звіт: ${error.message}`;
    $('diagnostic-report-status').textContent = message;
    setAppStatus(error.message);
    announce(message);
  }
}

let diagnosticSnapshotInFlight = false;
async function recordDashboardDiagnosticSnapshot() {
  if (diagnosticSnapshotInFlight || !ui.selectedSessionId || !ui.selected) return;
  if (!['RUNNING', 'RECOVERING'].includes(ui.selected.runState)) return;
  diagnosticSnapshotInFlight = true;
  try {
    await core('RECORD_DIAGNOSTIC_SNAPSHOT', { sessionId: ui.selectedSessionId });
  } catch {
    // Diagnostics must never steal focus, announce repeatedly, or block execution.
  } finally {
    diagnosticSnapshotInFlight = false;
  }
}

let statusRefreshTimer = null;
let statusRefreshInFlight = false;
let statusRefreshQueued = false;
const dirtyStatusSessionIds = new Set();
function queueStatusRefresh(sessionId) {
  if (sessionId) dirtyStatusSessionIds.add(sessionId);
  if (statusRefreshTimer || statusRefreshInFlight) {
    statusRefreshQueued = true;
    return;
  }
  statusRefreshTimer = setTimeout(flushStatusRefresh, STATUS_REFRESH_DELAY_MS);
}
async function flushStatusRefresh() {
  statusRefreshTimer = null;
  if (statusRefreshInFlight) { statusRefreshQueued = true; return; }
  statusRefreshInFlight = true;
  const dirty = new Set(dirtyStatusSessionIds);
  dirtyStatusSessionIds.clear();
  statusRefreshQueued = false;
  try {
    await loadSessions();
    if (ui.selectedSessionId && dirty.has(ui.selectedSessionId)) {
      await refreshSelectedSessionStatus(ui.selectedSessionId);
    }
  } finally {
    statusRefreshInFlight = false;
    if (statusRefreshQueued || dirtyStatusSessionIds.size) queueStatusRefresh();
  }
}

$('mode-sessions').addEventListener('click', () => setUiMode('sessions', { focus: true }));
$('mode-orchestration').addEventListener('click', () => setUiMode('orchestration', { focus: true }));
$('mode-scenario-work').addEventListener('click', () => setUiMode('scenario-work', { focus: true }));
$('mode-agent').addEventListener('click', () => setUiMode('agent', { focus: true }));
$('mode-ai').addEventListener('click', () => setUiMode('ai', { focus: true }));
$('mode-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const ordered = ['sessions', 'orchestration', 'scenario-work', 'agent', 'ai'];
  const current = ordered.findIndex(value => $(`mode-${value}`)?.getAttribute('aria-selected') === 'true');
  let index = current < 0 ? 0 : current;
  if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = ordered.length - 1;
  else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + ordered.length) % ordered.length;
  event.preventDefault();
  setUiMode(ordered[index], { focus: true });
});

for (const panel of SCENARIO_WORK_PANELS) $('scenario-work-tab-' + panel).addEventListener('click', () => setScenarioWorkPanel(panel, { focus: true }));
$('scenario-work-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const current = SCENARIO_WORK_PANELS.findIndex(value => $(`scenario-work-tab-${value}`).getAttribute('aria-selected') === 'true');
  let index = current < 0 ? 0 : current;
  if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = SCENARIO_WORK_PANELS.length - 1;
  else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + SCENARIO_WORK_PANELS.length) % SCENARIO_WORK_PANELS.length;
  event.preventDefault();
  setScenarioWorkPanel(SCENARIO_WORK_PANELS[index], { focus: true });
});
$('scenario-work-list').addEventListener('change', () => openScenarioWork($('scenario-work-list').value));
$('new-scenario-cycle-button').addEventListener('click', () => createScenarioWork('CHAT_CYCLE'));
$('new-scenario-pairs-button').addEventListener('click', () => createScenarioWork('PAIRS'));
$('new-scenario-group-button').addEventListener('click', () => createScenarioWork('AUDITOR_GROUP'));
$('new-scenario-pipeline-button').addEventListener('click', () => createScenarioWork('AUDITOR_PIPELINE'));
$('save-scenario-work-button').addEventListener('click', saveScenarioWork);
$('start-scenario-work-button').addEventListener('click', () => scenarioWorkLifecycle('START_SCENARIO_WORK', 'Сценарій запущено.'));
$('pause-scenario-work-button').addEventListener('click', () => scenarioWorkLifecycle('PAUSE_SCENARIO_WORK', 'Сценарій призупинено.'));
$('resume-scenario-work-button').addEventListener('click', () => scenarioWorkLifecycle('RESUME_SCENARIO_WORK', 'Сценарій продовжено.'));
$('stop-scenario-work-button').addEventListener('click', () => scenarioWorkLifecycle('STOP_SCENARIO_WORK', 'Сценарій зупинено.'));
$('delete-scenario-work-button').addEventListener('click', deleteScenarioWork);
$('scenario-work-run-now').addEventListener('click', runScenarioWorkNow);
$('scenario-cycle-add-step').addEventListener('click', () => {
  const container = $('scenario-cycle-steps');
  const row = createScenarioCycleStep({ prompt: '', repeat: 1 }, container.querySelectorAll('[data-scenario-step]').length);
  container.append(row);
  renumberScenarioCycleSteps();
  row.querySelector('textarea')?.focus();
  announce('Додано новий промпт.');
});

for (const panel of ORCHESTRATION_PANELS) $('orchestration-v2-tab-' + panel).addEventListener('click', () => setOrchestrationPanel(panel, { focus: true }));
$('orchestration-v2-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const enabled = ORCHESTRATION_PANELS.filter(value => !$(`orchestration-v2-tab-${value}`).disabled);
  const current = enabled.findIndex(value => $(`orchestration-v2-tab-${value}`).getAttribute('aria-selected') === 'true');
  let index = current < 0 ? 0 : current;
  if (event.key === 'Home') index = 0; else if (event.key === 'End') index = enabled.length - 1;
  else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
  event.preventDefault(); setOrchestrationPanel(enabled[index], { focus: true });
});
$('orchestration-v2-orchestra-list').addEventListener('change', selectOrchestrationV2Orchestra);
$('new-orchestration-v2-orchestra-button').addEventListener('click', createOrchestrationV2Orchestra);
$('rename-orchestration-v2-orchestra-button').addEventListener('click', renameOrchestrationV2Orchestra);
$('start-orchestration-v2-orchestra-button').addEventListener('click', startOrchestrationV2Orchestra);
$('pause-orchestration-v2-orchestra-button').addEventListener('click', pauseOrchestrationV2Orchestra);
$('resume-orchestration-v2-orchestra-button').addEventListener('click', resumeOrchestrationV2Orchestra);
$('delete-orchestration-v2-orchestra-button').addEventListener('click', deleteOrchestrationV2Orchestra);
$('orchestration-v2-profile-file').addEventListener('change', onOrchestrationProfileFileChange);
$('import-orchestration-v2-profile-button').addEventListener('click', importOrchestrationProfile);
$('export-orchestration-v2-profile-button').addEventListener('click', exportOrchestrationProfile);
$('configure-orchestration-v2-hierarchy-button').addEventListener('click', configureOrchestrationHierarchyTemplate);
$('authorize-orchestration-v2-drive-button').addEventListener('click', authorizeOrchestrationDrive);
$('agent-run-prompt-button').addEventListener('click', runBrowserAgentPrompt);
$('agent-job-list').addEventListener('change', selectBrowserAgentJob);
$('agent-pause-button').addEventListener('click', () => browserAgentLifecycle('PAUSE_BROWSER_AGENT_JOB'));
$('agent-resume-button').addEventListener('click', () => browserAgentLifecycle('RESUME_BROWSER_AGENT_JOB'));
$('agent-stop-button').addEventListener('click', () => browserAgentLifecycle('STOP_BROWSER_AGENT_JOB'));
$('agent-step-button').addEventListener('click', () => browserAgentLifecycle('STEP_BROWSER_AGENT_JOB'));
$('agent-run-now-button').addEventListener('click', runBrowserAgentNow);
$('agent-delete-button').addEventListener('click', deleteBrowserAgentJob);
$('agent-send-follow-up-button').addEventListener('click', sendBrowserAgentFollowUp);
$('agent-approve-action-button').addEventListener('click', approveBrowserAgentAction);
$('agent-reject-action-button').addEventListener('click', rejectBrowserAgentAction);
$('agent-save-policy-button').addEventListener('click', saveBrowserAgentPolicy);
$('agent-allow-current-site-button').addEventListener('click', () => requestBrowserAgentPermission({ allSites: false }));
$('agent-allow-all-sites-button').addEventListener('click', () => requestBrowserAgentPermission({ allSites: true }));
$('agent-allow-downloads-button').addEventListener('click', () => requestBrowserAgentCapability('downloads'));
$('agent-allow-notifications-button').addEventListener('click', () => requestBrowserAgentCapability('notifications'));
$('save-rate-limit-cooldown-button').addEventListener('click', saveProfileSettings);
$('save-orchestration-v2-button').addEventListener('click', saveOrchestrationV2Settings);
$('save-start-orchestration-v2-button').addEventListener('click', saveAndStartOrchestrationV2Now);
$('test-orchestration-v2-button').addEventListener('click', testOrchestrationV2Control);
$('run-orchestration-v2-button').addEventListener('click', runOrchestrationV2Now);
$('stop-orchestration-v2-button').addEventListener('click', emergencyStopOrchestrationV2);
$('save-remote-dispatch-button').addEventListener('click', saveRemoteDispatchSettings);
$('test-remote-dispatch-button').addEventListener('click', testRemoteDispatchFeed);
$('run-remote-dispatch-button').addEventListener('click', runRemoteDispatchNow);
$('save-local-ai-button').addEventListener('click', saveLocalAiSettings);
$('test-local-ai-button').addEventListener('click', testLocalAiConnection);
$('run-local-ai-test-button').addEventListener('click', runLocalAiTestPrompt);
$('local-ai-provider').addEventListener('change', onLocalAiProviderChanged);
$('save-ai-router-button').addEventListener('click', saveAiRouterSettings);
$('test-ai-gateway-button').addEventListener('click', testAiGateway);
$('reset-ai-router-runtime-button').addEventListener('click', resetAiRouterRuntime);
$('ai-router-primary-provider').addEventListener('change', () => resetAiRouterModelSlot('primary'));
$('ai-router-strong-provider').addEventListener('change', () => resetAiRouterModelSlot('strong'));
$('ai-router-primary-models-button').addEventListener('click', () => loadAiRouterModels('primary'));
$('ai-router-strong-models-button').addEventListener('click', () => loadAiRouterModels('strong'));
$('run-ai-router-test-button').addEventListener('click', () => runAiRouterPrompt(false));
$('run-ai-router-strong-button').addEventListener('click', () => runAiRouterPrompt(true));
$('save-ai-manager-button').addEventListener('click', saveAiManagerSettings);
$('run-ai-manager-now-button').addEventListener('click', runAiManagerNow);
$('reset-ai-manager-runtime-button').addEventListener('click', resetAiManagerRuntime);
$('create-session-button').addEventListener('click', createSession);
$('master-pause-button').addEventListener('click', () => masterAction('MASTER_PAUSE', 'master pause', true));
$('master-resume-button').addEventListener('click', () => masterAction('MASTER_RESUME', 'master resume', false));
$('bulk-add-urls-button').addEventListener('click', () => runBulkUrlImport(false));
$('bulk-replace-urls-button').addEventListener('click', () => runBulkUrlImport(true));
document.querySelectorAll('input[name="taskConfigurationMode"]').forEach((input) => input.addEventListener('change', onTaskConfigurationModeChange));
$('task-count').addEventListener('change', onTaskCountChange);
$('task-count').addEventListener('input', () => { if ($('task-count').value) onTaskCountChange(); });
$('shared-task-url').addEventListener('input', onSharedUrlInput);
$('retry-backoff-unit').addEventListener('change', onRetryBackoffUnitChange);
$('minimum-send-interval-unit').addEventListener('change', onMinimumSendIntervalUnitChange);
$('apply-default-prompt-button').addEventListener('click', applyDefaultPrompt);
$('save-session-button').addEventListener('click', saveSession);
$('start-session-button').addEventListener('click', () => action('START_SESSION', 'Start'));
$('pause-session-button').addEventListener('click', () => action('PAUSE_SESSION', 'Pause'));
$('resume-session-button').addEventListener('click', () => action('RESUME_SESSION', 'Resume'));
$('stop-session-button').addEventListener('click', () => action('STOP_SESSION', 'Stop'));
$('clear-log-button').addEventListener('click', () => action('CLEAR_LOG', 'Clear log'));
$('confirm-delete-button').addEventListener('click', confirmDelete);
$('cancel-delete-button').addEventListener('click', closeDeleteDialog);
$('portable-profile-file').addEventListener('change', onPortableProfileFileChange);
$('import-profile-button').addEventListener('click', () => importPortableProfile(false));
$('import-profile-start-button').addEventListener('click', () => importPortableProfile(true));
$('export-profile-button').addEventListener('click', exportPortableProfile);
$('download-diagnostic-report-button').addEventListener('click', downloadDiagnosticReport);
$('uncertain-confirm').addEventListener('change', () => {
  $('uncertain-retry').disabled = !$('uncertain-confirm').checked;
  $('uncertain-skip').disabled = !$('uncertain-confirm').checked;
});
async function resolveUncertain(resolution) {
  try {
    const data = await core('RESOLVE_UNCERTAIN', {
      sessionId: ui.selectedSessionId,
      operationId: ui.selected?.status?.uncertainOperationId,
      resolution,
      confirmed: $('uncertain-confirm').checked,
    });
    ui.selected = data.session;
    clearDraft(ui.selectedSessionId);
    await openSession(ui.selectedSessionId);
    reportCommandResult(resolution === 'check'
      ? 'Перевіряю попереднє надсилання. Нового натискання немає.'
      : 'Рішення збережено. Натисніть Продовжити для продовження.');
    if (resolution !== 'check') $('resume-session-button').focus();
  } catch (error) {
    reportCommandResult(error.message);
  }
}
$('uncertain-check').addEventListener('click', () => resolveUncertain('check'));
$('uncertain-retry').addEventListener('click', () => resolveUncertain('retry'));
$('uncertain-skip').addEventListener('click', () => resolveUncertain('skip'));
document.addEventListener('keydown', trapDialog);
document.addEventListener('input', (event) => {
  if (ui.selected && event.target?.closest?.('#session-editor') && event.target.id !== 'bulk-task-urls' && !event.target.closest?.('#uncertain-recovery')) scheduleDraftPersistence();
});
document.addEventListener('change', (event) => {
  if (ui.selected && event.target?.closest?.('#session-editor') && !event.target.closest?.('#uncertain-recovery')) scheduleDraftPersistence();
});

if (globalThis.chrome?.runtime?.onMessage) chrome.runtime.onMessage.addListener((message) => {
  if (message?.channel !== 'autopilot-core' || message?.type !== 'STATUS_CHANGED') return;
  queueStatusRefresh(message.sessionId);
});

async function initialLoad() {
  setUiMode(storageGet(UI_MODE_KEY) || 'sessions');
  setOrchestrationPanel(storageGet(ORCHESTRATION_PANEL_KEY) || 'orchestras');
  setScenarioWorkPanel(storageGet(SCENARIO_WORK_PANEL_KEY) || 'cycle');
  await loadProfileSettings();
  await loadLocalAiSettings();
  await loadAiRouterSettings();
  await loadAiManagerSettings();
  await loadSessions({ preserveFocus: false });
  await loadOrchestrationV2Status();
  await loadScenarioWork();
  await loadBrowserAgentJobs();
  await loadRemoteDispatchStatus();
  const lastSessionId = storageGet(LAST_SESSION_KEY);
  if (lastSessionId && ui.sessions.some(session => session.id === lastSessionId)) await openSession(lastSessionId);
}
void initialLoad();
window.setInterval(() => { void recordDashboardDiagnosticSnapshot(); }, DIAGNOSTIC_SNAPSHOT_DELAY_MS);
window.setInterval(() => {
  if (document.visibilityState === 'visible' && storageGet(UI_MODE_KEY) === 'agent') void loadBrowserAgentJobs({ selectId: ui.selectedBrowserAgentId });
}, 2000);

export { MAX_TASKS, blankSession, blankTask, validate, diagnosticFileName };
