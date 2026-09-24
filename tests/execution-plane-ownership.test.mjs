import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionOwnershipState,
  createExecutionOwnershipV1,
  claimExecutionOwnershipV1,
  requestExecutionHandoffV1,
  acceptExecutionHandoffV1,
  recoverExpiredExecutionOwnershipV1,
  resolveExecutionReconciliationV1,
  verifyOwnedExecutionV1,
  normalizeExecutionOwnershipV1,
} from '../src/core/execution-plane-ownership.js';

const T0 = '2026-09-23T13:00:00.000Z';
const T1 = '2026-09-23T13:10:00.000Z';
const T2 = '2026-09-23T13:20:00.000Z';
const T3 = '2026-09-23T13:30:00.000Z';
const base = () => createExecutionOwnershipV1({ taskId:'task-1', planId:'plan-1', nodeId:'node-1', effectId:'effect-1', policyEnvelopeId:'policy-1', at:T0 });

function localOwned() { return claimExecutionOwnershipV1(base(), { plane:'LOCAL', ownerId:'local-worker', leaseId:'lease-local', leaseUntil:T2, at:T1 }); }

function reconciliationVerification(overrides = {}) {
  return {
    schemaVersion: 1,
    verificationId: 'verification-no-effect-1',
    invocationId: 'invoke-effect-1',
    observationId: 'observation-no-effect-1',
    status: 'VERIFIED',
    reasonCode: 'NO_EFFECT_OBSERVED',
    summary: 'Fresh independent observation proves the attempted effect did not commit.',
    evidenceArtifactIds: ['artifact:no-effect-1'],
    verifiedAt: '2026-09-23T13:31:00.000Z',
    verifierId: 'independent-verifier',
    verificationAuthorityId: 'policy-1',
    effectId: 'effect-1',
    executionId: 'lease-local',
    attempt: 1,
    ...overrides,
  };
}

test('claim preserves durable causal identity and rejects a second execution owner', () => {
  const owned = localOwned();
  assert.equal(owned.state, ExecutionOwnershipState.OWNED);
  assert.equal(owned.effectId, 'effect-1');
  assert.equal(owned.policyEnvelopeId, 'policy-1');
  assert.equal(owned.ownerPlane, 'LOCAL');
  assert.throws(() => claimExecutionOwnershipV1(owned, { plane:'REMOTE', ownerId:'r', leaseId:'r1', leaseUntil:T3, at:T2 }), /not available/);
});

test('handoff transfers exactly one ownership lease without changing task/plan/effect identity', () => {
  const pending = requestExecutionHandoffV1(localOwned(), { leaseId:'lease-local', toPlane:'REMOTE', handoffId:'handoff-1', at:'2026-09-23T13:11:00Z' });
  assert.equal(pending.state, ExecutionOwnershipState.HANDOFF_PENDING);
  assert.equal(pending.ownerPlane, 'LOCAL');
  assert.throws(() => acceptExecutionHandoffV1(pending, { handoffId:'wrong', ownerId:'remote-worker', leaseId:'lease-remote', leaseUntil:T3, at:T2 }), /mismatch/);
  const remote = acceptExecutionHandoffV1(pending, { handoffId:'handoff-1', ownerId:'remote-worker', leaseId:'lease-remote', leaseUntil:T3, at:T2 });
  assert.equal(remote.ownerPlane, 'REMOTE');
  assert.equal(remote.effectId, 'effect-1');
  assert.equal(remote.taskId, 'task-1');
  assert.equal(remote.handoffId, '');
});

test('expired ambiguous ownership enters RECONCILE and cannot be blindly reclaimed', () => {
  const owned = localOwned();
  const reconcile = recoverExpiredExecutionOwnershipV1(owned, { at:T3 });
  assert.equal(reconcile.state, ExecutionOwnershipState.RECONCILE);
  assert.equal(reconcile.leaseId, 'lease-local');
  assert.throws(() => claimExecutionOwnershipV1(reconcile, { plane:'CLOUD', ownerId:'cloud', leaseId:'cloud-1', leaseUntil:'2026-09-23T13:40:00Z', at:T3 }), /not available/);
});

test('expiry always enters RECONCILE even when a caller asserts observedNoEffect', () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3, observedNoEffect:true });
  assert.equal(reconcile.state, ExecutionOwnershipState.RECONCILE);
  assert.equal(reconcile.leaseId, 'lease-local');
  assert.throws(() => claimExecutionOwnershipV1(reconcile, { plane:'CLOUD', ownerId:'cloud', leaseId:'cloud-1', leaseUntil:'2026-09-23T13:40:00Z', at:T3 }), /not available/);
});

