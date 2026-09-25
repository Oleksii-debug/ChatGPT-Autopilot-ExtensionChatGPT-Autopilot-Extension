import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';

function makeVisionChrome() {
  const storage = {};
  const tabs = new Map([[1, {
    id: 1,
    url: 'https://ais.example.edu/app',
    active: true,
    status: 'complete',
    lastAccessed: 1,
  }]]);
  const alarms = new Map();
  let pageVersion = 1;
  let screenshotCount = 0;
  let mutateOnAttach = false;
  let onCapture = null;

  const chrome = {
    storage: { local: {
      async get(key) { return { [key]: structuredClone(storage[key]) }; },
      async set(values) { Object.assign(storage, structuredClone(values)); },
    } },
    tabs: {
      async query() { return [...tabs.values()].map(tab => structuredClone(tab)); },
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('missing tab');
        return structuredClone(tab);
      },
      async create({ url, active = false }) {
        const id = Math.max(0, ...tabs.keys()) + 1;
        const tab = { id, url, active, status: 'complete', lastAccessed: id };
        tabs.set(id, tab);
        return structuredClone(tab);
      },
      async update(id, patch) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('missing tab');
        Object.assign(tab, patch);
        if (patch.url) {
          tab.status = 'complete';
          pageVersion += 1;
        }
        return structuredClone(tab);
      },
      async remove(id) { tabs.delete(id); },
      async reload() { pageVersion += 1; },
      async goBack() { pageVersion += 1; },
    },
    permissions: {
      async contains() { return true; },
    },
    alarms: {
      async create(name, info) { alarms.set(name, structuredClone(info)); },
      async clear(name) { alarms.delete(name); return true; },
    },
    scripting: {
      async executeScript(details) {
        const name = details.func?.name || '';
        if (name === 'snapshotBrowserPage') {
          const tab = tabs.get(details.target.tabId);
          return [{
            frameId: 0,
            result: {
              snapshotId: details.args[0],
              url: tab?.url || '',
              title: 'AIS',
              text: `semantic page ${pageVersion}`,
              elements: [],
              viewport: { width: 1280, height: 720, scrollY: 0, documentHeight: 1600 },
            },
          }];
        }
        if (name === 'probeBrowserCoordinateTarget') {
          const tab = tabs.get(details.target.tabId);
          return [{ frameId: 0, result: {
            url: tab?.url || '',
            viewportWidth: 1280,
            viewportHeight: 720,
            target: {
              tag: 'canvas',
              role: '',
              type: '',
              name: '',
              href: '',
              submitLike: false,
              formAssociated: false,
              editable: false,
              sensitive: false,
              visualOnly: true,
              disabled: false,
            },
          } }];
        }
        if (name === 'verifyBrowserCoordinateTarget') return [{ frameId: 0, result: { ok: true } }];
        throw new Error(`unexpected script ${name}`);
      },
    },
    debugger: {
      async attach() {
        if (mutateOnAttach) {
          mutateOnAttach = false;
          const tab = tabs.get(1);
          tab.url = 'https://ais.example.edu/other';
          tab.status = 'complete';
          pageVersion += 1;
        }
      },
      async sendCommand(_target, method) {
        if (method === 'Page.captureScreenshot') {
          screenshotCount += 1;
          if (typeof onCapture === 'function') await onCapture();
          return { data: 'QUJDREVGRw==' };
        }
        return {};
      },
      async detach() {},
    },
    _tabs: tabs,
    _alarms: alarms,
    mutateOnNextAttach() { mutateOnAttach = true; },
    setOnCapture(fn) { onCapture = fn; },
    screenshotCount() { return screenshotCount; },
  };
  return chrome;
}

function usage(text) {
  return { text, usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, modelCalls: 1 } };
}

test('Browser Agent vision is semantic-first and attaches one screenshot only on the requested next reasoning turn', async () => {
  const chrome = makeVisionChrome();
  const payloads = [];
  const replies = [
    usage(JSON.stringify({ type: 'vision' })),
    usage(JSON.stringify({ type: 'done', summary: 'Visual state understood' })),
  ];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async payload => {
      payloads.push(structuredClone(payload));
      return replies.shift();
    },
    now: (() => { let now = 10_000; return () => ++now; })(),
  });

  await manager.create({ id: 'vision-job', goal: 'Read the visual-only state safely', visionOnDemand: true });
  await manager.start('vision-job', { runInitial: false });

  const first = await manager.cycleOne('vision-job');
  assert.equal(first.kind, 'ACTION');
  assert.equal(first.action.type, 'vision');
  assert.equal(payloads.length, 1);
  assert.equal('imageDataUrl' in payloads[0], false, 'semantic reasoning must happen before vision is requested');
  assert.equal(chrome.screenshotCount(), 0);
  assert.equal((await manager.get('vision-job')).job.runtime.visionPending, true);

  const second = await manager.cycleOne('vision-job');
  assert.equal(second.kind, 'COMPLETED');
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].imageDataUrl, 'data:image/jpeg;base64,QUJDREVGRw==');
  assert.match(payloads[1].prompt, /screenshot from THIS exact reasoning turn is attached/i);
  assert.equal(chrome.screenshotCount(), 1);
  assert.equal((await manager.get('vision-job')).job.runtime.visionPending, false);
});

