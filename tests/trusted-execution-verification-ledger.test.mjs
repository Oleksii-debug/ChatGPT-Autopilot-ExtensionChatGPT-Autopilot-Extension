import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TrustedExecutionVerificationOutcome,
  claimExecutionOwnershipV1,
  createExecutionOwnershipV1,
  verifyExecutionWithTrustedRecordV1,
  authorizeExecutionSafeRetryWithTrustedRecordV1,
  requireExecutionReconciliationV1,
} from '../src/core/execution-plane-ownership.js';
import {
  TrustedExecutionVerificationLedgerRepository,
  appendTrustedExecutionVerificationRecordV1,
  createTrustedExecutionVerificationLedgerV1,
  normalizeTrustedExecutionVerificationLedgerV1,
  resolveTrustedExecutionVerificationRecordV1,
} from '../src/core/trusted-execution-verification-ledger.js';

const T0 = '2026-09-29T00:00:00.000Z';
const T1 = '2026-09-29T00:01:00.000Z';
const T2 = '2026-09-29T00:02:00.000Z';
const T3 = '2026-09-29T00:03:00.000Z';
const T4 = '2026-09-29T00:04:00.000Z';
const T5 = '2026-09-29T00:05:00.000Z';
const T6 = '2026-09-29T00:06:00.000Z';

function ownedExecution() {
  const available = createExecutionOwnershipV1({
    taskId: 'task.specialist.1',
    planId: 'plan.specialist.1',
    nodeId: 'node.specialist.1',
    effectId: 'effect.specialist.1',
    policyEnvelopeId: 'policy.specialist.1',
    at: T0,
  });
  return claimExecutionOwnershipV1(available, {
    plane: 'LOCAL',
    ownerId: 'agent.specialist.1',
    leaseId: 'lease.specialist.1',
    leaseUntil: T6,
    at: T1,
  });
}

function evidenceArtifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'artifact.specialist.proof.1',
    kind: 'specialist-result',
    uri: 'file://workspace/proof.bin',
    mediaType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
    sizeBytes: 64,
    createdAt: T2,
    producerInvocationId: 'invoke.specialist.verifier.1',
    sensitive: false,
    ...overrides,
  };
}

function trustedRecord({
  outcome = TrustedExecutionVerificationOutcome.EFFECT_VERIFIED,
  verificationId = 'verification.specialist.1',
  recordId = 'record.specialist.1',
  executionId = 'lease.specialist.1',
  artifacts = [evidenceArtifact()],
  verificationOverrides = {},
  overrides = {},
} = {}) {
  return {
    schemaVersion: 1,
    recordId,
    taskId: 'task.specialist.1',
    planId: 'plan.specialist.1',
    nodeId: 'node.specialist.1',
    effectId: 'effect.specialist.1',
    policyEnvelopeId: 'policy.specialist.1',
    executionId,
    outcome,
    verification: {
      schemaVersion: 1,
      verificationId,
      invocationId: 'invoke.specialist.verifier.1',
      observationId: 'observation.specialist.verifier.1',
      status: 'VERIFIED',
      reasonCode: outcome === TrustedExecutionVerificationOutcome.NO_EFFECT_VERIFIED
        ? 'NO_EFFECT_OBSERVED'
        : 'RESULT_POSTCONDITION_MATCH',
      summary: 'Independent verifier resolved the exact execution effect.',
      evidenceArtifactIds: artifacts.map(item => item.artifactId),
      verifiedAt: T3,
      verifierId: 'agent.specialist.verifier.1',
      verificationAuthorityId: 'policy.specialist.1',
      effectId: 'effect.specialist.1',
      executionId,
      attempt: 1,
      ...verificationOverrides,
    },
    evidenceArtifacts: artifacts,
    recordedAt: T4,
    validThrough: T6,
    ...overrides,
  };
}

