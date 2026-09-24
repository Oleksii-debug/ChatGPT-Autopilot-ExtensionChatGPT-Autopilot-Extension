import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createChromeDeterministicWebStoreV1,
  createChromeDeterministicWebTransportV1,
} from '../src/core/deterministic-web-chrome-runtime.js';

function chromeFixture() {
  const storage = {};
  const calls = [];
  return {
    storage,
    calls,
    chrome: {
      storage: { local: {
        async get(key) { return key in storage ? { [key]: structuredClone(storage[key]) } : {}; },
        async set(record) { Object.assign(storage, structuredClone(record)); },
      } },
      tabs: {
        async get(id) { return { id, url: 'https://example.test/start' }; },
        async update(id, update) { calls.push(['navigate', id, update]); return { id, ...update }; },
      },
      scripting: {
        async executeScript(request) {
          calls.push(['script', request.target.tabId, request.args || []]);
          if ((request.args || [])[0] === 'CLICK') return [{ result: { ok: true } }];
          return [{ result: { url: 'https://example.test/start', visibleSelectors: ['#ready'] } }];
        },
      },
    },
  };
}

test('durable store serializes competing updates without losing target ownership', async () => {
  const fixture = chromeFixture();
  const store = createChromeDeterministicWebStoreV1(fixture.chrome);
  await Promise.all([
    store.update(async draft => { await Promise.resolve(); draft.leasesByTargetId['tab:1'] = { leaseId: 'a' }; }),
    store.update(draft => { draft.effectsById.effectB = { state: 'prepared' }; }),
  ]);
  const saved = fixture.storage['autopilot.deterministicWebRuntime.v1'];
  assert.equal(saved.leasesByTargetId['tab:1'].leaseId, 'a');
  assert.equal(saved.effectsById.effectB.state, 'prepared');
});

test('Chrome transport binds navigation and scripted actions to exact tab target', async () => {
  const fixture = chromeFixture();
  const transport = createChromeDeterministicWebTransportV1(fixture.chrome);
  await transport.execute({ targetId: 'tab:7', action: { kind: 'NAVIGATE', url: 'https://example.test/next' } });
  await transport.execute({ targetId: 'tab:7', action: { kind: 'CLICK', selector: '#go' } });
  const observation = await transport.observe({ targetId: 'tab:7' });
  assert.deepEqual(fixture.calls[0], ['navigate', 7, { url: 'https://example.test/next' }]);
  assert.deepEqual(fixture.calls[1], ['script', 7, ['CLICK', '#go', '']]);
  assert.equal(observation.url, 'https://example.test/start');
  assert.deepEqual(observation.visibleSelectors, ['#ready']);
});

test('Chrome transport rejects ambiguous/non-tab target identities', async () => {
  const fixture = chromeFixture();
  const transport = createChromeDeterministicWebTransportV1(fixture.chrome);
  await assert.rejects(() => transport.observe({ targetId: 'window:7' }), /tab:<id>/);
});
