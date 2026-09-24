import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CrossAppTransactionProjectionStatus,
  createCrossAppInvocationFingerprintV1,
  createCrossAppTransactionFingerprintV1,
  normalizeCrossAppTransactionV1,
  projectCrossAppTransactionV1,
} from '../src/core/cross-app-transaction.js';

const AT = '2026-09-24T23:20:00.000Z';
const SHA_D = 'd'.repeat(64);

function invocation(invocationId, providerId, toolId = `${providerId}.mutate`, overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId,
    toolId,
    providerId,
    requestedCapabilityIds: [`${providerId}.write`],
    policyDecisionId: `policy-${invocationId}`,
    arguments: { target: invocationId, options: { mode: 'verified' } },
    createdAt: AT,
    parentInvocationId: null,
    ...overrides,
  };
}

const INV_RELEASE = invocation('invoke-release', 'github');
const INV_DRIVE = invocation('invoke-drive', 'drive');
const INV_MAIL = invocation('invoke-mail', 'gmail');
const INV_ROLLBACK = invocation('invoke-drive-rollback', 'drive', 'drive.restore');
const SHA_RELEASE = await createCrossAppInvocationFingerprintV1(INV_RELEASE);
const SHA_DRIVE = await createCrossAppInvocationFingerprintV1(INV_DRIVE);
const SHA_MAIL = await createCrossAppInvocationFingerprintV1(INV_MAIL);
const SHA_ROLLBACK = await createCrossAppInvocationFingerprintV1(INV_ROLLBACK);

function step(stepId, providerId, invocationId, invocationSha256, dependsOnStepIds = [], overrides = {}) {
  return { stepId, providerId, invocationId, invocationSha256, dependsOnStepIds, ...overrides };
}

function transaction(overrides = {}) {
  return {
    schemaVersion: 1,
    transactionId: 'txn-1',
    projectId: 'project-1',
    label: 'Publish verified release and notify owner',
    createdAt: AT,
    steps: [
      step('send-mail', 'gmail', INV_MAIL.invocationId, SHA_MAIL, ['update-drive']),
      step('create-release', 'github', INV_RELEASE.invocationId, SHA_RELEASE),
      step('update-drive', 'drive', INV_DRIVE.invocationId, SHA_DRIVE, ['create-release'], {
        compensationInvocationId: INV_ROLLBACK.invocationId,
        compensationInvocationSha256: SHA_ROLLBACK,
      }),
    ],
    ...overrides,
  };
}

function exactEffectState(invocationValue, phase, {
  createdAt = '2026-09-24T23:20:10.000Z',
  updatedAt = createdAt,
  commitId = phase === 'COMMITTED' ? `commit-${invocationValue.invocationId}` : '',
  overrides = {},
} = {}) {
  return {
    schemaVersion: 1,
    effectId: invocationValue.invocationId,
    invocation: invocationValue,
    phase,
    attempt: phase === 'PREPARED' ? 0 : 1,
    executionId: phase === 'PREPARED' ? '' : `${invocationValue.invocationId}:attempt:1`,
    observation: null,
    verification: null,
    ambiguity: { reasonCode: '', summary: '', declaredAt: '' },
    reconciliation: { outcome: '', reasonCode: '', summary: '', resolvedAt: '' },
    commitId,
    createdAt,
    updatedAt,
    processedEventIds: [],
    ...overrides,
  };
}

test('normalizes a bounded cross-app DAG deterministically without creating execution authority', () => {
  const normalized = normalizeCrossAppTransactionV1(transaction());
  assert.deepEqual(normalized.steps.map(item => item.stepId), ['create-release', 'send-mail', 'update-drive']);
  assert.deepEqual(normalized.steps.find(item => item.stepId === 'send-mail').dependsOnStepIds, ['update-drive']);
  assert.equal(normalized.steps.find(item => item.stepId === 'update-drive').compensationInvocationId, 'invoke-drive-rollback');
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.steps));
  assert.ok(Object.isFrozen(normalized.steps[0]));
});

test('transaction and invocation fingerprints are stable across non-semantic object and step ordering', async () => {
  const reorderedInvocation = invocation('invoke-release', 'github', 'github.mutate', {
    arguments: { options: { mode: 'verified' }, target: 'invoke-release' },
  });
  assert.equal(await createCrossAppInvocationFingerprintV1(INV_RELEASE), await createCrossAppInvocationFingerprintV1(reorderedInvocation));

  const first = transaction();
  const second = transaction({
    steps: [
      step('update-drive', 'drive', INV_DRIVE.invocationId, SHA_DRIVE, ['create-release'], {
        compensationInvocationId: INV_ROLLBACK.invocationId,
        compensationInvocationSha256: SHA_ROLLBACK,
      }),
      step('create-release', 'github', INV_RELEASE.invocationId, SHA_RELEASE),
      step('send-mail', 'gmail', INV_MAIL.invocationId, SHA_MAIL, ['update-drive']),
    ],
  });
  assert.equal(await createCrossAppTransactionFingerprintV1(first), await createCrossAppTransactionFingerprintV1(second));
});