function lookup({
  expectedOutcome = TrustedExecutionVerificationOutcome.EFFECT_VERIFIED,
  verificationId = 'verification.specialist.1',
  overrides = {},
} = {}) {
  return {
    taskId: 'task.specialist.1',
    planId: 'plan.specialist.1',
    nodeId: 'node.specialist.1',
    effectId: 'effect.specialist.1',
    policyEnvelopeId: 'policy.specialist.1',
    executionId: 'lease.specialist.1',
    verificationId,
    expectedOutcome,
    ...overrides,
  };
}

function storageChrome() {
  const data = Object.create(null);
  return {
    storage: {
      local: {
        async get(key) {
          return Object.hasOwn(data, key)
            ? { [key]: structuredClone(data[key]) }
            : {};
        },
        async set(values) {
          Object.assign(data, structuredClone(values));
        },
      },
    },
  };
}

test('append-only ledger resolves one exact trusted execution verification record', () => {
  const empty = createTrustedExecutionVerificationLedgerV1();
  const appended = appendTrustedExecutionVerificationRecordV1(empty, trustedRecord());

  assert.equal(appended.revision, 1);
  assert.equal(appended.records.length, 1);
  assert.ok(Object.isFrozen(appended));
  assert.ok(Object.isFrozen(appended.records[0]));

  const resolved = resolveTrustedExecutionVerificationRecordV1(appended, lookup());
  assert.equal(resolved.recordId, 'record.specialist.1');
  assert.equal(resolved.verification.verificationId, 'verification.specialist.1');
  assert.equal(resolved.executionId, 'lease.specialist.1');

  assert.equal(
    resolveTrustedExecutionVerificationRecordV1(
      appended,
      lookup({ overrides: { executionId: 'lease.specialist.other' } }),
    ),
    null,
  );
  assert.equal(
    resolveTrustedExecutionVerificationRecordV1(
      appended,
      lookup({ expectedOutcome: TrustedExecutionVerificationOutcome.NO_EFFECT_VERIFIED }),
    ),
    null,
  );
});

test('exact duplicate append is idempotent but recordId and verificationId cannot be rebound', () => {
  const once = appendTrustedExecutionVerificationRecordV1(
    createTrustedExecutionVerificationLedgerV1(),
    trustedRecord(),
  );
  const duplicate = appendTrustedExecutionVerificationRecordV1(once, trustedRecord());
  assert.equal(duplicate, once);

  assert.throws(
    () => appendTrustedExecutionVerificationRecordV1(
      once,
      trustedRecord({
        overrides: { validThrough: T5 },
      }),
    ),
    /recordId is append-only and cannot be rewritten/u,
  );

  assert.throws(
    () => appendTrustedExecutionVerificationRecordV1(
      once,
      trustedRecord({
        recordId: 'record.specialist.2',
        overrides: { validThrough: T5 },
      }),
    ),
    /verificationId is append-only and cannot be rebound/u,
  );
});

test('ledger normalization rejects duplicate canonical identities and hostile accessor state', () => {
  const record = trustedRecord();
  assert.throws(
    () => normalizeTrustedExecutionVerificationLedgerV1({
      schemaVersion: 1,
      revision: 2,
      records: [record, structuredClone(record)],
    }),
    /Duplicate trusted execution verification recordId/u,
  );

  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'revision', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 0;
    },
  });
  Object.defineProperty(hostile, 'schemaVersion', {
    enumerable: true,
    value: 1,
  });
  Object.defineProperty(hostile, 'records', {
    enumerable: true,
    value: [],
  });
  assert.throws(
    () => normalizeTrustedExecutionVerificationLedgerV1(hostile),
    /enumerable own data property/u,
  );
  assert.equal(getterCalls, 0);
});

