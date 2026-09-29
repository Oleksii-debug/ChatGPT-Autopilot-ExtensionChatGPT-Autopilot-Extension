import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ExecutionOwnershipState,
  TrustedExecutionVerificationOutcome,
  createExecutionOwnershipV1,
  claimExecutionOwnershipV1,
  recoverExpiredExecutionOwnershipV1,
  verifyExecutionWithTrustedRecordV1,
  authorizeExecutionSafeRetryWithTrustedRecordV1,
} from '../src/core/execution-plane-ownership.js';

const T0 = '2026-09-27T03:00:00.000Z';
const T1 = '2026-09-27T03:01:00.000Z';
const T2 = '2026-09-27T03:02:00.000Z';
const T3 = '2026-09-27T03:03:00.000Z';
const T4 = '2026-09-27T03:04:00.000Z';
const T5 = '2026-09-27T03:05:00.000Z';
const T6 = '2026-09-27T03:06:00.000Z';

function owned() {
  const available = createExecutionOwnershipV1({
    taskId: 'task-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    effectId: 'effect-1',
    policyEnvelopeId: 'policy-1',
    at: T0,
  });
  return claimExecutionOwnershipV1(available, {
    plane: 'LOCAL',
    ownerId: 'specialist-1',
    leaseId: 'lease-1',
    leaseUntil: T2,
    at: T1,
  });
}

function artifact(createdAt = T3, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'artifact:proof',
    kind: 'verification-proof',
    uri: 'file://workspace/proof.json',
    mediaType: 'application/json',
    sha256: 'a'.repeat(64),
    sizeBytes: 42,
    createdAt,
    producerInvocationId: 'invoke:verifier',
    sensitive: false,
    ...overrides,
  };
}

function trustedRecord({
  outcome = TrustedExecutionVerificationOutcome.EFFECT_VERIFIED,
  verificationId = 'verification-1',
  verifiedAt = T4,
  recordedAt = T5,
  validThrough = T6,
  artifacts = [artifact()],
  overrides = {},
  verificationOverrides = {},
} = {}) {
  return {
    schemaVersion: 1,
    recordId: 'trusted-record-1',
    taskId: 'task-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    effectId: 'effect-1',
    policyEnvelopeId: 'policy-1',
    executionId: 'lease-1',
    outcome,
    verification: {
      schemaVersion: 1,
      verificationId,
      invocationId: 'invoke:effect-1',
      observationId: 'observation-1',
      status: 'VERIFIED',
      reasonCode: outcome === TrustedExecutionVerificationOutcome.NO_EFFECT_VERIFIED
        ? 'NO_EFFECT_OBSERVED'
        : 'POSTCONDITION_MATCH',
      summary: 'Independent canonical verification.',
      evidenceArtifactIds: artifacts.map(item => item.artifactId),
      verifiedAt,
      verifierId: 'independent-verifier',
      verificationAuthorityId: 'policy-1',
      effectId: 'effect-1',
      executionId: 'lease-1',
      attempt: 1,
      ...verificationOverrides,
    },
    evidenceArtifacts: artifacts,
    recordedAt,
    validThrough,
    ...overrides,
  };
}

test('trusted resolver verifies exact owned execution and clears execution authority', async () => {
  let lookup;
  const result = await verifyExecutionWithTrustedRecordV1(
    owned(),
    { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
    {
      resolveTrustedExecutionVerificationRecord: async value => {
        lookup = value;
        return trustedRecord();
      },
    },
  );

  assert.equal(result.ownership.state, ExecutionOwnershipState.VERIFIED);
  assert.equal(result.ownership.ownerId, '');
  assert.equal(result.ownership.leaseId, '');
  assert.equal(result.trustedRecord.outcome, TrustedExecutionVerificationOutcome.EFFECT_VERIFIED);
  assert.equal(Object.isFrozen(lookup), true);
  assert.deepEqual(lookup, {
    taskId: 'task-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    effectId: 'effect-1',
    policyEnvelopeId: 'policy-1',
    executionId: 'lease-1',
    verificationId: 'verification-1',
    expectedOutcome: 'EFFECT_VERIFIED',
  });
});

test('trusted no-effect record releases RECONCILE to AVAILABLE without executing retry', async () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(owned(), { at: T3 });
  const result = await authorizeExecutionSafeRetryWithTrustedRecordV1(
    reconcile,
    { leaseId: 'lease-1', verificationId: 'verification-no-effect', at: T5 },
    {
      resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
        outcome: TrustedExecutionVerificationOutcome.NO_EFFECT_VERIFIED,
        verificationId: 'verification-no-effect',
        artifacts: [artifact(T3)],
      }),
    },
  );
  assert.equal(result.ownership.state, ExecutionOwnershipState.AVAILABLE);
  assert.equal(result.ownership.ownerId, '');
  assert.equal(result.ownership.leaseId, '');
  assert.equal(result.ownership.ambiguityReason, '');
  assert.match(result.verificationProvenance, /NO_EFFECT/);
});

