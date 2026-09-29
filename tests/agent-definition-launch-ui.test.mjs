import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const options = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');

function functionBody(name) {
  const start = options.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = options.indexOf('\nasync function ', start + 1);
  const nextSync = options.indexOf('\nfunction ', start + 1);
  const candidates = [next, nextSync].filter(value => value > start);
  const end = candidates.length ? Math.min(...candidates) : options.length;
  return options.slice(start, end);
}

test('reusable Agent launch surface is keyboard-native and exposes status semantics', () => {
  for (const id of [
    'agent-definition-launch-group',
    'agent-definition-launch-goal',
    'agent-definition-launch-project-id',
    'agent-definition-launch-job-id',
    'agent-definition-launch-owner-capabilities',
    'agent-definition-launch-owner-tools',
    'agent-definition-launch-requested-capabilities',
    'agent-definition-launch-requested-tools',
    'agent-definition-launch-button',
    'agent-definition-launch-status',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, 'u'));
  }

  assert.match(
    html,
    /<p id="agent-definition-launch-status" role="status">/u,
    'launch result must be announced through a status region',
  );
  assert.match(
    html,
    /<button id="agent-definition-launch-button" type="button" disabled>/u,
    'launch button must start fail-closed until a live enabled definition is selected',
  );
  assert.match(
    html,
    /Створення зберігає нове завдання у стані STOPPED і не запускає Agent/u,
    'the UI must state that definition launch does not execute the Agent',
  );
});

test('definition launch uses the canonical create command and never auto-starts or auto-runs', () => {
  const body = functionBody('createBrowserAgentFromDefinition');
  assert.match(body, /CREATE_BROWSER_AGENT_JOB_FROM_DEFINITION/u);
  assert.doesNotMatch(body, /START_BROWSER_AGENT_JOB/u);
  assert.doesNotMatch(body, /RUN_BROWSER_AGENT_BURST/u);
  assert.doesNotMatch(body, /RUN_BROWSER_AGENT_NOW/u);
  assert.doesNotMatch(body, /assertBrowserAgentRouteReadyForLaunch/u);
  assert.match(body, /runState !== 'STOPPED'/u);
  assert.match(body, /loadBrowserAgentJobs\(\{ selectId: id \}\)/u);
});

test('definition launch reads owner budget from the visible canonical Agent budget controls only', () => {
  const start = options.indexOf('function browserAgentOwnerBudgetPolicyFromForm()');
  const end = options.indexOf('\nfunction agentDefinitionLaunchFormValue()', start);
  assert.ok(start >= 0 && end > start);
  const body = options.slice(start, end);

  for (const id of [
    'agent-max-steps',
    'agent-max-model-calls',
    'agent-max-input-tokens',
    'agent-max-output-tokens',
    'agent-max-total-tokens',
    'agent-max-output-per-call',
    'agent-max-runtime-minutes',
    'agent-max-cost-usd',
    'agent-input-price',
    'agent-output-price',
  ]) {
    assert.match(body, new RegExp(id, 'u'));
    assert.match(html, new RegExp(`id=["']${id}["']`, 'u'));
  }

  assert.doesNotMatch(body, /startUrl|approvalMode|credentialDecision|trustedScriptEnabled/u);
});

test('selected definition controls launch admission and prefilled least-authority scope', () => {
  const start = options.indexOf('function fillAgentDefinitionLaunchForm');
  const end = options.indexOf('\nfunction browserAgentOwnerBudgetPolicyFromForm', start);
  assert.ok(start >= 0 && end > start);
  const body = options.slice(start, end);
  assert.match(body, /definition\?\.enabled === true/u);
  assert.match(body, /agentDefinitionLaunchScopeTextV1\(definition\)/u);
  assert.match(body, /button\.disabled = !launchable/u);
});
