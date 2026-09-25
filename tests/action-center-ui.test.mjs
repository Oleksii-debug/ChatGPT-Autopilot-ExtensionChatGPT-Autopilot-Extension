import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

test('Action Center shell is semantic and polling remains non-live; approval controls are created only from current runtime items', () => {
  const section = html.match(/<section id="action-center-panel"[\s\S]*?<\/section>/u)?.[0] || '';
  assert.match(section, /aria-labelledby="action-center-heading"/u);
  assert.match(section, /id="action-center-heading"/u);
  assert.match(section, /id="action-center-summary" tabindex="0"/u);
  assert.match(section, /<ul id="action-center-list" aria-label="[^"]+"/u);
  assert.doesNotMatch(section, /<button\b/iu);
  assert.doesNotMatch(section, /aria-live=/iu);
});

test('GET_ACTION_CENTER is explicitly read-only and projects canonical Core plus Browser Agent state', () => {
  const readOnlyBlock = worker.match(/const READ_ONLY_UI_COMMANDS = new Set\(\[[\s\S]*?\]\);/u)?.[0] || '';
  assert.match(readOnlyBlock, /'GET_ACTION_CENTER'/u);
  assert.match(worker, /message\.command === 'GET_ACTION_CENTER'/u);
  assert.match(worker, /Promise\.all\(\[repo\.load\(\), browserAgent\.list\(\)\]\)/u);
  assert.match(worker, /projectRuntimeActionCenter\(\{ coreState, agentJobs: agentState\.jobs \}\)/u);
});

test('Sessions UI loads Action Center without turning periodic refresh into a live-region announcement', () => {
  assert.match(ui, /core\('GET_ACTION_CENTER'\)/u);
  assert.match(ui, /function renderActionCenter\(data\)/u);
  assert.match(ui, /void loadActionCenter\(\)/u);
  assert.match(ui, /Очікувані дії Browser Agent можна схвалити або відхилити тут/u);
  assert.doesNotMatch(html.match(/<section id="action-center-panel"[\s\S]*?<\/section>/u)?.[0] || '', /aria-live=/iu);
});


test('Action Center approval buttons are native, labelled, revision-bound and call only the canonical mutation command', () => {
  assert.match(ui, /item\.ownerActionKind === 'APPROVE_OR_DENY' && item\.sourceKind === 'APPROVAL'/u);
  assert.match(ui, /document\.createElement\('button'\)/u);
  assert.match(ui, /approve\.type = 'button'/u);
  assert.match(ui, /reject\.type = 'button'/u);
  assert.match(ui, /aria-label/u);
  assert.match(ui, /DECIDE_ACTION_CENTER_BROWSER_APPROVAL/u);
  assert.match(ui, /itemId: item\.itemId/u);
  assert.match(ui, /sourceRevisionId: item\.sourceRevisionId/u);
  assert.match(ui, /decision,/u);
  assert.match(ui, /summary\.focus\(\)/u);
});

test('Action Center decision command is state-changing and resolves current canonical state before existing Browser Agent owner controls', () => {
  const readOnlyBlock = worker.match(/const READ_ONLY_UI_COMMANDS = new Set\(\[[\s\S]*?\]\);/u)?.[0] || '';
  assert.doesNotMatch(readOnlyBlock, /DECIDE_ACTION_CENTER_BROWSER_APPROVAL/u);
  assert.match(worker, /resolveRuntimeActionCenterBrowserApproval/u);
  assert.match(worker, /message\.command === 'DECIDE_ACTION_CENTER_BROWSER_APPROVAL'/u);
  assert.match(worker, /browserAgent\.approvePendingAction\(resolution\.jobId, \{ expectedApproval: resolution\.expectedApproval \}\)/u);
  assert.match(worker, /browserAgent\.rejectPendingAction\(resolution\.jobId, \{ expectedApproval: resolution\.expectedApproval \}\)/u);
  assert.match(worker, /result = \{ kind: 'APPROVED' \}/u);
  assert.match(worker, /result = \{ kind: 'REJECTED' \}/u);
});
