import { focusAfterLifecycleSuccess } from './focus-policy.js';
import { translateText } from './uk-localization.js';
import { MAX_PORTABLE_FILE_BYTES, extractChatGptUrls, mergeBulkUrls, parsePortableJson } from './config-tools.js';

const MAX_TASKS = 50;
const VISIBLE_LOG_LIMIT = 100;
const STATUS_REFRESH_DELAY_MS = 750;
const DRAFT_SAVE_DELAY_MS = 250;
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
};

const $ = (id) => document.getElementById(id);
const announce = (text) => { $('live-announcer').textContent = ''; requestAnimationFrame(() => { $('live-announcer').textContent = text; }); };
const formatTime = (value) => value ? new Date(value).toLocaleString() : 'Not available';
const runtimeAvailable = () => Boolean(globalThis.chrome?.runtime?.sendMessage);

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
    sharedPrompt: '',
    defaultUniquePrompt: '',
    runMode: 'continuous',
    tasks: [blankTask()],
    minimumSendIntervalMinutes: 2,
    preSendDelaySeconds: 5,
    busyCheckDelaySeconds: 2,
    retryBackoffSeconds: 30,
    retryBackoffUnit: 'seconds',
    retryPolicy: 'safe',
    busyChatBehavior: 'skip-next',
    tabStrategy: 'keep-open',
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
  return JSON.stringify((sessions || []).map(session => [session.id, session.name, session.runState, session.enabledTaskCount]));
}

