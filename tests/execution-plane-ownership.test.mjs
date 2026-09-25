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
  verifyExecutionByAuthorityV1,
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

test('execution ownership timestamps require exact canonical ISO-8601 UTC spelling', () => {
  assert.throws(
    () => createExecutionOwnershipV1({
      taskId:'task-alias',
      planId:'plan-alias',
      nodeId:'node-alias',
      effectId:'effect-alias',
      policyEnvelopeId:'policy-alias',
      at:'2026-09-23T13:00:00Z',
    }),
    /canonical ISO-8601 UTC representation/,
  );

  const owned = localOwned();
  assert.throws(
    () => requestExecutionHandoffV1(owned, {
      leaseId:'lease-local',
      toPlane:'REMOTE',
      handoffId:'handoff-alias',
      at:'2026-09-23T15:11:00.000+02:00',
    }),
    /canonical ISO-8601 UTC representation/,
  );
});

test('claim preserves durable causal identity and rejects a second execution owner', () => {
  const owned = localOwned();
  assert.equal(owned.state, ExecutionOwnershipState.OWNED);
  assert.equal(owned.effectId, 'effect-1');
  assert.equal(owned.policyEnvelopeId, 'policy-1');
  assert.equal(owned.ownerPlane, 'LOCAL');
  assert.throws(() => claimExecutionOwnershipV1(owned, { plane:'REMOTE', ownerId:'r', leaseId:'r1', leaseUntil:T3, at:T2 }), /not available/);
});

test('handoff transfers exactly one ownership lease without changing task/plan/effect identity', () => {
  const pending = requestExecutionHandoffV1(localOwned(), { leaseId:'lease-local', toPlane:'REMOTE', handoffId:'handoff-1', at:'2026-09-23T13:11:00.000Z' });
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
  assert.throws(() => claimExecutionOwnershipV1(reconcile, { plane:'CLOUD', ownerId:'cloud', leaseId:'cloud-1', leaseUntil:'2026-09-23T13:40:00.000Z', at:T3 }), /not available/);
});

test('expiry always enters RECONCILE even when a caller asserts observedNoEffect', () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3, observedNoEffect:true });
  assert.equal(reconcile.state, ExecutionOwnershipState.RECONCILE);
  assert.equal(reconcile.leaseId, 'lease-local');
  assert.throws(() => claimExecutionOwnershipV1(reconcile, { plane:'CLOUD', ownerId:'cloud', leaseId:'cloud-1', leaseUntil:'2026-09-23T13:40:00.000Z', at:T3 }), /not available/);
});

test('caller-shaped verification cannot release or complete reconciliation without trusted provenance', () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3 });
  const at = '2026-09-23T13:31:00.000Z';

  assert.throws(() => resolveExecutionReconciliationV1(reconcile, {
    leaseId:'other',
    outcome:'SAFE_RETRY',
    verification:reconciliationVerification(),
    at,
  }), /preserved owner lease/);

  assert.throws(() => resolveExecutionReconciliationV1(reconcile, {
    leaseId:'lease-local',
    outcome:'SAFE_RETRY',
    verification:reconciliationVerification(),
    at,
  }), /trusted verifier provenance/);

  assert.throws(() => resolveExecutionReconciliationV1(reconcile, {
    leaseId:'lease-local',
    outcome:'VERIFIED',
    verification:reconciliationVerification({
      reasonCode:'POSTCONDITION_MATCH',
      verificationId:'verification-effect-1',
    }),
    at,
  }), /trusted verifier provenance/);

  assert.equal(reconcile.state, ExecutionOwnershipState.RECONCILE);
  assert.equal(reconcile.leaseId, 'lease-local');
  assert.throws(() => claimExecutionOwnershipV1(reconcile, {
    plane:'CLOUD',
    ownerId:'cloud',
    leaseId:'cloud-1',
    leaseUntil:'2026-09-23T13:40:00.000Z',
    at,
  }), /not available/);
});

test('reconciliation request rejects coercive outcomes without executing them', () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3 });
  let coerced = 0;
  const outcome = { toString() { coerced += 1; return 'SAFE_RETRY'; } };
  assert.throws(() => resolveExecutionReconciliationV1(reconcile, {
    leaseId:'lease-local',
    outcome,
    verification:reconciliationVerification(),
    at:'2026-09-23T13:31:00.000Z',
  }), /reconciliation outcome must use exact canonical text/);
  assert.equal(coerced, 0);
});

