import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentDefinitionFromFormV1,
  mergeAgentDefinitionModelDefaultsV1,
  parseCanonicalAgentIdentity,
} from '../src/ui/agent-definition-form.js';

function form(overrides = {}) {
  return {
    agentDefinitionId: 'agent.research',
    label: 'Research Agent',
    description: 'Evidence-bound research worker',
    instructions: 'Research the owner task and preserve source evidence.',
    capabilityIdsText: 'project.context\nresearch.read',
    toolIdsText: 'browser.read\nfiles.read',
    tagsText: 'research\nverified',
    acceptanceCriteriaText: 'Every material claim has evidence.\nReturn a concise final artifact.',
    enabled: true,
    ...overrides,
  };
}

test('Agent definition form builds canonical portable data and preserves config defaults', () => {
  const defaults = { maxSteps: 50, aiPinnedRouteId: 'route.research', visionOnDemand: false };
  const definition = buildAgentDefinitionFromFormV1(form(), { definitionRevision: 7, configDefaults: defaults });
  assert.equal(definition.schemaVersion, 1);
  assert.equal(definition.definitionRevision, 7);
  assert.deepEqual(definition.capabilityIds, ['project.context', 'research.read']);
  assert.deepEqual(definition.toolIds, ['browser.read', 'files.read']);
  assert.deepEqual(definition.tags, ['research', 'verified']);
  assert.deepEqual(definition.configDefaults, defaults);
  assert.notEqual(definition.configDefaults, defaults);
});

test('create form uses revision one and empty defaults when no persisted definition exists', () => {
  const definition = buildAgentDefinitionFromFormV1(form());
  assert.equal(definition.definitionRevision, 1);
  assert.deepEqual(definition.configDefaults, {});
});

test('required identity and text fields fail before a Core mutation can be built', () => {
  assert.throws(() => buildAgentDefinitionFromFormV1(form({ agentDefinitionId: '' })), /ID/);
  assert.throws(() => buildAgentDefinitionFromFormV1(form({ agentDefinitionId: ' agent.research' })), /канонічним ID/);
  assert.throws(() => buildAgentDefinitionFromFormV1(form({ label: '' })), /Назва/);
  assert.throws(() => buildAgentDefinitionFromFormV1(form({ instructions: ' trailing ' })), /Інструкції/);
});

test('duplicate identity lists and acceptance criteria are rejected locally', () => {
  assert.throws(() => buildAgentDefinitionFromFormV1(form({ tagsText: 'research\nresearch' })), /дублікат/);
  assert.throws(() => buildAgentDefinitionFromFormV1(form({ capabilityIdsText: 'research.read\nresearch.read' })), /дублікат/);
  assert.throws(() => buildAgentDefinitionFromFormV1(form({ toolIdsText: 'browser.read\nbrowser.read' })), /дублікат/);
  assert.throws(() => buildAgentDefinitionFromFormV1(form({ acceptanceCriteriaText: 'Verified result\nVerified result' })), /дублікат/);
});

test('list input is bounded and blank separator lines do not create phantom authority entries', () => {
  const definition = buildAgentDefinitionFromFormV1(form({ capabilityIdsText: 'project.context\n\nresearch.read\n' }));
  assert.deepEqual(definition.capabilityIds, ['project.context', 'research.read']);
  assert.throws(
    () => buildAgentDefinitionFromFormV1(form({ tagsText: Array.from({ length:33 }, (_,i)=>'tag.'+i).join('\n') })),
    /забагато/,
  );
});

test('config defaults are copied through a data-only zero-getter boundary', () => {
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile,'maxSteps',{enumerable:true,get(){reads+=1;return 50;}});
  assert.throws(() => buildAgentDefinitionFromFormV1(form(), { configDefaults: hostile }), /data property/);
  assert.equal(reads,0);
});

test('registry and definition identities share the exact canonical ID syntax', () => {
  assert.equal(parseCanonicalAgentIdentity('agents:project-1','Registry ID'),'agents:project-1');
  assert.throws(() => parseCanonicalAgentIdentity('agents project','Registry ID'), /канонічним ID/);
});


