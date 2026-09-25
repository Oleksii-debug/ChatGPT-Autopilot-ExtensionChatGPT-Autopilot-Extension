import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRuntimeActionCenter, resolveRuntimeActionCenterBrowserApproval } from '../src/core/action-center-runtime.js';

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
      runState: 'WAITING_APPROVAL',
      controlEpoch: 1,
      updatedAt: T2,
      lastError: secret,
      pendingApproval: {
        snapshotId: 'snapshot-safe-id',
        snapshotSignature: 'snapshot-safe',
        requestedAt: T1,
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
      runtime: {
        runState: 'WAITING_APPROVAL',
        controlEpoch: 1,
        updatedAt: T1,
        lastError: '',
        pendingApproval: {
          snapshotId: 'snapshot-s1',
          snapshotSignature: 's1',
          requestedAt: T0,
          action: { type: 'CLICK' },
        },
      },
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


test('runtime projection is deterministically bounded and reports truncation instead of failing above contract capacity', async () => {
  const sessionsById = {};
  const sessionOrder = [];
  for (let index = 0; index < 300; index += 1) {
    const id = `error-${String(index).padStart(3, '0')}`;
    sessionOrder.push(id);
    sessionsById[id] = coreSession(id, {
      runState: 'ERROR',
      createdAt: T0 + index,
      updatedAt: T1 + index,
      lastError: `diagnostic-${index}`,
    });
  }
  sessionsById['blocking'] = coreSession('blocking', {
    operation: { operationId: 'op-blocking', phase: 'AMBIGUOUS', createdAt: T2, updatedAt: T2 },
  });
  sessionOrder.push('blocking');

  const projection = await projectRuntimeActionCenter({
    coreState: { sessionOrder, sessionsById },
  });

  assert.equal(projection.items.length, 256);
  assert.equal(projection.runtimeSummary.candidateCount, 301);
  assert.equal(projection.runtimeSummary.projectedCount, 256);
  assert.equal(projection.runtimeSummary.truncated, true);
  assert.equal(projection.items.some(item => item.ownerActionKind === 'RECONCILE'), true, 'blocking attention must survive truncation');
});


test('stale or malformed Browser Agent pendingApproval does not manufacture an owner approval action', async () => {
  const stale = agentJob('stale-approval', {
    runtime: {
      runState: 'PAUSED',
      updatedAt: T2,
      lastError: '',
      pendingApproval: {
        snapshotSignature: 'stale-snapshot',
        action: { type: 'CLICK', ref: 'control-1' },
      },
    },
  });
  const missingAction = agentJob('missing-action', {
    runtime: {
      runState: 'WAITING_APPROVAL',
      updatedAt: T2,
      lastError: '',
      pendingApproval: { snapshotSignature: 'missing-action' },
    },
  });
  const malformedFence = agentJob('malformed-fence', {
    runtime: {
      runState: 'WAITING_APPROVAL',
      updatedAt: T2,
      lastError: '',
      pendingApproval: {
        snapshotSignature: 'malformed-snapshot',
        action: { type: 'CLICK', ref: 'control-malformed' },
      },
    },
  });
  const valid = agentJob('valid-approval', {
    runtime: {
      runState: 'WAITING_APPROVAL',
      controlEpoch: 2,
      updatedAt: T2,
      lastError: '',
      pendingApproval: {
        snapshotId: 'snapshot-valid',
        snapshotSignature: 'valid-snapshot',
        requestedAt: T1,
        action: { type: 'CLICK', ref: 'control-2' },
      },
    },
  });

  const projection = await projectRuntimeActionCenter({
    agentJobs: [stale, missingAction, malformedFence, valid],
  });
  assert.equal(projection.summary.openCount, 1);
  assert.equal(projection.items[0].ownerActionKind, 'APPROVE_OR_DENY');
  assert.match(projection.items[0].title, /valid-approval/u);
});


test('Action Center resolves only the exact current Browser Agent approval revision to a private owner fence', async () => {
  const job = agentJob('private-job-id', {
    config: { name: 'Owner research agent' },
    runtime: {
      runState: 'WAITING_APPROVAL',
      controlEpoch: 7,
      updatedAt: T2,
      lastError: 'private diagnostic',
      pendingApproval: {
        snapshotId: 'snapshot-7',
        snapshotSignature: 'signature-7',
        requestedAt: T1,
        targetName: 'Private target',
        url: 'https://example.invalid/private',
        action: { type: 'click', ref: 'control-7' },
      },
    },
  });
  const projection = await projectRuntimeActionCenter({ agentJobs: [job] });
  assert.equal(projection.items.length, 1);
  const item = projection.items[0];
  const publicJson = JSON.stringify(projection);
  assert.equal(publicJson.includes('private-job-id'), false);
  assert.equal(publicJson.includes('example.invalid'), false);
  assert.equal(publicJson.includes('Private target'), false);

  const resolved = await resolveRuntimeActionCenterBrowserApproval({
    agentJobs: [job],
    itemId: item.itemId,
    sourceRevisionId: item.sourceRevisionId,
    decision: 'APPROVE',
  });
  assert.equal(resolved.jobId, 'private-job-id');
  assert.equal(resolved.decision, 'APPROVE');
  assert.deepEqual(resolved.expectedApproval, {
    controlEpoch: 7,
    updatedAt: T2,
    snapshotId: 'snapshot-7',
    snapshotSignature: 'signature-7',
    requestedAt: T1,
  });
  assert.equal(Object.isFrozen(resolved.expectedApproval), true);
});

test('Action Center rejects a stale approval revision when canonical pending ownership changes', async () => {
  const job = agentJob('approval-race', {
    config: { name: 'Approval race' },
    runtime: {
      runState: 'WAITING_APPROVAL',
      controlEpoch: 3,
      updatedAt: T1,
      lastError: '',
      pendingApproval: {
        snapshotId: 'snapshot-old',
        snapshotSignature: 'same-page-signature',
        requestedAt: T0,
        action: { type: 'click', ref: 'old-control' },
      },
    },
  });
  const first = await projectRuntimeActionCenter({ agentJobs: [job] });
  const stale = first.items[0];

  job.runtime.controlEpoch = 4;
  job.runtime.updatedAt = T2;
  job.runtime.pendingApproval = {
    snapshotId: 'snapshot-new',
    snapshotSignature: 'same-page-signature',
    requestedAt: T1,
    action: { type: 'click', ref: 'new-control' },
  };
  const second = await projectRuntimeActionCenter({ agentJobs: [job] });
  assert.equal(second.items[0].itemId, stale.itemId, 'same page identity remains one attention item');
  assert.notEqual(second.items[0].sourceRevisionId, stale.sourceRevisionId, 'approval ownership change must move revision');

  await assert.rejects(
    () => resolveRuntimeActionCenterBrowserApproval({
      agentJobs: [job],
      itemId: stale.itemId,
      sourceRevisionId: stale.sourceRevisionId,
      decision: 'APPROVE',
    }),
    /revision is stale/i,
  );
});

test('Action Center owner bridge refuses non-approval items and invalid decisions', async () => {
  const projection = await projectRuntimeActionCenter({
    coreState: {
      sessionOrder: ['core-error'],
      sessionsById: {
        'core-error': coreSession('core-error', { runState: 'ERROR', lastError: 'diagnostic' }),
      },
    },
  });
  const item = projection.items[0];
  await assert.rejects(
    () => resolveRuntimeActionCenterBrowserApproval({
      coreState: {
        sessionOrder: ['core-error'],
        sessionsById: {
          'core-error': coreSession('core-error', { runState: 'ERROR', lastError: 'diagnostic' }),
        },
      },
      itemId: item.itemId,
      sourceRevisionId: item.sourceRevisionId,
      decision: 'APPROVE',
    }),
    /not an actionable Browser Agent approval/i,
  );
  await assert.rejects(
    () => resolveRuntimeActionCenterBrowserApproval({
      itemId: item.itemId,
      sourceRevisionId: item.sourceRevisionId,
      decision: 'ALLOW_ALL',
    }),
    /decision is invalid/i,
  );
});


test('malformed Browser Agent approval fences fail closed instead of manufacturing APPROVE_OR_DENY attention', async () => {
  const baseRuntime = {
    runState: 'WAITING_APPROVAL',
    controlEpoch: 3,
    updatedAt: T2,
    lastError: '',
    pendingApproval: {
      snapshotId: 'snapshot-3',
      snapshotSignature: 'signature-3',
      requestedAt: T1,
      action: { type: 'CLICK', ref: 'control-3' },
    },
  };
  const mutations = [
    runtime => { delete runtime.controlEpoch; },
    runtime => { runtime.controlEpoch = -1; },
    runtime => { runtime.controlEpoch = -0; },
    runtime => { runtime.updatedAt = '123'; },
    runtime => { runtime.updatedAt = -0; },
    runtime => { delete runtime.pendingApproval.requestedAt; },
    runtime => { runtime.pendingApproval.requestedAt = -1; },
    runtime => { runtime.pendingApproval.requestedAt = -0; },
    runtime => { delete runtime.pendingApproval.snapshotId; },
    runtime => { runtime.pendingApproval.snapshotId = ''; },
    runtime => { runtime.pendingApproval.snapshotId = 7; },
    runtime => { delete runtime.pendingApproval.snapshotSignature; },
    runtime => { runtime.pendingApproval.snapshotSignature = ''; },
    runtime => { runtime.pendingApproval.snapshotSignature = 7; },
  ];

  for (const mutate of mutations) {
    const runtime = structuredClone(baseRuntime);
    mutate(runtime);
    const projection = await projectRuntimeActionCenter({
      agentJobs: [agentJob('malformed-approval', { runtime })],
    });
    assert.equal(projection.summary.openCount, 0);
    assert.equal(projection.items.length, 0);
  }
});


test('Action Center public envelopes reject accessor-backed fields without executing getters', async () => {
  let projectionGetterCalls = 0;
  const projectionInput = {};
  Object.defineProperty(projectionInput, 'agentJobs', {
    enumerable: true,
    get() {
      projectionGetterCalls += 1;
      return [];
    },
  });
  await assert.rejects(
    () => projectRuntimeActionCenter(projectionInput),
    /enumerable own data properties/u,
  );
  assert.equal(projectionGetterCalls, 0);

  let resolverGetterCalls = 0;
  const resolverInput = {
    itemId: 'item',
    sourceRevisionId: 'revision',
    decision: 'APPROVE',
  };
  Object.defineProperty(resolverInput, 'agentJobs', {
    enumerable: true,
    get() {
      resolverGetterCalls += 1;
      return [];
    },
  });
  await assert.rejects(
    () => resolveRuntimeActionCenterBrowserApproval(resolverInput),
    /enumerable own data properties/u,
  );
  assert.equal(resolverGetterCalls, 0);
});

test('Browser Agent approval authority records are snapshotted without executing accessors', async () => {
  const makeJob = () => agentJob('descriptor-safe', {
    config: { name: 'Descriptor safe approval' },
    runtime: {
      runState: 'WAITING_APPROVAL',
      controlEpoch: 9,
      updatedAt: T2,
      lastError: '',
      pendingApproval: {
        snapshotId: 'snapshot-9',
        snapshotSignature: 'signature-9',
        requestedAt: T1,
        action: { type: 'CLICK', ref: 'control-9' },
      },
    },
  });
  const mutations = [
    (job, getter) => Object.defineProperty(job, 'id', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job, 'runtime', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job.config, 'name', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job.runtime, 'runState', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job.runtime, 'controlEpoch', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job.runtime, 'updatedAt', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job.runtime, 'pendingApproval', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job.runtime.pendingApproval, 'requestedAt', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job.runtime.pendingApproval, 'snapshotId', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job.runtime.pendingApproval, 'snapshotSignature', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job.runtime.pendingApproval, 'action', { enumerable: true, get: getter }),
    (job, getter) => Object.defineProperty(job.runtime.pendingApproval.action, 'type', { enumerable: true, get: getter }),
  ];

  for (const mutate of mutations) {
    let getterCalls = 0;
    const job = makeJob();
    mutate(job, () => {
      getterCalls += 1;
      return 'hostile';
    });
    const projection = await projectRuntimeActionCenter({ agentJobs: [job] });
    assert.equal(projection.summary.openCount, 0);
    assert.equal(getterCalls, 0);
  }
});

test('Browser approval resolver fails closed on hostile changed authority without executing getters', async () => {
  const job = agentJob('resolver-hostile', {
    runtime: {
      runState: 'WAITING_APPROVAL',
      controlEpoch: 11,
      updatedAt: T2,
      lastError: '',
      pendingApproval: {
        snapshotId: 'snapshot-11',
        snapshotSignature: 'signature-11',
        requestedAt: T1,
        action: { type: 'CLICK', ref: 'control-11' },
      },
    },
  });
  const projection = await projectRuntimeActionCenter({ agentJobs: [job] });
  const item = projection.items[0];

  let getterCalls = 0;
  Object.defineProperty(job.runtime.pendingApproval, 'snapshotId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'changed-snapshot';
    },
  });
  await assert.rejects(
    () => resolveRuntimeActionCenterBrowserApproval({
      agentJobs: [job],
      itemId: item.itemId,
      sourceRevisionId: item.sourceRevisionId,
      decision: 'APPROVE',
    }),
    /no longer current/u,
  );
  assert.equal(getterCalls, 0);
});

