import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const options = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');

function functionBody(name) {
  const syncStart = options.indexOf(`function ${name}(`);
  const asyncStart = options.indexOf(`async function ${name}(`);
  const starts = [syncStart, asyncStart].filter(index => index >= 0);
  assert.ok(starts.length, `${name} must exist`);
  const start = Math.min(...starts);
  const candidates = [
    options.indexOf('\nfunction ', start + 1),
    options.indexOf('\nasync function ', start + 1),
  ].filter(index => index > start);
  const end = candidates.length ? Math.min(...candidates) : options.length;
  return options.slice(start, end);
}

test('Specialist delegation profile controls have explicit accessible labels and warning text', () => {
  for (const id of [
    'agent-definition-specialist-delegation-configured',
    'agent-definition-specialist-delegation-enabled',
    'agent-definition-specialist-registry-id',
    'agent-definition-specialist-capabilities',
    'agent-definition-specialist-tools',
    'agent-definition-specialist-policy-envelope',
    'agent-definition-specialist-deadline-seconds',
    'agent-definition-specialist-max-concurrent',
    'agent-definition-specialist-lease-seconds',
    'agent-definition-specialist-priority',
  ]) {
    assert.match(html, new RegExp(`(?:for=["']${id}["']|<label><input id=["']${id}["'])`, 'u'));
  }
  assert.match(
    html,
    /Збереження profile нічого не запускає[\s\S]*?Runtime все одно повторно перевіряє plan, registry, policy, provider readiness і product-wide capacity/u,
  );
});

test('inactive Specialist delegation profile removes subordinate controls from keyboard tab flow', () => {
  const sync = functionBody('syncAgentDefinitionSpecialistDelegationControls');
  assert.match(sync, /agent-definition-specialist-delegation-configured/u);
  assert.match(sync, /\$\(id\)\.disabled = !configured/u);
  assert.match(
    options,
    /agent-definition-specialist-delegation-configured'\)\.addEventListener\('change', syncAgentDefinitionSpecialistDelegationControls\)/u,
  );
  const fill = functionBody('fillAgentDefinitionForm');
  assert.match(fill, /specialistProfileConfigured = Boolean\(specialistDelegationProfile\)/u);
  assert.match(fill, /syncAgentDefinitionSpecialistDelegationControls\(\)/u);
});

test('selected reusable Agent exposes concise Specialist delegation state for screen-reader review', () => {
  const summary = functionBody('agentDefinitionSpecialistDelegationSummary');
  assert.match(summary, /Specialist delegation: не налаштовано/u);
  assert.match(summary, /Specialist delegation: очищено/u);
  assert.match(summary, /profile\.enabled \? 'увімкнено' : 'вимкнено'/u);
  assert.match(summary, /profile\.registryId/u);
  const fill = functionBody('fillAgentDefinitionForm');
  assert.match(fill, /agentDefinitionSpecialistDelegationSummary\(definition\)/u);
});

test('definition save persists profile only through existing registry mutation and performs no delegation effect', () => {
  const form = functionBody('agentDefinitionFormValue');
  assert.match(form, /specialistDelegationConfigured:/u);
  assert.match(form, /specialistRegistryId:/u);
  assert.match(form, /specialistMaxConcurrentHandoffs:/u);

  const save = functionBody('saveAgentDefinition');
  assert.match(save, /specialistDelegationProfile:\s*current && Object\.hasOwn\(current, 'specialistDelegationProfile'\)/u);
  assert.match(save, /MUTATE_BROWSER_AGENT_DEFINITION_REGISTRY/u);
  assert.doesNotMatch(save, /PREPARE_BROWSER_AGENT_SPECIALIST_HANDOFF|CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS|RUN_AI_ROUTED_PROMPT|START_BROWSER_AGENT_JOB/u);
});
