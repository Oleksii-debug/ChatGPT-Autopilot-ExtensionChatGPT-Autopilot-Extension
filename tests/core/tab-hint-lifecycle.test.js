import test from 'node:test';
import assert from 'node:assert/strict';

import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { createSession, createTask, TabStrategy } from '../../src/core/schema.js';
import { StorageRepository } from '../../src/core/storage.js';
import { resolveTaskTab } from '../../src/core/tabs.js';
import { CoreCommand } from '../../src/shared/protocol.js';

function fakeChrome() {
  const db = {};
  const tabs = [];
  let creates = 0;

  return {
    api: {
      storage: {
        local: {
          async get(key) {
            return { [key]: db[key] === undefined ? undefined : structuredClone(db[key]) };
          },
          async set(record) {
            for (const [key, value] of Object.entries(record)) db[key] = structuredClone(value);
          },
        },
      },
      tabs: {
        async get(id) {
          const tab = tabs.find(item => item.id === id);
          if (!tab) throw new Error('No tab');
          return structuredClone(tab);
        },
        async query() {
          return structuredClone(tabs);
        },
        async create({ url, active }) {
          creates += 1;
          const id = Math.max(0, ...tabs.map(item => item.id)) + 1;
          const tab = { id, url, active };
          tabs.push(tab);
          return structuredClone(tab);
        },
        async update(id, changes) {
          const tab = tabs.find(item => item.id === id);
          if (!tab) throw new Error('No tab');
          Object.assign(tab, changes);
          return structuredClone(tab);
        },
      },
    },
    seedTab(id, url) {
      tabs.push({ id, url, active: false });
    },
    creates: () => creates,
  };
}

test('removing a Task prunes only its tab hint so another Session can reuse the open exact URL', async () => {
  const chrome = fakeChrome();
  const repo = new StorageRepository(chrome.api);
  const core = new CoreCommandDispatcher(repo, () => 1_000);

  const removed = createTask({ id: 'removed', url: 'https://chatgpt.com/c/reusable' });
  const retained = createTask({ id: 'retained', url: 'https://chatgpt.com/c/retained' });
  const first = createSession({
    id: 's1',
    name: 'First',
    tasks: [removed, retained],
    sharedPrompt: 'continue',
    tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
    now: 100,
  });

  await repo.update(state => {
    state.sessionsById.s1 = first;
    state.sessionOrder.push('s1');
    state.tabHintsByTaskId.removed = {
      tabId: 41,
      sessionId: 's1',
      normalizedUrl: removed.normalizedUrl,
      kind: 'TASK',
      boundAt: 100,
    };
    state.tabHintsByTaskId.retained = {
      tabId: 42,
      sessionId: 's1',
      normalizedUrl: retained.normalizedUrl,
      kind: 'TASK',
      boundAt: 100,
    };
    state.tabHintsByTaskId['__session_worker__:s1'] = {
      tabId: 43,
      sessionId: 's1',
      normalizedUrl: retained.normalizedUrl,
      kind: 'SESSION_WORKER',
      boundAt: 100,
    };
    return state;
  });

  chrome.seedTab(41, removed.normalizedUrl);
  chrome.seedTab(42, retained.normalizedUrl);
  chrome.seedTab(43, retained.normalizedUrl);

  await core.execute(CoreCommand.UPDATE_SESSION, {
    sessionId: 's1',
    expectedVersion: 0,
    config: {
      id: 's1',
      name: 'First',
      promptMode: 'shared',
      sharedPrompt: 'continue',
      runMode: 'continuous',
      minimumSendIntervalMinutes: 2,
      preSendDelaySeconds: 5,
      busyCheckDelaySeconds: 2,
      retryBackoffSeconds: 30,
      tabStrategy: 'keep-open',
      tasks: [{ id: 'retained', url: retained.url, enabled: true }],
    },
  });

  let state = await repo.load();
  assert.equal(state.tabHintsByTaskId.removed, undefined, 'removed Task must release its tab ownership hint');
  assert.equal(state.tabHintsByTaskId.retained.tabId, 42, 'retained Task hint must remain');
  assert.equal(state.tabHintsByTaskId['__session_worker__:s1'].tabId, 43, 'Session worker hint must not be mistaken for a removed Task hint');

  const secondTask = createTask({ id: 's2-task', url: removed.url });
  const second = createSession({
    id: 's2',
    name: 'Second',
    tasks: [secondTask],
    sharedPrompt: 'continue',
    tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
    now: 1_000,
  });
  await repo.update(draft => {
    draft.sessionsById.s2 = second;
    draft.sessionOrder.push('s2');
    return draft;
  });

  state = await repo.load();
  const resolved = await resolveTaskTab(chrome.api, state, 's2', state.sessionsById.s2.tasksById['s2-task']);

  assert.equal(resolved.id, 41, 'the already-open exact URL must be reusable after the old Task is removed');
  assert.equal(chrome.creates(), 0, 'removing a Task must not leave ownership that forces a duplicate tab');
});
