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
  return options.slice(start, candidates.length ? Math.min(...candidates) : options.length);
}

test('Specialist management is keyboard-native, labeled and fail-closed before registry selection', () => {
  for (const id of [
    'specialist-registry-list',
    'specialist-create-registry-id',
    'specialist-list',
    'specialist-id',
    'specialist-provider-id',
    'specialist-label',
    'specialist-description',
    'specialist-execution-plane',
    'specialist-capabilities',
    'specialist-tools',
    'specialist-result-contract-id',
  ]) {
    assert.ok(html.includes(`<label for="${id}">`), `${id} needs a persistent native label`);
    assert.ok(html.includes(`id="${id}"`), `${id} control is missing`);
  }
  assert.match(html, /<fieldset class="settings-group" id="specialist-form-group" disabled>/u);
  assert.match(html, /<p id="specialist-status" role="status">/u);
  assert.match(html, /id="specialist-quarantine-status" tabindex="0"/u);
  assert.match(html, /Ця форма не запускає Specialist і не створює handoff/u);
});

test('Specialist registry load and create use only canonical registry Core commands', () => {
  const load = functionBody('loadSpecialistRegistries');
  assert.match(load, /LIST_BROWSER_AGENT_SPECIALIST_REGISTRIES/u);
  assert.match(load, /GET_BROWSER_AGENT_SPECIALIST_REGISTRY/u);
  assert.doesNotMatch(load, /PREPARE_BROWSER_AGENT_SPECIALIST_HANDOFF|CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS|START_BROWSER_AGENT_JOB|RUN_BROWSER_AGENT/u);

  const create = functionBody('createSpecialistRegistry');
  assert.match(create, /CREATE_BROWSER_AGENT_SPECIALIST_REGISTRY/u);
  assert.match(create, /parseCanonicalAgentIdentity/u);
  assert.doesNotMatch(create, /HANDOFF|CLAIM|START_BROWSER_AGENT_JOB|RUN_BROWSER_AGENT/u);
});

test('Specialist save binds exact registry and definition CAS and never executes a child', () => {
  const save = functionBody('saveSpecialistDefinition');
  assert.match(save, /buildSpecialistDefinitionFromFormV1/u);
  assert.match(save, /expectedRegistryRevision: registry\.revision/u);
  assert.match(save, /expectedDefinitionRevision: current\.definitionRevision/u);
  assert.match(save, /MUTATE_BROWSER_AGENT_SPECIALIST_REGISTRY/u);
  assert.doesNotMatch(save, /PREPARE_BROWSER_AGENT_SPECIALIST_HANDOFF|CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS|COMPLETE_BROWSER_AGENT_SPECIALIST_HANDOFF|START_BROWSER_AGENT_JOB|RUN_BROWSER_AGENT|RUN_AI_/u);
});

test('Specialist toggle and delete retain exact revision guards and existing mutation authority', () => {
  for (const name of ['toggleSpecialistEnabled', 'deleteSpecialistDefinition']) {
    const body = functionBody(name);
    assert.match(body, /expectedRegistryRevision: registry\.revision/u);
    assert.match(body, /expectedDefinitionRevision: current\.definitionRevision/u);
    assert.match(body, /MUTATE_BROWSER_AGENT_SPECIALIST_REGISTRY/u);
    assert.doesNotMatch(body, /PREPARE_BROWSER_AGENT_SPECIALIST_HANDOFF|CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS|START_BROWSER_AGENT_JOB|RUN_BROWSER_AGENT/u);
  }
});

test('Specialist revision drift reloads durable live state instead of retrying stale authority', () => {
  const body = functionBody('reloadAfterSpecialistDrift');
  assert.match(body, /revision drifted/iu);
  assert.match(body, /loadSpecialistRegistries/u);
  assert.match(body, /selectRegistryId: registryId/u);
  assert.match(body, /selectSpecialistId: specialistId/u);
});

test('Specialist UI exposes exactly the canonical execution-plane values', () => {
  const start = html.indexOf('id="specialist-execution-plane"');
  assert.ok(start >= 0);
  const end = html.indexOf('</select>', start);
  const select = html.slice(start, end);
  const values = [...select.matchAll(/<option value="([^"]+)"/gu)].map(match => match[1]);
  assert.deepEqual(values, ['BROWSER', 'LOCAL', 'CLOUD', 'REMOTE']);
});
