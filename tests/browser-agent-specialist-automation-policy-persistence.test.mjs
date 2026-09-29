import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';

const T0 = Date.parse('2026-09-29T04:40:00.000Z');

function chromeStorage() {
  const data = Object.create(null);
  return {
    data,
    chrome: {
      storage: { local: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(record) {
          for (const [key, value] of Object.entries(record)) data[key] = structuredClone(value);
        },
      } },
      alarms: { async create() {}, async clear() { return true; } },
    },
  };
}

function managerFor(chrome, now = () => T0) {
  return new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now,
  });
}

test('product-wide Specialist automation policy persists in the existing BrowserAgent store', async () => {
  const { data, chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.setSpecialistAutomationPolicy({
    expectedRevision: 0,
    enabled: true,
    maxConcurrentHandoffs: 3,
  });
  assert.equal(created.policy.revision, 1);
  assert.equal(created.policy.maxConcurrentHandoffs, 3);
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1']);

  const restarted = managerFor(chrome);
  const state = await restarted.getSpecialistAutomationPolicy();
  assert.equal(state.quarantined, false);
  assert.equal(state.revision, 1);
  assert.equal(state.policy.enabled, true);
  assert.equal(state.policy.maxConcurrentHandoffs, 3);
});

test('Specialist automation policy uses serialized CAS and durable clear tombstone', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: T0 };
  const manager = managerFor(chrome, () => clock.value);
  await manager.setSpecialistAutomationPolicy({
    expectedRevision: 0,
    enabled: true,
    maxConcurrentHandoffs: 2,
  });
  clock.value += 1000;

  const first = manager.setSpecialistAutomationPolicy({
    expectedRevision: 1,
    enabled: true,
    maxConcurrentHandoffs: 4,
  });
  const second = manager.setSpecialistAutomationPolicy({
    expectedRevision: 1,
    enabled: true,
    maxConcurrentHandoffs: 5,
  });
  const settled = await Promise.allSettled([first, second]);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
  assert.match(String(settled.find(item => item.status === 'rejected').reason), /revision drifted/);

  clock.value += 1000;
  const cleared = await manager.clearSpecialistAutomationPolicy({ expectedRevision: 2 });
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.revision, 3);
  assert.equal((await manager.getSpecialistAutomationPolicy()).policy, null);

  await assert.rejects(
    () => manager.setSpecialistAutomationPolicy({
      expectedRevision: 0,
      enabled: true,
      maxConcurrentHandoffs: 1,
    }),
    /revision drifted/,
  );
  const recreated = await manager.setSpecialistAutomationPolicy({
    expectedRevision: 3,
    enabled: false,
    maxConcurrentHandoffs: 0,
  });
  assert.equal(recreated.policy.revision, 4);
});

test('corrupt persisted Specialist automation policy is quarantined fail-closed', async () => {
  const { data, chrome } = chromeStorage();
  const manager = managerFor(chrome);
  await manager.setSpecialistAutomationPolicy({
    expectedRevision: 0,
    enabled: true,
    maxConcurrentHandoffs: 2,
  });
  data.autopilotBrowserAgentV1.specialistAutomationPolicy.maxConcurrentHandoffs = 999;

  const restarted = managerFor(chrome);
  const state = await restarted.getSpecialistAutomationPolicy();
  assert.equal(state.policy, null);
  assert.equal(state.quarantined, true);
  assert.equal(state.revision, 1);
  await assert.rejects(
    () => restarted.setSpecialistAutomationPolicy({
      expectedRevision: 1,
      enabled: true,
      maxConcurrentHandoffs: 1,
    }),
    /quarantined as corrupt/,
  );
});

test('policy mutation input rejects accessors before asynchronous storage access', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  let reads = 0;
  const request = {
    expectedRevision: 0,
    enabled: true,
    maxConcurrentHandoffs: 1,
  };
  Object.defineProperty(request, 'maxConcurrentHandoffs', {
    enumerable: true,
    get() {
      reads += 1;
      return 256;
    },
  });
  await assert.rejects(
    () => manager.setSpecialistAutomationPolicy(request),
    /data property/,
  );
  assert.equal(reads, 0);
  assert.equal((await manager.getSpecialistAutomationPolicy()).policy, null);
});
