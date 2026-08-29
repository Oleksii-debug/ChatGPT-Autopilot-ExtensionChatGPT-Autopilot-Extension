import test from 'node:test';
import assert from 'node:assert/strict';

import { TabStrategy, createEmptyState, createSession, createTask } from '../../src/core/schema.js';
import { resolveTaskTab } from '../../src/core/tabs.js';

function fakeChrome() {
  const tabs = [];
  let nextId = 0;
  let creates = 0;
  let updates = 0;
  return {
    api: {
      tabs: {
        async get(id) {
          const tab = tabs.find(item => item.id === id);
          if (!tab) throw new Error('No tab');
          return structuredClone(tab);
        },
        async query() { return structuredClone(tabs); },
        async create({ url, active }) {
          creates += 1;
          const tab = { id: ++nextId, url, active };
          tabs.push(tab);
          return structuredClone(tab);
        },
        async update(id, changes) {
          const tab = tabs.find(item => item.id === id);
          if (!tab) throw new Error('No tab');
          updates += 1;
          Object.assign(tab, changes);
          return structuredClone(tab);
        },
      },
    },
    seed(url, active = false) {
      const tab = { id: ++nextId, url, active };
      tabs.push(tab);
      return structuredClone(tab);
    },
    setUrl(id, url) {
      const tab = tabs.find(item => item.id === id);
      if (!tab) throw new Error('No tab');
      tab.url = url;
    },
    close(id) {
      const index = tabs.findIndex(item => item.id === id);
      if (index >= 0) tabs.splice(index, 1);
    },
    creates: () => creates,
    updates: () => updates,
    tabs: () => structuredClone(tabs),
  };
}

function fixture(strategy) {
  const state = createEmptyState(1);
  const first = createTask({ id: 't1', url: 'https://chatgpt.com/c/one' });
  const second = createTask({ id: 't2', url: 'https://chatgpt.com/c/two' });
  const session = createSession({ id: 's1', name: 'tabs', tasks: [first, second], tabStrategy: strategy, now: 1 });
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return { state, first, second };
}

function manyTaskFixture(strategy, count = 10) {
  const state = createEmptyState(1);
  const tasks = Array.from({ length: count }, (_, index) => createTask({
    id: `t${index + 1}`,
    url: `https://chatgpt.com/c/task-${index + 1}`,
  }));
  const session = createSession({ id: 's1', name: 'many tabs', tasks, tabStrategy: strategy, now: 1 });
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return { state, tasks };
}

test('keep-open strategy preserves one reusable tab per task', async () => {
  const chrome = fakeChrome();
  const { state, first, second } = fixture(TabStrategy.KEEP_TASK_TABS_OPEN);
  const a = await resolveTaskTab(chrome.api, state, 's1', first);
  const b = await resolveTaskTab(chrome.api, state, 's1', second);
  const again = await resolveTaskTab(chrome.api, state, 's1', first);
  assert.notEqual(a.id, b.id);
  assert.equal(again.id, a.id);
  assert.equal(chrome.creates(), 2);
});

test('worker strategy navigates and reuses one session-owned tab', async () => {
  const chrome = fakeChrome();
  const { state, first, second } = fixture(TabStrategy.ONE_WORKER_TAB_PER_SESSION);
  const a = await resolveTaskTab(chrome.api, state, 's1', first);
  const b = await resolveTaskTab(chrome.api, state, 's1', second);
  assert.equal(b.id, a.id);
  assert.equal(b.url, second.normalizedUrl);
  assert.equal(chrome.creates(), 1);
});

test('worker strategy reuses an existing unclaimed exact matching tab', async () => {
  const chrome = fakeChrome();
  const { state, first } = fixture(TabStrategy.ONE_WORKER_TAB_PER_SESSION);
  const existing = chrome.seed(first.normalizedUrl);

  const resolved = await resolveTaskTab(chrome.api, state, 's1', first);

  assert.equal(resolved.id, existing.id);
  assert.equal(chrome.creates(), 0);
  assert.equal(state.tabHintsByTaskId['__session_worker__:s1'].tabId, existing.id);
});

