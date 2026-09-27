import test from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverAgentDefinitionsV1,
  materializeAgentDefinitionV1,
  normalizeAgentDefinitionRegistryV1,
  normalizeAgentDefinitionV1,
  normalizeAgentDefinitionSelectionV1,
  selectAgentDefinitionV1,
} from '../src/core/agent-definition-registry.js';

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    agentDefinitionId: 'agent.research',
    label: 'Research Agent',
    description: 'Reusable source-aware research worker.',
    instructions: 'Research the owner task using only the admitted tools. Preserve source provenance.',
    capabilityIds: ['research.read', 'project.context'],
    toolIds: ['browser.read', 'files.read', 'github.read'],
    tags: ['verified', 'research'],
    acceptanceCriteria: ['Every material claim has source evidence.', 'Return a concise final artifact.'],
    configDefaults: {
      maxSteps: 120,
      maxModelCalls: 20,
      maxRuntimeMinutes: 30,
      aiRoutingMode: 'primary',
      aiPinnedRouteId: 'mistral-agent',
      aiPrimaryProvider: 'openai-compatible',
      aiPrimaryModel: 'mistral-small-latest',
      visionOnDemand: false,
    },
    enabled: true,
    definitionRevision: 7,
    ...overrides,
  };
}

function registry(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'agents:project-1',
    revision: 3,
    definitions: [
      definition({ agentDefinitionId: 'agent.writer', label: 'Writer Agent', definitionRevision: 2 }),
      definition(),
    ],
    ...overrides,
  };
}

function materialization(overrides = {}) {
  const reg = registry();
  return {
    registry: reg,
    selection: selectAgentDefinitionV1({ registry: reg, agentDefinitionId: 'agent.research' }),
    jobId: 'job-research-001',
    projectId: 'project-1',
    goal: 'Compare the two candidate APIs and report documented trade-offs.',
    ownerBudget: {
      maxSteps: 500,
      maxModelCalls: 100,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 100_000,
      maxTotalTokens: 1_000_000,
      maxOutputTokensPerCall: 8192,
      maxRuntimeMinutes: 120,
      maxCostUsd: 5,
      inputPricePerMillionUsd: 3,
      outputPricePerMillionUsd: 6,
    },
    ownerCapabilityIds: ['project.context', 'research.read', 'research.write'],
    ownerToolIds: ['browser.read', 'files.read', 'github.read', 'artifact.write'],
    requestedCapabilityIds: ['research.read', 'project.context'],
    requestedToolIds: ['github.read', 'browser.read'],
    ...overrides,
  };
}

test('registry canonicalizes reusable Agent definitions deterministically', () => {
  const normalized = normalizeAgentDefinitionRegistryV1(registry());
  assert.equal(normalized.registryId, 'agents:project-1');
  assert.equal(normalized.revision, 3);
  assert.deepEqual(normalized.definitions.map(item => item.agentDefinitionId), ['agent.research', 'agent.writer']);
  assert.deepEqual(normalized.definitions[0].capabilityIds, ['project.context', 'research.read']);
  assert.deepEqual(normalized.definitions[0].toolIds, ['browser.read', 'files.read', 'github.read']);
  assert.deepEqual(normalized.definitions[0].tags, ['research', 'verified']);
  assert.equal(normalized.definitions[0].configDefaults.aiPrimaryModel, 'mistral-small-latest');
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.definitions[0].configDefaults));
});

