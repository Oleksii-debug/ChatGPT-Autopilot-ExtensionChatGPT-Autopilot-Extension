import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(fs.readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

test('manifest wires the options UI and ChatGPT content scripts with bounded permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.options_ui.page, 'src/ui/options.html');
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'storage', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['https://chatgpt.com/*'],
    js: ['src/interaction/chatgpt-adapter.js', 'src/interaction/content-script.js'],
    run_at: 'document_idle',
  }]);
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
