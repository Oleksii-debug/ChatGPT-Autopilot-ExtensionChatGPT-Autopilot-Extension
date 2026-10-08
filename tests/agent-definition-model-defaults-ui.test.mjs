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

test('Agent model defaults expose native labeled provider/model controls without a second pinned-route field', () => {
  for (const id of [
    'agent-definition-ai-routing-mode',
    'agent-definition-ai-primary-provider',
    'agent-definition-ai-primary-model',
    'agent-definition-ai-strong-provider',
    'agent-definition-ai-strong-model',
  ]) {
    assert.ok(html.includes(`<label for="${id}">`), `${id} needs a persistent native label`);
    assert.ok(html.includes(`id="${id}"`), `${id} control is missing`);
  }
  assert.match(html, /Pinned route і route allow\/deny редагуються тільки в Model Router policy нижче/u);
  assert.doesNotMatch(html, /id="agent-definition-ai-pinned-route-id"/u);
  assert.match(html, /id="agent-definition-model-route-pinned-id"/u);
});

test('definition selection loads only persisted provider/model defaults and never aliases policy pin', () => {
  const body = functionBody('fillAgentDefinitionForm');
  assert.match(body, /const configDefaults = definition\?\.configDefaults \|\| \{\}/u);
  for (const key of ['aiRoutingMode','aiPrimaryProvider','aiPrimaryModel','aiStrongProvider','aiStrongModel']) {
    assert.ok(body.includes(`Object.hasOwn(configDefaults, '${key}')`), `${key} must preserve absence`);
  }
  assert.doesNotMatch(body, /aiPinnedRouteId/u);
});

test('definition save routes defaults through existing registry mutation and leaves policy authority separate', () => {
  const form = functionBody('agentDefinitionFormValue');
  for (const id of [
    'agent-definition-ai-routing-mode',
    'agent-definition-ai-primary-provider',
    'agent-definition-ai-primary-model',
    'agent-definition-ai-strong-provider',
    'agent-definition-ai-strong-model',
  ]) assert.ok(form.includes(id));
  assert.match(form, /modelRoutePinnedRouteId: \$\('agent-definition-model-route-pinned-id'\)\.value/u);
  assert.doesNotMatch(form, /aiPinnedRouteId/u);
  const save = functionBody('saveAgentDefinition');
  assert.match(save, /MUTATE_BROWSER_AGENT_DEFINITION_REGISTRY/u);
  assert.doesNotMatch(save, /CREATE_BROWSER_AGENT_JOB_FROM_DEFINITION|START_BROWSER_AGENT_JOB|RUN_BROWSER_AGENT_BURST|RUN_AI_ROUTED_PROMPT|UPDATE_AI_/u);
});