test('read-only discovery filters enabled definitions deterministically without granting permission', () => {
  const reg = registry({
    definitions: [
      definition({
        agentDefinitionId: 'agent.writer',
        label: 'Writer Agent',
        definitionRevision: 2,
        tags: ['writing'],
        capabilityIds: ['artifact.write'],
        toolIds: ['artifact.write'],
      }),
      definition(),
      definition({
        agentDefinitionId: 'agent.disabled',
        label: 'Disabled Agent',
        definitionRevision: 1,
        enabled: false,
      }),
    ],
  });
  const result = discoverAgentDefinitionsV1({
    registry: reg,
    requiredTags: ['research'],
    requiredCapabilityIds: ['research.read'],
    requiredToolIds: ['browser.read'],
  });
  assert.deepEqual(result.definitions.map(item => item.agentDefinitionId), ['agent.research']);
  assert.equal(result.definitions[0].definitionRevision, 7);
  assert.deepEqual(result.authority, { permissionGranted: false, executionAuthorized: false });
  assert.equal(Object.hasOwn(result.definitions[0], 'instructions'), false, 'discovery summary must not copy the full prompt payload');

  const noMatch = discoverAgentDefinitionsV1({
    registry: reg,
    requiredCapabilityIds: ['research.write'],
  });
  assert.deepEqual(noMatch.definitions, []);
});

test('selection carries a full immutable definition snapshot so same-revision byte drift fails closed', () => {
  const reg = registry();
  const selected = selectAgentDefinitionV1({ registry: reg, agentDefinitionId: 'agent.research' });
  assert.equal(selected.registryRevision, 3);
  assert.equal(selected.definitionRevision, 7);
  assert.equal(selected.definition.instructions, definition().instructions);
  assert.ok(Object.isFrozen(selected.definition));

  const drifted = registry({
    definitions: [
      definition({ agentDefinitionId: 'agent.writer', label: 'Writer Agent', definitionRevision: 2 }),
      definition({ instructions: 'Changed instructions without a revision bump.' }),
    ],
  });
  assert.throws(() => materializeAgentDefinitionV1({
    ...materialization(),
    registry: drifted,
    selection: selected,
  }), /drifted from current registry definition/);
});

test('materialization reuses Browser Agent config and binds model defaults under owner budget authority', () => {
  const result = materializeAgentDefinitionV1(materialization());
  assert.equal(result.config.id, 'job-research-001');
  assert.equal(result.config.projectId, 'project-1');
  assert.equal(result.config.name, 'Research Agent');
  assert.match(result.config.goal, /^Reusable Agent definition instructions:/);
  assert.match(result.config.goal, /Owner task:\nCompare the two candidate APIs/);
  assert.equal(result.config.maxSteps, 120);
  assert.equal(result.config.maxModelCalls, 20);
  assert.equal(result.config.maxRuntimeMinutes, 30);
  assert.equal(result.config.aiRoutingMode, 'primary');
  assert.equal(result.config.aiPinnedRouteId, 'mistral-agent');
  assert.equal(result.config.aiPrimaryProvider, 'openai-compatible');
  assert.equal(result.config.aiPrimaryModel, 'mistral-small-latest');
  assert.equal(result.config.maxCostUsd, 5);
  assert.equal(result.config.inputPricePerMillionUsd, 3);
  assert.equal(result.config.outputPricePerMillionUsd, 6);
  assert.deepEqual(result.config.acceptanceCriteria, definition().acceptanceCriteria);
});

