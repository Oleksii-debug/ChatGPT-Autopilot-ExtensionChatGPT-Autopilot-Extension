const MAX_TASKS = 50;
const ui = {
  sessions: [],
  selectedSessionId: null,
  selected: null,
  deleteReturnFocus: null,
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

async function loadSessions({ preserveFocus = true } = {}) {
  const active = preserveFocus ? document.activeElement : null;
  const activeId = preserveFocus ? active?.id || null : null;
  try {
    const data = await core('LIST_SESSIONS');
    ui.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    renderSessionList();
    setAppStatus('Connected to Core.');
    if (active?.isConnected) active.focus();
    else if (activeId) $(activeId)?.focus();
  } catch (error) {
    setAppStatus(error.message);
    renderSessionList();
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
}

function button(id, text, handler) {
  const b = document.createElement('button'); b.id = id; b.type = 'button'; b.textContent = text; b.addEventListener('click', handler); return b;
}

async function openSession(sessionId) {
  try {
    const data = await core('GET_SESSION', { sessionId });
    ui.selectedSessionId = sessionId;
    ui.selected = clone(data.session);
    renderEditor();
    $('session-heading').focus();
  } catch (error) { setAppStatus(error.message); announce(error.message); }
}

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
    renderStatus();
    renderLog();
    renderActions();
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
  $('retry-backoff').value = ui.selected.retryBackoffSeconds ?? 30;
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
  const task = blankTask(); ui.selected.tasks.push(task); renderTasks(task.id); announce(`Task ${ui.selected.tasks.length} added.`);
}
function removeTask(taskId) {
  const index = ui.selected.tasks.findIndex((t) => t.id === taskId); if (index < 0) return;
  ui.selected.tasks.splice(index, 1); renderTasks();
  const next = ui.selected.tasks[index] || ui.selected.tasks[index - 1];
  if (next) $(`task-url-${next.id}`)?.focus(); else $('add-task-button').focus();
  announce('Task removed.');
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
  s.retryBackoffSeconds = Number($('retry-backoff').value);
  s.retryPolicy = document.querySelector('input[name="retryPolicy"]:checked')?.value || 'safe';
  s.busyChatBehavior = $('busy-chat-behavior').value;
  s.tabStrategy = document.querySelector('input[name="tabStrategy"]:checked')?.value || 'keep-open';
  return s;
}

function validate(session) {
  clearErrors(); const errors = [];
  if (!session.name) errors.push(['session-name', 'Session name is required.']);
  if (!session.tasks.length) errors.push(['add-task-button', 'Add at least one task.']);
  session.tasks.forEach((task, i) => {
    if (!task.enabled) return;
    if (!task.url) errors.push([`task-url-${task.id}`, `Task ${i + 1} URL is required.`]);
    else { try { const u = new URL(task.url); if (u.protocol !== 'https:' || !['chatgpt.com','www.chatgpt.com'].includes(u.hostname)) throw new Error(); } catch { errors.push([`task-url-${task.id}`, `Task ${i + 1} must use a valid https://chatgpt.com URL.`]); } }
    if (session.promptMode === 'unique' && !task.promptOverride.trim()) errors.push([`task-prompt-${task.id}`, `Prompt for Task ${i + 1} is required in unique mode.`]);
  });
  if (session.promptMode === 'shared' && !session.sharedPrompt.trim()) errors.push(['shared-prompt', 'Shared prompt is required.']);
  if (!(session.minimumSendIntervalMinutes >= 1)) errors.push(['minimum-send-interval', 'Minimum send interval must be at least 1 minute.']);
  if (!(session.preSendDelaySeconds >= 1 && session.preSendDelaySeconds <= 30)) errors.push(['pre-send-delay', 'Pre-send delay must be between 1 and 30 seconds.']);
  if (!(session.busyCheckDelaySeconds >= 1 && session.busyCheckDelaySeconds <= 30)) errors.push(['busy-check-delay', 'Busy-check delay must be between 1 and 30 seconds.']);
  if (!(session.retryBackoffSeconds >= 5 && session.retryBackoffSeconds <= 3600)) errors.push(['retry-backoff', 'Retry backoff must be between 5 and 3600 seconds.']);
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
  const session = collectEditor(); const errors = validate(session); if (errors.length) { announce(`${errors.length} configuration error${errors.length === 1 ? '' : 's'}.`); return; }
  try {
    const data = await core('UPDATE_SESSION', { sessionId: session.id, expectedVersion: session.version, config: session });
    ui.selected = clone(data.session); announce('Session saved.'); await loadSessions(); renderEditor();
  } catch (error) { setAppStatus(error.message); announce(error.message); }
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
    closeDeleteDialog({ restoreFocus: false });
    if (ui.selectedSessionId === id) { ui.selectedSessionId = null; ui.selected = null; $('session-editor').hidden = true; $('empty-state').hidden = false; }
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
  $('session-log-count').textContent = `${entries.length} Core log entr${entries.length === 1 ? 'y' : 'ies'} shown.`;
  $('session-log-region').textContent = entries.map((entry) => typeof entry === 'string' ? entry : `${formatTime(entry.at)} — ${entry.message}`).join('\n');
}

function onPromptModeChange() {
  const value = document.querySelector('input[name="promptMode"]:checked')?.value || 'shared'; ui.selected.promptMode = value; $('shared-prompt-container').hidden = value !== 'shared'; $('unique-default-container').hidden = value !== 'unique'; renderTasks(); announce(value === 'shared' ? 'Shared prompt mode selected.' : 'Unique prompt mode selected.');
}
function applyDefaultPrompt() { const value = $('default-unique-prompt').value; let changed = 0; ui.selected.tasks.forEach((task) => { if (!task.promptOverride.trim()) { task.promptOverride = value; changed++; } }); renderTasks(); announce(`Default prompt applied to ${changed} empty task${changed === 1 ? '' : 's'}.`); }

$('create-session-button').addEventListener('click', createSession);
$('master-pause-button').addEventListener('click', () => masterAction('MASTER_PAUSE', 'master pause', true));
$('master-resume-button').addEventListener('click', () => masterAction('MASTER_RESUME', 'master resume', false));
$('add-task-button').addEventListener('click', addTask);
$('prompt-mode-shared').addEventListener('change', onPromptModeChange);
$('prompt-mode-unique').addEventListener('change', onPromptModeChange);
$('apply-default-prompt-button').addEventListener('click', applyDefaultPrompt);
$('save-session-button').addEventListener('click', saveSession);
$('start-session-button').addEventListener('click', () => action('START_SESSION', 'Start'));
$('pause-session-button').addEventListener('click', () => action('PAUSE_SESSION', 'Pause'));
$('resume-session-button').addEventListener('click', () => action('RESUME_SESSION', 'Resume'));
$('stop-session-button').addEventListener('click', () => action('STOP_SESSION', 'Stop'));
$('clear-log-button').addEventListener('click', () => action('CLEAR_LOG', 'Clear log'));
$('confirm-delete-button').addEventListener('click', confirmDelete);
$('cancel-delete-button').addEventListener('click', closeDeleteDialog);
document.addEventListener('keydown', trapDialog);

if (globalThis.chrome?.runtime?.onMessage) chrome.runtime.onMessage.addListener((message) => {
  if (message?.channel !== 'autopilot-core' || message?.type !== 'STATUS_CHANGED') return;
  void loadSessions();
  if (message.sessionId === ui.selectedSessionId) void refreshSelectedSessionStatus(ui.selectedSessionId);
});

loadSessions();

export { MAX_TASKS, blankSession, blankTask, validate };
