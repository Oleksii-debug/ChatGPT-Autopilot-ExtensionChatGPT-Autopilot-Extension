import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_SPECIALIST_DELEGATION_PROFILE_VERSION,
  materializeAgentSpecialistDelegationIntentV1,
  normalizeAgentSpecialistDelegationProfileV1,
} from '../src/core/agent-specialist-delegation-profile.js';

const T0 = '2026-09-27T18:00:00.000Z';

function profile(overrides = {}) {
  return {
    schemaVersion: AGENT_SPECIALIST_DELEGATION_PROFILE_VERSION,
    registryId: 'specialists:project-1',
    requiredCapabilityIds: ['data.read', 'data.analyze'],
    requiredToolIds: ['artifact.write', 'data.query'],
    policyEnvelopeId: 'policy:job.auto',
    deadlineSeconds: 900,
    maxConcurrentHandoffs: 4,
    leaseSeconds: 600,
    priority: 7,
    enabled: true,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    profile: profile(),
    parentCapabilityIds: ['filesystem.write', 'data.read', 'data.analyze'],
    parentToolIds: ['shell.run', 'artifact.write', 'data.query'],
    expectedRegistryRevision: 5,
    expectedPlanRevision: 11,
    nodeId: 'node:local-analysis',
    at: T0,
    parentInvocationId: 'invocation:parent-1',
    childBudget: {
      maxModelCalls: 4,
      maxRuntimeSeconds: 300,
      maxCostUsdMicros: 500000,
    },
    ...overrides,
  };
}

test('normalizes owner delegation profile deterministically and freezes it', () => {
  const normalized = normalizeAgentSpecialistDelegationProfileV1(profile());
  assert.deepEqual(normalized.requiredCapabilityIds, ['data.analyze', 'data.read']);
  assert.deepEqual(normalized.requiredToolIds, ['artifact.write', 'data.query']);
  assert.equal(normalized.registryId, 'specialists:project-1');
  assert.equal(normalized.deadlineSeconds, 900);
  assert.equal(normalized.maxConcurrentHandoffs, 4);
  assert.equal(normalized.leaseSeconds, 600);
  assert.equal(normalized.priority, 7);
  assert.equal(normalized.enabled, true);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.requiredCapabilityIds), true);
});

test('profile rejects unknown fields, accessors and non-canonical arrays', () => {
  assert.throws(
    () => normalizeAgentSpecialistDelegationProfileV1({
      ...profile(),
      hiddenAuthority: true,
    }),
    /unknown field/u,
  );

  const accessor = profile();
  Object.defineProperty(accessor, 'registryId', {
    enumerable: true,
    get() { throw new Error('must not execute'); },
  });
  assert.throws(
    () => normalizeAgentSpecialistDelegationProfileV1(accessor),
    /enumerable own data property/u,
  );

  const sparse = profile();
  sparse.requiredCapabilityIds = new Array(2);
  sparse.requiredCapabilityIds[1] = 'data.read';
  assert.throws(
    () => normalizeAgentSpecialistDelegationProfileV1(sparse),
    /enumerable own data property/u,
  );
});

test('profile requires non-empty canonical capabilities and exact bounded policy values', () => {
  assert.throws(
    () => normalizeAgentSpecialistDelegationProfileV1(profile({ requiredCapabilityIds: [] })),
    /1-64 items/u,
  );
  assert.throws(
    () => normalizeAgentSpecialistDelegationProfileV1(profile({
      requiredCapabilityIds: ['data.read', 'data.read'],
    })),
    /duplicate identity/u,
  );
  assert.throws(
    () => normalizeAgentSpecialistDelegationProfileV1(profile({ maxConcurrentHandoffs: -0 })),
    /maxConcurrentHandoffs is invalid/u,
  );
  assert.throws(
    () => normalizeAgentSpecialistDelegationProfileV1(profile({ maxConcurrentHandoffs: 257 })),
    /maxConcurrentHandoffs is invalid/u,
  );
  assert.throws(
    () => normalizeAgentSpecialistDelegationProfileV1(profile({ leaseSeconds: 86401 })),
    /leaseSeconds is invalid/u,
  );
  assert.throws(
    () => normalizeAgentSpecialistDelegationProfileV1(profile({ priority: 1000001 })),
    /priority is invalid/u,
  );
  assert.throws(
    () => normalizeAgentSpecialistDelegationProfileV1(profile({ enabled: 1 })),
    /enabled must be boolean/u,
  );
});

test('materialization derives existing PREPARE intent without granting runtime authority', () => {
  const intent = materializeAgentSpecialistDelegationIntentV1(request());
  assert.equal(intent.registryId, 'specialists:project-1');
  assert.equal(intent.expectedRegistryRevision, 5);
  assert.equal(intent.expectedPlanRevision, 11);
  assert.equal(intent.nodeId, 'node:local-analysis');
  assert.deepEqual(intent.requiredCapabilityIds, ['data.analyze', 'data.read']);
  assert.deepEqual(intent.requiredToolIds, ['artifact.write', 'data.query']);
  assert.equal(intent.policyEnvelopeId, 'policy:job.auto');
  assert.equal(intent.deadlineAt, '2026-09-27T18:15:00.000Z');
  assert.equal(intent.maxConcurrentHandoffs, 4);
  assert.equal(intent.leaseSeconds, 600);
  assert.equal(intent.priority, 7);
  assert.deepEqual(intent.childBudget, {
    maxModelCalls: 4,
    maxRuntimeSeconds: 300,
    maxCostUsdMicros: 500000,
  });
  assert.equal(intent.parentInvocationId, 'invocation:parent-1');
  assert.deepEqual(intent.authority, {
    proposalOnly: true,
    executionAuthorized: false,
    policyAuthorized: false,
    schedulingAuthorized: false,
    recoveryAuthorized: false,
    credentialAuthorized: false,
    completionAuthorized: false,
    verificationAuthorized: false,
    capacityReserved: false,
  });
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.authority), true);
});

test('materialization rejects capability or tool escalation beyond persisted parent scope', () => {
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({
      parentCapabilityIds: ['data.read'],
    })),
    /Required specialist capabilities exceeds parent authority: data\.analyze/u,
  );
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({
      parentToolIds: ['artifact.write'],
    })),
    /Required specialist tools exceeds parent authority: data\.query/u,
  );
});

test('disabled profile cannot produce automatic delegation intent', () => {
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({
      profile: profile({ enabled: false }),
    })),
    /profile is disabled/u,
  );
});

test('materialization rejects stale-shaped identities, timestamps, revisions and budgets', () => {
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({ expectedRegistryRevision: -0 })),
    /expectedRegistryRevision is invalid/u,
  );
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({ expectedPlanRevision: 0 })),
    /expectedPlanRevision is invalid/u,
  );
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({ at: '2026-09-27T18:00:00Z' })),
    /canonical ISO-8601 UTC/u,
  );
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({
      childBudget: { maxModelCalls: -0 },
    })),
    /childBudget\.maxModelCalls is invalid/u,
  );
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({
      childBudget: { maxModelCalls: 1, hidden: 2 },
    })),
    /unknown field/u,
  );
});

test('materialization does not retain mutable caller collections', () => {
  const input = request();
  const intent = materializeAgentSpecialistDelegationIntentV1(input);
  input.profile.requiredCapabilityIds[0] = 'capability.mutated';
  input.parentCapabilityIds[0] = 'capability.mutated';
  input.childBudget.maxModelCalls = 99;

  assert.deepEqual(intent.requiredCapabilityIds, ['data.analyze', 'data.read']);
  assert.equal(intent.childBudget.maxModelCalls, 4);
});
