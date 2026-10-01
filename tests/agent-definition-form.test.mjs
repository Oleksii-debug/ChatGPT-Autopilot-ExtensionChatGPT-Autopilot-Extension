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

test('Agent definition form builds canonical portable data and preserves config/model defaults', () => {
  const defaults = { maxSteps: 50, visionOnDemand: false };
  const routePolicy = { autoSwitch: false, pinnedRouteId: 'route.research', orderedRouteIds: [], allowRouteIds: ['route.research'], denyRouteIds: [], freeOnly: true, locality: 'any', maxInputPricePerMillionUsd: 0, maxOutputPricePerMillionUsd: 0 };
  const definition = buildAgentDefinitionFromFormV1(form(), { definitionRevision: 7, configDefaults: defaults, modelRoutePolicy: routePolicy });
  assert.equal(definition.schemaVersion, 1);
  assert.equal(definition.definitionRevision, 7);
  assert.deepEqual(definition.capabilityIds, ['project.context', 'research.read']);
  assert.deepEqual(definition.toolIds, ['browser.read', 'files.read']);
  assert.deepEqual(definition.tags, ['research', 'verified']);
  assert.deepEqual(definition.configDefaults, defaults);
  assert.deepEqual(definition.modelRoutePolicy, routePolicy);
  assert.notEqual(definition.configDefaults, defaults);
  assert.notEqual(definition.modelRoutePolicy, routePolicy);
});

test('editing preserves specialist delegation profile and model route policy as durable data', () => {
  const specialist = {
    schemaVersion: 1,
    registryId: 'specialists:project-1',
    requiredCapabilityIds: ['project.context'],
    requiredToolIds: ['browser.read'],
    policyEnvelopeId: 'policy:agent',
    deadlineSeconds: 900,
    maxConcurrentHandoffs: 2,
    leaseSeconds: 600,
    priority: 3,
    enabled: true,
  };
  const routePolicy = {
    autoSwitch: false,
    pinnedRouteId: 'route.research',
    orderedRouteIds: [],
    allowRouteIds: ['route.research'],
    denyRouteIds: [],
    freeOnly: true,
    locality: 'any',
    maxInputPricePerMillionUsd: 0,
    maxOutputPricePerMillionUsd: 0,
  };
  const definition = buildAgentDefinitionFromFormV1(form(), {
    definitionRevision: 4,
    modelRoutePolicy: routePolicy,
    specialistDelegationProfile: specialist,
  });
  assert.deepEqual(definition.modelRoutePolicy, routePolicy);
  assert.deepEqual(definition.specialistDelegationProfile, specialist);
  assert.notEqual(definition.modelRoutePolicy, routePolicy);
  assert.notEqual(definition.specialistDelegationProfile, specialist);
});