test('rejects unknown dependencies, self-dependencies, cycles and duplicate primary or compensation identities', () => {
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [step('a', 'github', 'invoke-a', 'a'.repeat(64), ['missing'])],
  })), /unknown dependency/);
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [step('a', 'github', 'invoke-a', 'a'.repeat(64), ['a'])],
  })), /cannot depend on itself/);
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [
      step('a', 'github', 'invoke-a', 'a'.repeat(64), ['b']),
      step('b', 'drive', 'invoke-b', 'b'.repeat(64), ['a']),
    ],
  })), /contains a cycle/);
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [
      step('a', 'github', 'invoke-shared', 'a'.repeat(64)),
      step('b', 'drive', 'invoke-shared', 'b'.repeat(64)),
    ],
  })), /duplicate invocationId/);
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [
      step('a', 'github', 'invoke-a', 'a'.repeat(64), [], { compensationInvocationId: 'rollback-shared', compensationInvocationSha256: 'c'.repeat(64) }),
      step('b', 'drive', 'invoke-b', 'b'.repeat(64), [], { compensationInvocationId: 'rollback-shared', compensationInvocationSha256: 'd'.repeat(64) }),
    ],
  })), /duplicate invocationId/);
});

test('compensation remains an opaque paired reference and can never alias primary invocation', () => {
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [step('a', 'github', 'invoke-a', 'a'.repeat(64), [], { compensationInvocationId: 'rollback-a' })],
  })), /must be provided together/);
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [step('a', 'github', 'invoke-a', 'a'.repeat(64), [], {
      compensationInvocationId: 'invoke-a', compensationInvocationSha256: 'b'.repeat(64),
    })],
  })), /must differ/);
});

test('strict data-only boundaries reject accessors, hidden fields, symbols, exotic records and sparse arrays without getter execution', async () => {
  let reads = 0;
  const accessorStep = { providerId: 'github', invocationId: 'invoke-a', invocationSha256: 'a'.repeat(64), dependsOnStepIds: [] };
  Object.defineProperty(accessorStep, 'stepId', { enumerable: true, get() { reads += 1; return 'a'; } });
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({ steps: [accessorStep] })), /data property/);
  assert.equal(reads, 0);

  const hidden = step('a', 'github', 'invoke-a', 'a'.repeat(64));
  Object.defineProperty(hidden, 'providerId', { value: 'github', enumerable: false });
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({ steps: [hidden] })), /enumerable data property/);

  const symbol = step('a', 'github', 'invoke-a', 'a'.repeat(64));
  symbol[Symbol('authority')] = 'admin';
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({ steps: [symbol] })), /unknown field/);

  const exotic = Object.create({ stepId: 'a' });
  Object.assign(exotic, { providerId: 'github', invocationId: 'invoke-a', invocationSha256: 'a'.repeat(64), dependsOnStepIds: [] });
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({ steps: [exotic] })), /plain object/);

  const sparse = new Array(2);
  sparse[1] = step('a', 'github', 'invoke-a', 'a'.repeat(64));
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({ steps: sparse })), /must not be sparse/);

  const state = exactEffectState(INV_RELEASE, 'PREPARED');
  Object.defineProperty(state, 'phase', { enumerable: true, get() { reads += 1; return 'PREPARED'; } });
  await assert.rejects(() => projectCrossAppTransactionV1(transaction(), [state]), /data property/);
  assert.equal(reads, 0);
});

test('strict invocation fingerprint rejects coercion, whitespace aliases and non-JSON authority data', async () => {
  await assert.rejects(() => createCrossAppInvocationFingerprintV1({ ...INV_RELEASE, schemaVersion: '1' }), /schemaVersion/);
  await assert.rejects(() => createCrossAppInvocationFingerprintV1({ ...INV_RELEASE, invocationId: 1 }), /invocationId is invalid/);
  await assert.rejects(() => createCrossAppInvocationFingerprintV1({ ...INV_RELEASE, providerId: ' github' }), /providerId is invalid/);
  const bad = invocation('invoke-bad', 'github', 'github.mutate', { arguments: { x: undefined } });
  await assert.rejects(() => createCrossAppInvocationFingerprintV1(bad), /JSON data only/);
});

test('projection is READY only for dependency-satisfied work and never exposes dispatch or compensation execution', async () => {
  const releasePrepared = exactEffectState(INV_RELEASE, 'PREPARED');
  const projected = await projectCrossAppTransactionV1(transaction(), [releasePrepared]);
  assert.equal(projected.status, CrossAppTransactionProjectionStatus.READY);
  assert.equal(projected.advisoryOnly, true);
  assert.deepEqual(projected.committedStepIds, []);
  assert.deepEqual(projected.readyStepIds, ['create-release']);
  assert.deepEqual(projected.activeStepIds, []);
  assert.deepEqual(projected.attentionStepIds, []);
  assert.deepEqual(projected.blockedStepIds, ['send-mail', 'update-drive']);
  assert.equal('dispatch' in projected, false);
  assert.equal('compensationReadyStepIds' in projected, false);
});

