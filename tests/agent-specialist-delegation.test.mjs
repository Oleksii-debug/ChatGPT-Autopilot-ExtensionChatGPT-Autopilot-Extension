import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareAutomaticAgentSpecialistDelegationV1 } from '../src/core/agent-specialist-delegation.js';

const T0 = '2026-09-27T03:00:00.000Z';
const T1 = '2026-09-27T04:00:00.000Z';

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    planId: 'plan-auto-delegation',
    jobId: 'job-auto-delegation',
    objective: 'Finish the project outcome.',
    successCriteria: ['Verified result exists'],
    createdAt: T0,
    updatedAt: T0,
    revision: 7,
    nodes: [{
      nodeId: 'local-analysis',
      title: 'Analyze data',
      objective: 'Analyze the bounded local dataset and return an artifact.',
      dependsOn: [],
      conflictKeys: ['artifact:analysis'],
      ownerId: 'agent-root',
      executionPlane: 'LOCAL',
      acceptanceCriteria: ['Artifact is verified'],
      budget: {
        maxModelCalls: 6,
        maxRuntimeSeconds: 1200,
        maxCostUsdMicros: 900000,
      },
      state: 'READY',
      evidence: '',
      updatedAt: T0,
    }],
    ...overrides,
  };
}

function definition(specialistId, capabilityIds, toolIds, overrides = {}) {
  return {
    schemaVersion: 1,
    specialistId,
    providerId: `provider:${specialistId}`,
    label: specialistId,
    description: '',
    executionPlane: 'LOCAL',
    capabilityIds,
    toolIds,
    resultContractId: 'result:analysis',
    enabled: true,
    definitionRevision: 1,
    ...overrides,
  };
}

function registry(definitions) {
  return {
    schemaVersion: 1,
    registryId: 'registry:default',
    revision: 4,
    definitions,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    plan: plan(),
    expectedPlanRevision: 7,
    nodeId: 'local-analysis',
    registry: registry([
      definition('broad', ['data.read', 'data.analyze', 'filesystem.write'], ['data.query', 'artifact.write', 'shell.run']),
      definition('narrow-z', ['data.read', 'data.analyze'], ['data.query', 'artifact.write']),
      definition('narrow-a', ['data.read', 'data.analyze'], ['data.query', 'artifact.write']),
    ]),
    parentCapabilityIds: ['data.analyze', 'data.read', 'filesystem.write'],
    parentToolIds: ['artifact.write', 'data.query', 'shell.run'],
    requiredCapabilityIds: ['data.read', 'data.analyze'],
    requiredToolIds: ['data.query', 'artifact.write'],
    policyEnvelopeId: 'policy:job-auto-delegation',
    deadlineAt: T1,
    priority: 5,
    at: T0,
    ...overrides,
  };
}

test('automatic delegation selects least-authority eligible specialist with deterministic identity tie-break', () => {
  const result = prepareAutomaticAgentSpecialistDelegationV1(request());
  assert.equal(result.selection.specialistId, 'narrow-a');
  assert.deepEqual(result.selectionReason, {
    kind: 'LEAST_AUTHORITY_ELIGIBLE',
    capabilitySurplus: 0,
    toolSurplus: 0,
  });
  assert.equal(result.preview.assignment.specialistId, 'narrow-a');
  assert.equal(result.preview.assignment.parentAgentId, 'browser-agent:job-auto-delegation');
  assert.equal(result.preview.executionOwnership.effectId, 'specialist-effect:plan-auto-delegation:local-analysis');
  assert.equal(result.authority.executionAuthorized, false);
  assert.equal(result.authority.policyAuthorized, false);
  assert.equal(result.requiresCanonicalRevalidation.planRevision, true);
  assert.equal(result.requiresCanonicalRevalidation.ownerSubagentPolicy, true);
});

test('delegation is constrained to the AgentPlan execution plane and fails when no specialist is eligible', () => {
  const remoteOnly = registry([
    definition('remote-specialist', ['data.read', 'data.analyze'], ['data.query', 'artifact.write'], {
      executionPlane: 'REMOTE',
    }),
  ]);
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({ registry: remoteOnly })),
    /No eligible specialist/,
  );

  const localAndRemote = registry([
    definition('aaa-remote', ['data.read', 'data.analyze'], ['data.query', 'artifact.write'], {
      executionPlane: 'REMOTE',
    }),
    definition('zzz-local', ['data.read', 'data.analyze'], ['data.query', 'artifact.write']),
  ]);
  assert.equal(
    prepareAutomaticAgentSpecialistDelegationV1(request({ registry: localAndRemote })).selection.specialistId,
    'zzz-local',
  );
});

