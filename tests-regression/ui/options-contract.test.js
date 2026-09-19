import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../../src/ui/options.js', import.meta.url), 'utf8');

function has(pattern, message) { assert.match(html, pattern, message); }

test('page exposes semantic landmarks and five explicit operating modes', () => {
  has(/<html lang="uk">/, 'Ukrainian document language missing');
  has(/<h1 id="page-title">ChatGPT Autopilot<\/h1>/, 'missing H1');
  has(/<nav id="session-navigation" aria-label="Сеанси" data-app-mode="sessions">/, 'missing labelled session nav');
  has(/<main id="main" tabindex="-1">/, 'missing main landmark');
  has(/id="mode-tabs"[^>]*role="tablist"/, 'mode tablist missing');
  for (const id of ['mode-sessions','mode-orchestration','mode-scenario-work','mode-agent','mode-ai']) assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  assert.match(js, /element\.hidden = element\.dataset\.appMode !== next/, 'mode switching must actually hide inactive mode surfaces');
  assert.match(js, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/, 'mode tablist must support keyboard arrow navigation');
  has(/id="session-status-region"/, 'missing readable status region');
  has(/id="session-log-region" tabindex="0" aria-label="Session log"/, 'missing readable log');
});

test('all static controls use native elements and persistent labels/legends', () => {
  assert.doesNotMatch(html, /role="button"/i);
  assert.doesNotMatch(html, /tabindex="[1-9][0-9]*"/i);
  has(/<label for="session-name">Session name<\/label>/, 'session name label missing');
  has(/<fieldset id="task-configuration-mode">\s*<legend>Task configuration mode<\/legend>/s, 'task configuration mode fieldset missing');
  has(/<fieldset id="run-mode">\s*<legend>Run mode<\/legend>/s, 'run mode fieldset missing');
  has(/<fieldset id="tab-strategy">\s*<legend>Tab strategy<\/legend>/s, 'tab strategy fieldset missing');
});

