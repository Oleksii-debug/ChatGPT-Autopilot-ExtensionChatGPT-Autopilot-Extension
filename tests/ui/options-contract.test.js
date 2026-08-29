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
  has(/id="session-status-region" aria-live="polite"/, 'missing status live region');
  has(/id="session-log-region" tabindex="0" aria-label="Session log"/, 'missing readable log');
});

test('all static controls use native elements and persistent labels/legends', () => {
  assert.doesNotMatch(html, /role="button"/i);
  assert.doesNotMatch(html, /tabindex="[1-9][0-9]*"/i);
  has(/<label for="session-name">Session name<\/label>/, 'session name label missing');
  has(/<fieldset id="prompt-mode">\s*<legend>Prompt mode<\/legend>/s, 'prompt mode fieldset missing');
  has(/<fieldset id="run-mode">\s*<legend>Run mode<\/legend>/s, 'run mode fieldset missing');
  has(/<fieldset id="tab-strategy">\s*<legend>Tab strategy<\/legend>/s, 'tab strategy fieldset missing');
});

test('timing controls expose required limits and units', () => {
  has(/Minimum interval between actual sends, minutes<\/label>\s*<input id="minimum-send-interval" type="number" min="1" step="1"/s);
  has(/Delay after prompt insertion before Send, seconds<\/label>\s*<input id="pre-send-delay" type="number" min="1" max="30"/s);
  has(/Busy-chat checks do not consume this interval\./);
});

test('timing bounds are enforced by the JS Save validation path', () => {
  has(/id="busy-check-delay"[^>]*min="1"[^>]*max="30"/s, 'busy-check markup bounds missing');
  has(/id="retry-backoff"[^>]*min="5"[^>]*max="3600"/s, 'retry-backoff markup bounds missing');
  assert.match(js, /session\.busyCheckDelaySeconds\s*>=\s*1\s*&&\s*session\.busyCheckDelaySeconds\s*<=\s*30/);
  assert.match(js, /session\.retryBackoffSeconds\s*>=\s*5\s*&&\s*session\.retryBackoffSeconds\s*<=\s*3600/);
});

test('session controls and delete dialog are present', () => {
  for (const id of ['create-session-button','save-session-button','start-session-button','pause-session-button','resume-session-button','stop-session-button','clear-log-button']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  has(/id="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-heading"/);
  assert.match(js, /function trapDialog\(event\)/);
  assert.match(js, /ui\.deleteReturnFocus/);
});

test('Create Session explicitly focuses and selects the Session name field', () => {
  assert.match(js, /async function createSession\(\)[\s\S]*?await openSession\(data\.session\.id\);\s*\$\('session-name'\)\.focus\(\);\s*\$\('session-name'\)\.select\(\);/);
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
  for (const command of ['LIST_SESSIONS','GET_SESSION','CREATE_SESSION','UPDATE_SESSION','START_SESSION','PAUSE_SESSION','RESUME_SESSION','STOP_SESSION','DELETE_SESSION']) {
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

test('background status refresh does not reopen the selected session or steal editor focus', () => {
  assert.match(js, /async function refreshSelectedSessionStatus\(sessionId\)/);
  assert.match(js, /renderStatus\(\);\s*renderLog\(\);\s*renderActions\(\);/s);
  assert.match(js, /if \(message\.sessionId === ui\.selectedSessionId\) void refreshSelectedSessionStatus\(ui\.selectedSessionId\)/);
  assert.doesNotMatch(js, /if \(message\.sessionId === ui\.selectedSessionId\) openSession\(ui\.selectedSessionId\)/);
});

test('session-list refresh restores the same control by stable id when list DOM is replaced', () => {
  assert.match(js, /const activeId = preserveFocus \? active\?\.id \|\| null : null/);
  assert.match(js, /else if \(activeId\) \$\(activeId\)\?\.focus\(\)/);
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