test('definition ceilings can only narrow owner budgets and zero/unbounded aliases cannot widen them', () => {
  const stricterOwner = {
    maxSteps: 80,
    maxModelCalls: 10,
    maxInputTokens: 50_000,
    maxOutputTokens: 8_000,
    maxTotalTokens: 55_000,
    maxOutputTokensPerCall: 1024,
    maxRuntimeMinutes: 15,
    maxCostUsd: 0.75,
    inputPricePerMillionUsd: 4,
    outputPricePerMillionUsd: 9,
  };
  const reg = registry({
    definitions: [
      definition({ agentDefinitionId: 'agent.writer', label: 'Writer Agent', definitionRevision: 2 }),
      definition({
        configDefaults: {
          ...definition().configDefaults,
          maxModelCalls: 0,
          maxInputTokens: 0,
          maxOutputTokens: 12_000,
          maxTotalTokens: 0,
          maxOutputTokensPerCall: 4096,
        },
      }),
    ],
  });
  const result = materializeAgentDefinitionV1({
    ...materialization(),
    registry: reg,
    selection: selectAgentDefinitionV1({ registry: reg, agentDefinitionId: 'agent.research' }),
    ownerBudget: stricterOwner,
  });
  assert.equal(result.config.maxSteps, 80);
  assert.equal(result.config.maxModelCalls, 10);
  assert.equal(result.config.maxInputTokens, 50_000);
  assert.equal(result.config.maxOutputTokens, 8_000);
  assert.equal(result.config.maxTotalTokens, 55_000);
  assert.equal(result.config.maxOutputTokensPerCall, 1024);
  assert.equal(result.config.maxRuntimeMinutes, 15);
  assert.equal(result.config.maxCostUsd, 0.75);
  assert.equal(result.config.inputPricePerMillionUsd, 4);
  assert.equal(result.config.outputPricePerMillionUsd, 9);

  const ownerUnbounded = {
    ...stricterOwner,
    maxModelCalls: 0,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxTotalTokens: 0,
    maxRuntimeMinutes: 0,
    maxCostUsd: 0,
  };
  const unboundedResult = materializeAgentDefinitionV1({
    ...materialization(),
    registry: reg,
    selection: selectAgentDefinitionV1({ registry: reg, agentDefinitionId: 'agent.research' }),
    ownerBudget: ownerUnbounded,
  });
  assert.equal(unboundedResult.config.maxModelCalls, 0);
  assert.equal(unboundedResult.config.maxInputTokens, 0);
  assert.equal(unboundedResult.config.maxOutputTokens, 12_000);
  assert.equal(unboundedResult.config.maxTotalTokens, 0);
  assert.equal(unboundedResult.config.maxRuntimeMinutes, 30);
  assert.equal(unboundedResult.config.maxCostUsd, 0);
});

test('owner budget is complete, canonical, descriptor-safe and reusable definitions cannot set accounting rates', () => {
  for (const [field, value] of [
    ['maxCostUsd', 0.5],
    ['inputPricePerMillionUsd', 1],
    ['outputPricePerMillionUsd', 2],
  ]) {
    assert.throws(() => normalizeAgentDefinitionV1(definition({
      configDefaults: { ...definition().configDefaults, [field]: value },
    })), /unknown field/);
  }

  const missing = { ...materialization().ownerBudget };
  delete missing.maxTotalTokens;
  assert.throws(() => materializeAgentDefinitionV1(materialization({ ownerBudget: missing })), /missing required field: maxTotalTokens/);

  const nonCanonical = { ...materialization().ownerBudget, maxModelCalls: -0 };
  assert.throws(() => materializeAgentDefinitionV1(materialization({ ownerBudget: nonCanonical })), /must already be canonical/);

  let reads = 0;
  const hostile = { ...materialization().ownerBudget };
  Object.defineProperty(hostile, 'maxSteps', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 1;
    },
  });
  assert.throws(() => materializeAgentDefinitionV1(materialization({ ownerBudget: hostile })), /maxSteps must be an enumerable own data property/);
  assert.equal(reads, 0);
});

test('definition never grants owner policy, credential, scheduling, execution or verification authority', () => {
  const result = materializeAgentDefinitionV1(materialization());
  assert.equal(result.config.approvalMode, 'CONSEQUENTIAL');
  assert.equal(result.config.credentialDecision, 'ASK');
  assert.equal(result.config.trustedScriptEnabled, false);
  assert.deepEqual(result.config.siteRules, []);
  assert.deepEqual(result.authority, {
    executionAuthorized: false,
    policyAuthorized: false,
    schedulingAuthorized: false,
    recoveryAuthorized: false,
    credentialAuthorized: false,
    completionAuthorized: false,
    verificationAuthorized: false,
  });
  assert.equal(JSON.stringify(result).includes('credentialRef'), false);
  assert.equal(JSON.stringify(result).includes('apiKey'), false);
  assert.equal(JSON.stringify(result).includes('runState'), false);
});