async function loadSessions({ preserveFocus = true } = {}) {
  const active = preserveFocus ? document.activeElement : null;
  const activeId = preserveFocus ? active?.id || null : null;
  try {
    const data = await core('LIST_SESSIONS');
    const nextSessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const nextSignature = sessionListSignature(nextSessions);
    ui.sessions = nextSessions;
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
    state.id = `session-state-${session.id}`; state.textContent = ` State: ${session.runState || 'STOPPED'}.`;
    const count = document.createElement('span');
    count.id = `session-enabled-count-${session.id}`; count.textContent = ` ${session.enabledTaskCount ?? 0} enabled tasks.`;
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
    sharedPrompt: session.sharedPrompt,
    defaultUniquePrompt: session.defaultUniquePrompt,
    runMode: session.runMode,
    tasks: clone(session.tasks || []),
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

function renderEditor() {
  if (!ui.selected) return;
  $('empty-state').hidden = true; $('session-editor').hidden = false;
  $('session-heading').textContent = `Session: ${ui.selected.name || 'Unnamed session'}`;
  $('session-name').value = ui.selected.name || '';
  const shared = ui.selected.promptMode !== 'unique';
  $('prompt-mode-shared').checked = shared;
  $('prompt-mode-unique').checked = !shared;
  $('shared-prompt-container').hidden = !shared;
  $('unique-default-container').hidden = shared;
  $('shared-prompt').value = ui.selected.sharedPrompt || '';
  $('default-unique-prompt').value = ui.selected.defaultUniquePrompt || '';
  $('run-mode-one-pass').checked = ui.selected.runMode === 'one-pass';
  $('run-mode-continuous').checked = ui.selected.runMode !== 'one-pass';
  $('minimum-send-interval').value = ui.selected.minimumSendIntervalMinutes ?? 2;
  $('pre-send-delay').value = ui.selected.preSendDelaySeconds ?? 5;
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
  renderTasks(); renderStatus(); renderLog(); renderActions();
}

function renderTasks(focusTaskId = null) {
  const list = $('task-list'); list.replaceChildren();
  const unique = ui.selected.promptMode === 'unique';
  ui.selected.tasks.forEach((task, index) => {
    const ordinal = index + 1;
    const li = document.createElement('li'); li.id = `task-${task.id}`;
    const fieldset = document.createElement('fieldset'); fieldset.className = 'task-card';
    const legend = document.createElement('legend'); legend.id = `task-heading-${task.id}`; legend.textContent = `Task ${ordinal}${hostSuffix(task.url)}`;
    const enabled = labeledCheckbox(`task-enabled-${task.id}`, `Task ${ordinal} enabled`, task.enabled, (checked) => { task.enabled = checked; });
    const labelInput = labeledInput(`task-label-${task.id}`, `Task ${ordinal} label, optional`, 'text', task.label || '', (value) => { task.label = value; });
    const urlInput = labeledInput(`task-url-${task.id}`, `Task ${ordinal} ChatGPT URL`, 'url', task.url || '', (value) => { task.url = value; });
    urlInput.input.autocomplete = 'off'; urlInput.input.spellcheck = false;
    fieldset.append(legend, enabled.wrapper, labelInput.wrapper, urlInput.wrapper);
    if (unique) {
      const prompt = labeledTextarea(`task-prompt-${task.id}`, `Prompt for Task ${ordinal}`, task.promptOverride || '', (value) => { task.promptOverride = value; });
      fieldset.append(prompt.wrapper);
    }
    const remove = button(`remove-task-${task.id}`, `Remove Task ${ordinal}`, () => removeTask(task.id));
    remove.setAttribute('aria-label', `Remove Task ${ordinal}`);
    fieldset.append(remove); li.append(fieldset); list.append(li);
  });
  $('add-task-button').disabled = ui.selected.tasks.length >= MAX_TASKS;
  $('task-limit-help').textContent = ui.selected.tasks.length >= MAX_TASKS ? 'Task limit reached: 50.' : `Up to 50 tasks per session. ${ui.selected.tasks.length} configured.`;
  if (focusTaskId) $(`task-url-${focusTaskId}`)?.focus();
}

function hostSuffix(url) {
  try { return url ? ` — ${new URL(url).host}` : ''; } catch { return ''; }
}

function labeledInput(id, labelText, type, value, onInput) {
  const wrapper = document.createElement('div'); const label = document.createElement('label'); label.htmlFor = id; label.textContent = labelText;
  const input = document.createElement('input'); input.id = id; input.type = type; input.value = value; input.addEventListener('input', () => onInput(input.value)); wrapper.append(label, input); return { wrapper, input };
}
function labeledTextarea(id, labelText, value, onInput) {
  const wrapper = document.createElement('div'); const label = document.createElement('label'); label.htmlFor = id; label.textContent = labelText;
  const input = document.createElement('textarea'); input.id = id; input.rows = 6; input.value = value; input.addEventListener('input', () => onInput(input.value)); wrapper.append(label, input); return { wrapper, input };
}
function labeledCheckbox(id, labelText, checked, onChange) {
  const wrapper = document.createElement('label'); const input = document.createElement('input'); input.id = id; input.type = 'checkbox'; input.checked = checked; input.addEventListener('change', () => onChange(input.checked)); wrapper.append(input, document.createTextNode(` ${labelText}`)); return { wrapper, input };
}

function addTask() {
  if (!ui.selected || ui.selected.tasks.length >= MAX_TASKS) return;
  const task = blankTask(); ui.selected.tasks.push(task); renderTasks(task.id); scheduleDraftPersistence(); announce(`Task ${ui.selected.tasks.length} added.`);
}
function removeTask(taskId) {
  const index = ui.selected.tasks.findIndex((t) => t.id === taskId); if (index < 0) return;
  ui.selected.tasks.splice(index, 1); renderTasks(); scheduleDraftPersistence();
  const next = ui.selected.tasks[index] || ui.selected.tasks[index - 1];
  if (next) $(`task-url-${next.id}`)?.focus(); else $('add-task-button').focus();
  announce('Task removed.');
}

function runBulkUrlImport(replace) {
  if (!ui.selected) return;
  const urls = extractChatGptUrls($('bulk-task-urls').value);
  if (!urls.length) {
    $('bulk-task-result').textContent = 'No valid ChatGPT links were recognized.';
    $('bulk-task-result').focus();
    return;
  }
  const hasOnlyBlankDefault = ui.selected.tasks.length === 1
    && !ui.selected.tasks[0].url
    && !ui.selected.tasks[0].label
    && !ui.selected.tasks[0].promptOverride;
  const existing = !replace && hasOnlyBlankDefault ? [] : ui.selected.tasks;
  const result = mergeBulkUrls(existing, urls, { replace, maxTasks: MAX_TASKS });
  if (!result.tasks.length) return;
  ui.selected.tasks = result.tasks;
  renderTasks();
  scheduleDraftPersistence();
  const truncated = result.truncated ? ` ${result.truncated} link(s) did not fit the 50-task limit.` : '';
  $('bulk-task-result').textContent = `${result.recognized} unique ChatGPT link(s) recognized; ${result.added} new task(s) created.${truncated}`;
  $('bulk-task-result').focus();
}

function collectEditor() {
  const s = ui.selected;
  s.name = $('session-name').value.trim();
  s.promptMode = document.querySelector('input[name="promptMode"]:checked')?.value || 'shared';
  s.sharedPrompt = $('shared-prompt').value;
  s.defaultUniquePrompt = $('default-unique-prompt').value;
  s.runMode = document.querySelector('input[name="runMode"]:checked')?.value || 'continuous';
  s.minimumSendIntervalMinutes = Number($('minimum-send-interval').value);
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
  if (!session.tasks.length) errors.push(['add-task-button', 'Add at least one task.']);
  const hasEnabledTasks = session.tasks.some((task) => task.enabled);
  session.tasks.forEach((task, i) => {
    if (!task.enabled) return;
    if (!task.url) errors.push([`task-url-${task.id}`, `Task ${i + 1} URL is required.`]);
    else { try { const u = new URL(task.url); if (u.protocol !== 'https:' || !['chatgpt.com','www.chatgpt.com'].includes(u.hostname)) throw new Error(); } catch { errors.push([`task-url-${task.id}`, `Task ${i + 1} must use a valid https://chatgpt.com URL.`]); } }
    if (session.promptMode === 'unique' && !task.promptOverride.trim()) errors.push([`task-prompt-${task.id}`, `Prompt for Task ${i + 1} is required in unique mode.`]);
  });
  if (hasEnabledTasks && session.promptMode === 'shared' && !session.sharedPrompt.trim()) errors.push(['shared-prompt', 'Shared prompt is required.']);
  if (!(session.minimumSendIntervalMinutes >= 1)) errors.push(['minimum-send-interval', 'Minimum send interval must be at least 1 minute.']);
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
  [
    ['Session state', ui.selected.runState || 'STOPPED'],
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

function onPromptModeChange() {
  const value = document.querySelector('input[name="promptMode"]:checked')?.value || 'shared'; ui.selected.promptMode = value; $('shared-prompt-container').hidden = value !== 'shared'; $('unique-default-container').hidden = value !== 'unique'; renderTasks(); scheduleDraftPersistence(); announce(value === 'shared' ? 'Shared prompt mode selected.' : 'Unique prompt mode selected.');
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
  if (file.size > MAX_PORTABLE_FILE_BYTES) {
    $('portable-profile-preview').textContent = 'Configuration file is larger than 2 MB.';
    $('portable-profile-preview').focus();
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

$('create-session-button').addEventListener('click', createSession);
$('master-pause-button').addEventListener('click', () => masterAction('MASTER_PAUSE', 'master pause', true));
$('master-resume-button').addEventListener('click', () => masterAction('MASTER_RESUME', 'master resume', false));
$('add-task-button').addEventListener('click', addTask);
$('bulk-add-urls-button').addEventListener('click', () => runBulkUrlImport(false));
$('bulk-replace-urls-button').addEventListener('click', () => runBulkUrlImport(true));
$('prompt-mode-shared').addEventListener('change', onPromptModeChange);
$('prompt-mode-unique').addEventListener('change', onPromptModeChange);
$('retry-backoff-unit').addEventListener('change', onRetryBackoffUnitChange);
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
document.addEventListener('keydown', trapDialog);
document.addEventListener('input', (event) => {
  if (ui.selected && event.target?.closest?.('#session-editor') && event.target.id !== 'bulk-task-urls') scheduleDraftPersistence();
});
document.addEventListener('change', (event) => {
  if (ui.selected && event.target?.closest?.('#session-editor')) scheduleDraftPersistence();
});

if (globalThis.chrome?.runtime?.onMessage) chrome.runtime.onMessage.addListener((message) => {
  if (message?.channel !== 'autopilot-core' || message?.type !== 'STATUS_CHANGED') return;
  queueStatusRefresh(message.sessionId);
});

async function initialLoad() {
  await loadSessions({ preserveFocus: false });
  const lastSessionId = storageGet(LAST_SESSION_KEY);
  if (lastSessionId && ui.sessions.some(session => session.id === lastSessionId)) await openSession(lastSessionId);
}
void initialLoad();

export { MAX_TASKS, blankSession, blankTask, validate };
