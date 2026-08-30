import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../../src/ui/options.js', import.meta.url), 'utf8');

function has(pattern, message) { assert.match(html, pattern, message); }

test('page exposes semantic landmarks and primary accessible names', () => {
  has(/<h1 id="page-title">ChatGPT Autopilot<\/h1>/, 'missing H1');
  has(/<nav aria-label="Session navigation">/, 'missing labelled nav');
  has(/<main id="main" tabindex="-1">/, 'missing main landmark');
  has(/id="session-status-region"/, 'missing readable status region');
  has(/id="session-log-region" tabindex="0" aria-label="Session log"/, 'missing readable log');
  has(/<h2 id="keyboard-startup-heading">Keyboard and startup behavior<\/h2>/, 'keyboard/startup help heading missing');
  has(/No extension-specific global keyboard shortcuts are assigned\./, 'shortcut truth missing');
  has(/Sessions left RUNNING or RECOVERING resume automatically when Chrome starts\. PAUSED and STOPPED Sessions do not auto-resume\./, 'startup truth missing');
});

test('all static controls use native elements and persistent labels/legends', () => {
  assert.doesNotMatch(html, /role="button"/i);
  assert.doesNotMatch(html, /tabindex="[1-9][0-9]*"/i);
  has(/<label for="session-name">Session name<\/label>/, 'session name label missing');
  has(/<fieldset id="prompt-mode">\s*<legend>Prompt mode<\/legend>/s, 'prompt mode fieldset missing');
  has(/<fieldset id="run-mode">\s*<legend>Run mode<\/legend>/s, 'run mode fieldset missing');
  has(/<fieldset id="tab-strategy">\s*<legend>Tab strategy<\/legend>/s, 'tab strategy fieldset missing');
});

test('static keyboard controls follow a stable logical DOM order with no accesskey overrides', () => {
  const orderedIds = [
    'master-pause-button', 'master-resume-button', 'create-session-button',
    'session-name', 'prompt-mode-shared', 'prompt-mode-unique', 'shared-prompt',
    'run-mode-one-pass', 'run-mode-continuous', 'add-task-button',
    'minimum-send-interval', 'pre-send-delay', 'busy-check-delay',
    'retry-backoff', 'retry-backoff-unit', 'busy-chat-behavior',
    'tab-strategy-keep-open', 'tab-strategy-worker', 'tab-strategy-open-close',
    'save-session-button', 'start-session-button', 'pause-session-button',
    'resume-session-button', 'stop-session-button', 'clear-log-button'
  ];
  let previous = -1;
  for (const id of orderedIds) {
    const position = html.indexOf(`id="${id}"`);
    assert.ok(position > previous, `${id} is missing or out of keyboard order`);
    previous = position;
  }
  assert.doesNotMatch(html, /\saccesskey=/i);
});

