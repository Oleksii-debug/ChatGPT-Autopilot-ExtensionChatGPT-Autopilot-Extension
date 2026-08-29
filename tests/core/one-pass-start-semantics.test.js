import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRepository } from '../../src/core/storage.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { selectNextTask } from '../../src/core/scheduler.js';
import { CoreCommand } from '../../src/shared/protocol.js';

function memoryChrome() {
  const db = {};
  return {
    storage: {
      local: {
        get: async key => ({ [key]: db[key] }),
        set: async record => Object.assign(db, record),
      },
    },
  };
}

test('Start begins a fresh one-pass run while Resume preserves in-pass progress', async () => {
  const repo = new StorageRepository(memoryChrome());
  let now = 1000;
  const core = new CoreCommandDispatcher(repo, () => now);

  await core.execute(CoreCommand.CREATE_SESSION, {
    config: {
      id: 'one-pass',
      name: 'One pass',
      runMode: 'one-pass',
      sharedPrompt: 'continue',
      tasks: [
        { id: 't1', enabled: true, url: 'https://chatgpt.com/c/one' },
        { id: 't2', enabled: true, url: 'https://chatgpt.com/c/two' },
      ],
    },
  });

  await repo.update(draft => {
    const session = draft.sessionsById['one-pass'];
    session.onePassCompletedTaskIds = ['t1', 't2'];
    session.currentTaskIndex = 0;
    return draft;
  });

  now = 2000;
  const started = (await core.execute(CoreCommand.START_SESSION, { sessionId: 'one-pass' })).session;
  assert.equal(started.runState, 'RUNNING');
  assert.deepEqual(started.onePassCompletedTaskIds, []);

  let state = await repo.load();
  assert.equal(selectNextTask(state.sessionsById['one-pass'], now).task.id, 't1');

  await repo.update(draft => {
    const session = draft.sessionsById['one-pass'];
    session.onePassCompletedTaskIds = ['t1'];
    session.currentTaskIndex = 1;
    return draft;
  });

  now = 3000;
  await core.execute(CoreCommand.PAUSE_SESSION, { sessionId: 'one-pass' });
  now = 4000;
  const resumed = (await core.execute(CoreCommand.RESUME_SESSION, { sessionId: 'one-pass' })).session;
  assert.deepEqual(resumed.onePassCompletedTaskIds, ['t1']);

  state = await repo.load();
  assert.equal(selectNextTask(state.sessionsById['one-pass'], now).task.id, 't2');
});
