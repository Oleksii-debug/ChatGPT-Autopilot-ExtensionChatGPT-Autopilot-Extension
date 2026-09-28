import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_SPECIALIST_DELEGATION_BINDING_VERSION,
  AGENT_SPECIALIST_DELEGATION_PROFILE_VERSION,
  materializeAgentSpecialistDelegationIntentV1,
  materializeBoundAgentSpecialistDelegationIntentV1,
  normalizeAgentSpecialistDelegationBindingV1,
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

function binding(overrides = {}) {
  return {
    schemaVersion: AGENT_SPECIALIST_DELEGATION_BINDING_VERSION,
    jobId: 'job:agent-1',
    projectId: 'project:1',
    registryId: 'agents:project-1',
    registryRevision: 3,
    agentDefinitionId: 'agent:research',
    definitionRevision: 7,
    profile: profile(),
    authority: {
      proposalOnly: true,
      executionAuthorized: false,
      policyAuthorized: false,
      schedulingAuthorized: false,
      recoveryAuthorized: false,
      credentialAuthorized: false,
      completionAuthorized: false,
      verificationAuthorized: false,
      capacityReserved: false,
    },
    ...overrides,
  };
}

function boundRequest(overrides = {}) {
  return {
    binding: binding(),
    jobId: 'job:agent-1',
    projectId: 'project:1',
    agentDefinitionRegistryId: 'agents:project-1',
    agentDefinitionRegistryRevision: 3,
    agentDefinitionId: 'agent:research',
    definitionRevision: 7,
    parentCapabilityIds: ['filesystem.write', 'data.read', 'data.analyze'],
    parentToolIds: ['shell.run', 'artifact.write', 'data.query'],
    expectedRegistryRevision: 5,
    expectedPlanRevision: 11,
    nodeId: 'node:local-analysis',
    at: T0,
    parentInvocationId: 'invocation:parent-1',
    ...overrides,
  };
}

test('normalizes launch binding and rejects any caller-shaped authority grant', () => {
  const normalized = normalizeAgentSpecialistDelegationBindingV1(binding());
  assert.equal(normalized.jobId, 'job:agent-1');
  assert.equal(normalized.projectId, 'project:1');
  assert.equal(normalized.registryId, 'agents:project-1');
  assert.equal(normalized.registryRevision, 3);
  assert.equal(normalized.agentDefinitionId, 'agent:research');
  assert.equal(normalized.definitionRevision, 7);
  assert.equal(normalized.profile.registryId, 'specialists:project-1');
  assert.equal(normalized.authority.proposalOnly, true);
  assert.equal(normalized.authority.executionAuthorized, false);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.profile), true);
  assert.equal(Object.isFrozen(normalized.authority), true);

  const escalated = binding();
  escalated.authority = { ...escalated.authority, executionAuthorized: true };
  assert.throws(
    () => normalizeAgentSpecialistDelegationBindingV1(escalated),
    /executionAuthorized must be false/u,
  );

  const hidden = binding();
  hidden.authority = { ...hidden.authority, hiddenGrant: true };
  assert.throws(
    () => normalizeAgentSpecialistDelegationBindingV1(hidden),
    /unknown field/u,
  );
});

test('bound materialization derives PREPARE intent only from exact launch provenance', () => {
  const intent = materializeBoundAgentSpecialistDelegationIntentV1(boundRequest());
  assert.equal(intent.request.registryId, 'specialists:project-1');
  assert.equal(intent.request.expectedRegistryRevision, 5);
  assert.equal(intent.request.expectedPlanRevision, 11);
  assert.equal(intent.request.nodeId, 'node:local-analysis');
  assert.deepEqual(intent.request.requiredCapabilityIds, ['data.analyze', 'data.read']);
  assert.deepEqual(intent.request.requiredToolIds, ['artifact.write', 'data.query']);
  assert.equal(intent.request.deadlineAt, '2026-09-27T18:15:00.000Z');
  assert.deepEqual(intent.provenance, {
    jobId: 'job:agent-1',
    projectId: 'project:1',
    agentDefinitionRegistryId: 'agents:project-1',
    agentDefinitionRegistryRevision: 3,
    agentDefinitionId: 'agent:research',
    definitionRevision: 7,
    ownerBound: true,
  });
  assert.equal(intent.authority.executionAuthorized, false);
  assert.equal(intent.authority.capacityReserved, false);
  assert.equal(Object.isFrozen(intent.provenance), true);
});

test('bound materialization fails closed on job, Project or definition provenance drift', () => {
  for (const [field, value] of [
    ['jobId', 'job:other'],
    ['projectId', 'project:other'],
    ['agentDefinitionRegistryId', 'agents:other'],
    ['agentDefinitionRegistryRevision', 4],
    ['agentDefinitionId', 'agent:other'],
    ['definitionRevision', 8],
  ]) {
    assert.throws(
      () => materializeBoundAgentSpecialistDelegationIntentV1(boundRequest({ [field]: value })),
      /binding provenance drifted/u,
      field,
    );
  }

  assert.throws(
    () => materializeBoundAgentSpecialistDelegationIntentV1(boundRequest({
      binding: binding({ projectId: '' }),
    })),
    /binding provenance drifted/u,
  );
});