test('null-prototype Action Center envelopes and Browser approval records remain compatible', async () => {
  const action = Object.assign(Object.create(null), { type: 'CLICK', ref: 'control-null' });
  const pendingApproval = Object.assign(Object.create(null), {
    snapshotId: 'snapshot-null',
    snapshotSignature: 'signature-null',
    requestedAt: T1,
    action,
  });
  const runtime = Object.assign(Object.create(null), {
    runState: 'WAITING_APPROVAL',
    controlEpoch: 12,
    updatedAt: T2,
    lastError: '',
    pendingApproval,
  });
  const config = Object.assign(Object.create(null), { name: 'Null prototype approval' });
  const job = Object.assign(Object.create(null), {
    id: 'null-prototype-job',
    config,
    createdAt: T0,
    updatedAt: T1,
    runtime,
  });
  const projectionInput = Object.assign(Object.create(null), { agentJobs: [job] });
  const projection = await projectRuntimeActionCenter(projectionInput);
  assert.equal(projection.summary.openCount, 1);

  const resolveInput = Object.assign(Object.create(null), {
    agentJobs: [job],
    itemId: projection.items[0].itemId,
    sourceRevisionId: projection.items[0].sourceRevisionId,
    decision: 'APPROVE',
  });
  const resolved = await resolveRuntimeActionCenterBrowserApproval(resolveInput);
  assert.equal(resolved.jobId, 'null-prototype-job');
  assert.equal(resolved.expectedApproval.snapshotId, 'snapshot-null');
});
