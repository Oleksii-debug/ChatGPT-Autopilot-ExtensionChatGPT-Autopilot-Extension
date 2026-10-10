import test from 'node:test';
import assert from 'node:assert/strict';

import {
  prepareAgentPlanSpecialistHandoffV1,
  prepareAgentPlanSpecialistExecutionOwnershipV1,
  claimAgentPlanSpecialistHandoffsV1,
  completeAgentPlanSpecialistHandoffV1,
  authorizeAgentPlanSpecialistSafeRetryV1,
  verifyAgentPlanSpecialistHandoffV1,
  authorizeAgentPlanSpecialistSafeRetryFromTrustedRecordV1,
  verifyAgentPlanSpecialistHandoffFromTrustedRecordV1,
} from '../src/core/agent-specialist-bridge.js';

const T0 = '2026-09-27T03:00:00.000Z';
const T1 = '2026-09-27T03:01:00.000Z';
const T1A = '2026-09-27T03:01:01.000Z';
const T1B = '2026-09-27T03:01:02.000Z';
const T1C = '2026-09-27T03:01:03.000Z';
const T1D = '2026-09-27T03:01:04.000Z';
const T2 = '2026-09-27T03:02:00.000Z';
const T3 = '2026-09-27T03:03:00.000Z';
const T4 = '2026-09-27T03:04:00.000Z';

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
    deadlineAt: '2026-09-27T04:00:00.000Z',
    priority: 4,
    at: T0,
  };
}

function initial() {
  const assignment = prepareAgentPlanSpecialistHandoffV1(plan(), scope());
  const ownership = prepareAgentPlanSpecialistExecutionOwnershipV1(plan(), scope());
  return { assignment, ownership };
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
  artifacts = [proofArtifact()],
  verifiedAt = T2,
  recordedAt = T3,
  validThrough = T4,
  overrides = {},
  verificationOverrides = {},
} = {}) {
  return {
    schemaVersion: 1,
    recordId: 'trusted-specialist-record-1',
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
      ...verificationOverrides,
    },
    evidenceArtifacts: artifacts,
    recordedAt,
    validThrough,
    ...overrides,
  };
}

test('completed specialist becomes AgentPlan VERIFIED only through trusted canonical record', async () => {
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

  let lookup;
  const verified = await verifyAgentPlanSpecialistHandoffFromTrustedRecordV1(
    completed.plan,
    completed.assignments,
    {
      executionOwnerships: completed.executionOwnerships,
      agentId,
      leaseId,
      verificationId: 'verification-specialist-1',
      at: T3,
    },
    {
      resolveTrustedExecutionVerificationRecord: async value => {
        lookup = value;
        return trustedRecord({ executionId: leaseId });
      },
    },
  );

  assert.equal(verified.plan.nodes.find(node => node.nodeId === 'local').state, 'VERIFIED');
  assert.match(verified.plan.nodes.find(node => node.nodeId === 'local').evidence, /trusted-record=/);
  assert.equal(verified.executionOwnerships[0].state, 'VERIFIED');
  assert.equal(verified.assignments[0].state, 'COMPLETED');
  assert.equal(verified.completionAuthorizedByTrustedVerifier, true);
  assert.equal(verified.executionAuthorized, false);
  assert.equal(lookup.executionId, leaseId);
  assert.equal(lookup.expectedOutcome, 'EFFECT_VERIFIED');
});

test('trusted completion must hash-cover every reported specialist result artifact', async () => {
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

  await assert.rejects(
    verifyAgentPlanSpecialistHandoffFromTrustedRecordV1(
      completed.plan,
      completed.assignments,
      {
        executionOwnerships: completed.executionOwnerships,
        agentId,
        leaseId,
        verificationId: 'verification-specialist-1',
        at: T3,
      },
      {
        resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
          executionId: leaseId,
          artifacts: [proofArtifact({ artifactId: 'artifact:other' })],
        }),
      },
    ),
    /does not cover result artifacts/,
  );
  assert.equal(completed.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  assert.equal(completed.executionOwnerships[0].state, 'OWNED');
});

test('expired ambiguous specialist becomes READY only after trusted NO_EFFECT record', async () => {
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

  const retriable = await authorizeAgentPlanSpecialistSafeRetryFromTrustedRecordV1(
    expired.plan,
    expired.assignments,
    {
      executionOwnerships: expired.executionOwnerships,
      agentId,
      leaseId,
      verificationId: 'verification-no-effect-specialist',
      at: T1D,
    },
    {
      resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
        executionId: leaseId,
        outcome: 'NO_EFFECT_VERIFIED',
        verificationId: 'verification-no-effect-specialist',
        artifacts: [proofArtifact({
          artifactId: 'artifact:no-effect',
          createdAt: T1A,
        })],
        verifiedAt: T1B,
        recordedAt: T1C,
        validThrough: T2,
      }),
    },
  );

  assert.equal(retriable.assignments[0].state, 'READY');
  assert.equal(retriable.assignments[0].leaseId, '');
  assert.equal(retriable.executionOwnerships[0].state, 'AVAILABLE');
  assert.equal(retriable.plan.nodes.find(node => node.nodeId === 'local').state, 'READY');
  assert.equal(retriable.executionDispatched, false);
  assert.equal(retriable.trustedVerification.outcome, 'NO_EFFECT_VERIFIED');

  const reclaimed = claimAgentPlanSpecialistHandoffsV1(
    retriable.plan,
    retriable.assignments,
    {
      executionOwnerships: retriable.executionOwnerships,
      availableSlots: 1,
      at: T2,
    },
  );
  assert.deepEqual(reclaimed.claimed, [agentId]);
  assert.notEqual(reclaimed.assignments[0].leaseId, leaseId);
  assert.equal(reclaimed.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
});

test('trusted bridge refuses stale assignment/ownership identity and missing resolver', async () => {
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

  await assert.rejects(
    verifyAgentPlanSpecialistHandoffFromTrustedRecordV1(
      completed.plan,
      completed.assignments,
      {
        executionOwnerships: completed.executionOwnerships,
        agentId,
        leaseId: 'lease:wrong',
        verificationId: 'verification-specialist-1',
        at: T3,
      },
      { resolveTrustedExecutionVerificationRecord: async () => trustedRecord({ executionId: leaseId }) },
    ),
    /exact current execution ownership/,
  );

  await assert.rejects(
    verifyAgentPlanSpecialistHandoffFromTrustedRecordV1(
      completed.plan,
      completed.assignments,
      {
        executionOwnerships: completed.executionOwnerships,
        agentId,
        leaseId,
        verificationId: 'verification-specialist-1',
        at: T3,
      },
      {},
    ),
    /resolver is required/,
  );
});

test('legacy caller-shaped verification paths remain fail-closed', () => {
  assert.throws(
    () => authorizeAgentPlanSpecialistSafeRetryV1(),
    /trusted verifier provenance/,
  );
  assert.throws(
    () => verifyAgentPlanSpecialistHandoffV1(),
    /trusted verifier provenance/,
  );
});
