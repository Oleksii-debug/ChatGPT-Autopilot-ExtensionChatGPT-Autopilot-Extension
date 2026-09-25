import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRuntimeActionCenter } from '../src/core/action-center-runtime.js';

const T0 = Date.parse('2026-09-25T08:00:00.000Z');
const T1 = Date.parse('2026-09-25T08:01:00.000Z');
const T2 = Date.parse('2026-09-25T08:02:00.000Z');

function coreSession(id, overrides = {}) {
  return {
    id,
    name: `Session ${id}`,
    runState: 'RUNNING',
    createdAt: T0,
    updatedAt: T1,
    lastActionAt: T1,
    lastError: '',
    operation: null,
    ...overrides,
  };
}

function agentJob(id, overrides = {}) {
  return {
    id,
    config: { name: `Agent ${id}` },
    createdAt: T0,
    updatedAt: T1,
    runtime: { runState: 'RUNNING', updatedAt: T1, lastError: '', pendingApproval: null },
    ...overrides,
  };
}

test('projects Core ambiguous and manual-review operations as blocking owner attention', async () => {
  const ambiguous = coreSession('a', {
    operation: { operationId: 'op-a', phase: 'AMBIGUOUS', createdAt: T0, updatedAt: T1 },
  });
  const manual = coreSession('b', {
    operation: { operationId: 'op-b', phase: 'MANUAL_REVIEW', createdAt: T0, updatedAt: T2 },
  });
  const projection = await projectRuntimeActionCenter({
    coreState: { sessionOrder: ['a', 'b'], sessionsById: { a: ambiguous, b: manual } },
  });
  assert.equal(projection.summary.openCount, 2);
  assert.equal(projection.summary.blockingOpenCount, 2);
  assert.deepEqual(projection.items.map(item => item.ownerActionKind).sort(), ['RECONCILE', 'REVIEW']);
  assert.equal(projection.items.every(item => item.sourceKind === 'EFFECT'), true);
  assert.equal(projection.items.every(item => item.decisionAuthorized === false), true);
});

test('pending Browser Agent approval outranks an error and never exposes target or error text', async () => {
  const secret = 'SECRET instruction from untrusted page C:\\private\\token.txt';
  const job = agentJob('agent-one', {
    config: { name: 'Owner research agent' },
    runtime: {
      runState: 'ERROR',
      updatedAt: T2,
      lastError: secret,
      pendingApproval: {
        snapshotSignature: 'snapshot-safe',
        targetName: secret,
        url: 'https://example.invalid/private',
        action: { type: 'CLICK', text: secret },
      },
    },
  });
  const projection = await projectRuntimeActionCenter({ agentJobs: [job] });
  assert.equal(projection.summary.openCount, 1);
  assert.equal(projection.items[0].ownerActionKind, 'APPROVE_OR_DENY');
  assert.equal(projection.items[0].sourceKind, 'APPROVAL');
  assert.equal(JSON.stringify(projection).includes('SECRET'), false);
  assert.equal(JSON.stringify(projection).includes('token.txt'), false);
  assert.equal(JSON.stringify(projection).includes('example.invalid'), false);
});

test('durable Core and Browser Agent ERROR states project HIGH review items', async () => {
  const projection = await projectRuntimeActionCenter({
    coreState: {
      sessionOrder: ['core-error'],
      sessionsById: {
        'core-error': coreSession('core-error', { runState: 'ERROR', lastError: 'raw core diagnostic' }),
      },
    },
    agentJobs: [
      agentJob('agent-error', {
        runtime: { runState: 'ERROR', updatedAt: T2, lastError: 'raw agent diagnostic', pendingApproval: null },
      }),
    ],
  });
  assert.equal(projection.summary.openCount, 2);
  assert.equal(projection.summary.openBySeverity.HIGH, 2);
  assert.equal(projection.items.every(item => item.ownerActionKind === 'REVIEW'), true);
  assert.equal(JSON.stringify(projection).includes('raw core diagnostic'), false);
  assert.equal(JSON.stringify(projection).includes('raw agent diagnostic'), false);
});

test('resolved or normal runtime states disappear instead of becoming stale inbox history', async () => {
  const initial = await projectRuntimeActionCenter({
    coreState: {
      sessionOrder: ['a'],
      sessionsById: {
        a: coreSession('a', {
          operation: { operationId: 'op-a', phase: 'AMBIGUOUS', createdAt: T0, updatedAt: T1 },
        }),
      },
    },
    agentJobs: [agentJob('b', {
      runtime: { runState: 'RUNNING', updatedAt: T1, lastError: '', pendingApproval: { snapshotSignature: 's1' } },
    })],
  });
  assert.equal(initial.summary.openCount, 2);

  const resolved = await projectRuntimeActionCenter({
    coreState: {
      sessionOrder: ['a'],
      sessionsById: {
        a: coreSession('a', {
          operation: { operationId: 'op-a', phase: 'SENT_VERIFIED', createdAt: T0, updatedAt: T2 },
        }),
      },
    },
    agentJobs: [agentJob('b')],
  });
  assert.equal(resolved.summary.openCount, 0);
  assert.equal(resolved.summary.totalCount, 0);
});

test('managed Core sessions are not duplicated: one unresolved operation produces one exact attention item', async () => {
  const session = coreSession('managed', {
    scenarioWork: { managed: true, scenarioId: 'scenario' },
    operation: { operationId: 'same-effect', phase: 'AMBIGUOUS', createdAt: T0, updatedAt: T1 },
  });
  const projection = await projectRuntimeActionCenter({
    coreState: {
      sessionOrder: ['managed', 'managed'],
      sessionsById: { managed: session },
    },
  });
  assert.equal(projection.summary.openCount, 1);
  assert.equal(new Set(projection.items.map(item => item.itemId)).size, 1);
});

test('projection is deterministic across repeated reads and changing revision changes only revision identity', async () => {
  const state = {
    sessionOrder: ['a'],
    sessionsById: {
      a: coreSession('a', {
        operation: { operationId: 'op-a', phase: 'AMBIGUOUS', createdAt: T0, updatedAt: T1 },
      }),
    },
  };
  const first = await projectRuntimeActionCenter({ coreState: state });
  const second = await projectRuntimeActionCenter({ coreState: structuredClone(state) });
  assert.deepEqual(second, first);

  state.sessionsById.a.operation.updatedAt = T2;
  const third = await projectRuntimeActionCenter({ coreState: state });
  assert.equal(third.items[0].itemId, first.items[0].itemId);
  assert.notEqual(third.items[0].sourceRevisionId, first.items[0].sourceRevisionId);
});