test('canonical COMMITTED exact-effect state unlocks only direct causal successor', async () => {
  const release = exactEffectState(INV_RELEASE, 'COMMITTED', {
    createdAt: '2026-09-24T23:20:10.000Z', updatedAt: '2026-09-24T23:21:00.000Z',
  });
  const projected = await projectCrossAppTransactionV1(transaction(), [release]);
  assert.deepEqual(projected.committedStepIds, ['create-release']);
  assert.deepEqual(projected.readyStepIds, ['update-drive']);
  assert.deepEqual(projected.blockedStepIds, ['send-mail']);
});

test('exact-effect bindings fail closed on unknown effect, provider or invocation substitution and stale state', async () => {
  const unknown = exactEffectState(invocation('invoke-other', 'github'), 'PREPARED');
  await assert.rejects(() => projectCrossAppTransactionV1(transaction(), [unknown]), /not part of transaction/);

  const wrongProvider = exactEffectState({ ...INV_RELEASE, providerId: 'drive' }, 'PREPARED');
  await assert.rejects(() => projectCrossAppTransactionV1(transaction(), [wrongProvider]), /provider binding/);

  const substituted = exactEffectState({ ...INV_RELEASE, arguments: { target: 'changed', options: { mode: 'verified' } } }, 'PREPARED');
  await assert.rejects(() => projectCrossAppTransactionV1(transaction(), [substituted]), /invocation binding/);

  const stale = exactEffectState(INV_RELEASE, 'PREPARED', { createdAt: '2026-09-24T23:19:59.000Z' });
  await assert.rejects(() => projectCrossAppTransactionV1(transaction(), [stale]), /predates transaction/);
});

test('dependent effect cannot advance before its dependency is canonically COMMITTED', async () => {
  const release = exactEffectState(INV_RELEASE, 'PREPARED');
  const drive = exactEffectState(INV_DRIVE, 'EXECUTING', { createdAt: '2026-09-24T23:20:20.000Z', updatedAt: '2026-09-24T23:20:30.000Z' });
  await assert.rejects(() => projectCrossAppTransactionV1(transaction(), [release, drive]), /lacks committed dependency/);
});

test('active, reconciliation and manual-review exact-effect phases project truthfully without granting retry authority', async () => {
  const release = exactEffectState(INV_RELEASE, 'COMMITTED', { updatedAt: '2026-09-24T23:21:00.000Z' });
  const driveExecuting = exactEffectState(INV_DRIVE, 'EXECUTING', { createdAt: '2026-09-24T23:21:00.000Z', updatedAt: '2026-09-24T23:21:10.000Z' });
  const active = await projectCrossAppTransactionV1(transaction(), [release, driveExecuting]);
  assert.equal(active.status, CrossAppTransactionProjectionStatus.ACTIVE);
  assert.deepEqual(active.activeStepIds, ['update-drive']);

  const driveReconcile = exactEffectState(INV_DRIVE, 'RECONCILE', { createdAt: '2026-09-24T23:21:00.000Z', updatedAt: '2026-09-24T23:21:10.000Z' });
  const attention = await projectCrossAppTransactionV1(transaction(), [release, driveReconcile]);
  assert.equal(attention.status, CrossAppTransactionProjectionStatus.ATTENTION);
  assert.deepEqual(attention.attentionStepIds, ['update-drive']);
  assert.equal('safeRetry' in attention, false);
});

test('duplicate exact-effect state or commit identity is rejected', async () => {
  const release = exactEffectState(INV_RELEASE, 'COMMITTED', { updatedAt: '2026-09-24T23:21:00.000Z' });
  await assert.rejects(() => projectCrossAppTransactionV1(transaction(), [release, structuredClone(release)]), /duplicate exact-effect state/);

  const drive = exactEffectState(INV_DRIVE, 'COMMITTED', {
    createdAt: '2026-09-24T23:21:00.000Z', updatedAt: '2026-09-24T23:22:00.000Z', commitId: release.commitId,
  });
  await assert.rejects(() => projectCrossAppTransactionV1(transaction(), [release, drive]), /duplicate commitId/);
});

test('complete canonical effect chain projects COMPLETE while compensation remains inert', async () => {
  const states = [
    exactEffectState(INV_RELEASE, 'COMMITTED', { updatedAt: '2026-09-24T23:21:00.000Z' }),
    exactEffectState(INV_DRIVE, 'COMMITTED', { createdAt: '2026-09-24T23:21:00.000Z', updatedAt: '2026-09-24T23:22:00.000Z' }),
    exactEffectState(INV_MAIL, 'COMMITTED', { createdAt: '2026-09-24T23:22:00.000Z', updatedAt: '2026-09-24T23:23:00.000Z' }),
  ];
  const projected = await projectCrossAppTransactionV1(transaction(), states);
  assert.equal(projected.status, CrossAppTransactionProjectionStatus.COMPLETE);
  assert.deepEqual(projected.committedStepIds, ['create-release', 'send-mail', 'update-drive']);
  assert.deepEqual(projected.readyStepIds, []);
  assert.deepEqual(projected.activeStepIds, []);
  assert.deepEqual(projected.attentionStepIds, []);
  assert.deepEqual(projected.blockedStepIds, []);
  assert.equal(projected.advisoryOnly, true);
});