test('Browser Agent never routes a screenshot paired with a stale semantic page identity', async () => {
  const chrome = makeVisionChrome();
  const payloads = [];
  const replies = [
    usage(JSON.stringify({ type: 'vision' })),
    usage(JSON.stringify({ type: 'done', summary: 'Fresh visual state used' })),
  ];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async payload => {
      payloads.push(structuredClone(payload));
      return replies.shift();
    },
    now: (() => { let now = 20_000; return () => ++now; })(),
  });

  await manager.create({ id: 'vision-job', goal: 'Use vision only on the live page', visionOnDemand: true });
  await manager.start('vision-job', { runInitial: false });
  assert.equal((await manager.cycleOne('vision-job')).action.type, 'vision');

  // Navigation begins after the semantic snapshot but during screenshot
  // acquisition. The old semantic page and new screenshot must never be sent
  // together to the model.
  chrome.mutateOnNextAttach();
  const stale = await manager.cycleOne('vision-job');
  assert.equal(stale.kind, 'VISION_SNAPSHOT_STALE');
  assert.equal(payloads.length, 1, 'stale screenshot cycle must spend no model call');
  let live = await manager.get('vision-job');
  assert.equal(live.job.runtime.visionPending, true, 'vision request remains durable for a fresh retry');
  assert.match(live.job.runtime.lastError, /identity changed/i);

  const retry = await manager.cycleOne('vision-job');
  assert.equal(retry.kind, 'COMPLETED');
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].imageDataUrl, 'data:image/jpeg;base64,QUJDREVGRw==');
  assert.match(payloads[1].prompt, /https:\/\/ais\.example\.edu\/other/);
  live = await manager.get('vision-job');
  assert.equal(live.job.runtime.visionPending, false);
});

test('owner Pause during screenshot capture prevents the post-capture model call', async () => {
  const chrome = makeVisionChrome();
  const payloads = [];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async payload => {
      payloads.push(structuredClone(payload));
      return usage(JSON.stringify({ type: 'vision' }));
    },
    now: (() => { let now = 30_000; return () => ++now; })(),
  });

  await manager.create({ id: 'vision-job', goal: 'Observe visual state', visionOnDemand: true });
  await manager.start('vision-job', { runInitial: false });
  assert.equal((await manager.cycleOne('vision-job')).action.type, 'vision');
  assert.equal(payloads.length, 1);

  chrome.setOnCapture(async () => {
    await manager.pause('vision-job');
    chrome.setOnCapture(null);
  });
  const result = await manager.cycleOne('vision-job');
  assert.equal(result.kind, 'CANCELLED_BY_OWNER');
  assert.equal(payloads.length, 1, 'Pause during capture must prevent another routed model call');
  const live = await manager.get('vision-job');
  assert.equal(live.job.runtime.runState, 'PAUSED');
  assert.equal(live.job.runtime.visionPending, true, 'read-only vision request can remain pending for an explicit Resume');
});

test('owner Stop during screenshot capture prevents the post-capture model call', async () => {
  const chrome = makeVisionChrome();
  const payloads = [];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async payload => {
      payloads.push(structuredClone(payload));
      return usage(JSON.stringify({ type: 'vision' }));
    },
    now: (() => { let now = 40_000; return () => ++now; })(),
  });

  await manager.create({ id: 'vision-job', goal: 'Observe visual state', visionOnDemand: true });
  await manager.start('vision-job', { runInitial: false });
  assert.equal((await manager.cycleOne('vision-job')).action.type, 'vision');

  chrome.setOnCapture(async () => {
    await manager.stop('vision-job');
    chrome.setOnCapture(null);
  });
  const result = await manager.cycleOne('vision-job');
  assert.equal(result.kind, 'CANCELLED_BY_OWNER');
  assert.equal(payloads.length, 1);
  const live = await manager.get('vision-job');
  assert.equal(live.job.runtime.runState, 'STOPPED');
});

test('vision disabled by owner policy cannot create a pending screenshot obligation', async () => {
  const chrome = makeVisionChrome();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => usage(JSON.stringify({ type: 'vision' })),
    now: () => 50_000,
  });

  await manager.create({ id: 'vision-job', goal: 'Do not use screenshots', visionOnDemand: false });
  await manager.start('vision-job', { runInitial: false });
  const result = await manager.cycleOne('vision-job');
  assert.equal(result.kind, 'ACTION_RETRY');
  const live = await manager.get('vision-job');
  assert.equal(live.job.runtime.visionPending, false);
  assert.equal(chrome.screenshotCount(), 0);
});
