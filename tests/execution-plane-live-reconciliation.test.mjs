import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ExecutionOwnershipState,
  claimExecutionOwnershipV1,
  createExecutionOwnershipV1,
  requireExecutionReconciliationV1,
} from '../src/core/execution-plane-ownership.js';

const T0 = '2026-09-27T14:40:00.000Z';
const T1 = '2026-09-27T14:41:00.000Z';
const T2 = '2026-09-27T14:55:00.000Z';

function owned() {
  return claimExecutionOwnershipV1(
    createExecutionOwnershipV1({
      taskId: 'task:1',
      planId: 'plan:1',
      nodeId: 'node:1',
      effectId: 'effect:1',
      policyEnvelopeId: 'policy:1',
      at: T0,
    }),
    {
      plane: 'LOCAL',
      ownerId: 'specialist:1',
      leaseId: 'lease:1',
      leaseUntil: T2,
      at: T0,
    },
  );
}

test('live ambiguous provider effect enters RECONCILE while preserving exact lease identity', () => {
  const value = requireExecutionReconciliationV1(owned(), {
    leaseId: 'lease:1',
    reason: 'OpenHands request became ambiguous after dispatch',
    at: T1,
  });
  assert.equal(value.state, ExecutionOwnershipState.RECONCILE);
  assert.equal(value.ownerId, 'specialist:1');
  assert.equal(value.leaseId, 'lease:1');
  assert.equal(value.leaseUntil, T2);
  assert.match(value.ambiguityReason, /OpenHands/);
});

test('reconciliation transition is idempotent only for the same preserved lease', () => {
  const first = requireExecutionReconciliationV1(owned(), {
    leaseId: 'lease:1',
    reason: 'ambiguous provider effect',
    at: T1,
  });
  assert.equal(
    requireExecutionReconciliationV1(first, {
      leaseId: 'lease:1',
      reason: 'ignored duplicate',
      at: T1,
    }),
    first,
  );
  assert.throws(
    () => requireExecutionReconciliationV1(first, {
      leaseId: 'lease:2',
      reason: 'wrong lease',
      at: T1,
    }),
    /lease identity mismatch/,
  );
});

test('unowned or expired execution cannot be converted through the live ambiguity path', () => {
  const available = createExecutionOwnershipV1({
    taskId: 'task:1',
    planId: 'plan:1',
    nodeId: 'node:1',
    effectId: 'effect:1',
    policyEnvelopeId: 'policy:1',
    at: T0,
  });
  assert.throws(
    () => requireExecutionReconciliationV1(available, {
      leaseId: 'lease:1',
      reason: 'ambiguous',
      at: T1,
    }),
    /current execution owner/,
  );
  assert.throws(
    () => requireExecutionReconciliationV1(owned(), {
      leaseId: 'lease:1',
      reason: 'ambiguous',
      at: '2026-09-27T15:00:00.000Z',
    }),
    /lease has expired/,
  );
});