test('create form uses revision one and empty defaults when no persisted definition exists', () => {
  const definition = buildAgentDefinitionFromFormV1(form());
  assert.equal(definition.definitionRevision, 1);
  assert.deepEqual(definition.configDefaults, {});
  assert.equal(definition.modelRoutePolicy, null);
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


test('Agent model defaults drop the historical configDefaults route pin alias', () => {
  const definition = buildAgentDefinitionFromFormV1(form(), {
    configDefaults: {
      maxSteps: 50,
      aiPinnedRouteId: 'route.legacy',
      visionOnDemand: false,
    },
    modelRoutePolicy: {
      autoSwitch: false,
      pinnedRouteId: 'route.current',
      orderedRouteIds: [],
      allowRouteIds: ['route.current'],
      denyRouteIds: [],
      freeOnly: false,
      locality: 'any',
      maxInputPricePerMillionUsd: null,
      maxOutputPricePerMillionUsd: null,
    },
  });
  assert.equal(Object.hasOwn(definition.configDefaults, 'aiPinnedRouteId'), false);
  assert.equal(definition.modelRoutePolicy.pinnedRouteId, 'route.current');
  assert.doesNotThrow(() => normalizeAgentDefinitionV1(definition));
});

test('Agent model defaults edit provider/model fields while route pin remains separate policy authority', () => {
  const definition = buildAgentDefinitionFromFormV1(form({
    aiRoutingMode: 'hybrid-auto',
    aiPrimaryProvider: 'openai',
    aiPrimaryModel: 'gpt-5.6',
    aiStrongProvider: 'ollama',
    aiStrongModel: 'qwen3:32b',
  }), {
    configDefaults: { maxSteps: 75, visionOnDemand: false },
    modelRoutePolicy: {
      autoSwitch: false,
      pinnedRouteId: 'route.research',
      orderedRouteIds: [],
      allowRouteIds: ['route.research'],
      denyRouteIds: [],
      freeOnly: false,
      locality: 'any',
      maxInputPricePerMillionUsd: null,
      maxOutputPricePerMillionUsd: null,
    },
  });
  assert.deepEqual(definition.configDefaults, {
    maxSteps: 75,
    visionOnDemand: false,
    aiRoutingMode: 'hybrid-auto',
    aiPrimaryProvider: 'openai',
    aiPrimaryModel: 'gpt-5.6',
    aiStrongProvider: 'ollama',
    aiStrongModel: 'qwen3:32b',
  });
  assert.equal(Object.hasOwn(definition.configDefaults, 'aiPinnedRouteId'), false);
  assert.equal(definition.modelRoutePolicy.pinnedRouteId, 'route.research');
  const canonical = normalizeAgentDefinitionV1(definition);
  assert.deepEqual(canonical.configDefaults, definition.configDefaults);
});

test('empty model-default controls remove only edited provider/model defaults and preserve unrelated defaults', () => {
  const existing = {
    maxSteps: 90,
    maxModelCalls: 12,
    aiRoutingMode: 'strong',
    aiPrimaryProvider: 'openai',
    aiPrimaryModel: 'gpt-old',
    aiStrongProvider: 'openai',
    aiStrongModel: 'gpt-strong',
  };
  const merged = mergeAgentDefinitionModelDefaultsV1({
    aiRoutingMode: '',
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
  assert.equal(existing.aiStrongModel, 'gpt-strong');
});

test('absent model-default fields preserve persisted canonical defaults', () => {
  const existing = {
    maxSteps: 42,
    aiRoutingMode: 'primary',
    aiPrimaryProvider: 'openai-compatible',
    aiPrimaryModel: 'model.saved',
  };
  assert.deepEqual(mergeAgentDefinitionModelDefaultsV1({}, existing), existing);
});

test('model-default fields fail closed on aliases, incomplete explicit providers and accessors', () => {
  assert.throws(() => mergeAgentDefinitionModelDefaultsV1({ aiRoutingMode: 'AUTO' }, {}), /routing mode не підтримується/);
  assert.throws(() => mergeAgentDefinitionModelDefaultsV1({ aiPrimaryProvider: 'openai', aiPrimaryModel: '' }, {}), /Primary provider override/);
  assert.throws(() => mergeAgentDefinitionModelDefaultsV1({ aiStrongProvider: 'ollama', aiStrongModel: '' }, {}), /Strong provider override/);
  assert.throws(() => mergeAgentDefinitionModelDefaultsV1({ aiPrimaryModel: ' model' }, {}), /канонічним текстом/);
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'aiRoutingMode', { enumerable: true, get() { reads += 1; return 'strong'; } });
  assert.throws(() => mergeAgentDefinitionModelDefaultsV1(hostile, {}), /data property/);
  assert.equal(reads, 0);
});


test('Agent definition form builds canonical Specialist delegation profile with explicit enabled state', () => {
  const definition = buildAgentDefinitionFromFormV1(form({
    specialistDelegationConfigured: true,
    specialistDelegationEnabled: true,
    specialistRegistryId: 'specialists:project-1',
    specialistCapabilityIdsText: 'research.read\nproject.context',
    specialistToolIdsText: 'files.read\nbrowser.read',
    specialistPolicyEnvelopeId: 'policy:agent.research',
    specialistDeadlineSeconds: '900',
    specialistMaxConcurrentHandoffs: '2',
    specialistLeaseSeconds: '600',
    specialistPriority: '5',
  }));
  assert.equal(definition.specialistDelegationProfile.enabled, true);
  assert.equal(definition.specialistDelegationProfile.registryId, 'specialists:project-1');
  assert.deepEqual(definition.specialistDelegationProfile.requiredCapabilityIds, ['project.context','research.read']);
  assert.deepEqual(definition.specialistDelegationProfile.requiredToolIds, ['browser.read','files.read']);
  assert.equal(definition.specialistDelegationProfile.maxConcurrentHandoffs, 2);
});

test('Specialist delegation clear semantics distinguish new absence from persisted-profile removal', () => {
  const created = buildAgentDefinitionFromFormV1(form({ specialistDelegationConfigured: false }));
  assert.equal(Object.hasOwn(created, 'specialistDelegationProfile'), false);
  const persisted = {
    schemaVersion: 1,
    registryId: 'specialists:project-1',
    requiredCapabilityIds: ['research.read'],
    requiredToolIds: ['browser.read'],
    policyEnvelopeId: 'policy:agent.research',
    deadlineSeconds: 900,
    maxConcurrentHandoffs: 2,
    leaseSeconds: 600,
    priority: 5,
    enabled: true,
  };
  const cleared = buildAgentDefinitionFromFormV1(form({ specialistDelegationConfigured: false }), {
    specialistDelegationProfile: persisted,
  });
  assert.equal(Object.hasOwn(cleared, 'specialistDelegationProfile'), true);
  assert.equal(cleared.specialistDelegationProfile, null);
});

test('Specialist delegation form rejects malformed numeric and accessor-backed authority input', () => {
  const baseInput = {
    specialistDelegationConfigured: true,
    specialistDelegationEnabled: true,
    specialistRegistryId: 'specialists:project-1',
    specialistCapabilityIdsText: 'research.read',
    specialistToolIdsText: 'browser.read',
    specialistPolicyEnvelopeId: 'policy:agent.research',
    specialistDeadlineSeconds: '900',
    specialistMaxConcurrentHandoffs: '2',
    specialistLeaseSeconds: '600',
    specialistPriority: '5',
  };
  assert.throws(
    () => buildAgentDefinitionFromFormV1(form({ ...baseInput, specialistDeadlineSeconds: '0900' })),
    /канонічному форматі/u,
  );
  assert.throws(
    () => buildAgentDefinitionFromFormV1(form({ ...baseInput, specialistMaxConcurrentHandoffs: '257' })),
    /діапазоном/u,
  );
  let reads = 0;
  const hostile = form();
  Object.defineProperty(hostile, 'specialistDelegationConfigured', {
    enumerable: true,
    get() { reads += 1; return false; },
  });
  assert.throws(() => buildAgentDefinitionFromFormV1(hostile), /data property/u);
  assert.equal(reads, 0);
});

test('disabled Specialist delegation does not inspect inactive subordinate fields', () => {
  let reads = 0;
  const input = form({ specialistDelegationConfigured: false });
  Object.defineProperty(input, 'specialistRegistryId', {
    enumerable: true,
    get() { reads += 1; return 'specialists:should-not-run'; },
  });
  const persisted = {
    schemaVersion: 1,
    registryId: 'specialists:project-1',
    requiredCapabilityIds: ['research.read'],
    requiredToolIds: ['browser.read'],
    policyEnvelopeId: 'policy:agent.research',
    deadlineSeconds: 900,
    maxConcurrentHandoffs: 2,
    leaseSeconds: 600,
    priority: 5,
    enabled: true,
  };
  const cleared = buildAgentDefinitionFromFormV1(input, { specialistDelegationProfile: persisted });
  assert.equal(cleared.specialistDelegationProfile, null);
  assert.equal(reads, 0);
});
