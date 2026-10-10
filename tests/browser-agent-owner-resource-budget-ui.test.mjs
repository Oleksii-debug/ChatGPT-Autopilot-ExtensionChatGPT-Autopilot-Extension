import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

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
    /if \(isWritableOwnerResourceBudgetSnapshot\(ui\.ownerResourceBudgetState\)\)/,
  );
});

function createOwnerBudgetUiHarness(coreHandler) {
  const start = js.indexOf('function isWritableOwnerResourceBudgetSnapshot(');
  const end = js.indexOf('\nasync function loadBrowserAgentJobs(', start);
  assert.ok(start >= 0 && end > start, 'owner budget functions remain isolateable');
  const nodes = Object.fromEntries([
    'agent-owner-resource-budget-status',
    'agent-owner-max-concurrent',
    'agent-owner-resource-budget-save-button',
  ].map(id => [id, { value: '', disabled: false, textContent: '', focus() {} }]));
  const calls = [];
  const announcements = [];
  const ui = { ownerResourceBudgetState: null };
  const context = {
    ui,
    $: id => {
      assert.ok(Object.hasOwn(nodes, id), `unexpected DOM target: ${id}`);
      return nodes[id];
    },
    core: async (name, payload) => {
      calls.push({ name, payload });
      return coreHandler(name, payload);
    },
    parseStrictBoundedInteger: (value, { min, max }) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('invalid capacity');
      return number;
    },
    announce: message => announcements.push(message),
  };
  const methods = runInNewContext(
    `${js.slice(start, end)}\n({loadBrowserAgentOwnerResourceBudget,saveBrowserAgentOwnerResourceBudget})`,
    context,
  );
  return { nodes, ui, calls, announcements, ...methods };
}

test('malformed revision and capacity reads never enable an owner-wide capacity write', async () => {
  const invalid = [
    null,
    {},
    { revision: '1', quarantined: false, budget: { maxConcurrentAgents: 2 } },
    { revision: -1, quarantined: false, budget: { maxConcurrentAgents: 2 } },
    { revision: Number.MAX_SAFE_INTEGER, quarantined: false, budget: { maxConcurrentAgents: 2 } },
    { revision: 0, quarantined: false, budget: { maxConcurrentAgents: '2' } },
    { revision: 0, quarantined: false, budget: { maxConcurrentAgents: 257 } },
    { revision: 0, quarantined: false, budget: { maxConcurrentAgents: -1 } },
    { revision: 0, quarantined: true, budget: { maxConcurrentAgents: 2 } },
  ];
  for (const sample of invalid) {
    const harness = createOwnerBudgetUiHarness(async () => sample);
    await harness.loadBrowserAgentOwnerResourceBudget();
    assert.equal(harness.nodes['agent-owner-max-concurrent'].disabled, true);
    assert.equal(harness.nodes['agent-owner-resource-budget-save-button'].disabled, true);
    assert.equal(harness.calls.length, 1);
    await harness.saveBrowserAgentOwnerResourceBudget();
    assert.equal(harness.calls.length, 1, 'invalid readback cannot dispatch SET');
  }
});

test('capacity read recovers only with fresh valid durable state and exact revision', async () => {
  let attempt = 0;
  const valid = { revision: 3, quarantined: false, budget: { maxConcurrentAgents: 4, maxDollars: 20 } };
  const harness = createOwnerBudgetUiHarness(async () => (++attempt === 1
    ? { revision: '3', quarantined: false, budget: { maxConcurrentAgents: 4 } }
    : valid));
  await harness.loadBrowserAgentOwnerResourceBudget();
  assert.equal(harness.nodes['agent-owner-resource-budget-save-button'].disabled, true);
  await harness.loadBrowserAgentOwnerResourceBudget();
  assert.equal(harness.nodes['agent-owner-resource-budget-save-button'].disabled, false);
  assert.equal(harness.nodes['agent-owner-max-concurrent'].value, '4');
  assert.equal(harness.ui.ownerResourceBudgetState.revision, 3);
});

test('malformed SET receipt is not announced as success or blindly retried', async () => {
  const valid = { revision: 2, quarantined: false, budget: { maxConcurrentAgents: 4, maxDollars: 20 } };
  const harness = createOwnerBudgetUiHarness(async command => command === 'SET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET'
    ? { revision: '3', quarantined: false, budget: { maxConcurrentAgents: 7 } }
    : valid);
  await harness.loadBrowserAgentOwnerResourceBudget();
  harness.nodes['agent-owner-max-concurrent'].value = '7';
  await harness.saveBrowserAgentOwnerResourceBudget();
  assert.deepEqual(harness.calls.map(call => call.name), [
    'GET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET',
    'SET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET',
    'GET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET',
  ]);
  assert.equal(harness.calls[1].payload.expectedRevision, 2);
  assert.equal(harness.calls[1].payload.budget.maxDollars, 20);
  assert.equal(harness.nodes['agent-owner-max-concurrent'].value, '4');
  assert.equal(harness.nodes['agent-owner-resource-budget-save-button'].disabled, false);
  assert.match(harness.nodes['agent-owner-resource-budget-status'].textContent, /не збережено/);
  assert.ok(harness.announcements.every(message => message !== 'Глобальну Specialist capacity збережено.'));
});

test('valid owner budget CAS save preserves unrelated dimensions and publishes the new revision', async () => {
  const valid = { revision: 2, quarantined: false, budget: { maxConcurrentAgents: 4, maxDollars: 20 } };
  const committed = { revision: 3, quarantined: false, budget: { maxConcurrentAgents: 7, maxDollars: 20 } };
  const harness = createOwnerBudgetUiHarness(async command => command === 'SET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET'
    ? committed : valid);
  await harness.loadBrowserAgentOwnerResourceBudget();
  harness.nodes['agent-owner-max-concurrent'].value = '7';
  await harness.saveBrowserAgentOwnerResourceBudget();
  assert.deepEqual(harness.calls.map(call => call.name), [
    'GET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET',
    'SET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET',
  ]);
  assert.equal(harness.calls[1].payload.expectedRevision, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls[1].payload.budget)), { maxConcurrentAgents: 7, maxDollars: 20 });
  assert.equal(harness.ui.ownerResourceBudgetState.revision, 3);
  assert.equal(harness.nodes['agent-owner-resource-budget-save-button'].disabled, false);
  assert.match(harness.nodes['agent-owner-resource-budget-status'].textContent, /Збережено/);
});