test('visible help text is programmatically associated with its controls', () => {
  has(/<button id="add-task-button" type="button" aria-describedby="task-limit-help">Add task<\/button>/, 'task-limit help association missing');
  has(/<input id="minimum-send-interval"[^>]*aria-describedby="minimum-send-interval-help"/, 'minimum send interval help association missing');
  has(/<input id="retry-backoff"[^>]*aria-describedby="retry-backoff-help"/, 'retry-backoff help association missing');
  has(/<select id="retry-backoff-unit" aria-describedby="retry-backoff-help">/, 'retry-backoff unit help association missing');
  assert.match(js, /const existing = field\.getAttribute\('aria-describedby'\); field\.setAttribute\('aria-describedby', \[existing, error\.id\]/, 'validation must append error descriptions to static help');
  assert.match(js, /filter\(\(x\) => x && !x\.endsWith\('-error'\)\)/, 'clearing validation must preserve static help descriptions');
});

test('timing controls expose required limits and units', () => {
  has(/Minimum interval between actual sends, minutes<\/label>\s*<input id="minimum-send-interval" type="number" min="1" step="1" inputmode="numeric" aria-describedby="minimum-send-interval-help"/s);
  has(/Delay after prompt insertion before Send, seconds<\/label>\s*<input id="pre-send-delay" type="number" min="1" max="30"/s);
  has(/Busy-chat checks do not consume this interval\./);
  has(/<label for="retry-backoff">Retry\/backoff wait<\/label>/);
  has(/<label for="retry-backoff-unit">Retry\/backoff unit<\/label>/);
  has(/<option value="seconds">Seconds<\/option>/);
  has(/<option value="minutes">Minutes<\/option>/);
  has(/Used after temporary failures and after the exact Too many requests acknowledgement\./);
});

test('timing bounds are enforced by the JS Save validation path', () => {
  has(/id="busy-check-delay"[^>]*min="1"[^>]*max="30"/s, 'busy-check markup bounds missing');
  has(/id="retry-backoff"[^>]*min="5"[^>]*max="3600"/s, 'retry-backoff markup bounds missing');
  assert.match(js, /session\.busyCheckDelaySeconds\s*>=\s*1\s*&&\s*session\.busyCheckDelaySeconds\s*<=\s*30/);
  assert.match(js, /session\.retryBackoffSeconds\s*>=\s*5\s*&&\s*session\.retryBackoffSeconds\s*<=\s*3600/);
  assert.match(js, /retryBackoffAmount \* \(retryBackoffUnit === 'minutes' \? 60 : 1\)/);
  assert.match(js, /input\.min = minutes \? '1' : '5'/);
  assert.match(js, /input\.max = minutes \? '60' : '3600'/);
});

test('session and master runtime controls are present', () => {
  for (const id of ['create-session-button','save-session-button','start-session-button','pause-session-button','resume-session-button','stop-session-button','master-pause-button','master-resume-button','clear-log-button']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  has(/id="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-heading"/);
  assert.match(js, /function trapDialog\(event\)/);
  assert.match(js, /ui\.deleteReturnFocus/);
});

test('Create Session explicitly focuses and selects the Session name field', () => {
  assert.match(js, /async function createSession\(\)[\s\S]*?await openSession\(data\.session\.id\);\s*\$\('session-name'\)\.focus\(\);\s*\$\('session-name'\)\.select\(\);/);
});

test('runtime command outcome remains in persistent normal text', () => {
  has(/<p id="command-result" tabindex="0">No runtime command has been issued\.<\/p>/, 'persistent command result missing');
  assert.match(js, /function setCommandResult\(text\) \{ \$\('command-result'\)\.textContent = text; \}/);
  assert.match(js, /reportCommandResult\(`Command failed: \$\{error\.message\}`\)/);
  assert.match(js, /const data = await core\(command, \{ sessionId: ui\.selectedSessionId \}\);[\s\S]*reportCommandResult\(`Core acknowledged \$\{label\}/, 'session command success must follow Core acknowledgement');
  assert.match(js, /const data = await core\(command\);[\s\S]*data\?\.masterPaused !== expectedMasterPaused[\s\S]*reportCommandResult\(`Core acknowledged \$\{label\}/, 'master command success must follow Core acknowledgement');
});

test('runtime status renders Core read-model fields without a UI state machine', () => {
  for (const field of ['currentTaskStatus','operationPhase','lastAction','lastActionAt','nextAllowedSendAt','currentTaskRetryAt','currentTaskManualReviewReason','lastError']) {
    assert.ok(js.includes(`s.${field}`), `missing Core status field ${field}`);
  }
  assert.match(js, /\['Session state', ui\.selected\.runState \|\| 'STOPPED'\]/);
  assert.doesNotMatch(js, /switch\s*\(\s*ui\.selected\.runState/);
  assert.doesNotMatch(js, /case\s+'RATE_LIMITED'/);
  assert.doesNotMatch(js, /case\s+'RETRY_WAIT'/);
});

test('bounded Core log remains keyboard-readable and reports its visible entry count', () => {
  has(/id="session-log-bound">Core retains a bounded session log\. The options page shows only the newest 100 entries to stay responsive\.<\/p>/);
  has(/id="session-log-count">0 Core log entries shown\.<\/p>/);
  assert.match(js, /const VISIBLE_LOG_LIMIT = 100/);
  assert.match(js, /const entries = ui\.selected\.log \|\| \[\]/);
  assert.match(js, /const visible = entries\.slice\(-VISIBLE_LOG_LIMIT\)/);
  assert.match(js, /\$\('session-log-count'\)\.textContent/);
});

test('dynamic tasks are capped, ordered, labelled and focus-managed in implementation', () => {
  assert.match(js, /const MAX_TASKS = 50/);
  assert.match(js, /task-url-\$\{task\.id\}/);
  assert.match(js, /Task \$\{ordinal\} ChatGPT URL/);
  assert.match(js, /Remove Task \$\{ordinal\}/);
  assert.match(js, /focusTaskId/);
  assert.match(js, /ui\.selected\.tasks\.length >= MAX_TASKS/);
});

test('UI talks to Core by message protocol rather than owning scheduler/storage', () => {
  assert.match(js, /chrome\.runtime\.sendMessage/);
  for (const command of ['LIST_SESSIONS','GET_SESSION','CREATE_SESSION','UPDATE_SESSION','START_SESSION','PAUSE_SESSION','RESUME_SESSION','STOP_SESSION','DELETE_SESSION','MASTER_PAUSE','MASTER_RESUME']) {
    assert.ok(js.includes(`'${command}'`), `missing Core command ${command}`);
  }
  assert.doesNotMatch(js, /chrome\.storage/);
  assert.doesNotMatch(js, /chrome\.alarms/);
  assert.doesNotMatch(js, /chrome\.tabs/);
});

test('validation uses aria-invalid, aria-describedby and deterministic focus', () => {
  assert.match(js, /setAttribute\('aria-invalid', 'true'\)/);
  assert.match(js, /setAttribute\('aria-describedby'/);
  assert.match(js, /summary\.focus\(\)/);
  assert.match(js, /\$\(errors\[0\]\[0\]\)\?\.focus\(\)/);
});

test('multi-error validation summary is a named programmatic focus region', () => {
  has(/id="form-error-summary" tabindex="-1" role="region" aria-label="Configuration errors" hidden/, 'focused error summary must expose a stable accessible name');
  assert.doesNotMatch(html, /id="form-error-summary"[^>]*(?:role="alert"|aria-live)/i, 'focused error summary must not add a second assertive announcement path');
  assert.match(js, /summary\.focus\(\)/);
});

test('background status refresh is coalesced without reopening the selected session or stealing editor focus', () => {
  assert.match(js, /async function refreshSelectedSessionStatus\(sessionId\)/);
  assert.match(js, /function queueStatusRefresh\(sessionId\)/);
  assert.match(js, /statusRefreshTimer = setTimeout\(flushStatusRefresh, STATUS_REFRESH_DELAY_MS\)/);
  assert.match(js, /async function flushStatusRefresh\(\)[\s\S]*if \(ui\.selectedSessionId && dirty\.has\(ui\.selectedSessionId\)\) \{\s*await refreshSelectedSessionStatus\(ui\.selectedSessionId\);\s*\}/s);
  assert.match(js, /queueStatusRefresh\(message\.sessionId\)/);
  assert.doesNotMatch(js, /if \(message\.sessionId === ui\.selectedSessionId\) openSession\(ui\.selectedSessionId\)/);
});

test('structured background status is readable without becoming a repeated live announcement', () => {
  has(/<div id="session-status-region"><\/div>/, 'status region must remain in normal document flow');
  assert.doesNotMatch(html, /id="session-status-region"[^>]*aria-live/i, 'background status container must not announce every rerender');
  has(/id="live-announcer" class="visually-hidden" aria-live="polite" aria-atomic="true"/, 'dedicated concise live announcer must remain available');
});

test('app status avoids duplicate live-region mutations on background refresh', () => {
  has(/id="app-status" role="status"/, 'app status must remain a status live region');
  assert.match(js, /function setAppStatus\(text\) \{\s*const status = \$\('app-status'\);\s*if \(status\.textContent === text\) return;\s*status\.textContent = text;\s*\}/s);
  assert.match(js, /setAppStatus\('Connected to Core\.'\)/);
});

test('session-list refresh restores the same control by stable id when list DOM is replaced', () => {
  assert.match(js, /const activeId = preserveFocus \? active\?\.id \|\| null : null/);
  assert.match(js, /else if \(activeId\) \$\(activeId\)\?\.focus\(\)/);
});

test('Session navigation marks exactly the opened Session as current without toggle semantics', () => {
  assert.match(js, /function syncCurrentSessionMarker\(\)/);
  assert.match(js, /querySelectorAll\('#session-list \[aria-current=\"page\"\]'\)\.forEach\(\(element\) => element\.removeAttribute\('aria-current'\)\)/);
  assert.match(js, /if \(ui\.selectedSessionId\) \$\(`session-select-\$\{ui\.selectedSessionId\}`\)\?\.setAttribute\('aria-current', 'page'\)/);
  assert.match(js, /function renderSessionList\(\)[\s\S]*syncCurrentSessionMarker\(\);/);
  assert.match(js, /ui\.selectedSessionId = sessionId;\s*syncCurrentSessionMarker\(\);/);
  assert.doesNotMatch(js, /aria-pressed/);
});

test('delete dialog names its target and successful deletion restores focus deterministically', () => {
  has(/id="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-heading" aria-describedby="delete-dialog-description"/);
  assert.match(js, /Rename session \$\{sessionName\}/);
  assert.match(js, /Duplicate session \$\{sessionName\}/);
  assert.match(js, /Delete session \$\{sessionName\}/);
  assert.match(js, /delete-dialog-description'\)\.textContent = `Delete session \$\{sessionName\}\./);
  assert.match(js, /confirm-delete-button'\)\.setAttribute\('aria-label', `Delete session \$\{sessionName\}`\)/);
  assert.match(js, /function deleteFocusTargetId\(sessionId\)/);
  assert.match(js, /ui\.sessions\[index \+ 1\] \|\| ui\.sessions\[index - 1\]/);
  assert.match(js, /closeDeleteDialog\(\{ restoreFocus: false \}\)/);
  assert.match(js, /await loadSessions\(\{ preserveFocus: false \}\)/);
  assert.match(js, /\(\$\(focusTargetId\) \|\| \$\('create-session-button'\)\)\.focus\(\)/);
  assert.match(js, /catch \(e\) \{ setAppStatus\(e\.message\); announce\(e\.message\); \}/);
});

test('Core command failures remain readable in normal status text and command-result text', () => {
  assert.match(js, /async function duplicateSession\(id\).*?catch \(e\) \{ setAppStatus\(e\.message\); announce\(e\.message\); \}/s);
  assert.match(js, /async function action\(command, label\).*?catch \(error\) \{\s*setAppStatus\(error\.message\);\s*reportCommandResult\(`Command failed: \$\{error\.message\}`\);\s*\}/s);
  assert.match(js, /async function masterAction\(command, label, expectedMasterPaused\).*?catch \(error\) \{\s*setAppStatus\(error\.message\);\s*reportCommandResult\(`Command failed: \$\{error\.message\}`\);\s*\}/s);
  for (const command of ['START_SESSION','PAUSE_SESSION','RESUME_SESSION','STOP_SESSION','CLEAR_LOG']) {
    assert.ok(js.includes(`action('${command}'`), `missing persistent-error action path for ${command}`);
  }
});
