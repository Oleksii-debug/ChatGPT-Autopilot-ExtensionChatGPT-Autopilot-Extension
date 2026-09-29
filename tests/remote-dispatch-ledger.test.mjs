import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RemoteDispatchLedgerRepository,
  canLaunchRemoteTask,
  createRemoteDispatchLedger,
  getRemoteLaunchCount,
  makeRemoteLaunchKey,
  recordAcceptedRemoteDispatch,
  recordRejectedRemoteDispatch,
  recordRemoteFetch,
  recordRemoteTaskLaunch,
  recordVerifiedRemoteSend,
  recordRemoteSessionBinding,
  setRemoteFallbackActive,
  validateRemoteDispatchLedger,
} from '../src/core/remote-dispatch-ledger.js';

function fakeChrome(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    storage: { local: {
      async get(key) { return { [key]: data[key] }; },
      async set(record) { Object.assign(data, structuredClone(record)); },
    } },
  };
}

const identity = { projectId: 'project-a', dispatchId: 'dispatch-1', sessionKey: 'builders', taskId: 'task-1' };

test('empty repository creates project-bound durable ledger', async () => {
  const chrome = fakeChrome();
  const repo = new RemoteDispatchLedgerRepository(chrome, { projectId: 'project-a' });
  const ledger = await repo.load();
  assert.equal(ledger.projectId, 'project-a');
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.revision, 0);
});

test('launch identity is stable and project/dispatch/session/task scoped', () => {
  const key = makeRemoteLaunchKey(identity);
  assert.equal(key, 'project-a\u001fdispatch-1\u001fbuilders\u001ftask-1');
  assert.notEqual(key, makeRemoteLaunchKey({ ...identity, dispatchId: 'dispatch-2' }));
});

test('max_launches is enforced from durable count', () => {
  const ledger = createRemoteDispatchLedger('project-a', 1);
  assert.equal(canLaunchRemoteTask(ledger, identity, 1), true);
  assert.equal(recordRemoteTaskLaunch(ledger, identity, { nowMs: 2 }), 1);
  assert.equal(canLaunchRemoteTask(ledger, identity, 1), false);
  assert.equal(canLaunchRemoteTask(ledger, identity, 2), true);
  assert.equal(recordRemoteTaskLaunch(ledger, identity, { nowMs: 3 }), 2);
  assert.equal(getRemoteLaunchCount(ledger, identity), 2);
});

test('launch count survives repository restart and prevents one-shot duplicate', async () => {
  const chrome = fakeChrome();
  const first = new RemoteDispatchLedgerRepository(chrome, { projectId: 'project-a' });
  await first.update(ledger => { recordRemoteTaskLaunch(ledger, identity, { nowMs: 10 }); return ledger; }, { nowMs: 10 });
  const restarted = new RemoteDispatchLedgerRepository(chrome, { projectId: 'project-a' });
  const reloaded = await restarted.load();
  assert.equal(getRemoteLaunchCount(reloaded, identity), 1);
  assert.equal(canLaunchRemoteTask(reloaded, identity, 1), false);
});

test('repository serializes concurrent updates without losing launch increments', async () => {
  const chrome = fakeChrome();
  const repo = new RemoteDispatchLedgerRepository(chrome, { projectId: 'project-a' });
  await Promise.all([
    repo.update(ledger => { recordRemoteTaskLaunch(ledger, identity, { nowMs: 20 }); return ledger; }, { nowMs: 20 }),
    repo.update(ledger => { recordRemoteTaskLaunch(ledger, identity, { nowMs: 21 }); return ledger; }, { nowMs: 21 }),
  ]);
  const reloaded = await repo.load();
  assert.equal(getRemoteLaunchCount(reloaded, identity), 2);
  assert.equal(reloaded.revision, 2);
});

