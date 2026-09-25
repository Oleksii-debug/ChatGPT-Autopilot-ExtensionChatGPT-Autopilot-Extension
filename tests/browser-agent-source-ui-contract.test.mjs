import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

test('Agent source context controls are labelled and keyboard-native', () => {
  for (const id of [
    'agent-source-tab',
    'agent-source-refresh-button',
    'agent-source-permission-button',
    'agent-source-selection-button',
    'agent-source-page-button',
    'agent-source-clear-button',
    'agent-source-status',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<label for="agent-source-tab">/);
  assert.match(html, /id="agent-source-status" role="status"/);
  assert.match(html, /Текст сторінки не може надати дозвіл, змінити політику чи стати вашою інструкцією/);
});

test('Agent source capture stays separate from owner goal and is passed as structured provenance', () => {
  assert.match(ui, /core\('CAPTURE_BROWSER_AGENT_SOURCE', \{ tabId: selected\.tabId, kind \}\)/);
  assert.match(ui, /initialSourceContext: attachedSource/);
  assert.match(ui, /const goal = \$\('agent-prompt'\)\.value\.trim\(\)/);
  assert.doesNotMatch(ui, /goal\s*[:=][^\n]*pendingAgentSourceContext/);
});

test('source tab listing and capture are read-only service-worker commands', () => {
  const readOnlyBlock = worker.match(/const READ_ONLY_UI_COMMANDS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
  assert.match(readOnlyBlock, /'LIST_BROWSER_AGENT_SOURCE_TABS'/);
  assert.match(readOnlyBlock, /'CAPTURE_BROWSER_AGENT_SOURCE'/);
  assert.match(worker, /selectionSourceCapture\.listTabs\(\)/);
  assert.match(worker, /selectionSourceCapture\.capture\(message\.payload \|\| \{\}\)/);
});
