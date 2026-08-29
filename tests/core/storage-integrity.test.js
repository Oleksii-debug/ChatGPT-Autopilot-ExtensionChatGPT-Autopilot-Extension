import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireSendLease } from '../../src/core/arbiter.js';
import { createEmptyState, createSession, createTask, RunState } from '../../src/core/schema.js';
import { beginOperation, markSubmitting } from '../../src/core/state-machine.js';
import { StorageRepository } from '../../src/core/storage.js';

function fakeChrome(initial = undefined) {
  const db = {};
  if (initial !== undefined) db.autopilotState = structuredClone(initial);
  let writes = 0;
  return {
    db,
    writes: () => writes,
    chrome: {
      storage: {
        local: {
          get: async key => ({ [key]: db[key] }),
          set: async record => {
            writes += 1;
            Object.assign(db, structuredClone(record));
          },
        },
      },
    },
  };
}

function validActiveState() {
  const state = createEmptyState(100);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/storage-integrity' });
  const session = createSession({ id: 's1', name: 'Storage integrity', tasks: [task], now: 100 });
  session.runState = RunState.RECOVERING;
  beginOperation(session, {
    operationId: 'op1',
    taskId: task.id,
    promptFingerprint: 'fingerprint',
    targetUrl: task.normalizedUrl,
    now: 110,
  });
  session.operation.generation = 1;
  session.operation.promptText = 'continue';
  markSubmitting(session, 120);
  state.sessionsById[session.id] = session;
  state.sessionOrder = [session.id];
  assert.equal(acquireSendLease(state, { sessionId: session.id, operationId: 'op1', now: 120 }), true);
  state.tabHintsByTaskId[task.id] = {
    tabId: 7,
    sessionId: session.id,
    normalizedUrl: task.normalizedUrl,
    kind: 'TASK',
    boundAt: 115,
  };
  state.logs[session.id] = [{ at: 120, level: 'INFO', message: 'checkpoint' }];
  return state;
}

test('missing storage key is the only condition that bootstraps a new v1 envelope', async () => {
  const { chrome, writes } = fakeChrome();
  const repo = new StorageRepository(chrome);
  const state = await repo.load();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.revision, 0);
  assert.equal(writes(), 0);
});

test('falsy malformed stored values are not mistaken for an empty install', async () => {
  for (const raw of [false, 0, '']) {
    const { chrome, db, writes } = fakeChrome();
    db.autopilotState = raw;
    const repo = new StorageRepository(chrome);
    await assert.rejects(() => repo.load(), /Stored state is corrupt/);
    assert.equal(db.autopilotState, raw);
    assert.equal(writes(), 0);
  }
});

test('partial v1 envelope fails closed and preserves the stored value', async () => {
  const partial = { schemaVersion: 1, revision: 4, sessionsById: {}, sessionOrder: [] };
  const { chrome, db, writes } = fakeChrome(partial);
  const before = structuredClone(db.autopilotState);
  const repo = new StorageRepository(chrome);
  await assert.rejects(() => repo.load(), /Invalid profile/);
  assert.deepEqual(db.autopilotState, before);
  assert.equal(writes(), 0);
});

test('invalid session/task identity is rejected before a corrupt state can be written', async () => {
  const initial = validActiveState();
  const { chrome, db, writes } = fakeChrome(initial);
  const repo = new StorageRepository(chrome);
  const bad = structuredClone(initial);
  bad.sessionsById.s1.tasksById.t1.id = 'wrong-task-id';
  await assert.rejects(() => repo.save(bad), /Invalid task t1/);
  assert.deepEqual(db.autopilotState, initial);
  assert.equal(writes(), 0);
});

test('valid active SUBMITTING state, lease, tab hint and bounded log shape reload intact', async () => {
  const initial = validActiveState();
  const { chrome } = fakeChrome(initial);
  const repo = new StorageRepository(chrome);
  const loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.operation.phase, 'SUBMITTING');
  assert.equal(loaded.sendArbiter.lease.operationId, 'op1');
  assert.equal(loaded.tabHintsByTaskId.t1.tabId, 7);
  assert.equal(loaded.logs.s1[0].message, 'checkpoint');
});

test('orphan send lease is rejected instead of authorizing a later send', async () => {
  const initial = validActiveState();
  initial.sendArbiter.lease.operationId = 'different-operation';
  const { chrome, writes } = fakeChrome(initial);
  const repo = new StorageRepository(chrome);
  await assert.rejects(() => repo.load(), /Invalid sendArbiter lease owner/);
  assert.equal(writes(), 0);
});
