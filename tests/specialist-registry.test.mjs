import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentExecutionPlane } from '../src/core/agent-plan.js';
import {
  bindSpecialistHandoffToRegistryV1,
  discoverSpecialistsV1,
  normalizeSpecialistDefinitionV1,
  normalizeSpecialistRegistryV1,
} from '../src/core/specialist-registry.js';
import {
  OPENHANDS_CODING_PROVIDER_ID,
  OPENHANDS_CODING_SPECIALIST_ID,
} from '../src/core/coding-specialist-provider.js';

const CREATED_AT = '2026-09-27T00:20:00.000Z';

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    specialistId: OPENHANDS_CODING_SPECIALIST_ID,
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    label: 'OpenHands Coding',
    description: 'Bounded coding specialist behind the canonical Agent control plane.',
    executionPlane: AgentExecutionPlane.LOCAL,
    capabilityIds: ['coding.read', 'coding.workspace'],
    toolIds: ['filesystem.read', 'github.read', 'workspace.patch'],
    resultContractId: 'result.coding.workspace.v1',
    enabled: true,
    definitionRevision: 7,
    ...overrides,
  };
}

function researchDefinition(overrides = {}) {
  return definition({
    specialistId: 'research-local',
    providerId: 'mcp-research-provider',
    label: 'Research',
    executionPlane: AgentExecutionPlane.LOCAL,
    capabilityIds: ['research.web'],
    toolIds: ['browser.read', 'files.read'],
    resultContractId: 'result.research.v1',
    definitionRevision: 2,
    ...overrides,
  });
}

function registry(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'specialists:project-1',
    revision: 3,
    definitions: [researchDefinition(), definition()],
    ...overrides,
  };
}

function discovery(overrides = {}) {
  return {
    registry: registry(),
    requiredCapabilityIds: ['coding.workspace'],
    requiredToolIds: ['workspace.patch', 'filesystem.read'],
    parentCapabilityIds: ['coding.read', 'coding.workspace', 'filesystem.archive'],
    parentToolIds: ['workspace.patch', 'filesystem.read', 'github.read'],
    executionPlanes: [AgentExecutionPlane.LOCAL],
    ...overrides,
  };
}

function handoff(overrides = {}) {
  return {
    schemaVersion: 1,
    handoffId: 'handoff-coding-001',
    specialistId: OPENHANDS_CODING_SPECIALIST_ID,
    goal: 'Repair the bounded repository defect and return evidence artifacts.',
    requestedCapabilityIds: ['coding.workspace'],
    artifactRefs: [],
    credentialRefs: [],
    maxModelCalls: 0,
    maxRuntimeSeconds: 600,
    maxCostUsdMicros: 0,
    createdAt: CREATED_AT,
    parentInvocationId: 'invoke-parent-001',
    ...overrides,
  };
}

test('portable registry normalizes deterministically and interoperates with the existing OpenHands specialist identity', () => {
  const normalized = normalizeSpecialistRegistryV1(registry());
  assert.equal(normalized.registryId, 'specialists:project-1');
  assert.deepEqual(normalized.definitions.map(item => item.specialistId), [OPENHANDS_CODING_SPECIALIST_ID, 'research-local']);
  const coding = normalized.definitions[0];
  assert.equal(coding.providerId, OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(coding.executionPlane, AgentExecutionPlane.LOCAL);
  assert.equal(coding.resultContractId, 'result.coding.workspace.v1');
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(coding.capabilityIds));
});

test('discovery grants only requested parent capabilities and explicitly requested tools', () => {
  const result = discoverSpecialistsV1(discovery());
  assert.equal(result.specialists.length, 1);
  const selected = result.specialists[0];
  assert.equal(selected.specialistId, OPENHANDS_CODING_SPECIALIST_ID);
  assert.deepEqual(selected.requestedCapabilityIds, ['coding.workspace']);
  assert.deepEqual(selected.grantedToolIds, ['filesystem.read', 'workspace.patch']);
  assert.equal(selected.grantedToolIds.includes('github.read'), false, 'parent-granted but unrequested tools must not reach the child');
  assert.equal(selected.definitionRevision, 7);
  assert.equal(selected.registryRevision, 3);

  assert.throws(() => discoverSpecialistsV1(discovery({
    requiredCapabilityIds: ['coding.admin'],
  })), /exceeds parent or specialist authority/);

  const noMatch = discoverSpecialistsV1(discovery({
    requiredToolIds: ['browser.read'],
    parentToolIds: ['browser.read'],
  }));
  assert.deepEqual(noMatch.specialists, []);
});

