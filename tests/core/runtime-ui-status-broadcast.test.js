import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  createEmptyState,
  createSession,
  createTask,
} from '../../src/core/schema.js';

test('background runtime cycle broadcasts durable Session status without requiring an open UI', async () => {
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/status-broadcast' });
  const session = createSession({
    id: 's1',
    name: 'Status broadcast',
    tasks: [task],
    sharedPrompt: 'continue',
    now: 1,
  });
  const initial = createEmptyState(1);
  initial.sessionsById.s1 = session;
  initial.sessionOrder = ['s1'];
  initial.logs.s1 = [];

  const db = { [STORAGE_KEY]: structuredClone(initial) };
  const statusMessages = [];
  const event = () => ({ addListener() {} });

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(db[key]) }; },
        async set(record) { Object.assign(db, structuredClone(record)); },
      },
    },
    alarms: {
      async clear() { return true; },
      async create() {},
      onAlarm: event(),
    },
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      async sendMessage(message) {
        statusMessages.push(structuredClone(message));
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async openOptionsPage() {},
    },
    action: { onClicked: event() },
  };

  try {
    const worker = await import(`../../src/background/service-worker.js?runtime-ui-status=${Date.now()}`);
    const result = await worker.runExecutionCycle();

    assert.equal(result.state.sessionsById.s1.id, 's1');
    assert.deepEqual(statusMessages, [{
      channel: 'autopilot-core',
      type: 'STATUS_CHANGED',
      sessionId: 's1',
    }]);
  } finally {
    delete globalThis.chrome;
  }
});
