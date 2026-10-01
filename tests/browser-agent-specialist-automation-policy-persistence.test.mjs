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

test('Specialist automation policy persists only the execution gate in the existing BrowserAgent store', async () => {
  const { data, chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.setSpecialistAutomationPolicy({
    expectedRevision: 0,
    enabled: true,
  });
  assert.equal(created.policy.revision, 1);
  assert.equal(created.policy.enabled, true);
  assert.equal(Object.hasOwn(created.policy, 'maxConcurrentHandoffs'), false);
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1']);

  const restarted = managerFor(chrome);
  const state = await restarted.getSpecialistAutomationPolicy();
  assert.equal(state.quarantined, false);
  assert.equal(state.revision, 1);
  assert.equal(state.policy.enabled, true);
  assert.equal(Object.hasOwn(state.policy, 'maxConcurrentHandoffs'), false);
});

test('Specialist automation gate uses serialized CAS and durable clear tombstone', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: T0 };
  const manager = managerFor(chrome, () => clock.value);
  await manager.setSpecialistAutomationPolicy({
    expectedRevision: 0,
    enabled: true,
  });
  clock.value += 1000;

  const first = manager.setSpecialistAutomationPolicy({
    expectedRevision: 1,
    enabled: false,
  });
  const second = manager.setSpecialistAutomationPolicy({
    expectedRevision: 1,
    enabled: true,
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
    }),
    /revision drifted/,
  );
  const recreated = await manager.setSpecialistAutomationPolicy({
    expectedRevision: 3,
    enabled: false,
  });
  assert.equal(recreated.policy.revision, 4);
});

test('legacy numeric automation capacity migrates to gate-only policy without granting capacity authority', async () => {
  const { data, chrome } = chromeStorage();
  const manager = managerFor(chrome);
  await manager.setSpecialistAutomationPolicy({
    expectedRevision: 0,
    enabled: true,
  });
  data.autopilotBrowserAgentV1.specialistAutomationPolicy.maxConcurrentHandoffs = 2;

  const restarted = managerFor(chrome);
  const state = await restarted.getSpecialistAutomationPolicy();
  assert.equal(state.quarantined, false);
  assert.equal(state.revision, 1);
  assert.equal(state.policy.enabled, true);
  assert.equal(Object.hasOwn(state.policy, 'maxConcurrentHandoffs'), false);

  const claim = await restarted.claimSpecialistHandoffsAcrossJobsFromAutomationPolicy();
  assert.equal(claim.ownerMaxConcurrentAgents, 0);
  assert.equal(claim.maxConcurrentHandoffs, 0);
  assert.deepEqual(claim.claimed, []);
});

test('automation-gate mutation input rejects accessors before asynchronous storage access', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  let reads = 0;
  const request = { expectedRevision: 0 };
  Object.defineProperty(request, 'enabled', {
    enumerable: true,
    get() {
      reads += 1;
      return true;
    },
  });
  await assert.rejects(
    () => manager.setSpecialistAutomationPolicy(request),
    /data property/,
  );
  assert.equal(reads, 0);
  assert.equal((await manager.getSpecialistAutomationPolicy()).policy, null);
});