test('binding preserves exact selection provenance and never mints execution or completion authority', () => {
  const request = discovery();
  const selected = discoverSpecialistsV1(request).specialists[0];
  const bound = bindSpecialistHandoffToRegistryV1({
    registry: request.registry,
    selection: selected,
    handoff: handoff(),
    parentCapabilityIds: request.parentCapabilityIds,
    parentToolIds: request.parentToolIds,
  });
  assert.deepEqual(bound.childContext, {
    goal: 'Repair the bounded repository defect and return evidence artifacts.',
    artifactRefs: [],
    credentialRefs: [],
    parentInvocationId: 'invoke-parent-001',
  });
  assert.deepEqual(bound.childScope.capabilityIds, ['coding.workspace']);
  assert.deepEqual(bound.childScope.toolIds, ['filesystem.read', 'workspace.patch']);
  assert.deepEqual(bound.authority, {
    executionAuthorized: false,
    policyAuthorized: false,
    schedulingAuthorized: false,
    recoveryAuthorized: false,
    credentialAuthorized: false,
    completionAuthorized: false,
    verificationAuthorized: false,
  });
  assert.equal(bound.handoff.handoffId, 'handoff-coding-001');
  assert.ok(Object.isFrozen(bound.childContext));
  assert.ok(Object.isFrozen(bound.childScope));
  assert.equal(Object.hasOwn(bound, 'parentContext'), false);
});

test('disabled, removed or revision-drifted specialist definitions fail closed after selection', () => {
  const request = discovery();
  const selected = discoverSpecialistsV1(request).specialists[0];
  const bind = nextRegistry => bindSpecialistHandoffToRegistryV1({
    registry: nextRegistry,
    selection: selected,
    handoff: handoff(),
    parentCapabilityIds: request.parentCapabilityIds,
    parentToolIds: request.parentToolIds,
  });

  assert.throws(() => bind(registry({
    definitions: [researchDefinition(), definition({ enabled: false })],
  })), /missing or disabled/);
  assert.throws(() => bind(registry({
    definitions: [researchDefinition()],
  })), /missing or disabled/);
  assert.throws(() => bind(registry({
    definitions: [researchDefinition(), definition({ definitionRevision: 8 })],
  })), /drifted from current registry definition/);
  assert.throws(() => bind(registry({ revision: 4 })), /registry identity or revision drifted/);
});

test('parent capability or tool-scope drift requires rediscovery instead of widening or silently changing child authority', () => {
  const request = discovery();
  const selected = discoverSpecialistsV1(request).specialists[0];
  const base = {
    registry: request.registry,
    selection: selected,
    handoff: handoff(),
  };

  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    ...base,
    parentCapabilityIds: ['coding.read'],
    parentToolIds: request.parentToolIds,
  }), /exceeds parent or specialist authority/);

  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    ...base,
    parentCapabilityIds: request.parentCapabilityIds,
    parentToolIds: ['workspace.patch'],
  }), /Selected child tools exceeds parent or specialist authority/);

  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    ...base,
    handoff: handoff({ requestedCapabilityIds: ['coding.read'] }),
    parentCapabilityIds: request.parentCapabilityIds,
    parentToolIds: request.parentToolIds,
  }), /capability scope changed after selection/);
});

test('registry rejects duplicate identities, numeric aliases, secret-shaped unknown fields and text aliases', () => {
  assert.throws(() => normalizeSpecialistRegistryV1(registry({
    definitions: [definition(), definition()],
  })), /duplicate specialistId/);
  assert.throws(() => normalizeSpecialistRegistryV1(registry({ revision: -0 })), /registry revision is invalid/);
  assert.throws(() => normalizeSpecialistDefinitionV1(definition({ definitionRevision: -0 })), /definitionRevision is invalid/);
  assert.throws(() => normalizeSpecialistDefinitionV1({ ...definition(), apiKey: 'must-never-enter-registry' }), /unknown field: apiKey/);
  assert.throws(() => normalizeSpecialistDefinitionV1(definition({ specialistId: ' openhands-coding' })), /exact canonical identity/);
  assert.throws(() => normalizeSpecialistDefinitionV1(definition({ label: ' OpenHands Coding' })), /exact bounded text/);
});

test('authority records reject accessors and hidden/symbol fields without executing getters', () => {
  let reads = 0;
  const hostile = definition();
  Object.defineProperty(hostile, 'providerId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return OPENHANDS_CODING_PROVIDER_ID;
    },
  });
  assert.throws(() => normalizeSpecialistDefinitionV1(hostile), /providerId must be an enumerable own data property/);
  assert.equal(reads, 0);

  const hidden = definition();
  Object.defineProperty(hidden, 'enabled', { enumerable: false, value: true });
  assert.throws(() => normalizeSpecialistDefinitionV1(hidden), /enabled must be an enumerable own data property/);

  const symbolic = definition();
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeSpecialistDefinitionV1(symbolic), /unknown field/);
});

test('null-prototype records are accepted and caller-owned registry inputs remain unchanged', () => {
  const coding = Object.assign(Object.create(null), definition());
  const portable = Object.assign(Object.create(null), registry({ definitions: [coding] }));
  const before = JSON.stringify(portable);
  const normalized = normalizeSpecialistRegistryV1(portable);
  assert.equal(normalized.definitions.length, 1);
  assert.equal(JSON.stringify(portable), before);
  assert.equal(portable.definitions[0].enabled, true);
});
