import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SwarmDispatchProposalKind,
  SwarmRefillTriggerKind,
  SwarmWorkerStatus,
  buildSwarmRefillPlanV1,
} from '../src/core/swarm-refill-planner.js';

const NOW = '2026-09-25T12:00:00.000Z';
const HOUR = 60 * 60 * 1000;

function node(nodeId, overrides = {}) {
  return {
    nodeId,
    title: 'Node ' + nodeId,
    objective: 'Complete ' + nodeId,
    dependsOn: [],
    conflictKeys: [],
    ownerId: '',
    executionPlane: 'LOCAL',
    acceptanceCriteria: [],
    budget: {},
    state: 'READY',
    evidence: '',
    updatedAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

function basePlan(overrides = {}) {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    jobId: 'job-1',
    objective: 'Finish the product',
    successCriteria: [],
    nodes: [
      node('n1', {
        state: 'VERIFIED',
        evidence: 'verified evidence',
        updatedAt: '2026-09-25T10:00:00.000Z',
      }),
      node('n2', {
        dependsOn: ['n1'],
        conflictKeys: ['repo:a'],
        ownerId: 'w1',
        updatedAt: '2026-09-25T10:10:00.000Z',
      }),
      node('n3', {
        dependsOn: ['n1'],
        conflictKeys: ['repo:b'],
        ownerId: 'w1',
        updatedAt: '2026-09-25T10:20:00.000Z',
      }),
      node('n4', {
        dependsOn: ['n1'],
        executionPlane: 'CLOUD',
        updatedAt: '2026-09-25T10:30:00.000Z',
      }),
      node('n5', {
        dependsOn: ['n2'],
        state: 'PENDING',
        updatedAt: '2026-09-25T10:30:00.000Z',
      }),
    ],
    createdAt: '2026-09-25T09:00:00.000Z',
    updatedAt: '2026-09-25T10:30:00.000Z',
    revision: 7,
    ...overrides,
  };
}

function worker(workerId, overrides = {}) {
  return {
    workerId,
    status: SwarmWorkerStatus.AVAILABLE,
    executionPlanes: ['LOCAL'],
    maxConcurrent: 1,
    activeCount: 0,
    rateRemaining: 10,
    observedAt: '2026-09-25T11:50:00.000Z',
    validUntil: '2026-09-25T12:10:00.000Z',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    evaluatedAt: NOW,
    stealAfterMs: HOUR,
    workerFreshnessMs: 30 * 60 * 1000,
    trigger: {
      kind: SwarmRefillTriggerKind.TERMINAL_EVENT,
      eventId: 'event-1',
      nodeId: 'n1',
      observedAt: '2026-09-25T10:00:01.000Z',
    },
    plan: basePlan(),
    workers: [
      worker('w1'),
      worker('w2'),
      worker('w3', { executionPlanes: ['CLOUD'] }),
    ],
    ...overrides,
  };
}

test('terminal-event refill fills available capacity owner-first and steals only remaining ready work', () => {
  const out = buildSwarmRefillPlanV1(request());

  assert.equal(out.completionDrivenRefill, true);
  assert.equal(out.summary.proposedCount, 3);
  assert.deepEqual(out.proposals.map(item => item.nodeId), ['n2', 'n3', 'n4']);

  const n2 = out.proposals.find(item => item.nodeId === 'n2');
  const n3 = out.proposals.find(item => item.nodeId === 'n3');
  const n4 = out.proposals.find(item => item.nodeId === 'n4');

  assert.equal(n2.workerId, 'w1');
  assert.equal(n2.proposalKind, SwarmDispatchProposalKind.ASSIGN);
  assert.equal(n2.reasonCode, 'CURRENT_OWNER_CAPACITY_AVAILABLE');
  assert.equal(n2.structuralDownstreamDepth, 2);

  assert.equal(n3.workerId, 'w2');
  assert.equal(n3.proposalKind, SwarmDispatchProposalKind.STEAL);
  assert.equal(n3.reasonCode, 'OWNER_AT_CAPACITY_WAIT_EXCEEDED');

  assert.equal(n4.workerId, 'w3');
  assert.equal(n4.proposalKind, SwarmDispatchProposalKind.ASSIGN);
  assert.equal(n4.reasonCode, 'UNOWNED_READY_NODE');

  assert.equal(out.summary.ownerFillCount, 1);
  assert.equal(out.summary.stealCount, 1);
  assert.equal(out.summary.unownedFillCount, 1);
  assert.equal(out.summary.idleSlotsAfter, 0);
});

test('healthy saturated owner keeps recently-ready work reserved until steal threshold elapses', () => {
  const plan = basePlan();
  plan.nodes = plan.nodes.map(item => item.nodeId === 'n3'
    ? { ...item, updatedAt: '2026-09-25T11:50:00.000Z' }
    : item);
  plan.updatedAt = '2026-09-25T11:50:00.000Z';

  const out = buildSwarmRefillPlanV1(request({ plan }));

  assert.equal(out.proposals.some(item => item.nodeId === 'n3'), false);
  assert.deepEqual(
    out.unassigned.find(item => item.nodeId === 'n3'),
    { nodeId: 'n3', ownerId: 'w1', reasonCode: 'OWNER_AT_CAPACITY_RESERVED' },
  );
});

test('offline or backpressured owner permits immediate bounded steal without waiting for timeout', () => {
  for (const status of [SwarmWorkerStatus.OFFLINE, SwarmWorkerStatus.BACKPRESSURED]) {
    const out = buildSwarmRefillPlanV1(request({
      stealAfterMs: 24 * HOUR,
      workers: [
        worker('w1', { status }),
        worker('w2', { maxConcurrent: 2 }),
        worker('w3', { executionPlanes: ['CLOUD'] }),
      ],
    }));

    const stolen = out.proposals.filter(item => ['n2', 'n3'].includes(item.nodeId));
    assert.equal(stolen.length, 2);
    assert.ok(stolen.every(item => item.workerId === 'w2'));
    assert.ok(stolen.every(item => item.proposalKind === SwarmDispatchProposalKind.STEAL));
    assert.ok(stolen.every(item => item.reasonCode === (
      status === SwarmWorkerStatus.OFFLINE ? 'OWNER_OFFLINE' : 'OWNER_BACKPRESSURED'
    )));
  }
});

test('stale worker evidence never supplies advisory capacity', () => {
  const out = buildSwarmRefillPlanV1(request({
    workers: [
      worker('w1'),
      worker('w2', {
        observedAt: '2026-09-25T10:00:00.000Z',
        validUntil: '2026-09-25T11:00:00.000Z',
      }),
      worker('w3', { executionPlanes: ['CLOUD'] }),
    ],
  }));

  assert.equal(out.summary.staleWorkerCount, 1);
  assert.equal(out.proposals.some(item => item.workerId === 'w2'), false);
  assert.equal(out.proposals.some(item => item.nodeId === 'n3'), false);
  assert.equal(
    out.unassigned.find(item => item.nodeId === 'n3').reasonCode,
    'NO_ELIGIBLE_WORKER_CAPACITY',
  );
});

test('one refill projection does not propose concurrent READY nodes sharing a mutation conflict key', () => {
  const plan = basePlan({
    nodes: [
      node('n1', {
        state: 'VERIFIED',
        evidence: 'done',
        updatedAt: '2026-09-25T10:00:00.000Z',
      }),
      node('a', {
        dependsOn: ['n1'],
        conflictKeys: ['repo:shared'],
        updatedAt: '2026-09-25T10:10:00.000Z',
      }),
      node('b', {
        dependsOn: ['n1'],
        conflictKeys: ['repo:shared'],
        updatedAt: '2026-09-25T10:20:00.000Z',
      }),
    ],
    updatedAt: '2026-09-25T10:20:00.000Z',
  });
  const out = buildSwarmRefillPlanV1(request({
    plan,
    workers: [worker('w1'), worker('w2')],
  }));

  assert.deepEqual(out.proposals.map(item => item.nodeId), ['a']);
  assert.deepEqual(out.unassigned, [
    { nodeId: 'b', ownerId: '', reasonCode: 'PROPOSED_CONFLICT_KEY_RESERVED' },
  ]);
});

test('RUNNING and terminal nodes are never dispatch proposals', () => {
  const plan = basePlan();
  plan.nodes = plan.nodes.map(item => item.nodeId === 'n3'
    ? { ...item, state: 'RUNNING', ownerId: 'w1' }
    : item);

  const out = buildSwarmRefillPlanV1(request({
    plan,
    workers: [
      worker('w1', { activeCount: 1, maxConcurrent: 2 }),
      worker('w2'),
      worker('w3', { executionPlanes: ['CLOUD'] }),
    ],
  }));

  assert.equal(out.proposals.some(item => item.nodeId === 'n1'), false);
  assert.equal(out.proposals.some(item => item.nodeId === 'n3'), false);
  assert.ok(out.proposals.every(item => item.nodeId === 'n2' || item.nodeId === 'n4'));
});

test('forged READY with a pending dependency fails closed before dispatch planning', () => {
  const plan = basePlan({
    nodes: [
      node('a', { state: 'PENDING', updatedAt: '2026-09-25T10:00:00.000Z' }),
      node('b', {
        state: 'READY',
        dependsOn: ['a'],
        updatedAt: '2026-09-25T10:10:00.000Z',
      }),
    ],
    updatedAt: '2026-09-25T10:10:00.000Z',
  });

  assert.throws(
    () => buildSwarmRefillPlanV1(request({
      trigger: {
        kind: SwarmRefillTriggerKind.WATCHDOG,
        eventId: 'watchdog-forged-pending',
        nodeId: '',
        observedAt: NOW,
      },
      plan,
      workers: [worker('w1')],
    })),
    /READY node has unverified dependency: b <- a/u,
  );
});

test('forged READY with failed, cancelled or blocked dependency fails closed', () => {
  for (const dependencyState of ['FAILED', 'CANCELLED', 'BLOCKED']) {
    const plan = basePlan({
      nodes: [
        node('a', {
          state: dependencyState,
          updatedAt: '2026-09-25T10:00:00.000Z',
        }),
        node('b', {
          state: 'READY',
          dependsOn: ['a'],
          updatedAt: '2026-09-25T10:10:00.000Z',
        }),
      ],
      updatedAt: '2026-09-25T10:10:00.000Z',
    });

    assert.throws(
      () => buildSwarmRefillPlanV1(request({
        trigger: {
          kind: SwarmRefillTriggerKind.WATCHDOG,
          eventId: 'watchdog-forged-' + dependencyState.toLowerCase(),
          nodeId: '',
          observedAt: NOW,
        },
        plan,
        workers: [worker('w1')],
      })),
      /READY node has terminal or blocked dependency: b <- a/u,
    );
  }
});

test('worker input ordering does not change deterministic dispatch selection', () => {
  const forward = buildSwarmRefillPlanV1(request());
  const reverse = buildSwarmRefillPlanV1(request({
    workers: [...request().workers].reverse(),
  }));

  assert.deepEqual(forward.proposals, reverse.proposals);
  assert.deepEqual(forward.unassigned, reverse.unassigned);
  assert.deepEqual(forward.workerEvidence, reverse.workerEvidence);
});

test('WATCHDOG is explicitly fallback-only and cannot carry a terminal node identity', () => {
  const out = buildSwarmRefillPlanV1(request({
    trigger: {
      kind: SwarmRefillTriggerKind.WATCHDOG,
      eventId: 'watchdog-1',
      nodeId: '',
      observedAt: NOW,
    },
  }));
  assert.equal(out.watchdogFallback, true);
  assert.equal(out.completionDrivenRefill, false);

  assert.throws(
    () => buildSwarmRefillPlanV1(request({
      trigger: {
        kind: SwarmRefillTriggerKind.WATCHDOG,
        eventId: 'watchdog-2',
        nodeId: 'n1',
        observedAt: NOW,
      },
    })),
    /cannot carry nodeId/u,
  );
});

test('descriptor, symbol and sparse-array boundaries fail closed without executing worker getters', () => {
  let getterCalls = 0;
  const badWorker = worker('w1');
  Object.defineProperty(badWorker, 'status', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return SwarmWorkerStatus.AVAILABLE;
    },
  });

  assert.throws(
    () => buildSwarmRefillPlanV1(request({
      workers: [badWorker, worker('w2'), worker('w3', { executionPlanes: ['CLOUD'] })],
    })),
    /enumerable own data properties/u,
  );
  assert.equal(getterCalls, 0);

  const symbolic = request();
  symbolic[Symbol('authority')] = true;
  assert.throws(() => buildSwarmRefillPlanV1(symbolic), /unknown field/u);

  const sparse = new Array(1);
  assert.throws(
    () => buildSwarmRefillPlanV1(request({ workers: sparse })),
    /enumerable own data property/u,
  );
});