test('SAFE_RETRY requires fresh canonical no-effect verification bound to effect, lease and policy', () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3 });
  const at = '2026-09-23T13:31:00Z';
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'other', outcome:'SAFE_RETRY', verification:reconciliationVerification(), at }), /preserved owner lease/);
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'SAFE_RETRY', evidence:'remote verifier proves no effect', at }), /VerificationV1/);
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'SAFE_RETRY', verification:reconciliationVerification({ effectId:'effect-other' }), at }), /effectId/);
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'SAFE_RETRY', verification:reconciliationVerification({ executionId:'lease-other' }), at }), /preserved lease/);
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'SAFE_RETRY', verification:reconciliationVerification({ verificationAuthorityId:'policy-other' }), at }), /policy envelope/);
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'SAFE_RETRY', verification:reconciliationVerification({ verifierId:'local-worker' }), at }), /independent/);
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'SAFE_RETRY', verification:reconciliationVerification({ verifiedAt:'2026-09-23T13:29:59.000Z' }), at }), /fresh/);
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'SAFE_RETRY', verification:reconciliationVerification({ reasonCode:'POSTCONDITION_MATCH' }), at }), /NO_EFFECT_OBSERVED/);
  const retry = resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'SAFE_RETRY', verification:reconciliationVerification(), at });
  assert.equal(retry.state, ExecutionOwnershipState.AVAILABLE);
  const cloud = claimExecutionOwnershipV1(retry, { plane:'CLOUD', ownerId:'cloud', leaseId:'cloud-1', leaseUntil:'2026-09-23T13:40:00Z', at });
  assert.equal(cloud.ownerPlane, 'CLOUD');
});

test('ambiguous VERIFIED resolution also requires matching fresh canonical verification', () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3 });
  const at = '2026-09-23T13:31:00Z';
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'VERIFIED', at }), /VerificationV1/);
  const verified = resolveExecutionReconciliationV1(reconcile, {
    leaseId:'lease-local',
    outcome:'VERIFIED',
    verification:reconciliationVerification({ reasonCode:'POSTCONDITION_MATCH', verificationId:'verification-effect-1' }),
    at,
  });
  assert.equal(verified.state, ExecutionOwnershipState.VERIFIED);
  assert.equal(verified.ownerId, '');
});

test('manual review is terminal to automation and carries ambiguity reason', () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3, reason:'write may have committed remotely' });
  const manual = resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'MANUAL_REVIEW', at:'2026-09-23T13:31:00Z' });
  assert.equal(manual.state, ExecutionOwnershipState.MANUAL_REVIEW);
  assert.match(manual.ambiguityReason, /may have committed/);
  assert.throws(() => claimExecutionOwnershipV1(manual, { plane:'REMOTE', ownerId:'r', leaseId:'r1', leaseUntil:'2026-09-23T13:40:00Z', at:T3 }), /not available/);
});

test('only current lease can verify completion', () => {
  const owned = localOwned();
  assert.throws(() => verifyOwnedExecutionV1(owned, { leaseId:'wrong', at:T2 }), /current execution owner/);
  const verified = verifyOwnedExecutionV1(owned, { leaseId:'lease-local', at:T2 });
  assert.equal(verified.state, ExecutionOwnershipState.VERIFIED);
  assert.equal(verified.ownerPlane, '');
});

test('normalization fails closed on unknown fields and inconsistent durable ownership', () => {
  const raw = structuredClone(base());
  raw.surprise = true;
  assert.throws(() => normalizeExecutionOwnershipV1(raw), /unknown field/);
  const inconsistent = structuredClone(base());
  inconsistent.state = 'OWNED';
  inconsistent.ownerPlane = 'LOCAL';
  assert.throws(() => normalizeExecutionOwnershipV1(inconsistent), /complete owner lease/);
});

test('lease duration is bounded and target plane must differ on handoff', () => {
  assert.throws(() => claimExecutionOwnershipV1(base(), { plane:'LOCAL', ownerId:'x', leaseId:'l', leaseUntil:'2026-09-25T13:10:00Z', at:T1 }), /duration/);
  assert.throws(() => requestExecutionHandoffV1(localOwned(), { leaseId:'lease-local', toPlane:'LOCAL', handoffId:'h', at:T1 }), /distinct target/);
});

test('expired lease fences handoff and completion until reconciliation resolves the ownership', () => {
  const owned = localOwned();
  assert.throws(() => requestExecutionHandoffV1(owned, { leaseId:'lease-local', toPlane:'REMOTE', handoffId:'handoff-expired', at:T3 }), /expired.*reconciliation/);
  assert.throws(() => verifyOwnedExecutionV1(owned, { leaseId:'lease-local', at:T3 }), /expired.*reconciliation/);

  const pending = requestExecutionHandoffV1(owned, { leaseId:'lease-local', toPlane:'REMOTE', handoffId:'handoff-before-expiry', at:'2026-09-23T13:11:00Z' });
  assert.throws(() => acceptExecutionHandoffV1(pending, { handoffId:'handoff-before-expiry', ownerId:'remote', leaseId:'lease-remote', leaseUntil:'2026-09-23T13:40:00Z', at:T3 }), /expired.*reconciliation/);
});
