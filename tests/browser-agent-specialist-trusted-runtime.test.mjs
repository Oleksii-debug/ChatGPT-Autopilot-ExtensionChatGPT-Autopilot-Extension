import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { TRUSTED_EXECUTION_VERIFICATION_LEDGER_STORAGE_KEY } from '../src/core/trusted-execution-verification-ledger.js';
import {
  prepareAgentPlanSpecialistHandoffV1,
  prepareAgentPlanSpecialistExecutionOwnershipV1,
  claimAgentPlanSpecialistHandoffsV1,
  completeAgentPlanSpecialistHandoffV1,
} from '../src/core/agent-specialist-bridge.js';

const T0 = '2026-09-29T00:00:00.000Z';
const T1 = '2026-09-29T00:01:00.000Z';
const T1A = '2026-09-29T00:01:01.000Z';
const T1B = '2026-09-29T00:01:02.000Z';
const T1C = '2026-09-29T00:01:03.000Z';
const T1D = '2026-09-29T00:01:04.000Z';
const T2 = '2026-09-29T00:02:00.000Z';
const T3 = '2026-09-29T00:03:00.000Z';
const T4 = '2026-09-29T00:04:00.000Z';

function storageChrome() {
  const storage = Object.create(null);
  return {
    storage: {
      local: {
        async get(key) {
          return Object.hasOwn(storage, key)
            ? { [key]: structuredClone(storage[key]) }
            : {};
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        },
      },
    },
  };
}

function plan() {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    jobId: 'job-1',
    objective: 'Complete safely',
    successCriteria: ['Verified'],
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
    nodes: [
      {
        nodeId: 'browser',
        title: 'Inspect',
        objective: 'Inspect',
        dependsOn: [],
        conflictKeys: ['web'],
        ownerId: 'parent',
        executionPlane: 'BROWSER',
        acceptanceCriteria: [],
        budget: {},
        state: 'VERIFIED',
        evidence: 'Observed',
        updatedAt: T0,
      },
      {
        nodeId: 'local',
        title: 'Archive',
        objective: 'Create a bounded archive',
        dependsOn: ['browser'],
        conflictKeys: ['files'],
        ownerId: 'parent',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Archive exists'],
        budget: {},
        state: 'PENDING',
        evidence: '',
        updatedAt: T0,
      },
    ],
  };
}

function scope() {
  return {
    nodeId: 'local',
    specialistId: 'native-companion',
    requestedCapabilityIds: ['filesystem.archive'],
    parentCapabilityIds: ['filesystem.read', 'filesystem.archive'],
    policyEnvelopeId: 'policy:archive',
    deadlineAt: '2026-09-29T01:00:00.000Z',
    priority: 4,
    at: T0,
  };
}

function proofArtifact({
  artifactId = 'artifact:archive',
  createdAt = T1,
  sha256 = 'b'.repeat(64),
} = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'specialist-result',
    uri: `file://workspace/${artifactId.replace(':', '-')}.bin`,
    mediaType: 'application/octet-stream',
    sha256,
    sizeBytes: 64,
    createdAt,
    producerInvocationId: 'invoke:verifier',
    sensitive: false,
  };
}

function trustedRecord({
  executionId,
  outcome = 'EFFECT_VERIFIED',
  verificationId = 'verification-specialist-1',
  recordId = 'trusted-specialist-record-1',
  artifacts = [proofArtifact()],
  verifiedAt = T2,
  recordedAt = T3,
  validThrough = T4,
} = {}) {
  return {
    schemaVersion: 1,
    recordId,
    taskId: 'browser-agent-task:plan-1',
    planId: 'plan-1',
    nodeId: 'local',
    effectId: 'specialist-effect:plan-1:local',
    policyEnvelopeId: 'policy:archive',
    executionId,
    outcome,
    verification: {
      schemaVersion: 1,
      verificationId,
      invocationId: 'invoke:specialist-verifier',
      observationId: 'observation:specialist-verifier',
      status: 'VERIFIED',
      reasonCode: outcome === 'NO_EFFECT_VERIFIED'
        ? 'NO_EFFECT_OBSERVED'
        : 'RESULT_POSTCONDITION_MATCH',
      summary: 'Canonical independent verifier resolved exact specialist execution.',
      evidenceArtifactIds: artifacts.map(item => item.artifactId),
      verifiedAt,
      verifierId: 'independent-specialist-verifier',
      verificationAuthorityId: 'policy:archive',
      effectId: 'specialist-effect:plan-1:local',
      executionId,
      attempt: 1,
    },
    evidenceArtifacts: artifacts,
    recordedAt,
    validThrough,
  };
}