test('lookup admission rejects extra fields and accessors without executing getters', () => {
  const ledger = appendTrustedExecutionVerificationRecordV1(
    createTrustedExecutionVerificationLedgerV1(),
    trustedRecord(),
  );

  assert.throws(
    () => resolveTrustedExecutionVerificationRecordV1(
      ledger,
      { ...lookup(), callerSaysVerified: true },
    ),
    /unknown field/u,
  );

  let getterCalls = 0;
  const hostile = lookup();
  Object.defineProperty(hostile, 'verificationId', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'verification.specialist.1';
    },
  });
  assert.throws(
    () => resolveTrustedExecutionVerificationRecordV1(ledger, hostile),
    /enumerable own data property/u,
  );
  assert.equal(getterCalls, 0);
});

test('durable repository serializes concurrent appends and supplies the canonical resolver', async () => {
  const repository = new TrustedExecutionVerificationLedgerRepository(storageChrome());
  const effect = trustedRecord();
  const noEffect = trustedRecord({
    outcome: TrustedExecutionVerificationOutcome.NO_EFFECT_VERIFIED,
    recordId: 'record.specialist.2',
    verificationId: 'verification.specialist.2',
  });

  await Promise.all([
    repository.append(effect),
    repository.append(noEffect),
  ]);

  const stored = await repository.load();
  assert.equal(stored.revision, 2);
  assert.deepEqual(
    stored.records.map(item => item.recordId),
    ['record.specialist.1', 'record.specialist.2'],
  );

  const resolved = await repository.resolver()(lookup());
  assert.equal(resolved.recordId, 'record.specialist.1');
  const noEffectResolved = await repository.resolve(lookup({
    expectedOutcome: TrustedExecutionVerificationOutcome.NO_EFFECT_VERIFIED,
    verificationId: 'verification.specialist.2',
  }));
  assert.equal(noEffectResolved.recordId, 'record.specialist.2');
});

test('existing execution ownership completion consumes only the ledger resolver', async () => {
  const repository = new TrustedExecutionVerificationLedgerRepository(storageChrome());
  await repository.append(trustedRecord());

  const current = ownedExecution();
  const result = await verifyExecutionWithTrustedRecordV1(
    current,
    {
      leaseId: 'lease.specialist.1',
      verificationId: 'verification.specialist.1',
      at: T5,
    },
    {
      resolveTrustedExecutionVerificationRecord: repository.resolver(),
    },
  );

  assert.equal(result.ownership.state, 'VERIFIED');
  assert.equal(result.ownership.leaseId, '');
  assert.equal(result.trustedRecord.recordId, 'record.specialist.1');
  assert.equal(
    result.verificationProvenance,
    'TRUSTED_CANONICAL_EXECUTION_VERIFICATION_RECORD_WITH_HASHED_ARTIFACT_REFS',
  );
});

test('existing SAFE_RETRY path consumes exact NO_EFFECT record without dispatching a retry', async () => {
  const repository = new TrustedExecutionVerificationLedgerRepository(storageChrome());
  await repository.append(trustedRecord({
    outcome: TrustedExecutionVerificationOutcome.NO_EFFECT_VERIFIED,
    recordId: 'record.specialist.no-effect.1',
    verificationId: 'verification.specialist.no-effect.1',
  }));

  const reconcile = requireExecutionReconciliationV1(ownedExecution(), {
    leaseId: 'lease.specialist.1',
    reason: 'provider effect is ambiguous',
    at: T2,
  });
  const result = await authorizeExecutionSafeRetryWithTrustedRecordV1(
    reconcile,
    {
      leaseId: 'lease.specialist.1',
      verificationId: 'verification.specialist.no-effect.1',
      at: T5,
    },
    {
      resolveTrustedExecutionVerificationRecord: repository.resolver(),
    },
  );

  assert.equal(result.ownership.state, 'AVAILABLE');
  assert.equal(result.ownership.leaseId, '');
  assert.equal(result.trustedRecord.outcome, 'NO_EFFECT_VERIFIED');
  assert.equal(
    result.verificationProvenance,
    'TRUSTED_CANONICAL_NO_EFFECT_RECORD_WITH_HASHED_ARTIFACT_REFS',
  );
});
