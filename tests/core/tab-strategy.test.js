import test from 'node:test';
import assert from 'node:assert/strict';

import { TabStrategy, createEmptyState, createSession, createTask } from '../../src/core/schema.js';
import { resolveTaskTab } from '../../src/core/tabs.js';

function fakeChrome() {
  const tabs = [];
  let nextId = 0;
  let creates = 0;
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
          Object.assign(tab, changes);
          return structuredClone(tab);
        },
      },
    },
    creates: () => creates,
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