test('accepted dispatch records revision, expiry, comment and explicit supersession', () => {
  const ledger = createRemoteDispatchLedger('project-a', 1);
  recordAcceptedRemoteDispatch(ledger, {
    dispatchId: 'dispatch-2', strategyRevision: 4, expiresAtMs: 1000, commentId: '55', supersedesDispatchIds: ['dispatch-1'],
  }, { nowMs: 100 });
  assert.equal(ledger.currentDispatchId, 'dispatch-2');
  assert.equal(ledger.currentStrategyRevision, 4);
  assert.equal(ledger.lastCommentId, '55');
  assert.deepEqual(ledger.supersededDispatchIds, ['dispatch-1']);
});

test('re-applying the same accepted dispatch revision does not duplicate history', () => {
  const ledger = createRemoteDispatchLedger('project-a', 1);
  const accepted = {
    dispatchId: 'dispatch-2', strategyRevision: 4, expiresAtMs: 1000, commentId: '55', supersedesDispatchIds: [],
  };
  recordAcceptedRemoteDispatch(ledger, accepted, { nowMs: 100 });
  recordAcceptedRemoteDispatch(ledger, accepted, { nowMs: 200 });
  assert.equal(ledger.acceptedDispatches.length, 1);
  assert.equal(ledger.acceptedDispatches[0].acceptedAt, 100);
});

test('fetch and rejection diagnostics are bounded non-secret strings', () => {
  const ledger = createRemoteDispatchLedger('project-a', 1);
  recordRemoteFetch(ledger, { ok: false, error: 'x'.repeat(1000) }, { nowMs: 10 });
  recordRejectedRemoteDispatch(ledger, { dispatchId: 'd', commentId: '1', reason: 'bad schema' }, { nowMs: 11 });
  assert.equal(ledger.lastFetchError.length, 500);
  assert.equal(ledger.rejectedDispatches.at(-1).reason, 'bad schema');
  recordRemoteFetch(ledger, { ok: true, commentId: '2' }, { nowMs: 12 });
  assert.equal(ledger.lastFetchError, '');
  assert.equal(ledger.lastFetchOkAt, 12);
});

test('fallback activation timestamp is durable and deactivation clears it', () => {
  const ledger = createRemoteDispatchLedger('project-a', 1);
  setRemoteFallbackActive(ledger, true, { nowMs: 50 });
  assert.equal(ledger.fallbackActive, true);
  assert.equal(ledger.fallbackActivatedAt, 50);
  setRemoteFallbackActive(ledger, true, { nowMs: 60 });
  assert.equal(ledger.fallbackActivatedAt, 50);
  setRemoteFallbackActive(ledger, false, { nowMs: 70 });
  assert.equal(ledger.fallbackActive, false);
  assert.equal(ledger.fallbackActivatedAt, 0);
});

test('project-bound repository refuses another project ledger', async () => {
  const chrome = fakeChrome();
  const repo = new RemoteDispatchLedgerRepository(chrome, { projectId: 'project-a' });
  const wrong = createRemoteDispatchLedger('project-b', 1);
  await assert.rejects(() => repo.save(wrong), /another project/i);
});

test('ledger validation fails closed for corrupt persisted launch state', () => {
  const ledger = createRemoteDispatchLedger('project-a', 1);
  ledger.launchCounts.bad = -1;
  assert.throws(() => validateRemoteDispatchLedger(ledger), /launch count/i);
});


test('verified send fingerprint increments launch count exactly once across restart-style resync', () => {
  const ledger = createRemoteDispatchLedger('project-a', 1);
  assert.deepEqual(recordVerifiedRemoteSend(ledger, identity, 'sha256:a', { nowMs: 2 }), { counted: true, count: 1 });
  assert.deepEqual(recordVerifiedRemoteSend(ledger, identity, 'sha256:a', { nowMs: 3 }), { counted: false, count: 1 });
  assert.deepEqual(recordVerifiedRemoteSend(ledger, identity, 'sha256:b', { nowMs: 4 }), { counted: true, count: 2 });
});

test('remote session binding is persisted by stable session key', () => {
  const ledger = createRemoteDispatchLedger('project-a', 1);
  recordRemoteSessionBinding(ledger, 'builders', 'remote:project-a:builders', { nowMs: 2 });
  assert.equal(ledger.importedSessionIds.builders, 'remote:project-a:builders');
});
