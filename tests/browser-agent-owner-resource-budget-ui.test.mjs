import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');

test('owner Agent capacity control is keyboard-native and explicitly labelled for screen readers', () => {
  assert.match(html, /<label for="agent-owner-max-concurrent">[^<]+<\/label>/);
  assert.match(
    html,
    /<input id="agent-owner-max-concurrent" type="number" min="0" max="256" step="1" inputmode="numeric" value="0" aria-describedby="agent-owner-max-concurrent-help">/,
  );
  assert.match(html, /<button id="agent-owner-resource-budget-save-button" type="button">/);
  assert.match(html, /<p id="agent-owner-resource-budget-status" role="status" tabindex="0">/);
  assert.match(html, /0 означає: не видавати нові Specialist leases/);
});

test('capacity UI reads durable revision, preserves other ResourceBudget dimensions and performs CAS save', () => {
  assert.match(js, /core\('GET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET'\)/);
  assert.match(
    js,
    /core\('SET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET',[\s\S]*?expectedRevision: state\.revision,[\s\S]*?\.\.\.\(state\.budget \|\| \{\}\),[\s\S]*?maxConcurrentAgents/,
  );
  assert.match(js, /parseStrictBoundedInteger\(input\.value,[\s\S]*?min: 0,[\s\S]*?max: 256/);
  assert.match(js, /loadBrowserAgentOwnerResourceBudget\(\)/);
  assert.match(js, /agent-owner-resource-budget-save-button'\)\.addEventListener\('click', saveBrowserAgentOwnerResourceBudget\)/);
});

test('quarantined budget disables mutation controls and reports fail-closed state', () => {
  assert.match(js, /const quarantined = state\?\.quarantined === true/);
  assert.match(js, /input\.disabled = quarantined/);
  assert.match(js, /saveButton\.disabled = quarantined/);
  assert.match(js, /нова Specialist capacity закрита/);
});

test('failed budget reread cannot re-enable mutation controls without a durable state', () => {
  assert.match(
    js,
    /if \(ui\.ownerResourceBudgetState && ui\.ownerResourceBudgetState\.quarantined !== true\)/,
  );
});
