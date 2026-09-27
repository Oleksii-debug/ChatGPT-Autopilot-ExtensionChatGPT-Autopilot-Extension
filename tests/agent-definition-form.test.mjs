import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAgentDefinitionV1 } from '../src/core/agent-definition-registry.js';
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

test('Agent definition form preserves persisted specialist delegation profile without sharing caller data', () => {
  const specialistDelegationProfile = {
    schemaVersion: 1,
    registryId: 'specialists:project-1',
    requiredCapabilityIds: ['research.read', 'project.context'],
    requiredToolIds: ['files.read', 'browser.read'],
    policyEnvelopeId: 'policy:agent.research',
    deadlineSeconds: 900,
    maxConcurrentHandoffs: 2,
    leaseSeconds: 600,
    priority: 5,
    enabled: true,
  };
  const definition = buildAgentDefinitionFromFormV1(form(), {
    specialistDelegationProfile,
  });
  assert.deepEqual(definition.specialistDelegationProfile.requiredCapabilityIds, [
    'project.context',
    'research.read',
  ]);
  assert.deepEqual(definition.specialistDelegationProfile.requiredToolIds, [
    'browser.read',
    'files.read',
  ]);
  assert.notEqual(definition.specialistDelegationProfile, specialistDelegationProfile);
  assert.notEqual(
    definition.specialistDelegationProfile.requiredCapabilityIds,
    specialistDelegationProfile.requiredCapabilityIds,
  );

  specialistDelegationProfile.requiredCapabilityIds[0] = 'mutated';
  assert.deepEqual(definition.specialistDelegationProfile.requiredCapabilityIds, [
    'project.context',
    'research.read',
  ]);
  assert.deepEqual(
    normalizeAgentDefinitionV1(definition).specialistDelegationProfile,
    definition.specialistDelegationProfile,
  );
});

test('Agent definition form keeps legacy absence and explicit specialist-profile clear distinct', () => {
  const absent = buildAgentDefinitionFromFormV1(form());
  assert.equal(Object.hasOwn(absent, 'specialistDelegationProfile'), false);

  const cleared = buildAgentDefinitionFromFormV1(form(), {
    specialistDelegationProfile: null,
  });
  assert.equal(Object.hasOwn(cleared, 'specialistDelegationProfile'), true);
  assert.equal(cleared.specialistDelegationProfile, null);
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


test('Agent definition form preserves durable model route policy without sharing caller data', () => {
  const policy = {
    autoSwitch: false,
    allowRouteIds: ['route.research'],
    denyRouteIds: [],
    freeOnly: true,
    locality: 'local',
    maxInputPricePerMillionUsd: 0,
    maxOutputPricePerMillionUsd: 0,
  };
  const definition = buildAgentDefinitionFromFormV1(form(), {
    definitionRevision: 7,
    modelRoutePolicy: policy,
  });
  assert.deepEqual(definition.modelRoutePolicy, policy);
  assert.notEqual(definition.modelRoutePolicy, policy);
  assert.notEqual(definition.modelRoutePolicy.allowRouteIds, policy.allowRouteIds);
});

test('Agent definition form policy copy rejects accessors and sparse arrays without executing them', () => {
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'freeOnly', {
    enumerable: true,
    get() {
      reads += 1;
      return true;
    },
  });
  assert.throws(
    () => buildAgentDefinitionFromFormV1(form(), { modelRoutePolicy: hostile }),
    /enumerable data property/,
  );
  assert.equal(reads, 0);

  const sparse = { allowRouteIds: new Array(1) };
  assert.throws(
    () => buildAgentDefinitionFromFormV1(form(), { modelRoutePolicy: sparse }),
    /text data values|dense data array/,
  );
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


test('form-produced model defaults are already canonical at the durable AgentDefinitionV1 boundary', () => {
  const raw = buildAgentDefinitionFromFormV1(form({
    aiRoutingMode: 'hybrid-rules',
    aiPinnedRouteId: 'route.canonical',
    aiPrimaryProvider: 'openai-compatible',
    aiPrimaryModel: 'local-primary',
    aiStrongProvider: 'openai',
    aiStrongModel: 'gpt-5.6',
  }), {
    definitionRevision: 9,
    configDefaults: {
      maxSteps: 250,
      maxModelCalls: 50,
      maxOutputTokensPerCall: 4096,
    },
  });
  const canonical = normalizeAgentDefinitionV1(raw);
  assert.deepEqual(canonical.configDefaults, raw.configDefaults);
  assert.equal(canonical.definitionRevision, 9);
});