test('requested capability and tool scope is the explicit intersection of owner and definition', () => {
  const result = materializeAgentDefinitionV1(materialization());
  assert.deepEqual(result.scope.capabilityIds, ['project.context', 'research.read']);
  assert.deepEqual(result.scope.toolIds, ['browser.read', 'github.read']);
  assert.equal(result.scope.toolIds.includes('files.read'), false, 'definition-granted but unrequested tool must not leak into instantiated scope');
  assert.equal(result.scope.toolIds.includes('artifact.write'), false, 'owner-granted but definition-absent tool must not leak into instantiated scope');

  assert.throws(() => materializeAgentDefinitionV1(materialization({
    requestedCapabilityIds: ['research.write'],
  })), /exceeds allowed authority/);
  assert.throws(() => materializeAgentDefinitionV1(materialization({
    requestedToolIds: ['artifact.write'],
  })), /exceeds allowed authority/);
});

test('disabled, removed and registry-revision drift require fresh selection', () => {
  const reg = registry();
  const selected = selectAgentDefinitionV1({ registry: reg, agentDefinitionId: 'agent.research' });
  const base = materialization({ selection: selected });

  assert.throws(() => materializeAgentDefinitionV1({
    ...base,
    registry: registry({
      definitions: [
        definition({ agentDefinitionId: 'agent.writer', label: 'Writer Agent', definitionRevision: 2 }),
        definition({ enabled: false }),
      ],
    }),
  }), /missing or disabled/);

  assert.throws(() => materializeAgentDefinitionV1({
    ...base,
    registry: registry({ definitions: [definition({ agentDefinitionId: 'agent.writer', label: 'Writer Agent', definitionRevision: 2 })] }),
  }), /missing or disabled/);

  assert.throws(() => materializeAgentDefinitionV1({
    ...base,
    registry: registry({ revision: 4 }),
  }), /registry identity or revision drifted/);
});

test('selection envelope cannot substitute a different definition identity or revision', () => {
  const reg = registry();
  const selected = selectAgentDefinitionV1({ registry: reg, agentDefinitionId: 'agent.research' });
  assert.throws(() => normalizeAgentDefinitionSelectionV1({
    ...selected,
    agentDefinitionId: 'agent.other',
  }), /identity does not match/);
  assert.throws(() => normalizeAgentDefinitionSelectionV1({
    ...selected,
    definitionRevision: 8,
  }), /identity does not match/);
});

test('config defaults are behavior/model defaults only and reject owner-authority fields', () => {
  for (const [field, value] of [
    ['approvalMode', 'ALLOW_ALL'],
    ['credentialDecision', 'ALLOW'],
    ['siteRules', []],
    ['trustedScriptEnabled', true],
    ['repeatMode', 'CONTINUOUS'],
    ['intervalSeconds', 60],
    ['activeWindowStart', '09:00'],
    ['activeWindowEnd', '17:00'],
    ['scheduleStartAt', 12345],
    ['scheduleEndAt', 23456],
  ]) {
    assert.throws(() => normalizeAgentDefinitionV1(definition({
      configDefaults: { ...definition().configDefaults, [field]: value },
    })), /unknown field/);
  }
});

test('config defaults reject every legacy-normalizer alias instead of silently changing definition bytes', () => {
  for (const [field, value] of [
    ['maxSteps', 1.5],
    ['aiRoutingMode', 'future-mode'],
    ['aiPrimaryModel', 'x'.repeat(301)],
    ['startUrl', 'https://example.com'],
  ]) {
    assert.throws(() => normalizeAgentDefinitionV1(definition({
      configDefaults: { ...definition().configDefaults, [field]: value },
    })), /must already be canonical/);
  }

  const canonical = normalizeAgentDefinitionV1(definition({
    configDefaults: {
      ...definition().configDefaults,
      startUrl: 'https://example.com/',
      aiPinnedRouteId: 'mistral-agent',
    },
  }));
  assert.equal(canonical.configDefaults.startUrl, 'https://example.com/');
  assert.equal(canonical.configDefaults.aiPinnedRouteId, 'mistral-agent');
});

