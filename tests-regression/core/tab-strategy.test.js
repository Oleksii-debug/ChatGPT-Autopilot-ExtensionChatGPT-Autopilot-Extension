import test from 'node:test';
import assert from 'node:assert/strict';

import { OperationPhase, TabStrategy, createEmptyState, createSession, createTask } from '../../src/core/schema.js';
import { resolveTaskTab } from '../../src/core/tabs.js';

function fakeChrome() {
  const tabs = [];
  let nextId = 0;
  let creates = 0;
  let updates = 0;
  let removes = 0;
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
        async remove(id) {
          const index = tabs.findIndex(item => item.id === id);
          if (index < 0) throw new Error('No tab');
          tabs.splice(index, 1);
          removes += 1;
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
    removes: () => removes,
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


test('open-close recovery keeps the same owned tab after root launch becomes a new conversation', async () => {
  const chrome = fakeChrome();
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/' });
  const session = createSession({
    id: 's1',
    name: 'root launch recovery',
    tasks: [task],
    tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK,
    now: 1,
  });
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');

  const original = await resolveTaskTab(chrome.api, state, 's1', task);
  session.operation = { taskId: task.id, phase: OperationPhase.AMBIGUOUS, submitStartedAt: 1000 };
  chrome.setUrl(original.id, 'https://chatgpt.com/c/generated-after-send');

  const recovered = await resolveTaskTab(chrome.api, state, 's1', task);

  assert.equal(recovered.id, original.id);
  assert.equal(recovered.url, 'https://chatgpt.com/c/generated-after-send');
  assert.equal(chrome.creates(), 1);
  assert.equal(chrome.tabs().length, 1);
});


test('managed coordinator re-adopts exact conversation after hint loss instead of opening duplicate tab', async () => {
  const chrome = fakeChrome();
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/coordinator-existing' });
  const session = createSession({
    id: 's1',
    name: 'managed coordinator',
    tasks: [task],
    tabStrategy: TabStrategy.ONE_WORKER_TAB_PER_SESSION,
    now: 1,
  });
  session.orchestrationCoordinator = { managed: true, projectId: 'proj', generation: 1 };
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');

  const existing = await chrome.api.tabs.create({ url: task.normalizedUrl, active: false });
  const createsBefore = chrome.creates();
  const resolved = await resolveTaskTab(chrome.api, state, 's1', task);

  assert.equal(resolved.id, existing.id);
  assert.equal(chrome.creates(), createsBefore, 'must not create a second coordinator tab');
});

test('worker shared-root cycles reuse one owned tab after each verified / -> /c transition', async () => {
  const chrome = fakeChrome();
  const state = createEmptyState(1);
  const tasks = Array.from({ length: 100 }, (_, index) => createTask({
    id: `root-${index + 1}`,
    url: 'https://chatgpt.com/',
  }));
  const session = createSession({
    id: 's1',
    name: '100 root worker cycles',
    tasks,
    tabStrategy: TabStrategy.ONE_WORKER_TAB_PER_SESSION,
    now: 1,
  });
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');

  let workerId = null;
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const tab = await resolveTaskTab(chrome.api, state, 's1', task);
    workerId ??= tab.id;
    assert.equal(tab.id, workerId, `cycle ${index + 1} must reuse the same worker tab`);
    assert.equal(tab.url, task.normalizedUrl, `cycle ${index + 1} must navigate back to the root launch surface`);

    // Model the real ChatGPT first-message navigation after a verified send.
    chrome.setUrl(workerId, `https://chatgpt.com/c/generated-${index + 1}`);
    session.operation = {
      operationId: `op-${index + 1}`,
      sessionId: session.id,
      taskId: task.id,
      promptFingerprint: `fp-${index + 1}`,
      promptText: 'p',
      targetUrl: task.normalizedUrl,
      phase: OperationPhase.SENT_VERIFIED,
      createdAt: index + 1,
      updatedAt: index + 1,
      preSendDeadline: 0,
      submitStartedAt: index + 1,
      verificationDeadline: 0,
    };
  }

  assert.equal(chrome.creates(), 1);
  assert.equal(chrome.tabs().length, 1);
  assert.equal(chrome.updates(), 99, 'every cycle after the first reuses and navigates the same worker tab');
});

test('open-close ambiguous recovery reuses the original root-owned tab after Task is rebound to concrete conversation', async () => {
  const chrome = fakeChrome();
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/' });
  const session = createSession({
    id: 's1',
    name: 'root-to-conversation ambiguous recovery',
    tasks: [task],
    tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK,
    now: 1,
  });
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');

  const original = await resolveTaskTab(chrome.api, state, 's1', task);
  const generated = 'https://chatgpt.com/c/generated-after-uncertain-send';
  chrome.setUrl(original.id, generated);
  session.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: task.id,
    promptFingerprint: 'fp',
    promptText: 'p',
    launchUrl: 'https://chatgpt.com/',
    targetUrl: generated,
    phase: OperationPhase.AMBIGUOUS,
    createdAt: 1,
    updatedAt: 2,
    preSendDeadline: 0,
    submitStartedAt: 2,
    verificationDeadline: 30_000,
  };
  task.url = generated;
  task.normalizedUrl = generated;

  const recovered = await resolveTaskTab(chrome.api, state, 's1', task);

  assert.equal(recovered.id, original.id, 'recovery must reuse the physical tab that launched the uncertain Send');
  assert.equal(recovered.url, generated);
  assert.equal(chrome.creates(), 1, 'recovery must not create a second tab after root -> /c transition');
  assert.equal(chrome.tabs().length, 1, 'the original extension-owned tab must not become orphaned');
  assert.equal(state.tabHintsByTaskId.t1.tabId, original.id);
  assert.equal(state.tabHintsByTaskId.t1.normalizedUrl, 'https://chatgpt.com/', 'ownership identity keeps the launch surface until operation settles');
});


test('keep-open retires a stale tab it explicitly created before opening a replacement', async () => {
  const chrome = fakeChrome();
  const { state, first } = fixture(TabStrategy.KEEP_TASK_TABS_OPEN);
  const original = await resolveTaskTab(chrome.api, state, 's1', first);
  assert.equal(state.tabHintsByTaskId.t1.ownedByExtension, true);
  chrome.setUrl(original.id, 'https://chatgpt.com/c/unrelated-after-navigation');

  const rebound = await resolveTaskTab(chrome.api, state, 's1', first);

  assert.notEqual(rebound.id, original.id);
  assert.equal(chrome.removes(), 1);
  assert.equal(chrome.tabs().length, 1);
  assert.equal(chrome.tabs()[0].id, rebound.id);
});

test('keep-open never physically closes an adopted user tab when its URL later drifts', async () => {
  const chrome = fakeChrome();
  const { state, first } = fixture(TabStrategy.KEEP_TASK_TABS_OPEN);
  const userTab = chrome.seed(first.normalizedUrl);
  const adopted = await resolveTaskTab(chrome.api, state, 's1', first);
  assert.equal(adopted.id, userTab.id);
  assert.equal(state.tabHintsByTaskId.t1.ownedByExtension, false);
  chrome.setUrl(userTab.id, 'https://chatgpt.com/c/user-moved-elsewhere');

  const replacement = await resolveTaskTab(chrome.api, state, 's1', first);

  assert.notEqual(replacement.id, userTab.id);
  assert.equal(chrome.removes(), 0);
  assert.equal(chrome.tabs().some(tab => tab.id === userTab.id), true);
  assert.equal(state.tabHintsByTaskId.t1.ownedByExtension, true);
});