function initial() {
  const assignment = prepareAgentPlanSpecialistHandoffV1(plan(), scope());
  const ownership = prepareAgentPlanSpecialistExecutionOwnershipV1(plan(), scope());
  return { assignment, ownership };
}

function managerWithStore(store, now = T3) {
  const chromeApi = storageChrome();
  const manager = new BrowserAgentManager({
    chromeApi,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(now),
  });
  manager.update = async mutator => {
    await mutator(store);
    return store;
  };
  return manager;
}

test('BrowserAgentManager verifies completed specialist only through durable trusted ledger', async () => {
  const { assignment, ownership } = initial();
  const claimed = claimAgentPlanSpecialistHandoffsV1(
    plan(),
    [assignment],
    { executionOwnerships: [ownership], availableSlots: 1, at: T0 },
  );
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;
  const completed = completeAgentPlanSpecialistHandoffV1(
    claimed.plan,
    claimed.assignments,
    {
      executionOwnerships: claimed.executionOwnerships,
      agentId,
      leaseId,
      resultArtifactIds: ['artifact:archive'],
      at: T1,
    },
  );
  const store = {
    byId: {
      'job-1': {
        runtime: {
          plan: completed.plan,
          specialistHandoffs: completed.assignments,
          specialistExecutionOwnerships: completed.executionOwnerships,
          history: [],
          updatedAt: Date.parse(T1),
        },
      },
    },
  };
  const manager = managerWithStore(store, T3);
  await manager.trustedExecutionVerificationLedger.append(trustedRecord({ executionId: leaseId }));

  const result = await manager.verifySpecialistHandoff('job-1', {
    agentId,
    leaseId,
    verificationId: 'verification-specialist-1',
    at: T3,
  });

  assert.equal(result.plan.nodes.find(node => node.nodeId === 'local').state, 'VERIFIED');
  assert.equal(result.executionOwnerships[0].state, 'VERIFIED');
  assert.equal(result.trustedVerification.recordId, 'trusted-specialist-record-1');
  assert.equal(store.byId['job-1'].runtime.history.at(-1).verificationId, 'verification-specialist-1');
  assert.match(store.byId['job-1'].runtime.history.at(-1).evidence, /trusted-record=trusted-specialist-record-1/);
});

test('BrowserAgentManager authorizes retry only from durable trusted NO_EFFECT record', async () => {
  const { assignment, ownership } = initial();
  const claimed = claimAgentPlanSpecialistHandoffsV1(
    plan(),
    [assignment],
    {
      executionOwnerships: [ownership],
      availableSlots: 1,
      leaseSeconds: 30,
      at: T0,
    },
  );
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;
  const expired = claimAgentPlanSpecialistHandoffsV1(
    claimed.plan,
    claimed.assignments,
    {
      executionOwnerships: claimed.executionOwnerships,
      availableSlots: 1,
      at: T1,
    },
  );
  const store = {
    byId: {
      'job-1': {
        runtime: {
          plan: expired.plan,
          specialistHandoffs: expired.assignments,
          specialistExecutionOwnerships: expired.executionOwnerships,
          history: [],
          updatedAt: Date.parse(T1),
        },
      },
    },
  };
  const manager = managerWithStore(store, T1D);
  await manager.trustedExecutionVerificationLedger.append(trustedRecord({
    executionId: leaseId,
    outcome: 'NO_EFFECT_VERIFIED',
    verificationId: 'verification-no-effect-specialist',
    recordId: 'trusted-specialist-no-effect-record-1',
    artifacts: [proofArtifact({ artifactId: 'artifact:no-effect', createdAt: T1A })],
    verifiedAt: T1B,
    recordedAt: T1C,
    validThrough: T2,
  }));

  const result = await manager.authorizeSpecialistSafeRetry('job-1', {
    agentId,
    leaseId,
    verificationId: 'verification-no-effect-specialist',
    at: T1D,
  });

  assert.equal(result.plan.nodes.find(node => node.nodeId === 'local').state, 'READY');
  assert.equal(result.assignments[0].state, 'READY');
  assert.equal(result.executionOwnerships[0].state, 'AVAILABLE');
  assert.equal(result.executionDispatched, false);
  assert.equal(result.trustedVerification.outcome, 'NO_EFFECT_VERIFIED');
  assert.equal(store.byId['job-1'].runtime.history.at(-1).verificationId, 'verification-no-effect-specialist');
  assert.match(store.byId['job-1'].runtime.history.at(-1).evidence, /outcome=NO_EFFECT_VERIFIED/);
});


