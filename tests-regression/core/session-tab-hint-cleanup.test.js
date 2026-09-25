import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { StorageRepository } from '../../src/core/storage.js';
import { CoreCommand } from '../../src/shared/protocol.js';

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

test('UPDATE_SESSION removes stale task tab hints after task deletion or URL change', async () => {
  const { chrome } = memoryChrome();
  const repo = new StorageRepository(chrome);
  const core = new CoreCommandDispatcher(repo, () => 1000);

  const created = await core.execute(CoreCommand.CREATE_SESSION, {
    config: {
      id: 's1',
      name: 'Session',
      tabStrategy: 'keep-open',
      sharedPrompt: 'continue',
      tasks: [
        { id: 't1', url: 'https://chatgpt.com/c/a' },
        { id: 't2', url: 'https://chatgpt.com/c/b' },
        { id: 't3', url: 'https://chatgpt.com/c/c' },
      ],
    },
  });

  await repo.update(state => {
    state.tabHintsByTaskId.t1 = { tabId: 11, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/c/a', kind: 'TASK', boundAt: 10 };
    state.tabHintsByTaskId.t2 = { tabId: 12, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/c/b', kind: 'TASK', boundAt: 10 };
    state.tabHintsByTaskId.t3 = { tabId: 13, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/c/c', kind: 'TASK', boundAt: 10 };
    return state;
  });

  await core.execute(CoreCommand.UPDATE_SESSION, {
    sessionId: 's1',
    expectedVersion: created.session.version,
    config: {
      ...created.session,
      tabStrategy: 'keep-open',
      tasks: [
        { id: 't1', url: 'https://chatgpt.com/c/a' },
        { id: 't2', url: 'https://chatgpt.com/c/b-new' },
      ],
    },
  });

  const { snapshot } = await core.execute(CoreCommand.GET_SNAPSHOT);
  assert.equal(snapshot.tabHintsByTaskId.t1.tabId, 11);
  assert.equal(snapshot.tabHintsByTaskId.t2, undefined);
  assert.equal(snapshot.tabHintsByTaskId.t3, undefined);
});

test('UPDATE_SESSION clears hints that belong to the previous tab strategy', async () => {
  const { chrome } = memoryChrome();
  const repo = new StorageRepository(chrome);
  const core = new CoreCommandDispatcher(repo, () => 2000);

  const created = await core.execute(CoreCommand.CREATE_SESSION, {
    config: {
      id: 's2',
      name: 'Session',
      tabStrategy: 'keep-open',
      sharedPrompt: 'continue',
      tasks: [{ id: 't1', url: 'https://chatgpt.com/c/a' }],
    },
  });

  await repo.update(state => {
    state.tabHintsByTaskId.t1 = { tabId: 21, sessionId: 's2', normalizedUrl: 'https://chatgpt.com/c/a', kind: 'TASK', boundAt: 10 };
    return state;
  });

  const worker = await core.execute(CoreCommand.UPDATE_SESSION, {
    sessionId: 's2',
    expectedVersion: created.session.version,
    config: { ...created.session, tabStrategy: 'worker' },
  });
  let { snapshot } = await core.execute(CoreCommand.GET_SNAPSHOT);
  assert.equal(snapshot.tabHintsByTaskId.t1, undefined);

  await repo.update(state => {
    state.tabHintsByTaskId['__session_worker__:s2'] = {
      tabId: 22,
      sessionId: 's2',
      normalizedUrl: 'https://chatgpt.com/c/a',
      kind: 'SESSION_WORKER',
      boundAt: 20,
    };
    return state;
  });

  await core.execute(CoreCommand.UPDATE_SESSION, {
    sessionId: 's2',
    expectedVersion: worker.session.version,
    config: { ...worker.session, tabStrategy: 'keep-open' },
  });
  ({ snapshot } = await core.execute(CoreCommand.GET_SNAPSHOT));
  assert.equal(snapshot.tabHintsByTaskId['__session_worker__:s2'], undefined);
});
