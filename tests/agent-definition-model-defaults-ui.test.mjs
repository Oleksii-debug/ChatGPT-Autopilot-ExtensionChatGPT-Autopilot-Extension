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

test('reusable Agent model defaults expose persistent keyboard/NVDA labels and bounded native controls', () => {
  const ids = [
    'agent-definition-ai-routing-mode',
    'agent-definition-ai-pinned-route-id',
    'agent-definition-ai-primary-provider',
    'agent-definition-ai-primary-model',
    'agent-definition-ai-strong-provider',
    'agent-definition-ai-strong-model',
  ];
  for (const id of ids) {
    assert.ok(html.includes(`<label for="${id}">`), `${id} needs a persistent native label`);
    assert.ok(html.includes(`id="${id}"`), `${id} control is missing`);
  }
  assert.match(html, /<legend>Модель за замовчуванням для цієї definition<\/legend>/u);
  assert.match(html, /id="agent-definition-ai-pinned-route-id"[^>]*maxlength="180"/u);
  assert.match(html, /id="agent-definition-ai-primary-model"[^>]*maxlength="300"/u);
  assert.match(html, /id="agent-definition-ai-strong-model"[^>]*maxlength="300"/u);
  assert.match(html, /«Не задавати» залишає відповідне runtime-налаштування власнику або глобальному AI Router/u);
});

test('definition selection loads exact persisted model defaults without inventing absent values', () => {
  const body = functionBody('fillAgentDefinitionForm');
  assert.match(body, /const configDefaults = definition\?\.configDefaults \|\| \{\}/u);
  assert.ok(body.includes("$('agent-definition-ai-routing-mode').value = Object.hasOwn(configDefaults, 'aiRoutingMode') ? configDefaults.aiRoutingMode : ''"));
  assert.ok(body.includes("$('agent-definition-ai-pinned-route-id').value = Object.hasOwn(configDefaults, 'aiPinnedRouteId') ? configDefaults.aiPinnedRouteId : ''"));
  assert.ok(body.includes("$('agent-definition-ai-primary-provider').value = Object.hasOwn(configDefaults, 'aiPrimaryProvider') ? configDefaults.aiPrimaryProvider : ''"));
  assert.ok(body.includes("$('agent-definition-ai-primary-model').value = Object.hasOwn(configDefaults, 'aiPrimaryModel') ? configDefaults.aiPrimaryModel : ''"));
  assert.ok(body.includes("$('agent-definition-ai-strong-provider').value = Object.hasOwn(configDefaults, 'aiStrongProvider') ? configDefaults.aiStrongProvider : ''"));
  assert.ok(body.includes("$('agent-definition-ai-strong-model').value = Object.hasOwn(configDefaults, 'aiStrongModel') ? configDefaults.aiStrongModel : ''"));
});

test('definition save routes model-default edits only through the existing definition mutation authority', () => {
  const form = functionBody('agentDefinitionFormValue');
  assert.ok(form.includes("aiRoutingMode: $('agent-definition-ai-routing-mode').value"));
  assert.ok(form.includes("aiPinnedRouteId: $('agent-definition-ai-pinned-route-id').value"));
  assert.ok(form.includes("aiPrimaryProvider: $('agent-definition-ai-primary-provider').value"));
  assert.ok(form.includes("aiPrimaryModel: $('agent-definition-ai-primary-model').value"));
  assert.ok(form.includes("aiStrongProvider: $('agent-definition-ai-strong-provider').value"));
  assert.ok(form.includes("aiStrongModel: $('agent-definition-ai-strong-model').value"));

  const save = functionBody('saveAgentDefinition');
  assert.match(save, /buildAgentDefinitionFromFormV1\(agentDefinitionFormValue\(\), \{/u);
  assert.match(save, /configDefaults: current\?\.configDefaults \|\| \{\}/u);
  assert.match(save, /MUTATE_BROWSER_AGENT_DEFINITION_REGISTRY/u);
  assert.doesNotMatch(save, /CREATE_BROWSER_AGENT_JOB_FROM_DEFINITION|START_BROWSER_AGENT_JOB|RUN_BROWSER_AGENT_BURST|RUN_AI_ROUTED_PROMPT|UPDATE_AI_/u);
});
