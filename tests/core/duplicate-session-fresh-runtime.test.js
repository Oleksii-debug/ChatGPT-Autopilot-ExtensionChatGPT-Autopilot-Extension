import test from 'node:test';
import assert from 'node:assert/strict';
import { RunMode, RunState } from '../../src/core/schema.js';
import { StorageRepository } from '../../src/core/storage.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { CoreCommand } from '../../src/shared/protocol.js';

function harness(now = 5000) {
  const db = {};
  const chrome = { storage: { local: {
    get: async key => ({ [key]: db[key] }),
    set: async record => Object.assign(db, record)
  } } };
  const repo = new StorageRepository(chrome);
  const core = new CoreCommandDispatcher(repo, () => now);
  return { repo, core };
}

test('DUPLICATE_SESSION resets ONE_PASS progress and runtime audit state while preserving configuration', async () => {
  const { repo, core } = harness();
  const { session: created } = await core.execute(CoreCommand.CREATE_SESSION, {
    config: {
      id: 'source',
      name: 'Source',
      runMode: 'one-pass',
      promptMode: 'unique',
      defaultUniquePrompt: 'fallback',
      retryPolicy: 'manual',
      minimumSendIntervalMinutes: 3,
      preSendDelaySeconds: 7,
      busyCheckDelaySeconds: 4,
      retryBackoffSeconds: 45,
      tabStrategy: 'worker',
      tasks: [
        { id: 't1', label: 'First', url: 'https://chatgpt.com/c/first', promptOverride: 'one', enabled: true },
        { id: 't2', label: 'Second', url: 'https://chatgpt.com/c/second', promptOverride: 'two', enabled: false }
      ]
    }
  });

  await repo.update(state => {
    const source = state.sessionsById[created.id];
    source.runState = RunState.STOPPED;
    source.currentTaskIndex = 1;
    source.onePassCompletedTaskIds = ['t1'];
    source.nextAllowedSendAt = 9000;
    source.lastActionAt = 300;
    source.lastSuccessfulSendAt = 400;
    source.lastError = 'old runtime error';
    source.createdAt = 10;
    source.updatedAt = 500;
    source.tasksById.t1.status = 'RATE_LIMITED';
    source.tasksById.t1.lastCheckedAt = 111;
    source.tasksById.t1.lastVerifiedSendAt = 222;
    source.tasksById.t1.lastVerifiedFingerprint = 'old-fingerprint';
    source.tasksById.t1.retryAfterAt = 9999;
    source.tasksById.t1.manualReviewReason = 'old review';
    return state;
  });

  const { session: duplicateUi } = await core.execute(CoreCommand.DUPLICATE_SESSION, { sessionId: created.id });
  const { snapshot } = await core.execute(CoreCommand.GET_SNAPSHOT);
  const duplicate = snapshot.sessionsById[duplicateUi.id];

  assert.equal(duplicate.runState, RunState.STOPPED);
  assert.equal(duplicate.currentTaskIndex, 0);
  assert.deepEqual(duplicate.onePassCompletedTaskIds, []);
  assert.equal(duplicate.operation, null);
  assert.equal(duplicate.nextAllowedSendAt, 0);
  assert.equal(duplicate.lastActionAt, 0);
  assert.equal(duplicate.lastSuccessfulSendAt, 0);
  assert.equal(duplicate.lastError, '');
  assert.equal(duplicate.createdAt, 5000);
  assert.equal(duplicate.updatedAt, 5000);
  assert.equal(duplicate.pausedByMaster, false);

  assert.equal(duplicate.runMode, RunMode.ONE_PASS);
  assert.equal(duplicate.minimumSendIntervalMs, 180000);
  assert.equal(duplicate.preSendDelayMs, 7000);
  assert.equal(duplicate.busyCheckDelayMs, 4000);
  assert.equal(duplicate.retryBackoffMs, 45000);
  assert.equal(duplicate.defaultUniquePrompt, 'fallback');
  assert.equal(duplicate.retryPolicy, 'manual');

  assert.equal(duplicate.taskOrder.length, 2);
  assert.ok(duplicate.taskOrder.every(id => !['t1', 't2'].includes(id)));
  const [first, second] = duplicate.taskOrder.map(id => duplicate.tasksById[id]);
  assert.deepEqual(
    [first.label, first.url, first.promptOverride, first.enabled],
    ['First', 'https://chatgpt.com/c/first', 'one', true]
  );
  assert.deepEqual(
    [second.label, second.url, second.promptOverride, second.enabled],
    ['Second', 'https://chatgpt.com/c/second', 'two', false]
  );
  for (const task of [first, second]) {
    assert.equal(task.status, 'IDLE');
    assert.equal(task.lastCheckedAt, 0);
    assert.equal(task.lastVerifiedSendAt, 0);
    assert.equal(task.lastVerifiedFingerprint, '');
    assert.equal(task.retryAfterAt, 0);
    assert.equal(task.manualReviewReason, '');
  }

  assert.deepEqual(snapshot.logs[duplicate.id].map(entry => entry.message), ['Session duplicated']);
});