test('trusted verification requires canonical resolver and exact durable identity', async () => {
  await assert.rejects(
    verifyExecutionWithTrustedRecordV1(
      owned(),
      { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
      {},
    ),
    /resolver is required/,
  );

  await assert.rejects(
    verifyExecutionWithTrustedRecordV1(
      owned(),
      { leaseId: 'lease-wrong', verificationId: 'verification-1', at: T5 },
      { resolveTrustedExecutionVerificationRecord: async () => trustedRecord() },
    ),
    /lease identity mismatch/,
  );

  await assert.rejects(
    verifyExecutionWithTrustedRecordV1(
      owned(),
      { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
      {
        resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
          overrides: { effectId: 'effect-other' },
        }),
      },
    ),
    /identity does not match/,
  );
});

test('verifier must be independent and bound to exact effect, lease and policy authority', async () => {
  for (const [label, verificationOverrides, pattern] of [
    ['owner', { verifierId: 'specialist-1' }, /independent verifier/],
    ['effect', { effectId: 'effect-other' }, /effect\/execution binding/],
    ['execution', { executionId: 'lease-other' }, /effect\/execution binding/],
    ['authority', { verificationAuthorityId: 'policy-other' }, /authority does not match/],
  ]) {
    await assert.rejects(
      verifyExecutionWithTrustedRecordV1(
        owned(),
        { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
        {
          resolveTrustedExecutionVerificationRecord: async () =>
            trustedRecord({ verificationOverrides }),
        },
      ),
      pattern,
      label,
    );
  }
});

test('trusted verification cannot certify an external effect without immutable evidence', async () => {
  await assert.rejects(
    verifyExecutionWithTrustedRecordV1(
      owned(),
      { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
      {
        resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
          artifacts: [],
          verificationOverrides: { evidenceArtifactIds: [] },
        }),
      },
    ),
    /requires hashed evidence artifacts/,
  );
});

test('trusted evidence is hashed, exact, chronological and non-stale', async () => {
  await assert.rejects(
    verifyExecutionWithTrustedRecordV1(
      owned(),
      { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
      {
        resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
          artifacts: [artifact(T3, { sha256: '' })],
        }),
      },
    ),
    /requires sha256/,
  );

  await assert.rejects(
    verifyExecutionWithTrustedRecordV1(
      owned(),
      { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
      {
        resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
          artifacts: [artifact(T3, { artifactId: 'artifact:other' })],
          verificationOverrides: { evidenceArtifactIds: ['artifact:proof'] },
        }),
      },
    ),
    /exactly match trusted evidence identity/,
  );

  await assert.rejects(
    verifyExecutionWithTrustedRecordV1(
      owned(),
      { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
      {
        resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
          artifacts: [artifact(T0)],
        }),
      },
    ),
    /evidence chronology/,
  );

  await assert.rejects(
    verifyExecutionWithTrustedRecordV1(
      owned(),
      { leaseId: 'lease-1', verificationId: 'verification-1', at: T6 },
      {
        resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
          validThrough: T5,
        }),
      },
    ),
    /record is stale/,
  );
});

test('trusted record is descriptor-safe and never evaluates returned accessors', async () => {
  let reads = 0;
  const record = trustedRecord();
  Object.defineProperty(record, 'effectId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'effect-1';
    },
  });
  await assert.rejects(
    verifyExecutionWithTrustedRecordV1(
      owned(),
      { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
      { resolveTrustedExecutionVerificationRecord: async () => record },
    ),
    /enumerable data property/,
  );
  assert.equal(reads, 0);
});

test('trusted outcome cannot be substituted across completion and safe-retry paths', async () => {
  await assert.rejects(
    verifyExecutionWithTrustedRecordV1(
      owned(),
      { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
      {
        resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
          outcome: TrustedExecutionVerificationOutcome.NO_EFFECT_VERIFIED,
        }),
      },
    ),
    /outcome does not match/,
  );

  const reconcile = recoverExpiredExecutionOwnershipV1(owned(), { at: T3 });
  await assert.rejects(
    authorizeExecutionSafeRetryWithTrustedRecordV1(
      reconcile,
      { leaseId: 'lease-1', verificationId: 'verification-1', at: T5 },
      {
        resolveTrustedExecutionVerificationRecord: async () => trustedRecord({
          outcome: TrustedExecutionVerificationOutcome.EFFECT_VERIFIED,
          artifacts: [artifact(T3)],
        }),
      },
    ),
    /outcome does not match/,
  );
});