test('required child capability and tools cannot exceed the parent authority envelope', () => {
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({
      parentCapabilityIds: ['data.read'],
    })),
    /exceeds parent or specialist authority/,
  );
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({
      parentToolIds: ['data.query'],
    })),
    /exceeds parent or specialist authority/,
  );
});

test('child budget is narrowed to the exact durable AgentPlan node envelope', () => {
  const result = prepareAutomaticAgentSpecialistDelegationV1(request({
    childBudget: {
      maxModelCalls: 100,
      maxRuntimeSeconds: 3600,
      maxCostUsdMicros: 5000000,
    },
  }));
  assert.deepEqual(result.childBudget, {
    maxModelCalls: 6,
    maxRuntimeSeconds: 1200,
    maxCostUsdMicros: 900000,
    narrowed: true,
  });
  assert.equal(result.binding.handoff.maxModelCalls, 6);
  assert.equal(result.binding.handoff.maxRuntimeSeconds, 1200);
  assert.equal(result.binding.handoff.maxCostUsdMicros, 900000);
});

test('delegation isolates child context to immutable artifact and credential references', () => {
  const artifact = {
    schemaVersion: 1,
    artifactId: 'artifact:input',
    kind: 'dataset',
    uri: 'file://workspace/input.csv',
    mediaType: 'text/csv',
    sha256: 'a'.repeat(64),
    sizeBytes: 128,
    createdAt: T0,
    producerInvocationId: 'invoke:parent',
    sensitive: false,
  };
  const credential = {
    schemaVersion: 1,
    credentialId: 'credential:data',
    brokerId: 'broker:windows',
    kind: 'token',
    scope: ['data.example'],
    expiresAt: T1,
  };
  const result = prepareAutomaticAgentSpecialistDelegationV1(request({
    artifactRefs: [artifact],
    credentialRefs: [credential],
    parentInvocationId: 'invoke:parent',
  }));
  assert.deepEqual(result.binding.childContext.artifactRefs.map(item => item.artifactId), ['artifact:input']);
  assert.deepEqual(result.binding.childContext.credentialRefs.map(item => item.credentialId), ['credential:data']);
  assert.equal(result.binding.childContext.parentInvocationId, 'invoke:parent');
  assert.deepEqual(result.binding.childScope.capabilityIds, ['data.analyze', 'data.read']);
  assert.deepEqual(result.binding.childScope.toolIds, ['artifact.write', 'data.query']);
  assert.equal(result.binding.authority.credentialAuthorized, false);
  assert.equal(result.authority.credentialAuthorized, false);
});

test('proposal binds exact READY plan revision and rejects browser/non-ready nodes and stale plans', () => {
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({ expectedPlanRevision: 6 })),
    /revision conflict/,
  );
  const running = plan({
    nodes: [{ ...plan().nodes[0], state: 'RUNNING' }],
  });
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({ plan: running })),
    /must be READY/,
  );
  const browser = plan({
    nodes: [{ ...plan().nodes[0], executionPlane: 'BROWSER' }],
  });
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({ plan: browser })),
    /LOCAL, CLOUD or REMOTE/,
  );
});

test('outer authority records reject accessors, aliases and coercive identities without executing them', () => {
  let reads = 0;
  const getter = request();
  Object.defineProperty(getter, 'nodeId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'local-analysis';
    },
  });
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(getter),
    /nodeId must be an enumerable own data property/,
  );
  assert.equal(reads, 0);

  let coercions = 0;
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({
      nodeId: { toString() { coercions += 1; return 'local-analysis'; } },
    })),
    /nodeId is invalid/,
  );
  assert.equal(coercions, 0);

  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({ executionAuthorized: true })),
    /unknown field/,
  );
});

test('authority arrays are canonical, dense and cannot hide fields or accessors', () => {
  const sparse = new Array(2);
  sparse[0] = 'data.read';
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({ requiredCapabilityIds: sparse })),
    /enumerable own data property/,
  );

  const decorated = ['data.read', 'data.analyze'];
  decorated.extra = 'filesystem.write';
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({ requiredCapabilityIds: decorated })),
    /non-canonical array fields/,
  );

  let reads = 0;
  const accessor = ['data.read', 'data.analyze'];
  Object.defineProperty(accessor, '1', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'data.analyze';
    },
  });
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({ requiredCapabilityIds: accessor })),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);
});

test('deadline and child budget representations fail closed on non-canonical input', () => {
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({ deadlineAt: T0 })),
    /deadlineAt must be later/,
  );
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({ at: '2026-09-27T03:00:00Z' })),
    /canonical ISO-8601 UTC/,
  );
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({
      childBudget: { maxModelCalls: '5' },
    })),
    /maxModelCalls is invalid/,
  );
  assert.throws(
    () => prepareAutomaticAgentSpecialistDelegationV1(request({
      childBudget: { maxModelCalls: -0 },
    })),
    /maxModelCalls is invalid/,
  );
});