test('launch binding snapshots mutable caller data and rejects accessor substitution', () => {
  const input = binding();
  const normalized = normalizeAgentSpecialistDelegationBindingV1(input);
  input.profile.requiredCapabilityIds[0] = 'capability.mutated';
  input.authority.executionAuthorized = true;

  assert.deepEqual(normalized.profile.requiredCapabilityIds, ['data.analyze', 'data.read']);
  assert.equal(normalized.authority.executionAuthorized, false);

  let reads = 0;
  const hostile = binding();
  Object.defineProperty(hostile, 'profile', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return profile();
    },
  });
  assert.throws(
    () => normalizeAgentSpecialistDelegationBindingV1(hostile),
    /AgentSpecialistDelegationBindingV1\.profile must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);
});

test('bound materialization rejects disabled bindings and hidden caller fields', () => {
  assert.throws(
    () => materializeBoundAgentSpecialistDelegationIntentV1(boundRequest({
      binding: binding({ profile: profile({ enabled: false }) }),
    })),
    /profile is disabled/u,
  );

  assert.throws(
    () => materializeBoundAgentSpecialistDelegationIntentV1({
      ...boundRequest(),
      hiddenAuthority: true,
    }),
    /unknown field/u,
  );
});

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
  assert.equal(intent.schemaVersion, 1);
  assert.equal(intent.request.registryId, 'specialists:project-1');
  assert.equal(intent.request.expectedRegistryRevision, 5);
  assert.equal(intent.request.expectedPlanRevision, 11);
  assert.equal(intent.request.nodeId, 'node:local-analysis');
  assert.deepEqual(intent.request.requiredCapabilityIds, ['data.analyze', 'data.read']);
  assert.deepEqual(intent.request.requiredToolIds, ['artifact.write', 'data.query']);
  assert.equal(intent.request.policyEnvelopeId, 'policy:job.auto');
  assert.equal(intent.request.deadlineAt, '2026-09-27T18:15:00.000Z');
  assert.equal(intent.request.maxConcurrentHandoffs, 4);
  assert.equal(intent.request.leaseSeconds, 600);
  assert.equal(intent.request.priority, 7);
  assert.deepEqual(intent.request.childBudget, {
    maxModelCalls: 4,
    maxRuntimeSeconds: 300,
    maxCostUsdMicros: 500000,
  });
  assert.equal(intent.request.parentInvocationId, 'invocation:parent-1');
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
  assert.equal(Object.isFrozen(intent.request), true);
  assert.equal(Object.isFrozen(intent.authority), true);
  assert.equal(Object.hasOwn(intent.request, 'authority'), false);
  assert.equal(Object.hasOwn(intent.request, 'schemaVersion'), false);
});

test('materialized request matches canonical AUTO_PREPARE key semantics and omits absent optionals', () => {
  const withoutBudget = request();
  delete withoutBudget.childBudget;
  delete withoutBudget.parentInvocationId;
  const materialized = materializeAgentSpecialistDelegationIntentV1(withoutBudget);

  assert.deepEqual(Object.keys(materialized.request).sort(), [
    'deadlineAt',
    'expectedPlanRevision',
    'expectedRegistryRevision',
    'leaseSeconds',
    'maxConcurrentHandoffs',
    'nodeId',
    'parentInvocationId',
    'policyEnvelopeId',
    'priority',
    'registryId',
    'requiredCapabilityIds',
    'requiredToolIds',
  ].sort());
  assert.equal(Object.hasOwn(materialized.request, 'childBudget'), false);
  assert.equal(materialized.request.parentInvocationId, '');
  assert.equal(Object.hasOwn(materialized.request, 'artifactRefs'), false);
  assert.equal(Object.hasOwn(materialized.request, 'credentialRefs'), false);
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
      at: '+275760-09-13T00:00:00.000Z',
      profile: profile({ deadlineSeconds: 1 }),
    })),
    /deadline exceeds exact timestamp range/u,
  );
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({
      childBudget: undefined,
    })),
    /childBudget must be omitted instead of undefined/u,
  );
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({
      childBudget: { maxModelCalls: -0 },
    })),
    /childBudget\.maxModelCalls is invalid/u,
  );
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({
      childBudget: { maxModelCalls: 1_000_001 },
    })),
    /childBudget\.maxModelCalls is invalid/u,
  );
  assert.throws(
    () => materializeAgentSpecialistDelegationIntentV1(request({
      childBudget: { maxRuntimeSeconds: 31_536_001 },
    })),
    /childBudget\.maxRuntimeSeconds is invalid/u,
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

  assert.deepEqual(intent.request.requiredCapabilityIds, ['data.analyze', 'data.read']);
  assert.equal(intent.request.childBudget.maxModelCalls, 4);
});