test('BrowserAgentManager leaves specialist state unchanged when trusted verification record is absent', async () => {
  const { assignment, ownership } = initial();
  const claimed = claimAgentPlanSpecialistHandoffsV1(
    plan(),
    [assignment],
    { executionOwnerships: [ownership], availableSlots: 1, at: T0 },
  );
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;
  const completed = completeAgentPlanSpecialistHandoffV1(
    claimed.plan,
    claimed.assignments,
    {
      executionOwnerships: claimed.executionOwnerships,
      agentId,
      leaseId,
      resultArtifactIds: ['artifact:archive'],
      at: T1,
    },
  );
  const store = {
    byId: {
      'job-1': {
        runtime: {
          plan: completed.plan,
          specialistHandoffs: completed.assignments,
          specialistExecutionOwnerships: completed.executionOwnerships,
          history: [],
          updatedAt: Date.parse(T1),
        },
      },
    },
  };
  const manager = managerWithStore(store, T3);

  await assert.rejects(
    () => manager.verifySpecialistHandoff('job-1', {
      agentId,
      leaseId,
      verificationId: 'verification-specialist-missing',
      at: T3,
    }),
    /trusted.*verification.*record.*not found/i,
  );

  assert.equal(store.byId['job-1'].runtime.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  assert.equal(store.byId['job-1'].runtime.specialistHandoffs[0].state, 'COMPLETED');
  assert.equal(store.byId['job-1'].runtime.specialistExecutionOwnerships[0].state, 'OWNED');
  assert.equal(store.byId['job-1'].runtime.history.length, 0);
  assert.equal(store.byId['job-1'].runtime.updatedAt, Date.parse(T1));
});

test('BrowserAgentManager fails closed on persisted trusted-ledger revision drift without mutating specialist state', async () => {
  const { assignment, ownership } = initial();
  const claimed = claimAgentPlanSpecialistHandoffsV1(
    plan(),
    [assignment],
    { executionOwnerships: [ownership], availableSlots: 1, at: T0 },
  );
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;
  const completed = completeAgentPlanSpecialistHandoffV1(
    claimed.plan,
    claimed.assignments,
    {
      executionOwnerships: claimed.executionOwnerships,
      agentId,
      leaseId,
      resultArtifactIds: ['artifact:archive'],
      at: T1,
    },
  );
  const store = {
    byId: {
      'job-1': {
        runtime: {
          plan: completed.plan,
          specialistHandoffs: completed.assignments,
          specialistExecutionOwnerships: completed.executionOwnerships,
          history: [],
          updatedAt: Date.parse(T1),
        },
      },
    },
  };
  const manager = managerWithStore(store, T3);
  const record = trustedRecord({ executionId: leaseId });
  await manager.chrome.storage.local.set({
    [TRUSTED_EXECUTION_VERIFICATION_LEDGER_STORAGE_KEY]: {
      schemaVersion: 1,
      revision: 0,
      records: [record],
    },
  });

  await assert.rejects(
    () => manager.verifySpecialistHandoff('job-1', {
      agentId,
      leaseId,
      verificationId: 'verification-specialist-1',
      at: T3,
    }),
    /revision must equal append-only record count/u,
  );

  assert.equal(store.byId['job-1'].runtime.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  assert.equal(store.byId['job-1'].runtime.specialistHandoffs[0].state, 'COMPLETED');
  assert.equal(store.byId['job-1'].runtime.specialistExecutionOwnerships[0].state, 'OWNED');
  assert.equal(store.byId['job-1'].runtime.history.length, 0);
  assert.equal(store.byId['job-1'].runtime.updatedAt, Date.parse(T1));
});

test('BrowserAgentManager cannot use a trusted record under a different verification identity', async () => {
  const { assignment, ownership } = initial();
  const claimed = claimAgentPlanSpecialistHandoffsV1(
    plan(),
    [assignment],
    { executionOwnerships: [ownership], availableSlots: 1, at: T0 },
  );
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;
  const completed = completeAgentPlanSpecialistHandoffV1(
    claimed.plan,
    claimed.assignments,
    {
      executionOwnerships: claimed.executionOwnerships,
      agentId,
      leaseId,
      resultArtifactIds: ['artifact:archive'],
      at: T1,
    },
  );
  const store = {
    byId: {
      'job-1': {
        runtime: {
          plan: completed.plan,
          specialistHandoffs: completed.assignments,
          specialistExecutionOwnerships: completed.executionOwnerships,
          history: [],
          updatedAt: Date.parse(T1),
        },
      },
    },
  };
  const manager = managerWithStore(store, T3);
  await manager.trustedExecutionVerificationLedger.append(trustedRecord({ executionId: leaseId }));

  await assert.rejects(
    () => manager.verifySpecialistHandoff('job-1', {
      agentId,
      leaseId,
      verificationId: 'verification-specialist-other',
      at: T3,
    }),
    /trusted.*verification.*record.*not found/i,
  );

  assert.equal(store.byId['job-1'].runtime.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  assert.equal(store.byId['job-1'].runtime.specialistExecutionOwnerships[0].state, 'OWNED');
  assert.equal(store.byId['job-1'].runtime.history.length, 0);
});

test('BrowserAgentManager rejects caller-shaped verifier authority fields before trusted lookup can authorize completion', async () => {
  const { assignment, ownership } = initial();
  const claimed = claimAgentPlanSpecialistHandoffsV1(
    plan(),
    [assignment],
    { executionOwnerships: [ownership], availableSlots: 1, at: T0 },
  );
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;
  const completed = completeAgentPlanSpecialistHandoffV1(
    claimed.plan,
    claimed.assignments,
    {
      executionOwnerships: claimed.executionOwnerships,
      agentId,
      leaseId,
      resultArtifactIds: ['artifact:archive'],
      at: T1,
    },
  );
  const store = {
    byId: {
      'job-1': {
        runtime: {
          plan: completed.plan,
          specialistHandoffs: completed.assignments,
          specialistExecutionOwnerships: completed.executionOwnerships,
          history: [],
          updatedAt: Date.parse(T1),
        },
      },
    },
  };
  const manager = managerWithStore(store, T3);
  await manager.trustedExecutionVerificationLedger.append(trustedRecord({ executionId: leaseId }));

  await assert.rejects(
    () => manager.verifySpecialistHandoff('job-1', {
      agentId,
      leaseId,
      verificationId: 'verification-specialist-1',
      verifierId: 'caller-forged-verifier',
      verificationAuthorityId: 'caller-forged-authority',
      at: T3,
    }),
    /unknown field|unexpected field|not allowed/i,
  );

  assert.equal(store.byId['job-1'].runtime.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  assert.equal(store.byId['job-1'].runtime.specialistExecutionOwnerships[0].state, 'OWNED');
  assert.equal(store.byId['job-1'].runtime.history.length, 0);
});


test('BrowserAgentManager leaves reconciliation fenced when trusted NO_EFFECT record is absent', async () => {
  const { assignment, ownership } = initial();
  const claimed = claimAgentPlanSpecialistHandoffsV1(
    plan(),
    [assignment],
    {
      executionOwnerships: [ownership],
      availableSlots: 1,
      leaseSeconds: 30,
      at: T0,
    },
  );
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;
  const expired = claimAgentPlanSpecialistHandoffsV1(
    claimed.plan,
    claimed.assignments,
    {
      executionOwnerships: claimed.executionOwnerships,
      availableSlots: 1,
      at: T1,
    },
  );
  const store = {
    byId: {
      'job-1': {
        runtime: {
          plan: expired.plan,
          specialistHandoffs: expired.assignments,
          specialistExecutionOwnerships: expired.executionOwnerships,
          history: [],
          updatedAt: Date.parse(T1),
        },
      },
    },
  };
  const manager = managerWithStore(store, T1D);

  await assert.rejects(
    () => manager.authorizeSpecialistSafeRetry('job-1', {
      agentId,
      leaseId,
      verificationId: 'verification-no-effect-missing',
      at: T1D,
    }),
    /trusted.*verification.*record.*not found/i,
  );

  assert.equal(store.byId['job-1'].runtime.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  assert.equal(store.byId['job-1'].runtime.specialistHandoffs[0].state, 'LEASED');
  assert.equal(store.byId['job-1'].runtime.specialistHandoffs[0].leaseId, leaseId);
  assert.equal(store.byId['job-1'].runtime.specialistExecutionOwnerships[0].state, 'RECONCILE');
  assert.equal(store.byId['job-1'].runtime.specialistExecutionOwnerships[0].leaseId, leaseId);
  assert.equal(store.byId['job-1'].runtime.history.length, 0);
  assert.equal(store.byId['job-1'].runtime.updatedAt, Date.parse(T1));
});