test('definition and registry reject secrets, numeric aliases, duplicate identities and non-canonical text', () => {
  assert.throws(() => normalizeAgentDefinitionV1({ ...definition(), apiKey: 'never-store-this' }), /unknown field: apiKey/);
  assert.throws(() => normalizeAgentDefinitionV1(definition({ definitionRevision: -0 })), /definitionRevision is invalid/);
  assert.throws(() => normalizeAgentDefinitionV1(definition({ label: ' Research Agent' })), /exact bounded text/);
  assert.throws(() => normalizeAgentDefinitionV1(definition({ tags: ['research', 'research'] })), /duplicate identity/);
  assert.throws(() => normalizeAgentDefinitionRegistryV1(registry({
    definitions: [definition(), definition()],
  })), /duplicate agentDefinitionId/);
  assert.throws(() => normalizeAgentDefinitionRegistryV1(registry({ revision: -0 })), /registry revision is invalid/);
});

test('authority envelopes reject accessors, hidden/symbol fields and sparse arrays without getter reads', () => {
  let reads = 0;
  const hostile = definition();
  Object.defineProperty(hostile, 'instructions', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'must not execute';
    },
  });
  assert.throws(() => normalizeAgentDefinitionV1(hostile), /instructions must be an enumerable own data property/);
  assert.equal(reads, 0);

  const hidden = definition();
  Object.defineProperty(hidden, 'enabled', { enumerable: false, value: true });
  assert.throws(() => normalizeAgentDefinitionV1(hidden), /enabled must be an enumerable own data property/);

  const symbolic = definition();
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeAgentDefinitionV1(symbolic), /unknown field/);

  const sparseCapabilities = definition();
  sparseCapabilities.capabilityIds = new Array(1);
  assert.throws(() => normalizeAgentDefinitionV1(sparseCapabilities), /enumerable own data property/);

  const hostileDefaults = definition();
  let defaultReads = 0;
  Object.defineProperty(hostileDefaults.configDefaults, 'maxSteps', {
    enumerable: true,
    configurable: true,
    get() {
      defaultReads += 1;
      return 9999;
    },
  });
  assert.throws(() => normalizeAgentDefinitionV1(hostileDefaults), /maxSteps must be an enumerable own data property/);
  assert.equal(defaultReads, 0);

  let coercions = 0;
  const objectValuedDefaults = definition();
  objectValuedDefaults.configDefaults = {
    ...objectValuedDefaults.configDefaults,
    maxSteps: {
      valueOf() {
        coercions += 1;
        return 50;
      },
    },
  };
  assert.throws(() => normalizeAgentDefinitionV1(objectValuedDefaults), /maxSteps must be an exact scalar data value/);
  assert.equal(coercions, 0);

  const objectValuedCriterion = definition();
  objectValuedCriterion.acceptanceCriteria = [{
    toString() {
      coercions += 1;
      return 'must not coerce';
    },
  }];
  assert.throws(() => normalizeAgentDefinitionV1(objectValuedCriterion), /acceptanceCriteria\[0\] must be exact bounded text/);
  assert.equal(coercions, 0);
});

test('null-prototype records are accepted and caller-owned data remains unchanged', () => {
  const def = Object.assign(Object.create(null), definition());
  def.configDefaults = Object.assign(Object.create(null), definition().configDefaults);
  const reg = Object.assign(Object.create(null), registry({ definitions: [def] }));
  const before = JSON.stringify(reg);
  const selected = selectAgentDefinitionV1({ registry: reg, agentDefinitionId: 'agent.research' });
  assert.equal(selected.definition.agentDefinitionId, 'agent.research');
  assert.equal(JSON.stringify(reg), before);
});

test('materialization rejects oversized composed goal and keeps reusable instructions bounded', () => {
  const reg = registry({
    definitions: [
      definition({ agentDefinitionId: 'agent.writer', label: 'Writer Agent', definitionRevision: 2 }),
      definition({ instructions: 'x'.repeat(12000) }),
    ],
  });
  const selection = selectAgentDefinitionV1({ registry: reg, agentDefinitionId: 'agent.research' });
  assert.throws(() => materializeAgentDefinitionV1({
    ...materialization(),
    registry: reg,
    selection,
    goal: 'y'.repeat(40000),
  }), /exceeds Browser Agent limit/);
});