test('model-default form writes only canonical supported Agent model fields', () => {
  const definition = buildAgentDefinitionFromFormV1(form({
    aiRoutingMode: 'hybrid-auto',
    aiPinnedRouteId: 'route.research',
    aiPrimaryProvider: 'openai',
    aiPrimaryModel: 'gpt-5.6',
    aiStrongProvider: 'ollama',
    aiStrongModel: 'qwen3:32b',
  }), {
    configDefaults: { maxSteps: 75, visionOnDemand: false },
  });
  assert.deepEqual(definition.configDefaults, {
    maxSteps: 75,
    visionOnDemand: false,
    aiRoutingMode: 'hybrid-auto',
    aiPinnedRouteId: 'route.research',
    aiPrimaryProvider: 'openai',
    aiPrimaryModel: 'gpt-5.6',
    aiStrongProvider: 'ollama',
    aiStrongModel: 'qwen3:32b',
  });
});

test('model-default edit preserves non-model defaults and empty controls remove only edited model defaults', () => {
  const existing = {
    maxSteps: 90,
    maxModelCalls: 12,
    aiRoutingMode: 'strong',
    aiPinnedRouteId: 'route.old',
    aiPrimaryProvider: 'openai',
    aiPrimaryModel: 'gpt-old',
    aiStrongProvider: 'openai',
    aiStrongModel: 'gpt-strong',
  };
  const merged = mergeAgentDefinitionModelDefaultsV1({
    aiRoutingMode: '',
    aiPinnedRouteId: '',
    aiPrimaryProvider: 'inherit',
    aiPrimaryModel: '',
    aiStrongProvider: '',
    aiStrongModel: '',
  }, existing);
  assert.deepEqual(merged, {
    maxSteps: 90,
    maxModelCalls: 12,
    aiPrimaryProvider: 'inherit',
  });
  assert.deepEqual(existing, {
    maxSteps: 90,
    maxModelCalls: 12,
    aiRoutingMode: 'strong',
    aiPinnedRouteId: 'route.old',
    aiPrimaryProvider: 'openai',
    aiPrimaryModel: 'gpt-old',
    aiStrongProvider: 'openai',
    aiStrongModel: 'gpt-strong',
  });
});

test('absent model-default form fields preserve the persisted canonical defaults byte-for-value', () => {
  const existing = {
    maxSteps: 42,
    aiRoutingMode: 'primary',
    aiPinnedRouteId: 'route.saved',
    aiPrimaryProvider: 'openai-compatible',
    aiPrimaryModel: 'model.saved',
  };
  assert.deepEqual(mergeAgentDefinitionModelDefaultsV1({}, existing), existing);
});

test('model-default fields fail closed on aliases, invalid route identity and incomplete explicit providers', () => {
  assert.throws(
    () => mergeAgentDefinitionModelDefaultsV1({ aiRoutingMode: 'AUTO' }, {}),
    /routing mode не підтримується/,
  );
  assert.throws(
    () => mergeAgentDefinitionModelDefaultsV1({ aiPinnedRouteId: ' route.bad' }, {}),
    /канонічним текстом/,
  );
  assert.throws(
    () => mergeAgentDefinitionModelDefaultsV1({ aiPinnedRouteId: 'route bad' }, {}),
    /канонічним ID/,
  );
  assert.throws(
    () => mergeAgentDefinitionModelDefaultsV1({ aiPrimaryProvider: 'openai', aiPrimaryModel: '' }, {}),
    /Primary provider override/,
  );
  assert.throws(
    () => mergeAgentDefinitionModelDefaultsV1({ aiStrongProvider: 'ollama', aiStrongModel: '' }, {}),
    /Strong provider override/,
  );
  assert.throws(
    () => mergeAgentDefinitionModelDefaultsV1({ aiPrimaryModel: ' model' }, {}),
    /канонічним текстом/,
  );
  assert.throws(
    () => mergeAgentDefinitionModelDefaultsV1({ aiStrongModel: 'x'.repeat(301) }, {}),
    /канонічним текстом/,
  );
});

test('model-default form admission does not execute accessors', () => {
  let reads = 0;
  const input = {};
  Object.defineProperty(input, 'aiRoutingMode', {
    enumerable: true,
    get() { reads += 1; return 'strong'; },
  });
  assert.throws(() => mergeAgentDefinitionModelDefaultsV1(input, {}), /data property/);
  assert.equal(reads, 0);
});
