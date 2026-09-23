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

test('proven no-effect expiry is SAFE to make available again', () => {
  const available = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3, observedNoEffect:true });
  assert.equal(available.state, ExecutionOwnershipState.AVAILABLE);
  const cloud = claimExecutionOwnershipV1(available, { plane:'CLOUD', ownerId:'cloud', leaseId:'cloud-1', leaseUntil:'2026-09-23T13:40:00Z', at:T3 });
  assert.equal(cloud.ownerPlane, 'CLOUD');
});

test('reconciliation requires preserved lease identity and explicit safe-retry evidence', () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3 });
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'other', outcome:'VERIFIED', at:'2026-09-23T13:31:00Z' }), /preserved owner lease/);
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'SAFE_RETRY', at:'2026-09-23T13:31:00Z' }), /evidence/);
  const retry = resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'SAFE_RETRY', evidence:'remote verifier proves no effect', at:'2026-09-23T13:31:00Z' });
  assert.equal(retry.state, ExecutionOwnershipState.AVAILABLE);
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
