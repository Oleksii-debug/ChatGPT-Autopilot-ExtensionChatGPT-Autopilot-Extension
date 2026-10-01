import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const options = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');

function functionBody(name) {
  const starts = [
    options.indexOf(`function ${name}(`),
    options.indexOf(`async function ${name}(`),
  ].filter(index => index >= 0);
  assert.ok(starts.length, `${name} must exist`);
  const start = Math.min(...starts);
  const ends = [
    options.indexOf('\nfunction ', start + 1),
    options.indexOf('\nasync function ', start + 1),
  ].filter(index => index > start);
  return options.slice(start, ends.length ? Math.min(...ends) : options.length);
}

test('Specialist profile controls expose setup-only warning and accessible group binding', () => {
  assert.match(html, /id="agent-definition-specialist-delegation-group" aria-describedby="agent-definition-specialist-delegation-help"/u);
  assert.match(html, /Збереження profile нічого не запускає/u);
  for (const id of [
    'agent-definition-specialist-registry-id',
    'agent-definition-specialist-capabilities',
    'agent-definition-specialist-tools',
    'agent-definition-specialist-policy-envelope',
    'agent-definition-specialist-deadline-seconds',
    'agent-definition-specialist-max-concurrent',
    'agent-definition-specialist-lease-seconds',
    'agent-definition-specialist-priority',
  ]) assert.match(html, new RegExp(`<label for=["']${id}["']>`, 'u'));
});

test('unconfigured Specialist profile removes subordinate fields from keyboard tab flow', () => {
  const sync = functionBody('syncAgentDefinitionSpecialistDelegationControls');
  assert.match(sync, /\$\(id\)\.disabled = !configured/u);
  assert.match(options, /agent-definition-specialist-delegation-configured'\)\.addEventListener\('change', syncAgentDefinitionSpecialistDelegationControls\)/u);
});

test('definition save remains registry-only and cannot execute delegation', () => {
  const save = functionBody('saveAgentDefinition');
  assert.match(save, /MUTATE_BROWSER_AGENT_DEFINITION_REGISTRY/u);
  assert.doesNotMatch(save, /PREPARE_BROWSER_AGENT_SPECIALIST_HANDOFF|CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS|RUN_AI_ROUTED_PROMPT|START_BROWSER_AGENT_JOB/u);
});
