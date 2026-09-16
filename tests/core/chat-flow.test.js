import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaskTab } from '../../src/core/tabs.js';

const OLD_URL = 'https://chatgpt.com/c/old-chat';
const NEW_URL = 'https://chatgpt.com/c/new-chat';
const ROOT_URL = 'https://chatgpt.com/';

function makeState({ mode, count, everyN = 2, continueCount = 2, taskCount = 1 } = {}) {
  const sessionId = 's1';
  const tasksById = {};
  for (let index = 1; index <= taskCount; index += 1) {
    const taskId = `t${index}`;
    tasksById[taskId] = {
      id: taskId,
      url: index === 1 ? OLD_URL : `https://chatgpt.com/c/task-${index}`,
      normalizedUrl: index === 1 ? OLD_URL : `https://chatgpt.com/c/task-${index}`,
    };
  }
  return {
    profile: {
      promptCadenceBySessionId: {
        [sessionId]: {
          enabled: false,
          prompts: [
            { enabled: false, prompt: '', everyN: 10 },
            { enabled: false, prompt: '', everyN: 10 },
            { enabled: false, prompt: '', everyN: 20 },
          ],
          chatFlow: {
            mode,
            newChatEveryN: everyN,
            continuePrompt: 'продовжуй',
            continueCount,
            stage2Prompt: 'другий промт',
            stage2Count: 2,
          },
        },
      },
    },
    sessionsById: {
      [sessionId]: {
        id: sessionId,
        tabStrategy: 'KEEP_TASK_TABS_OPEN',
        cadenceVerifiedSendCount: count,
        tasksById,
      },
    },
    tabHintsByTaskId: {},
  };
}

function fakeChrome(initialUrl = OLD_URL) {
  const tabs = new Map([[1, { id: 1, url: initialUrl, status: 'complete' }]]);
  const calls = [];
  return {
    calls,
    tabs: {
      async get(id) { return structuredClone(tabs.get(id)); },
      async query() { return [...tabs.values()].map(structuredClone); },
      async update(id, change) {
        calls.push(['update', id, change]);
        const current = tabs.get(id);
        const next = { ...current, ...change, status: 'complete' };
        tabs.set(id, next);
        return structuredClone(next);
      },
      async create({ url, active }) {
        calls.push(['create', url, active]);
        const id = Math.max(...tabs.keys(), 0) + 1;
        const tab = { id, url, active, status: 'complete' };
        tabs.set(id, tab);
        return structuredClone(tab);
      },
    },
  };
}

test('same-chat mode remembers one conversation for the whole Session', async () => {
  const state = makeState({ mode: 'same-chat', count: 0, taskCount: 2 });
  const chrome = fakeChrome(OLD_URL);
  const firstTask = state.sessionsById.s1.tasksById.t1;
  const secondTask = state.sessionsById.s1.tasksById.t2;
  const firstTab = await resolveTaskTab(chrome, state, 's1', firstTask);
  const secondTab = await resolveTaskTab(chrome, state, 's1', secondTask);
  assert.equal(firstTab.id, 1);
  assert.equal(secondTab.id, 1);
  assert.equal(firstTask.normalizedUrl, OLD_URL);
  assert.equal(secondTask.normalizedUrl, OLD_URL);
  assert.deepEqual(chrome.calls, []);
  assert.equal(state.tabHintsByTaskId.__chat_flow__s1.tabId, 1);
});

test('chat-flow remembers the same conversation and adopts its current URL', async () => {
  const state = makeState({ mode: 'new-chat-after', count: 1 });
  state.tabHintsByTaskId.__chat_flow__s1 = {
    tabId: 1,
    sessionId: 's1',
    normalizedUrl: OLD_URL,
    kind: 'CHAT_FLOW',
  };
  const chrome = fakeChrome(NEW_URL);
  const task = state.sessionsById.s1.tasksById.t1;
  const tab = await resolveTaskTab(chrome, state, 's1', task);
  assert.equal(tab.id, 1);
  assert.equal(task.normalizedUrl, NEW_URL);
  assert.equal(chrome.calls.length, 0);
});

test('chat-flow uses one remembered Session chat across different tasks', async () => {
  const state = makeState({ mode: 'new-chat-after', count: 1, taskCount: 2 });
  state.tabHintsByTaskId.__chat_flow__s1 = {
    tabId: 1,
    sessionId: 's1',
    normalizedUrl: OLD_URL,
    kind: 'CHAT_FLOW',
  };
  const chrome = fakeChrome(OLD_URL);
  const firstTask = state.sessionsById.s1.tasksById.t1;
  const secondTask = state.sessionsById.s1.tasksById.t2;
  const firstTab = await resolveTaskTab(chrome, state, 's1', firstTask);
  const secondTab = await resolveTaskTab(chrome, state, 's1', secondTask);
  assert.equal(firstTab.id, 1);
  assert.equal(secondTab.id, 1);
  assert.equal(firstTask.normalizedUrl, OLD_URL);
  assert.equal(secondTask.normalizedUrl, OLD_URL);
  assert.deepEqual(chrome.calls, []);
  assert.ok(state.tabHintsByTaskId.__chat_flow__s1);
});

test('new-chat mode rotates to a fresh conversation at the configured send boundary', async () => {
  const state = makeState({ mode: 'new-chat-after', count: 2, everyN: 2 });
  state.tabHintsByTaskId.__chat_flow__s1 = {
    tabId: 1,
    sessionId: 's1',
    normalizedUrl: OLD_URL,
    kind: 'CHAT_FLOW',
  };
  const chrome = fakeChrome(OLD_URL);
  const task = state.sessionsById.s1.tasksById.t1;
  const tab = await resolveTaskTab(chrome, state, 's1', task);
  assert.equal(tab.id, 1);
  assert.equal(task.normalizedUrl, ROOT_URL);
  assert.deepEqual(chrome.calls[0], ['update', 1, { url: ROOT_URL, active: false }]);
});

test('staged mode rotates exactly after the initial prompt plus configured continue prompts', async () => {
  const state = makeState({ mode: 'staged', count: 3, continueCount: 2 });
  state.tabHintsByTaskId.__chat_flow__s1 = {
    tabId: 1,
    sessionId: 's1',
    normalizedUrl: OLD_URL,
    kind: 'CHAT_FLOW',
  };
  const chrome = fakeChrome(OLD_URL);
  const task = state.sessionsById.s1.tasksById.t1;
  await resolveTaskTab(chrome, state, 's1', task);
  assert.equal(task.normalizedUrl, ROOT_URL);
  assert.equal(chrome.calls[0][0], 'update');
});