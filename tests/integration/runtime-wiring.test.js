import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { STORAGE_KEY, createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

test('manifest wires the options UI and ChatGPT content scripts with bounded permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.options_ui.page, 'src/ui/options.html');
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'scripting', 'storage', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['https://chatgpt.com/*'],
    js: ['src/interaction/chatgpt-adapter.js', 'src/interaction/content-script.js'],
    run_at: 'document_idle',
  }]);
  assert.equal(manifest.commands, undefined, 'no extension-specific global shortcuts are assigned');
});

test('content script ignores unrelated messages and returns structured adapter results', async () => {
  const source = fs.readFileSync(new URL('../../src/interaction/content-script.js', import.meta.url), 'utf8');
  let listener;
  const sandbox = {
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } },
    ChatGPTInteractionAdapter: {
      async execute(request) { return { status: 'READY', requestId: request.requestId }; },
    },
    Promise,
  };
  vm.runInNewContext(source, sandbox);
  assert.equal(typeof listener, 'function');
  assert.equal(listener({ channel: 'unrelated' }, {}, () => {}), false);
  const response = await new Promise((resolve) => {
    const keepAlive = listener({ channel: 'autopilot-interaction', request: { requestId: 'op-1' } }, {}, resolve);
    assert.equal(keepAlive, true);
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'READY');
  assert.equal(response.data.requestId, 'op-1');
});

test('content script sanitizes adapter failures', async () => {
  const source = fs.readFileSync(new URL('../../src/interaction/content-script.js', import.meta.url), 'utf8');
  let listener;
  const sandbox = {
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } },
    ChatGPTInteractionAdapter: {
      async execute() { throw new Error('cookie=synthetic-secret'); },
    },
    Promise,
  };
  vm.runInNewContext(source, sandbox);
  const response = await new Promise((resolve) => {
    listener({ channel: 'autopilot-interaction', request: {} }, {}, resolve);
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'INTERACTION_FAILED_SAFE');
  assert.equal(JSON.stringify(response).includes('synthetic-secret'), false);
});

test('service worker registers UI, lifecycle, alarm and action listeners', async () => {
  const listeners = {};
  const db = {};
  const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(db[key]) }; },
        async set(record) { Object.assign(db, structuredClone(record)); },
      },
    },
    alarms: {
      async clear() {},
      async create() {},
      onAlarm: event('alarm'),
    },
    runtime: {
      onInstalled: event('installed'),
      onStartup: event('startup'),
      onMessage: event('message'),
      async openOptionsPage() {},
    },
    action: { onClicked: event('action') },
  };
  try {
    await import(`../../src/background/service-worker.js?test=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(Object.keys(listeners).sort(), ['action', 'alarm', 'installed', 'message', 'startup']);
    assert.equal(listeners.message({ channel: 'unrelated' }, {}, () => {}), false);
  } finally {
    delete globalThis.chrome;
  }
});

test('transient cold-start failure is retried once a wake event reaches the same live worker', async () => {
  const listeners = {};
  const db = {};
  let clearAttempts = 0;
  const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(db[key]) }; },
        async set(record) { Object.assign(db, structuredClone(record)); },
      },
    },
    alarms: {
      async clear() {
        clearAttempts += 1;
        if (clearAttempts === 1) throw new Error('synthetic transient alarm failure');
        return true;
      },
      async create() {},
      onAlarm: event('alarm'),
    },
    runtime: {
      onInstalled: event('installed'),
      onStartup: event('startup'),
      onMessage: event('message'),
      async openOptionsPage() {},
    },
    action: { onClicked: event('action') },
  };

  try {
    await import(`../../src/background/service-worker.js?cold-start-retry=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clearAttempts, 1, 'module-load reconciliation should fail exactly once in this fixture');

    listeners.startup();
    listeners.alarm({ name: 'autopilot-core-wake' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      clearAttempts,
      3,
      'simultaneous wake events must share one retry reconciliation, then one normal runtime alarm reconciliation',
    );
  } finally {
    delete globalThis.chrome;
  }
});

test('enabled cold wake reconciles durable submission state and coalesces simultaneous startup/alarm cycles', async () => {
  const retryAt = Date.now() + 60_000;
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/cold-wake' });
  task.retryAfterAt = retryAt;
  const session = createSession({ id: 's1', name: 'Cold wake', tasks: [task], sharedPrompt: 'continue', now: 1 });
  session.runState = RunState.RUNNING;
  session.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp1',
    promptText: 'continue',
    phase: OperationPhase.SUBMITTING,
    targetUrl: task.normalizedUrl,
    createdAt: 1,
    updatedAt: 1,
    preSendDeadline: 0,
    submitStartedAt: 2,
    verificationDeadline: 0,
  };
  const initial = createEmptyState(1);
  initial.sessionsById.s1 = session;
  initial.sessionOrder = ['s1'];

  const listeners = {};
  const alarmCalls = [];
  const statusMessages = [];
  const db = { [STORAGE_KEY]: structuredClone(initial) };
  const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(db[key]) }; },
        async set(record) { Object.assign(db, structuredClone(record)); },
      },
    },
    alarms: {
      async clear(name) { alarmCalls.push(['clear', name]); return true; },
      async create(name, options) { alarmCalls.push(['create', name, options.when]); },
      onAlarm: event('alarm'),
    },
    runtime: {
      onInstalled: event('installed'),
      onStartup: event('startup'),
      onMessage: event('message'),
      async sendMessage(message) { statusMessages.push(message); },
      async openOptionsPage() {},
    },
    action: { onClicked: event('action') },
  };

  try {
    const worker = await import(`../../src/background/service-worker.js?cold-wake-enabled=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));

    const recovered = db[STORAGE_KEY].sessionsById.s1;
    assert.equal(recovered.operation.phase, OperationPhase.AMBIGUOUS);
    assert.equal(recovered.runState, RunState.RECOVERING);
    assert.notEqual(recovered.pausedByRuntimeGate, true);

    const direct = await worker.runExecutionCycle();
    assert.equal(direct.outcomes.length, 1);
    assert.equal(direct.outcomes[0].sessionId, 's1');
    assert.equal(direct.outcomes[0].result.kind, 'WAIT_RECOVERY');

    alarmCalls.length = 0;
    statusMessages.length = 0;
    listeners.startup();
    listeners.alarm({ name: 'autopilot-core-wake' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      alarmCalls,
      [['create', 'autopilot-core-wake', retryAt]],
      'simultaneous startup/alarm wake events must share one enabled in-flight runtime cycle',
    );
    assert.deepEqual(statusMessages, [{
      channel: 'autopilot-core',
      type: 'STATUS_CHANGED',
      sessionId: 's1',
    }]);
  } finally {
    delete globalThis.chrome;
  }
});