test('numeric aliases, future observations and incoherent plan time fail closed', () => {
  assert.throws(
    () => buildSwarmRefillPlanV1(request({ stealAfterMs: -0 })),
    /exact integer/u,
  );
  assert.throws(
    () => buildSwarmRefillPlanV1(request({ workerFreshnessMs: '1000' })),
    /exact integer/u,
  );
  assert.throws(
    () => buildSwarmRefillPlanV1(request({
      workers: [
        worker('w1', { observedAt: '2026-09-25T12:00:00.001Z' }),
        worker('w2'),
        worker('w3', { executionPlanes: ['CLOUD'] }),
      ],
    })),
    /cannot be after evaluatedAt/u,
  );

  const plan = basePlan({ updatedAt: '2026-09-25T09:30:00.000Z' });
  assert.throws(
    () => buildSwarmRefillPlanV1(request({ plan })),
    /outside plan chronology/u,
  );
});

test('output is deeply frozen and never grants dispatch, lease, policy, mutation or execution authority', () => {
  const out = buildSwarmRefillPlanV1(request());

  assert.equal(out.readOnly, true);
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.dispatchAuthorized, false);
  assert.equal(out.leaseAuthorized, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.taskMutationAuthorized, false);
  assert.equal(out.policyDecisionGranted, false);
  assert.equal(out.requiresCanonicalReservation, true);
  assert.equal(out.requiresCanonicalPlanRevisionRecheck, true);
  assert.equal(out.requiresCanonicalWorkerCapacityRecheck, true);
  assert.equal(out.requiresCanonicalConflictLeaseRecheck, true);
  assert.equal(out.requiresCanonicalPolicyDecision, true);
  assert.ok(Object.isFrozen(out));
  assert.ok(Object.isFrozen(out.proposals));
  assert.ok(Object.isFrozen(out.proposals[0]));
  assert.ok(Object.isFrozen(out.workerEvidence));
  assert.ok(Object.isFrozen(out.summary));
});