test('execution ownership normalization is strict data-only without hidden or accessor authority', () => {
  let reads = 0;
  const accessor = structuredClone(base());
  Object.defineProperty(accessor, 'state', {
    enumerable:true,
    get() { reads += 1; return 'AVAILABLE'; },
  });
  assert.throws(() => normalizeExecutionOwnershipV1(accessor), /enumerable data property/);
  assert.equal(reads, 0);

  const hidden = structuredClone(base());
  Object.defineProperty(hidden, 'state', { value:'AVAILABLE', enumerable:false });
  assert.throws(() => normalizeExecutionOwnershipV1(hidden), /enumerable data property/);

  const symbol = structuredClone(base());
  symbol[Symbol('authority')] = 'OWNED';
  assert.throws(() => normalizeExecutionOwnershipV1(symbol), /symbol fields/);

  const exotic = Object.create({ inheritedAuthority:'ALLOW' });
  Object.assign(exotic, structuredClone(base()));
  assert.throws(() => normalizeExecutionOwnershipV1(exotic), /plain object/);

  assert.throws(() => normalizeExecutionOwnershipV1({ ...structuredClone(base()), schemaVersion:'1' }), /schemaVersion/);
  assert.throws(() => normalizeExecutionOwnershipV1({ ...structuredClone(base()), revision:'1' }), /revision/);
  assert.throws(() => normalizeExecutionOwnershipV1({ ...structuredClone(base()), effectId:7 }), /effectId/);

  const nullPrototype = Object.assign(Object.create(null), structuredClone(base()));
  assert.equal(normalizeExecutionOwnershipV1(nullPrototype).state, ExecutionOwnershipState.AVAILABLE);
});

test('manual review is terminal to automation and carries ambiguity reason', () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3, reason:'write may have committed remotely' });
  const manual = resolveExecutionReconciliationV1(reconcile, { leaseId:'lease-local', outcome:'MANUAL_REVIEW', at:'2026-09-23T13:31:00.000Z' });
  assert.equal(manual.state, ExecutionOwnershipState.MANUAL_REVIEW);
  assert.match(manual.ambiguityReason, /may have committed/);
  assert.throws(() => claimExecutionOwnershipV1(manual, { plane:'REMOTE', ownerId:'r', leaseId:'r1', leaseUntil:'2026-09-23T13:40:00.000Z', at:T3 }), /not available/);
});

test('current effect owner cannot self-mint canonical VERIFIED', () => {
  const owned = localOwned();
  assert.throws(
    () => verifyOwnedExecutionV1(owned, { leaseId:'wrong', at:T2 }),
    /current execution owner/,
  );
  assert.throws(
    () => verifyOwnedExecutionV1(owned, { leaseId:'lease-local', at:T2 }),
    /trusted verifier provenance/,
  );
  assert.equal(owned.state, ExecutionOwnershipState.OWNED);
  assert.equal(owned.ownerId, 'local-worker');
  assert.equal(owned.leaseId, 'lease-local');
});

test('caller-shaped verifier authority cannot mint canonical VERIFIED', () => {
  const owned = localOwned();
  assert.throws(
    () => verifyExecutionByAuthorityV1(owned, {
      leaseId:'lease-local',
      verifierId:'independent-verifier',
      verificationAuthorityId:'policy-1',
      evidence:'Caller claims an independent observation verified the effect.',
      at:T2,
    }),
    /trusted verifier provenance/,
  );
  assert.equal(owned.state, ExecutionOwnershipState.OWNED);
  assert.equal(owned.ownerId, 'local-worker');
  assert.equal(owned.leaseId, 'lease-local');

  let reads = 0;
  const request = new Proxy({
    leaseId:'lease-local',
    verifierId:'independent-verifier',
    verificationAuthorityId:'policy-1',
    evidence:'Caller-shaped evidence.',
    at:T2,
  }, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => verifyExecutionByAuthorityV1(owned, request),
    /trusted verifier provenance/,
  );
  assert.equal(reads, 0, 'verification request must use descriptor snapshots, not caller get traps');
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
  assert.throws(() => claimExecutionOwnershipV1(base(), { plane:'LOCAL', ownerId:'x', leaseId:'l', leaseUntil:'2026-09-25T13:10:00.000Z', at:T1 }), /duration/);
  assert.throws(() => requestExecutionHandoffV1(localOwned(), { leaseId:'lease-local', toPlane:'LOCAL', handoffId:'h', at:T1 }), /distinct target/);
});

