import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');

test('Specialist automation owner controls are native, labeled and gate-only', () => {
  for (const id of [
    'agent-specialist-automation-details',
    'agent-specialist-automation-enabled',
    'agent-specialist-automation-save-button',
    'agent-specialist-automation-clear-button',
    'agent-specialist-automation-status',
  ]) {
    assert.match(html, new RegExp('id=["\\\']' + id + '["\\\']', 'u'));
  }
  assert.doesNotMatch(html, /id="agent-specialist-automation-capacity"/u);
  assert.match(html, /Product-wide числовий ліміт задається окремо через ResourceBudgetV1/u);
  assert.match(html, /id="agent-specialist-automation-status" role="status"/u);
});

test('Specialist automation UI reads and mutates only gate authority through canonical Core commands', () => {
  const loadStart = source.indexOf('async function loadSpecialistAutomationPolicy()');
  const saveStart = source.indexOf('async function saveSpecialistAutomationPolicy()');
  const clearStart = source.indexOf('async function clearSpecialistAutomationPolicy()');
  const next = source.indexOf('\nasync function loadBrowserAgentOwnerResourceBudget', clearStart);
  assert.ok(loadStart >= 0 && saveStart > loadStart && clearStart > saveStart && next > clearStart);

  const load = source.slice(loadStart, saveStart);
  const save = source.slice(saveStart, clearStart);
  const clear = source.slice(clearStart, next);
  assert.match(load, /GET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY/u);
  assert.match(save, /SET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY/u);
  assert.match(save, /expectedRevision:\s*ui\.specialistAutomationPolicyRevision/u);
  assert.match(save, /enabled:\s*\$\('agent-specialist-automation-enabled'\)\.checked/u);
  assert.doesNotMatch(save, /maxConcurrentHandoffs|automation-capacity/u);
  assert.match(clear, /CLEAR_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY/u);
  assert.match(clear, /expectedRevision:\s*ui\.specialistAutomationPolicyRevision/u);
  assert.doesNotMatch(load + save + clear, /RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION|executeClaimedSpecialistProvider|fetch\(/u);
});

test('Specialist automation UI fails closed on quarantine without creating numeric capacity authority', () => {
  const renderStart = source.indexOf('function renderSpecialistAutomationPolicy()');
  const loadStart = source.indexOf('async function loadSpecialistAutomationPolicy()', renderStart);
  const render = source.slice(renderStart, loadStart);
  assert.match(render, /enabled\.disabled = quarantined/u);
  assert.match(render, /save\.disabled = quarantined/u);
  assert.match(render, /automatic claim\/provider dispatch вимкнено/u);
  assert.match(render, /Product-wide capacity визначає ResourceBudgetV1/u);
  assert.doesNotMatch(render, /maxConcurrentHandoffs|automation-capacity/u);

  const saveStart = source.indexOf('async function saveSpecialistAutomationPolicy()');
  const clearStart = source.indexOf('async function clearSpecialistAutomationPolicy()', saveStart);
  const save = source.slice(saveStart, clearStart);
  assert.match(save, /revision drifted/u);
  assert.match(save, /await loadSpecialistAutomationPolicy\(\)/u);
  assert.doesNotMatch(save, /Number\.isSafeInteger\(capacity\)|capacity < 0|capacity > 256/u);
});

test('Agent mode refreshes Specialist automation policy without stealing focus', () => {
  assert.match(
    source,
    /mode-agent'\)\.addEventListener\('click',[\s\S]*?setUiMode\('agent', \{ focus: true \}\);[\s\S]*?void loadSpecialistAutomationPolicy\(\)/u,
  );
  assert.match(source, /await loadBrowserAgentJobs\(\);[\s\S]*?await loadSpecialistAutomationPolicy\(\);/u);
});
