import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState, createSession, createTask, TabStrategy } from '../../src/core/schema.js';
import { resolveTaskTab } from '../../src/core/tabs.js';

function makeChrome(initialTabs) {
  const tabs = structuredClone(initialTabs);
  let createCount = 0;

  return {
    api: {
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
          createCount += 1;
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
    createCount: () => createCount,
  };
}

function addSession(state, { id, taskId, url, tabStrategy }) {
  const task = createTask({ id: taskId, url });
  const session = createSession({
    id,
    name: id,
    tasks: [task],
    sharedPrompt: 'continue',
    tabStrategy,
    now: 1,
  });
  state.sessionsById[id] = session;
  state.sessionOrder.push(id);
  return { session, task };
}

test('pre-upgrade stale TASK URL claim does not block exact-tab reuse after the Task URL changed', async () => {
  const state = createEmptyState(0);
  const oldUrl = 'https://chatgpt.com/c/old-task-url';
  const { task: ownerTask } = addSession(state, {
    id: 'owner',
    taskId: 'owner-task',
    url: 'https://chatgpt.com/c/new-task-url',
    tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
  });
  const { task: requesterTask } = addSession(state, {
    id: 'requester',
    taskId: 'requester-task',
    url: oldUrl,
    tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
  });

  state.tabHintsByTaskId[ownerTask.id] = {
    tabId: 21,
    sessionId: 'owner',
    normalizedUrl: oldUrl,
    kind: 'TASK',
    boundAt: 1,
  };

  const chrome = makeChrome([{ id: 21, url: oldUrl, active: false }]);
  const resolved = await resolveTaskTab(chrome.api, state, 'requester', requesterTask);

  assert.equal(resolved.id, 21, 'stale persisted ownership for the old URL must not exclude the reusable exact tab');
  assert.equal(chrome.createCount(), 0, 'restart/upgrade must not turn a stale durable hint into duplicate tab creation');
});

test('current SESSION_WORKER ownership survives Task URL changes so another Session cannot steal the worker tab', async () => {
  const state = createEmptyState(0);
  const workerCurrentUrl = 'https://chatgpt.com/c/worker-next';
  const workerOldUrl = 'https://chatgpt.com/c/worker-previous';
  addSession(state, {
    id: 'worker-owner',
    taskId: 'worker-task',
    url: workerCurrentUrl,
    tabStrategy: TabStrategy.ONE_WORKER_TAB_PER_SESSION,
  });
  const { task: requesterTask } = addSession(state, {
    id: 'requester',
    taskId: 'requester-task',
    url: workerOldUrl,
    tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
  });

  state.tabHintsByTaskId['__session_worker__:worker-owner'] = {
    tabId: 31,
    sessionId: 'worker-owner',
    normalizedUrl: workerOldUrl,
    kind: 'SESSION_WORKER',
    boundAt: 1,
  };

  const chrome = makeChrome([{ id: 31, url: workerOldUrl, active: false }]);
  const resolved = await resolveTaskTab(chrome.api, state, 'requester', requesterTask);

  assert.notEqual(resolved.id, 31, 'a current worker tab remains physically owned by its Session while awaiting navigation');
  assert.equal(chrome.createCount(), 1, 'requester must create its own tab instead of stealing another Session worker');
});

test('pre-upgrade hints from an inactive tab strategy do not reserve tabs after restart', async () => {
  const oldUrl = 'https://chatgpt.com/c/strategy-old';

  {
    const state = createEmptyState(0);
    addSession(state, {
      id: 'former-worker',
      taskId: 'owner-task',
      url: 'https://chatgpt.com/c/current',
      tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
    });
    const { task: requesterTask } = addSession(state, {
      id: 'requester',
      taskId: 'requester-task',
      url: oldUrl,
      tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
    });
    state.tabHintsByTaskId['__session_worker__:former-worker'] = {
      tabId: 41,
      sessionId: 'former-worker',
      normalizedUrl: oldUrl,
      kind: 'SESSION_WORKER',
      boundAt: 1,
    };
    const chrome = makeChrome([{ id: 41, url: oldUrl, active: false }]);
    const resolved = await resolveTaskTab(chrome.api, state, 'requester', requesterTask);
    assert.equal(resolved.id, 41, 'worker hint must stop claiming a tab once its owner is no longer in worker strategy');
    assert.equal(chrome.createCount(), 0);
  }

  {
    const state = createEmptyState(0);
    const { task: ownerTask } = addSession(state, {
      id: 'new-worker',
      taskId: 'owner-task',
      url: oldUrl,
      tabStrategy: TabStrategy.ONE_WORKER_TAB_PER_SESSION,
    });
    const { task: requesterTask } = addSession(state, {
      id: 'requester',
      taskId: 'requester-task',
      url: oldUrl,
      tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
    });
    state.tabHintsByTaskId[ownerTask.id] = {
      tabId: 51,
      sessionId: 'new-worker',
      normalizedUrl: oldUrl,
      kind: 'TASK',
      boundAt: 1,
    };
    const chrome = makeChrome([{ id: 51, url: oldUrl, active: false }]);
    const resolved = await resolveTaskTab(chrome.api, state, 'requester', requesterTask);
    assert.equal(resolved.id, 51, 'per-Task hint must stop claiming a tab once its owner enters worker strategy');
    assert.equal(chrome.createCount(), 0);
  }
});
