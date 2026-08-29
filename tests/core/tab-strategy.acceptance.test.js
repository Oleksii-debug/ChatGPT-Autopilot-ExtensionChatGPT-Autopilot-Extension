import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TabStrategy,
  createEmptyState,
  createSession,
  createTask,
} from '../../src/core/schema.js';
import { resolveTaskTab } from '../../src/core/tabs.js';

function makeChrome() {
  const tabs = [];
  let nextId = 100;
  let createCount = 0;

  return {
    api: {
      tabs: {
        async get(id) {
          const tab = tabs.find((item) => item.id === id);
          if (!tab) throw new Error('No tab');
          return structuredClone(tab);
        },
        async query() {
          return structuredClone(tabs);
        },
        async create({ url, active }) {
          createCount += 1;
          const tab = { id: ++nextId, url, active };
          tabs.push(tab);
          return structuredClone(tab);
        },
        async update(id, changes) {
          const tab = tabs.find((item) => item.id === id);
          if (!tab) throw new Error('No tab');
          Object.assign(tab, changes);
          return structuredClone(tab);
        },
      },
    },
    createCount: () => createCount,
  };
}

function stateWithTwoTasks(tabStrategy) {
  const state = createEmptyState(1_000);
  const first = createTask({ id: 'task-1', url: 'https://chatgpt.com/c/one' });
  const second = createTask({ id: 'task-2', url: 'https://chatgpt.com/c/two' });
  const session = createSession({
    id: 'session-1',
    name: 'Tab strategy acceptance',
    tasks: [first, second],
    tabStrategy,
    now: 1_000,
  });
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  return { state, session, first, second };
}

test('KEEP_TASK_TABS_OPEN keeps separate reusable task tabs', async () => {
  const chrome = makeChrome();
  const { state, session, first, second } = stateWithTwoTasks(TabStrategy.KEEP_TASK_TABS_OPEN);

  const firstTab = await resolveTaskTab(chrome.api, state, session.id, first);
  const secondTab = await resolveTaskTab(chrome.api, state, session.id, second);

  assert.notEqual(firstTab.id, secondTab.id);
  assert.equal(chrome.createCount(), 2);

  const firstAgain = await resolveTaskTab(chrome.api, state, session.id, first);
  assert.equal(firstAgain.id, firstTab.id);
  assert.equal(chrome.createCount(), 2, 'revisiting a task must reuse its existing tab');
});

test('ONE_WORKER_TAB_PER_SESSION reuses one session-owned tab across different task URLs', async () => {
  const chrome = makeChrome();
  const { state, session, first, second } = stateWithTwoTasks(TabStrategy.ONE_WORKER_TAB_PER_SESSION);

  const firstTab = await resolveTaskTab(chrome.api, state, session.id, first);
  const secondTab = await resolveTaskTab(chrome.api, state, session.id, second);

  assert.equal(
    secondTab.id,
    firstTab.id,
    'worker-tab mode must navigate/reuse the same session-owned tab instead of creating one tab per task',
  );
  assert.equal(chrome.createCount(), 1, 'worker-tab mode may create at most one worker tab for the session');
  assert.equal(secondTab.url, second.normalizedUrl, 'the reused worker tab must end on the current task URL');
});