test('persisted worker tabId is only a hint and wrong live URL identity is not navigated', async () => {
  const chrome = fakeChrome();
  const { state, first, second } = fixture(TabStrategy.ONE_WORKER_TAB_PER_SESSION);
  const original = await resolveTaskTab(chrome.api, state, 's1', first);
  chrome.setUrl(original.id, 'https://chatgpt.com/c/unrelated-after-restart');

  const rebound = await resolveTaskTab(chrome.api, state, 's1', second);

  assert.notEqual(rebound.id, original.id);
  assert.equal(rebound.url, second.normalizedUrl);
  assert.equal(chrome.creates(), 2);
  assert.equal(chrome.updates(), 0);
  assert.equal(chrome.tabs().find(tab => tab.id === original.id).url, 'https://chatgpt.com/c/unrelated-after-restart');
});

test('manual close invalidates worker hint and restores only the missing worker tab', async () => {
  const chrome = fakeChrome();
  const { state, first, second } = fixture(TabStrategy.ONE_WORKER_TAB_PER_SESSION);
  const original = await resolveTaskTab(chrome.api, state, 's1', first);
  chrome.close(original.id);

  const restored = await resolveTaskTab(chrome.api, state, 's1', second);

  assert.notEqual(restored.id, original.id);
  assert.equal(restored.url, second.normalizedUrl);
  assert.equal(chrome.creates(), 2);
  assert.equal(chrome.tabs().length, 1);
});

test('worker exact-URL discovery never steals a tab already claimed by another session', async () => {
  const chrome = fakeChrome();
  const state = createEmptyState(1);
  const firstTask = createTask({ id: 's1t1', url: 'https://chatgpt.com/c/shared' });
  const secondTask = createTask({ id: 's2t1', url: 'https://chatgpt.com/c/shared' });
  state.sessionsById.s1 = createSession({
    id: 's1', name: 'first', tasks: [firstTask], tabStrategy: TabStrategy.ONE_WORKER_TAB_PER_SESSION, now: 1,
  });
  state.sessionsById.s2 = createSession({
    id: 's2', name: 'second', tasks: [secondTask], tabStrategy: TabStrategy.ONE_WORKER_TAB_PER_SESSION, now: 1,
  });
  state.sessionOrder.push('s1', 's2');

  const first = await resolveTaskTab(chrome.api, state, 's1', firstTask);
  const second = await resolveTaskTab(chrome.api, state, 's2', secondTask);

  assert.notEqual(first.id, second.id);
  assert.equal(chrome.creates(), 2);
  assert.equal(state.tabHintsByTaskId['__session_worker__:s1'].tabId, first.id);
  assert.equal(state.tabHintsByTaskId['__session_worker__:s2'].tabId, second.id);
});

test('ten keep-open tasks create once and do not create ten new tabs every cycle', async () => {
  const chrome = fakeChrome();
  const { state, tasks } = manyTaskFixture(TabStrategy.KEEP_TASK_TABS_OPEN);
  const firstCycle = [];
  const secondCycle = [];

  for (const task of tasks) firstCycle.push((await resolveTaskTab(chrome.api, state, 's1', task)).id);
  for (const task of tasks) secondCycle.push((await resolveTaskTab(chrome.api, state, 's1', task)).id);

  assert.deepEqual(secondCycle, firstCycle);
  assert.equal(new Set(firstCycle).size, 10);
  assert.equal(chrome.creates(), 10);
});

test('ten worker tasks across repeated cycles stay on one owned tab', async () => {
  const chrome = fakeChrome();
  const { state, tasks } = manyTaskFixture(TabStrategy.ONE_WORKER_TAB_PER_SESSION);
  const ids = [];

  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (const task of tasks) ids.push((await resolveTaskTab(chrome.api, state, 's1', task)).id);
  }

  assert.equal(new Set(ids).size, 1);
  assert.equal(chrome.creates(), 1);
  assert.equal(chrome.tabs().length, 1);
});