test('expired lease fences handoff and completion until reconciliation resolves the ownership', () => {
  const owned = localOwned();
  assert.throws(() => requestExecutionHandoffV1(owned, { leaseId:'lease-local', toPlane:'REMOTE', handoffId:'handoff-expired', at:T3 }), /expired.*reconciliation/);
  assert.throws(() => verifyOwnedExecutionV1(owned, { leaseId:'lease-local', at:T3 }), /expired.*reconciliation/);

  const pending = requestExecutionHandoffV1(owned, { leaseId:'lease-local', toPlane:'REMOTE', handoffId:'handoff-before-expiry', at:'2026-09-23T13:11:00.000Z' });
  assert.throws(() => acceptExecutionHandoffV1(pending, { handoffId:'handoff-before-expiry', ownerId:'remote', leaseId:'lease-remote', leaseUntil:'2026-09-23T13:40:00.000Z', at:T3 }), /expired.*reconciliation/);
});


test('durable ownership enums reject case and whitespace aliases instead of canonicalizing them', () => {
  const available = structuredClone(base());

  for (const state of ['available', ' AVAILABLE ', 'Available']) {
    assert.throws(
      () => normalizeExecutionOwnershipV1({ ...available, state }),
      /state is invalid/,
      state,
    );
  }

  assert.throws(
    () => claimExecutionOwnershipV1(base(), {
      plane:'local',
      ownerId:'local-worker',
      leaseId:'lease-local-alias',
      leaseUntil:T2,
      at:T1,
    }),
    /execution plane is invalid/,
  );
  assert.throws(
    () => claimExecutionOwnershipV1(base(), {
      plane:' LOCAL ',
      ownerId:'local-worker',
      leaseId:'lease-local-alias',
      leaseUntil:T2,
      at:T1,
    }),
    /execution plane is invalid/,
  );

  const owned = localOwned();
  assert.throws(
    () => requestExecutionHandoffV1(owned, {
      leaseId:'lease-local',
      toPlane:'remote',
      handoffId:'handoff-alias',
      at:'2026-09-23T13:11:00.000Z',
    }),
    /execution plane is invalid/,
  );
  assert.throws(
    () => normalizeExecutionOwnershipV1({ ...owned, ownerPlane:' local ' }),
    /execution plane is invalid/,
  );
});

test('reconciliation outcome requires exact canonical spelling', () => {
  const reconcile = recoverExpiredExecutionOwnershipV1(localOwned(), { at:T3 });

  for (const outcome of ['manual_review', ' MANUAL_REVIEW ', 'Manual_Review']) {
    assert.throws(
      () => resolveExecutionReconciliationV1(reconcile, {
        leaseId:'lease-local',
        outcome,
        at:'2026-09-23T13:31:00.000Z',
      }),
      /exact canonical text|must be VERIFIED, SAFE_RETRY, or MANUAL_REVIEW/,
      outcome,
    );
  }

  const manual = resolveExecutionReconciliationV1(reconcile, {
    leaseId:'lease-local',
    outcome:'MANUAL_REVIEW',
    at:'2026-09-23T13:31:00.000Z',
  });
  assert.equal(manual.state, ExecutionOwnershipState.MANUAL_REVIEW);
});

test('ownership revision is a safe exact integer and transition overflow fails closed', () => {
  const available = structuredClone(base());

  for (const revision of ['1', 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.throws(
      () => normalizeExecutionOwnershipV1({ ...available, revision }),
      /revision is invalid/,
      String(revision),
    );
  }

  const maximum = normalizeExecutionOwnershipV1({
    ...available,
    revision:Number.MAX_SAFE_INTEGER,
  });
  assert.equal(maximum.revision, Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => claimExecutionOwnershipV1(maximum, {
      plane:'LOCAL',
      ownerId:'local-worker',
      leaseId:'lease-overflow',
      leaseUntil:T2,
      at:T1,
    }),
    /revision exceeds exact durable-state range/,
  );
});


test('optional durable ownership fields reject falsy non-string aliases instead of treating them as absent', () => {
  const available = structuredClone(base());
  const fields = ['ownerPlane', 'handoffToPlane', 'ambiguityReason'];

  for (const field of fields) {
    for (const alias of [0, false]) {
      assert.throws(
        () => normalizeExecutionOwnershipV1({ ...available, [field]: alias }),
        /execution plane is invalid|ambiguityReason is invalid/,
        `${field}=${String(alias)}`,
      );
    }
  }
});