test('static keyboard controls follow a stable logical DOM order with no accesskey overrides', () => {
  const orderedIds = [
    'master-pause-button', 'master-resume-button', 'create-session-button',
    'session-name', 'mode-same-url-shared-prompt', 'mode-same-url-unique-prompts',
    'mode-unique-urls-shared-prompt', 'mode-unique-urls-unique-prompts', 'shared-task-url', 'shared-prompt',
    'run-mode-one-pass', 'run-mode-continuous', 'task-count',
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

test('configuration UI stays concise without broken aria-describedby references', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) {
    for (const ref of match[1].split(/\s+/)) assert.ok(ids.has(ref), `missing aria-describedby target ${ref}`);
  }
  assert.doesNotMatch(html, /Busy-chat checks do not consume this interval/);
  assert.doesNotMatch(html, /Keep the extension installed\. Give the JSON template/);
  assert.doesNotMatch(html, /The extension first presses “Understood”/);
  assert.match(js, /field\.setAttribute\('aria-describedby'/, 'validation errors must remain programmatically described');
});

test('timing controls expose required limits and units without tutorial prose', () => {
  has(/Minimum interval between actual sends<\/label>\s*<input id="minimum-send-interval" type="number" min="1" step="1" inputmode="numeric"/s);
  has(/<label for="minimum-send-interval-unit">Interval unit<\/label>/);
  has(/<option value="minutes">Minutes<\/option>/);
  has(/<option value="seconds">Seconds<\/option>/);
  has(/Delay after prompt insertion before Send, seconds<\/label>\s*<input id="pre-send-delay" type="number" min="1" max="30"/s);
  has(/<label for="retry-backoff">Retry\/backoff wait<\/label>/);
  has(/<label for="retry-backoff-unit">Retry\/backoff unit<\/label>/);
  has(/<option value="seconds">Seconds<\/option>/);
  has(/<option value="minutes">Minutes<\/option>/);
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
  assert.match(js, /\['Session state', s\.displayRunState \|\| ui\.selected\.runState \|\| 'STOPPED'\]/);
  assert.doesNotMatch(js, /switch\s*\(\s*ui\.selected\.runState/);
  assert.doesNotMatch(js, /case\s+'RATE_LIMITED'/);
  assert.doesNotMatch(js, /case\s+'RETRY_WAIT'/);
});

test('bounded Core log remains keyboard-readable and reports its visible entry count', () => {
  has(/id="session-log-count">0 Core log entries shown\.<\/p>/);
  assert.match(js, /const VISIBLE_LOG_LIMIT = 100/);
  assert.match(js, /const entries = ui\.selected\.log \|\| \[\]/);
  assert.match(js, /const visible = entries\.slice\(-VISIBLE_LOG_LIMIT\)/);
  assert.match(js, /\$\('session-log-count'\)\.textContent/);
});

test('task-count spinner drives compact million-cycle and bounded physical task modes', () => {
  assert.match(js, /const MAX_PHYSICAL_TASKS = 1000/);
  assert.match(js, /const MAX_TASKS = 1_000_000/);
  has(/id="task-count" type="number" min="1" max="1000000"/);
  for (const value of ['same-url-shared-prompt','same-url-unique-prompts','unique-urls-shared-prompt','unique-urls-unique-prompts']) {
    assert.ok(html.includes(`value="${value}"`), `missing mode ${value}`);
  }
  assert.match(js, /function resizeTasks\(rawCount\)/);
  assert.match(js, /const compactShared = urlMode === 'shared' && promptMode === 'shared'/);
  assert.match(js, /const physicalCount = compactShared \? 1 : Math\.min\(MAX_PHYSICAL_TASKS, requested\)/);
  assert.match(js, /ui\.selected\.configuredTaskCount = compactShared \? requested : physicalCount/);
  assert.match(js, /task-url-\$\{task\.id\}/);
  assert.match(js, /task-prompt-\$\{task\.id\}/);
  assert.doesNotMatch(html, /id="add-task-button"/);
});


test('unsaved draft persistence preserves the selected URL mode', () => {
  assert.match(js, /function portableDraftConfig\(session\)[\s\S]*urlMode: session\.urlMode/);
  assert.match(js, /return \{[\s\S]*\.\.\.canonical,[\s\S]*\.\.\.clone\(config\)/, 'restored draft must reapply persisted URL mode');
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
  assert.match(js, /ui\.selectedSessionId = sessionId;\s*storageSet\(LAST_SESSION_KEY, sessionId\);\s*syncCurrentSessionMarker\(\);/);
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


test('Multi-Agent Orchestration V2 exposes concise owner limits, profile files and observability', () => {
  for (const id of [
    'orchestration-v2-enabled','orchestration-v2-project-id','orchestration-v2-target-repository',
    'orchestration-v2-control-repository','orchestration-v2-control-issue','orchestration-v2-control-comment',
    'orchestration-v2-master-prompt','orchestration-v2-tick-prompt','orchestration-v2-desired-workers','orchestration-v2-max-workers',
    'orchestration-v2-max-launches-window','orchestration-v2-launch-window','orchestration-v2-min-launch-gap',
    'orchestration-v2-worker-probe','orchestration-v2-watchdog','orchestration-v2-max-turns','orchestration-v2-stale-worker',
    'download-orchestration-v2-template','orchestration-v2-profile-file','import-orchestration-v2-profile-button','export-orchestration-v2-profile-button',
    'save-orchestration-v2-button','test-orchestration-v2-button','run-orchestration-v2-button','stop-orchestration-v2-button',
    'orchestration-v2-status','orchestration-v2-runtime',
  ]) assert.ok(html.includes(`id="${id}"`), `missing Orchestration V2 control ${id}`);
  has(/id="orchestration-v2-desired-workers" type="number" min="0" max="200"/, 'initial workers must support large bounded pools');
  has(/id="orchestration-v2-status" role="status"/, 'Orchestration V2 state changes must be announced');
  has(/id="orchestration-v2-runtime" tabindex="0"/, 'Orchestration V2 runtime summary must be keyboard readable');
  assert.match(js, /core\('GET_ORCHESTRATION_V2_STATUS'\)/);
  assert.match(js, /core\('UPDATE_ORCHESTRATION_V2_SETTINGS'/);
  assert.match(js, /core\('TEST_ORCHESTRATION_V2_CONTROL'/);
  assert.match(js, /core\('PREVIEW_ORCHESTRATION_V2_PROFILE'/);
  assert.match(js, /core\('IMPORT_ORCHESTRATION_V2_PROFILE'/);
  assert.match(js, /core\('EXPORT_ORCHESTRATION_V2_PROFILE'/);
  assert.match(js, /core\('RUN_ORCHESTRATION_V2_NOW'\)/);
  assert.match(js, /core\('EMERGENCY_STOP_ORCHESTRATION_V2'\)/);
  assert.match(js, /parseStrictBoundedInteger\(\$\(id\)\.value, \{ min, max, label \}\)/, 'numeric orchestration fields must reject blank or non-integer values before Core update');
  assert.doesNotMatch(js, /Workers Q\/A\/B\/C\/F:/, 'runtime summary must not expose cryptic worker-state abbreviations');
  assert.match(js, /await loadOrchestrationV2Status\(\);[\s\S]*?await loadRemoteDispatchStatus\(\);/, 'initial load must populate orchestration status');
  assert.doesNotMatch(js, /orchestration-v2[\s\S]{0,300}chrome\.storage/, 'Orchestration V2 UI must not own durable storage');
  for (const [id, legend] of [
    ['orchestration-v2-project-group', 'Проєкт і control'],
    ['orchestration-v2-coordinator-group', 'Coordinator'],
    ['orchestration-v2-limits-group', 'Локальні ліміти'],
  ]) {
    assert.ok(html.includes(`<fieldset class="settings-group" id="${id}">`), `missing semantic group ${id}`);
    assert.ok(html.includes(`<legend>${legend}</legend>`), `missing semantic group legend ${legend}`);
  }
  has(/id="orchestration-v2-control-comment"[^>]*aria-describedby="orchestration-v2-control-comment-help"/, 'control comment auto-discovery help must be programmatically associated');
  has(/id="orchestration-v2-max-launches-window"[^>]*aria-describedby="orchestration-v2-launch-limit-help"/, 'launch window zero semantics must be programmatically associated');
  assert.match(js, /launch \${launch}, gap \${preview\.minimumLaunchIntervalSeconds \?\? 0}s; \${preview\.coordinatorProviderId \|\| '\?'} → \${preview\.workerProviderId \|\| '\?'}; Issue \${preview\.controlIssueNumber \|\| 0}, \${comment}/, 'profile preview must expose launch policy, providers and control comment before import');
  assert.match(js, /orchestration-v2-control-comment'\)\.value = config\.controlCommentId \? String\(config\.controlCommentId\) : ''/, 'auto-discovered provider comment must not silently pin the editable config field');
  assert.match(js, /Control \${controlCommentText}/, 'runtime summary must show discovered-vs-pinned control comment state');
});

test('Browser Agent exposes prompt-first autonomous UX with optional policy and explicit site permission controls', () => {
  for (const id of [
    'mode-agent','agent-prompt','agent-run-prompt-button','agent-pause-button','agent-resume-button','agent-stop-button',
    'agent-follow-up','agent-send-follow-up-button','agent-job-list','agent-history','agent-allow-current-site-button','agent-allow-all-sites-button',
    'agent-repeat-mode','agent-interval-seconds','agent-schedule-start','agent-schedule-end','agent-active-window-start','agent-active-window-end',
    'agent-ai-routing-mode','agent-ai-primary-provider','agent-ai-primary-model','agent-ai-strong-provider','agent-ai-strong-model',
    'agent-max-model-calls','agent-max-input-tokens','agent-max-output-tokens','agent-max-total-tokens','agent-max-runtime-minutes','agent-max-cost-usd',
    'agent-approval-panel','agent-approval-status','agent-approval-script','agent-approve-action-button','agent-reject-action-button','agent-approval-mode','agent-vision-on-demand','agent-trusted-script-enabled',
  ]) assert.ok(html.includes(`id="${id}"`), `missing Browser Agent control ${id}`);
  has(/<label for="agent-prompt">Що потрібно зробити\?<\/label>/, 'Agent must lead with a natural-language task composer');
  has(/id="agent-status" role="status"/, 'Agent status must be announced');
  has(/id="agent-history" tabindex="0" aria-label="Історія роботи агента"/, 'Agent history must be keyboard readable');
  assert.match(js, /core\('CREATE_BROWSER_AGENT_JOB'/);
  assert.match(js, /core\('START_BROWSER_AGENT_JOB'/);
  assert.match(js, /core\('ADD_BROWSER_AGENT_INSTRUCTION'/);
  assert.match(js, /core\('RUN_BROWSER_AGENT_BURST'/);
  assert.match(js, /chrome\.permissions\.request\(\{ origins \}\)/, 'site access must be explicit through Chrome optional permissions');
  assert.ok(js.includes("repeatMode: $('agent-repeat-mode').value"), 'schedule/repeat policy must be persisted through Core');
  assert.match(js, /WAITING_SCHEDULE: 'очікує розкладу'/, 'scheduled wait must be exposed in readable status');
  assert.match(js, /WAITING_APPROVAL: 'очікує підтвердження дії'/, 'approval wait must be exposed in readable status');
  assert.match(js, /core\('APPROVE_BROWSER_AGENT_ACTION'/, 'approval button must route through Core');
  assert.match(js, /core\('REJECT_BROWSER_AGENT_ACTION'/, 'rejection button must route through Core');
  assert.ok(js.includes("approvalMode: $('agent-approval-mode').value"), 'approval policy must be persisted through Core');
  assert.ok(js.includes("visionOnDemand: $('agent-vision-on-demand').checked"), 'vision policy must be persisted through Core');
  assert.ok(js.includes("trustedScriptEnabled: $('agent-trusted-script-enabled').checked"), 'Trusted Script opt-in must be persisted through Core');
  assert.match(html, /JavaScript, який Agent просить виконати/, 'Trusted Script approval must expose code in a keyboard/NVDA-readable panel');
  assert.ok(js.includes("aiRoutingMode: $('agent-ai-routing-mode').value"), 'per-Agent AI routing mode must persist through Core');
  assert.ok(js.includes("aiPrimaryProvider: $('agent-ai-primary-provider').value"), 'per-Agent primary provider override must persist through Core');
  assert.ok(js.includes("aiStrongProvider: $('agent-ai-strong-provider').value"), 'per-Agent strong provider override must persist through Core');
});

test('Remote Dispatch exposes keyboard/NVDA-readable GitHub feed configuration and status', () => {
  for (const id of [
    'remote-dispatch-enabled','remote-dispatch-intake-paused','remote-dispatch-project-id',
    'remote-dispatch-repository','remote-dispatch-issue','remote-dispatch-poll',
    'remote-dispatch-fallback-enabled','remote-dispatch-fallback-session','remote-dispatch-fallback-after','remote-dispatch-auto-start',
    'save-remote-dispatch-button','test-remote-dispatch-button','run-remote-dispatch-button',
    'remote-dispatch-status','remote-dispatch-runtime',
  ]) assert.ok(html.includes(`id="${id}"`), `missing Remote Dispatch control ${id}`);
  has(/id="remote-dispatch-status" role="status"/, 'Remote Dispatch save/test result must be announced');
  has(/id="remote-dispatch-runtime" tabindex="0"/, 'Remote Dispatch runtime summary must be keyboard readable');
  assert.match(js, /core\('GET_REMOTE_DISPATCH_STATUS'\)/);
  assert.match(js, /core\('UPDATE_REMOTE_DISPATCH_SETTINGS'/);
  assert.match(js, /core\('TEST_REMOTE_DISPATCH_FEED'/);
  assert.match(js, /core\('RUN_REMOTE_DISPATCH_NOW'\)/);
  assert.doesNotMatch(js, /remote-dispatch[\s\S]{0,300}chrome\.storage/, 'Remote Dispatch UI must not own durable storage');
});

test('orchestration controls explain per-orchestra pause/resume/stop and expose no inert fallback toggle', () => {
  assert.match(html, /Призупинити оркестр/);
  assert.match(html, /Продовжити оркестр/);
  assert.match(html, /Пауза стосується лише вибраного оркестру/);
  assert.match(html, /інші оркестри продовжують працювати/);
  assert.match(html, /Аварійно зупинити вибраний оркестр/);
  assert.match(html, /Інші оркестри не зупиняються/);
  assert.doesNotMatch(html, /orchestration-v2-fallback-prompt/);
});

test('orchestration action availability is recomputed after busy operations instead of blindly enabling invalid controls', () => {
  assert.match(js, /function syncOrchestrationV2ActionAvailability\(/, 'orchestration availability helper missing');
  assert.match(js, /resume-orchestration-v2-orchestra-button'[\s\S]*selected\?\.ownerPaused !== true/, 'resume availability must depend on selected orchestra pause state');
  assert.match(js, /delete-orchestration-v2-orchestra-button'[\s\S]*!hasSelected/, 'delete must stay disabled without a selected orchestra');
  assert.match(js, /import-orchestration-v2-profile-button'[\s\S]*!ui\.pendingOrchestrationProfile/, 'import must stay disabled without a validated profile');
});


test('Orchestration JSON import is visible in zero state and remains setup-only', () => {
  const orchestrasPanelStart = html.indexOf('id="orchestration-v2-orchestras-panel"');
  const settingsPanelStart = html.indexOf('id="orchestration-v2-settings-panel"');
  const importInput = html.indexOf('id="orchestration-v2-profile-file"');
  assert.ok(orchestrasPanelStart >= 0 && importInput > orchestrasPanelStart && importInput < settingsPanelStart, 'JSON file input must be directly visible on Orchestras panel');
  has(/<legend>Завантажити JSON оркестру<\/legend>/);
  has(/id="import-orchestration-v2-profile-button"[^>]*>Імпортувати JSON<\/button>/);
  assert.match(js, /import-orchestration-v2-profile-button'\)\.disabled = Boolean\(busy\) \|\| !ui\.pendingOrchestrationProfile/);
  assert.doesNotMatch(js, /import-orchestration-v2-profile-button'\)\.disabled = Boolean\(busy\) \|\| !hasSelected/);
  assert.match(js, /JSON оркестру імпортовано\. Автоматичного запуску не було\./);
});


test('orchestration profile preview exposes imported hierarchy counts in normal text', () => {
  assert.match(js, /const hierarchy = preview\.hierarchy/);
  assert.match(js, /ієрархія \$\{preview\.hierarchy\.nodeCount\} вузлів/);
  assert.match(js, /\$\{preview\.hierarchy\.rootCount\} коренів/);
  assert.match(js, /\$\{preview\.hierarchy\.promptProfileCount\} профілів промтів/);
});
