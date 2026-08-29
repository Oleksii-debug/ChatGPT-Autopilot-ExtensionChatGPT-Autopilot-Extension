import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRepository } from '../../src/core/storage.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { CoreCommand } from '../../src/shared/protocol.js';
import { OperationPhase } from '../../src/core/schema.js';

function memoryChrome() {
  const db = {};
  return {
    db,
    chrome: {
      storage: {
        local: {
          get: async key => ({ [key]: db[key] }),
          set: async record => Object.assign(db, record),
        },
      },
    },
  };
}

test('duplicate session preserves configuration but starts with fresh runtime progress', async () => {
  const { chrome } = memoryChrome();
  const repo = new StorageRepository(chrome);
  let now = 1000;
  const core = new CoreCommandDispatcher(repo, () => now);

  await core.execute(CoreCommand.CREATE_SESSION, {
    config: {
      id: 'source',
      name: 'One pass source',
      runMode: 'one-pass',
      promptMode: 'shared',
      sharedPrompt: 'continue',
      minimumSendIntervalMinutes: 3,
      preSendDelaySeconds: 7,
      busyCheckDelaySeconds: 4,
      retryBackoffSeconds: 45,
      tabStrategy: 'worker',
      tasks: [
        { id: 't1', enabled: true, label: 'First', url: 'https://chatgpt.com/c/first' },
        { id: 't2', enabled: false, label: 'Second', url: 'https://chatgpt.com/c/second' },
      ],
    },
  });

  await repo.update(draft => {
    const source = draft.sessionsById.source;
    source.currentTaskIndex = 1;
    source.nextAllowedSendAt = 9000;
    source.lastActionAt = 3000;
    source.lastSuccessfulSendAt = 2500;
    source.lastError = 'old runtime error';
    source.onePassCompletedTaskIds = ['t1'];
    source.tasksById.t1.status = 'RETRY_WAIT';
    source.tasksById.t1.lastCheckedAt = 2000;
    source.tasksById.t1.lastVerifiedSendAt = 1800;
    source.tasksById.t1.lastVerifiedFingerprint = 'old-fingerprint';
    source.tasksById.t1.retryAfterAt = 8000;
    source.tasksById.t1.manualReviewReason = 'old reason';
    return draft;
  });

  now = 5000;
  const { session: copy } = await core.execute(CoreCommand.DUPLICATE_SESSION, { sessionId: 'source' });

  assert.equal(copy.name, 'One pass source copy');
  assert.equal(copy.runMode, 'one-pass');
  assert.equal(copy.promptMode, 'shared');
  assert.equal(copy.sharedPrompt, 'continue');
  assert.equal(copy.minimumSendIntervalMinutes, 3);
  assert.equal(copy.preSendDelaySeconds, 7);
  assert.equal(copy.busyCheckDelaySeconds, 4);
  assert.equal(copy.retryBackoffSeconds, 45);
  assert.equal(copy.tabStrategy, 'worker');
  assert.deepEqual(copy.tasks.map(task => [task.enabled, task.label, task.url]), [
    [true, 'First', 'https://chatgpt.com/c/first'],
    [false, 'Second', 'https://chatgpt.com/c/second'],
  ]);

  assert.equal(copy.runState, 'STOPPED');
  assert.equal(copy.currentTaskIndex, 0);
  assert.equal(copy.nextAllowedSendAt, 0);
  assert.equal(copy.operation, null);
  assert.equal(copy.lastActionAt, 0);
  assert.equal(copy.lastSuccessfulSendAt, 0);
  assert.equal(copy.lastError, '');
  assert.deepEqual(copy.onePassCompletedTaskIds, []);
  assert.equal(copy.createdAt, 5000);
  assert.equal(copy.updatedAt, 5000);

  assert.notEqual(copy.tasks[0].id, 't1');
  assert.notEqual(copy.tasks[1].id, 't2');
  for (const task of copy.tasks) {
    assert.equal(task.status, 'IDLE');
    assert.equal(task.lastCheckedAt, 0);
    assert.equal(task.lastVerifiedSendAt, 0);
    assert.equal(task.lastVerifiedFingerprint, '');
    assert.equal(task.retryAfterAt, 0);
    assert.equal(task.manualReviewReason, '');
  }

  const source = (await core.execute(CoreCommand.GET_SESSION, { sessionId: 'source' })).session;
  assert.deepEqual(source.onePassCompletedTaskIds, ['t1']);
  assert.equal(source.currentTaskIndex, 1);
  assert.equal(source.lastSuccessfulSendAt, 2500);
});

test('duplicate session cannot erase unresolved uncertain-send evidence', async () => {
  const { chrome } = memoryChrome();
  const repo = new StorageRepository(chrome);
  const core = new CoreCommandDispatcher(repo, () => 5000);

  await core.execute(CoreCommand.CREATE_SESSION, {
    config: {
      id: 'source',
      name: 'Uncertain source',
      promptMode: 'shared',
      sharedPrompt: 'continue',
      tasks: [
        { id: 't1', enabled: true, label: 'Only', url: 'https://chatgpt.com/c/uncertain-copy' },
      ],
    },
  });

  await repo.update(draft => {
    const source = draft.sessionsById.source;
    const task = source.tasksById.t1;
    source.operation = {
      operationId: 'op-uncertain',
      sessionId: 'source',
      taskId: 't1',
      promptFingerprint: 'fp-uncertain',
      promptText: 'continue',
      phase: OperationPhase.AMBIGUOUS,
      targetUrl: task.normalizedUrl,
      createdAt: 2000,
      updatedAt: 3000,
      preSendDeadline: 0,
      submitStartedAt: 2500,
      verificationDeadline: 0,
    };
    task.status = 'SUBMISSION_UNCERTAIN';
    task.retryAfterAt = 30000;
    draft.sendArbiter.lease = {
      ownerSessionId: 'source',
      operationId: 'op-uncertain',
      acquiredAt: 2500,
      expiresAt: 60000,
    };
    return draft;
  });

  await assert.rejects(
    () => core.execute(CoreCommand.DUPLICATE_SESSION, { sessionId: 'source' }),
    /Resolve the uncertain send operation before duplicating/,
  );

  const after = await repo.load();
  assert.deepEqual(after.sessionOrder, ['source'], 'no fresh Session may be created by discarding unresolved evidence');
  assert.equal(after.sessionsById.source.operation.operationId, 'op-uncertain');
  assert.equal(after.sessionsById.source.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(after.sessionsById.source.tasksById.t1.status, 'SUBMISSION_UNCERTAIN');
  assert.equal(after.sessionsById.source.tasksById.t1.retryAfterAt, 30000);
  assert.equal(after.sendArbiter.lease.operationId, 'op-uncertain');
});
