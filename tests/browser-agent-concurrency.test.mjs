import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { BrowserAgentActionType, BrowserAgentRunState } from '../src/core/browser-agent.js';

function makeChromeStorage() {
  const data = Object.create(null);
  return {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(record) { for (const [key, value] of Object.entries(record)) data[key] = structuredClone(value); },
      },
    },
    alarms: {
      async create() {},
      async clear() { return true; },
    },
  };
}

function dueStore(maxConcurrentAgents, ids) {
  return {
    schemaVersion: 1,
    selectedId: ids[0] || '',
    executionPolicy: { maxConcurrentAgents },
    order: [...ids],
    byId: Object.fromEntries(ids.map(id => [id, {
      id,
      runtime: { runState: 'RUNNING', nextWakeAt: 0, retirePendingTabIds: [] },
    }])),
  };
}

test('Browser Agent global concurrency policy persists and rejects noncanonical values', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  assert.deepEqual(await manager.getExecutionPolicy(), { maxConcurrentAgents: 1 });
  assert.deepEqual(await manager.updateExecutionPolicy({ maxConcurrentAgents: 3 }), { maxConcurrentAgents: 3 });

  const restarted = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  assert.deepEqual(await restarted.getExecutionPolicy(), { maxConcurrentAgents: 3 });
  await assert.rejects(() => restarted.updateExecutionPolicy({ maxConcurrentAgents: 0 }), /1 to 32/);
  await assert.rejects(() => restarted.updateExecutionPolicy({ maxConcurrentAgents: 33 }), /1 to 32/);
  await assert.rejects(() => restarted.updateExecutionPolicy({ maxConcurrentAgents: '3' }), /1 to 32/);
  await assert.rejects(() => restarted.updateExecutionPolicy({ maxConcurrentAgents: -0 }), /1 to 32/);
  await assert.rejects(() => restarted.updateExecutionPolicy({ maxConcurrentAgents: 2, surprise: true }), /unknown field/);
});

test('execution policy boundary is zero-getter and supports canonical null-prototype data', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });

  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'maxConcurrentAgents', {
    enumerable: true,
    get() { getterCalls += 1; return 2; },
  });
  await assert.rejects(() => manager.updateExecutionPolicy(hostile), /enumerable data properties/);
  assert.equal(getterCalls, 0);

  const portable = Object.create(null);
  Object.defineProperty(portable, 'maxConcurrentAgents', {
    value: 2,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  assert.deepEqual(await manager.updateExecutionPolicy(portable), { maxConcurrentAgents: 2 });
});

test('execution policy rejects hidden, symbol and exotic fields and corrupt persisted data fails safe to serial', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });

  const hidden = {};
  Object.defineProperty(hidden, 'maxConcurrentAgents', { value: 2, enumerable: false });
  await assert.rejects(() => manager.updateExecutionPolicy(hidden), /enumerable data properties/);

  const symbol = { maxConcurrentAgents: 2 };
  symbol[Symbol('extra')] = 1;
  await assert.rejects(() => manager.updateExecutionPolicy(symbol), /unknown field/);

  class Exotic { constructor() { this.maxConcurrentAgents = 2; } }
  await assert.rejects(() => manager.updateExecutionPolicy(new Exotic()), /plain object/);

  await chrome.storage.local.set({
    autopilotBrowserAgentV1: {
      schemaVersion: 1,
      selectedId: '',
      order: [],
      byId: {},
      executionPolicy: { maxConcurrentAgents: 999 },
    },
  });
  const restarted = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  assert.deepEqual(await restarted.getExecutionPolicy(), { maxConcurrentAgents: 1 });
});

test('cycleAll overlaps independent due top-level Agents only up to the durable global ceiling', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  manager.load = async () => dueStore(2, ['a', 'b', 'c', 'd']);
  manager.reconcileAlarm = async () => 0;

  let active = 0;
  let maxActive = 0;
  const starts = [];
  manager.runBurst = async id => {
    starts.push(id);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active -= 1;
    return { kind: 'BURST', id };
  };

  const result = await manager.cycleAll();
  assert.equal(result.kind, 'CYCLED');
  assert.equal(result.maxConcurrentAgents, 2);
  assert.equal(maxActive, 2);
  assert.deepEqual(starts, ['a', 'b', 'c', 'd']);
  assert.deepEqual(result.results.map(item => item.id), ['a', 'b', 'c', 'd']);
});

test('cycleAll ceiling one preserves serial execution', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  manager.load = async () => dueStore(1, ['a', 'b', 'c']);
  manager.reconcileAlarm = async () => 0;
  let active = 0;
  let maxActive = 0;
  manager.runBurst = async id => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return { kind: 'BURST', id };
  };
  await manager.cycleAll();
  assert.equal(maxActive, 1);
});

test('overlapping cycleAll wake calls coalesce and cannot multiply the global ceiling', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  manager.load = async () => dueStore(2, ['a', 'b', 'c']);
  manager.reconcileAlarm = async () => 0;
  let active = 0;
  let maxActive = 0;
  const calls = new Map();
  manager.runBurst = async id => {
    calls.set(id, (calls.get(id) || 0) + 1);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    return { kind: 'BURST', id };
  };

  const first = manager.cycleAll();
  const second = manager.cycleAll();
  assert.strictEqual(first, second);
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(maxActive, 2);
  assert.deepEqual(Object.fromEntries(calls), { a: 1, b: 1, c: 1 });
});

test('direct runBurst callers share the same product-wide execution ceiling', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  const ids = ['manual-a', 'manual-b', 'manual-c'];
  manager.load = async () => dueStore(2, ids);
  manager.getExecutionPolicy = async () => ({ maxConcurrentAgents: 2 });
  manager.reconcileAlarm = async () => 0;

  let active = 0;
  let maxActive = 0;
  manager.cycleOne = async id => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    return { kind: 'COMPLETED', id };
  };

  await Promise.all(ids.map(id => manager.runBurst(id, { maxCycles: 1 })));
  assert.equal(maxActive, 2);
});

test('a queued direct burst observes a lowered owner concurrency limit before admission', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  const ids = ['a', 'b', 'c'];
  manager.load = async () => dueStore(2, ids);
  let limit = 2;
  manager.getExecutionPolicy = async () => ({ maxConcurrentAgents: limit });
  manager.reconcileAlarm = async () => 0;

  let releaseA;
  let releaseB;
  let startedAResolve;
  let startedBResolve;
  const barrierA = new Promise(resolve => { releaseA = resolve; });
  const barrierB = new Promise(resolve => { releaseB = resolve; });
  const startedA = new Promise(resolve => { startedAResolve = resolve; });
  const startedB = new Promise(resolve => { startedBResolve = resolve; });
  const starts = [];
  manager.cycleOne = async id => {
    starts.push(id);
    if (id === 'a') {
      startedAResolve();
      await barrierA;
    } else if (id === 'b') {
      startedBResolve();
      await barrierB;
    }
    return { kind: 'COMPLETED', id };
  };

  const a = manager.runBurst('a', { maxCycles: 1 });
  const b = manager.runBurst('b', { maxCycles: 1 });
  const c = manager.runBurst('c', { maxCycles: 1 });
  await Promise.all([startedA, startedB]);
  limit = 1;

  releaseB();
  await b;
  assert.deepEqual(starts, ['a', 'b'], 'queued Agent must remain blocked while one active Agent still occupies the lowered limit');

  releaseA();
  await Promise.all([a, c]);
  assert.deepEqual(starts, ['a', 'b', 'c']);
});

test('duplicate direct bursts for one Agent coalesce to one exact execution stream', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  manager.load = async () => dueStore(3, ['same']);
  manager.getExecutionPolicy = async () => ({ maxConcurrentAgents: 3 });
  manager.reconcileAlarm = async () => 0;

  let calls = 0;
  manager.cycleOne = async id => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 15));
    return { kind: 'COMPLETED', id };
  };

  const first = manager.runBurst('same', { maxCycles: 4 });
  const second = manager.runBurst('same', { maxCycles: 4 });
  assert.strictEqual(first, second);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('raising the owner limit wakes queued direct bursts without waiting for an active Agent to finish', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  const ids = ['held', 'queued'];
  let policy = { maxConcurrentAgents: 1 };
  manager.load = async () => dueStore(policy.maxConcurrentAgents, ids);
  manager.getExecutionPolicy = async () => policy;
  manager.reconcileAlarm = async () => 0;
  manager.update = async mutator => {
    const store = dueStore(policy.maxConcurrentAgents, ids);
    const next = await mutator(store) || store;
    policy = next.executionPolicy;
    return next;
  };

  let releaseHeld;
  let heldStartedResolve;
  let queuedStartedResolve;
  const heldBarrier = new Promise(resolve => { releaseHeld = resolve; });
  const heldStarted = new Promise(resolve => { heldStartedResolve = resolve; });
  const queuedStarted = new Promise(resolve => { queuedStartedResolve = resolve; });
  let queuedDidStart = false;
  manager.cycleOne = async id => {
    if (id === 'held') {
      heldStartedResolve();
      await heldBarrier;
    } else {
      queuedDidStart = true;
      queuedStartedResolve();
    }
    return { kind: 'COMPLETED', id };
  };

  const held = manager.runBurst('held', { maxCycles: 1 });
  await heldStarted;
  const queued = manager.runBurst('queued', { maxCycles: 1 });
  await Promise.resolve();
  assert.equal(queuedDidStart, false);

  await manager.updateExecutionPolicy({ maxConcurrentAgents: 2 });
  await queuedStarted;
  assert.equal(queuedDidStart, true);

  releaseHeld();
  await Promise.all([held, queued]);
});

test('queued admission fails closed instead of hanging when policy storage read fails', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  manager.reconcileAlarm = async () => 0;
  manager.get = async id => ({
    selectedId: id,
    job: { id, runtime: { runState: 'RUNNING', nextWakeAt: 0 } },
  });

  let policyReads = 0;
  manager.getExecutionPolicy = async () => {
    policyReads += 1;
    if (policyReads === 3) throw new Error('simulated policy storage read failure');
    return { maxConcurrentAgents: 1 };
  };

  let releaseHeld;
  let heldStartedResolve;
  const heldStarted = new Promise(resolve => { heldStartedResolve = resolve; });
  const heldBarrier = new Promise(resolve => { releaseHeld = resolve; });
  manager.cycleOne = async id => {
    if (id === 'held') {
      heldStartedResolve();
      await heldBarrier;
    }
    return { kind: 'COMPLETED', id };
  };

  const held = manager.runBurst('held', { maxCycles: 1 });
  await heldStarted;
  await assert.rejects(
    manager.runBurst('queued', { maxCycles: 1 }),
    /simulated policy storage read failure/,
  );
  releaseHeld();
  await held;

  manager.getExecutionPolicy = async () => ({ maxConcurrentAgents: 1 });
  const recovered = await manager.runBurst('queued', { maxCycles: 1 });
  assert.equal(recovered.kind, 'BURST');
  assert.equal(recovered.cycles, 1);
});

test('legacy top-level Agents sharing one persisted tab are serialized even when global capacity is higher', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  const store = dueStore(3, ['same-a', 'same-b']);
  store.byId['same-a'].runtime.tabId = 77;
  store.byId['same-b'].runtime.tabId = 77;
  manager.load = async () => structuredClone(store);
  manager.reconcileAlarm = async () => 0;

  let active = 0;
  let maxActive = 0;
  let releaseA;
  let startedAResolve;
  const barrierA = new Promise(resolve => { releaseA = resolve; });
  const startedA = new Promise(resolve => { startedAResolve = resolve; });
  manager.cycleOne = async id => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (id === 'same-a') {
      startedAResolve();
      await barrierA;
    }
    active -= 1;
    return { kind: 'COMPLETED', id };
  };

  const first = manager.runBurst('same-a', { maxCycles: 1 });
  await startedA;
  const second = manager.runBurst('same-b', { maxCycles: 1 });
  await Promise.resolve();
  assert.equal(maxActive, 1);

  releaseA();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
});

test('a shared-target queued Agent does not head-of-line block an unrelated target', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  const store = dueStore(3, ['held', 'conflict', 'independent']);
  store.byId.held.runtime.tabId = 10;
  store.byId.conflict.runtime.tabId = 10;
  store.byId.independent.runtime.tabId = 20;
  manager.load = async () => structuredClone(store);
  manager.reconcileAlarm = async () => 0;

  let releaseHeld;
  let heldStartedResolve;
  let independentStartedResolve;
  const heldBarrier = new Promise(resolve => { releaseHeld = resolve; });
  const heldStarted = new Promise(resolve => { heldStartedResolve = resolve; });
  const independentStarted = new Promise(resolve => { independentStartedResolve = resolve; });
  const starts = [];
  manager.cycleOne = async id => {
    starts.push(id);
    if (id === 'held') {
      heldStartedResolve();
      await heldBarrier;
    }
    if (id === 'independent') independentStartedResolve();
    return { kind: 'COMPLETED', id };
  };

  const held = manager.runBurst('held', { maxCycles: 1 });
  await heldStarted;
  const conflict = manager.runBurst('conflict', { maxCycles: 1 });
  const independent = manager.runBurst('independent', { maxCycles: 1 });
  await independentStarted;

  assert.deepEqual(starts, ['held', 'independent']);
  releaseHeld();
  await Promise.all([held, conflict, independent]);
  assert.deepEqual(starts, ['held', 'independent', 'conflict']);
});

test('concurrent active-tab adoption gives the owner tab to only one Agent and isolates the other', async () => {
  let state = {
    schemaVersion: 1,
    selectedId: 'a',
    executionPolicy: { maxConcurrentAgents: 2 },
    order: ['a', 'b'],
    byId: {
      a: { id: 'a', runtime: { tabId: null, knownTabIds: [], ownedTabIds: [], currentUrl: '', history: [] } },
      b: { id: 'b', runtime: { tabId: null, knownTabIds: [], ownedTabIds: [], currentUrl: '', history: [] } },
    },
  };
  let nextCreatedId = 8;
  const chrome = makeChromeStorage();
  chrome.tabs = {
    async query() { return [{ id: 7, url: 'https://example.test/', active: true, lastAccessed: 10 }]; },
    async get(id) {
      if (id === 7) return { id: 7, url: 'https://example.test/' };
      return { id, url: 'https://example.test/' };
    },
    async create({ url }) { return { id: nextCreatedId++, url }; },
  };

  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  manager.load = async () => structuredClone(state);
  manager.save = async next => {
    state = structuredClone(next);
    return structuredClone(state);
  };
  manager.resolveStartContext = async () => ({
    url: 'https://example.test/',
    tab: { id: 7, url: 'https://example.test/' },
    adopt: true,
  });

  const [tabA, tabB] = await Promise.all([
    manager.ensureTab(structuredClone(state.byId.a)),
    manager.ensureTab(structuredClone(state.byId.b)),
  ]);

  assert.deepEqual(new Set([tabA.id, tabB.id]), new Set([7, 8]));
  assert.notEqual(state.byId.a.runtime.tabId, state.byId.b.runtime.tabId);
  const adopted = state.byId.a.runtime.tabId === 7 ? state.byId.a : state.byId.b;
  const isolated = state.byId.a.runtime.tabId === 8 ? state.byId.a : state.byId.b;
  assert.deepEqual(adopted.runtime.ownedTabIds, []);
  assert.deepEqual(isolated.runtime.ownedTabIds, [8]);
  assert.ok(adopted.runtime.knownTabIds.includes(7));
  assert.ok(isolated.runtime.knownTabIds.includes(8));
});

test('an active Agent cannot switch onto another active Agent current tab', async () => {
  const chrome = makeChromeStorage();
  chrome.tabs = {
    async get(id) {
      if (id === 11) return { id: 11, url: 'https://one.example/', status: 'complete' };
      if (id === 22) return { id: 22, url: 'https://two.example/', status: 'complete' };
      throw new Error('unknown tab');
    },
    async query() { return []; },
  };
  chrome.permissions = {
    async contains() { return true; },
  };

  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  await manager.create({ id: 'owner-a', goal: 'Use tab one' });
  await manager.create({ id: 'owner-b', goal: 'Use tab two' });
  await manager.update(store => {
    const a = store.byId['owner-a'];
    const b = store.byId['owner-b'];
    a.runtime.runState = BrowserAgentRunState.RUNNING;
    a.runtime.controlEpoch = 1;
    a.runtime.tabId = 11;
    a.runtime.knownTabIds = [11];
    a.runtime.currentUrl = 'https://one.example/';
    b.runtime.runState = BrowserAgentRunState.RUNNING;
    b.runtime.controlEpoch = 1;
    b.runtime.tabId = 22;
    b.runtime.knownTabIds = [22, 11];
    b.runtime.currentUrl = 'https://two.example/';
    return store;
  });
  manager.executionSlotActive.add('owner-a');
  manager.executionSlotActive.add('owner-b');

  const current = (await manager.get('owner-b')).job;
  await assert.rejects(
    manager.executeAction(
      current,
      { url: 'https://two.example/' },
      { type: BrowserAgentActionType.SWITCH_TAB, tabId: 11 },
      current.runtime.controlEpoch,
    ),
    /already in use by another active Agent/,
  );
  const after = (await manager.get('owner-b')).job;
  assert.equal(after.runtime.tabId, 22);
  assert.equal(after.runtime.currentUrl, 'https://two.example/');
});

test('saving execution concurrency is independent of Chrome alarm reconciliation', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  manager.reconcileAlarm = async () => { throw new Error('alarm subsystem unavailable'); };

  assert.deepEqual(await manager.updateExecutionPolicy({ maxConcurrentAgents: 4 }), { maxConcurrentAgents: 4 });
  const restarted = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  assert.deepEqual(await restarted.getExecutionPolicy(), { maxConcurrentAgents: 4 });
});

test('closing an owned tab never falls back onto another active Agent current tab', async () => {
  const chrome = makeChromeStorage();
  chrome.tabs = {
    async query() { return []; },
    async get(id) {
      if (id === 11) return { id: 11, url: 'https://one.example/', status: 'complete' };
      if (id === 22) return { id: 22, url: 'https://two.example/', status: 'complete' };
      throw new Error('unknown tab');
    },
    async remove() {},
  };

  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  await manager.create({ id: 'owner-a', goal: 'Use tab one' });
  await manager.create({ id: 'owner-b', goal: 'Use tab two' });
  await manager.update(store => {
    const a = store.byId['owner-a'];
    const b = store.byId['owner-b'];
    a.runtime.runState = BrowserAgentRunState.RUNNING;
    a.runtime.controlEpoch = 1;
    a.runtime.tabId = 11;
    a.runtime.knownTabIds = [11];
    a.runtime.currentUrl = 'https://one.example/';
    b.runtime.runState = BrowserAgentRunState.RUNNING;
    b.runtime.controlEpoch = 1;
    b.runtime.tabId = 22;
    b.runtime.knownTabIds = [22, 11];
    b.runtime.ownedTabIds = [22];
    b.runtime.currentUrl = 'https://two.example/';
    return store;
  });
  manager.executionSlotActive.add('owner-a');
  manager.executionSlotActive.add('owner-b');

  const current = (await manager.get('owner-b')).job;
  const result = await manager.executeAction(
    current,
    { url: 'https://two.example/' },
    { type: BrowserAgentActionType.CLOSE_TAB, tabId: 22 },
    current.runtime.controlEpoch,
  );

  assert.equal(result.kind, 'ACTION');
  assert.equal(result.currentUrl, '');
  const after = (await manager.get('owner-b')).job;
  assert.equal(after.runtime.tabId, null);
  assert.equal(after.runtime.currentUrl, '');
  assert.deepEqual(after.runtime.ownedTabIds, []);
  assert.deepEqual(after.runtime.knownTabIds, [11]);
});

test('manual Step shares the global slot and never overlaps another execution of the same Agent', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  const store = dueStore(2, ['same']);
  manager.load = async () => structuredClone(store);
  manager.reconcileAlarm = async () => 0;

  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  let firstStartedResolve;
  const firstBarrier = new Promise(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise(resolve => { firstStartedResolve = resolve; });
  let calls = 0;
  manager.cycleOne = async id => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) {
      firstStartedResolve();
      await firstBarrier;
    }
    active -= 1;
    return { kind: 'ACTION', id };
  };

  const first = manager.step('same');
  await firstStarted;
  const second = manager.step('same');
  await Promise.resolve();
  assert.equal(calls, 1, 'second Step must wait for the active execution slot');

  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test('manual Step obeys the product-wide limit across different Agents', async () => {
  const chrome = makeChromeStorage();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  const store = dueStore(1, ['a', 'b']);
  manager.load = async () => structuredClone(store);
  manager.reconcileAlarm = async () => 0;

  let active = 0;
  let maxActive = 0;
  manager.cycleOne = async id => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    return { kind: 'ACTION', id };
  };

  await Promise.all([manager.step('a'), manager.step('b')]);
  assert.equal(maxActive, 1);
});

test('approved effects wait for the same global and same-target execution admission', async () => {
  const chrome = makeChromeStorage();
  chrome.tabs = {
    async get(id) {
      if (id === 11) return { id: 11, url: 'https://one.example/', status: 'complete' };
      throw new Error('unknown tab');
    },
    async query() { return []; },
  };

  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  await manager.create({ id: 'active', goal: 'Hold the shared tab' });
  await manager.create({ id: 'approval', goal: 'Execute only after approval' });
  await manager.updateExecutionPolicy({ maxConcurrentAgents: 2 });
  await manager.update(store => {
    const active = store.byId.active;
    const approval = store.byId.approval;
    active.runtime.runState = BrowserAgentRunState.RUNNING;
    active.runtime.controlEpoch = 1;
    active.runtime.tabId = 11;
    active.runtime.knownTabIds = [11];
    active.runtime.currentUrl = 'https://one.example/';

    approval.runtime.runState = BrowserAgentRunState.WAITING_APPROVAL;
    approval.runtime.controlEpoch = 4;
    approval.runtime.tabId = 11;
    approval.runtime.knownTabIds = [11];
    approval.runtime.currentUrl = 'https://one.example/';
    approval.runtime.pendingApproval = {
      action: { type: BrowserAgentActionType.WAIT, seconds: 1 },
      snapshotId: 'snap-approval',
      snapshotSignature: 'sig-approval',
      url: 'https://one.example/',
      tabId: 11,
      targetName: 'bounded wait',
      targetFingerprint: null,
      dragStartFingerprint: null,
      dragEndFingerprint: null,
      reason: 'owner approval required',
      requestedAt: 1,
    };
    return store;
  });
  manager.reconcileAlarm = async () => 0;
  manager.executionSlotActive.add('active');

  let executed = false;
  manager.executeAction = async () => {
    executed = true;
    return { kind: 'ACTION', currentUrl: 'https://one.example/' };
  };

  const approving = manager.approvePendingAction('approval', { runInitial: false });
  await Promise.resolve();
  assert.equal(executed, false, 'approved effect must wait while another active Agent owns the same target');

  manager.executionSlotActive.delete('active');
  await manager.updateExecutionPolicy({ maxConcurrentAgents: 2 });
  await approving;
  assert.equal(executed, true);
  const after = (await manager.get('approval')).job;
  assert.equal(after.runtime.pendingApproval, null);
  assert.equal(after.runtime.stepCount, 1);
});

test('moving an active Agent to another tab immediately unblocks a queued old-target Agent', async () => {
  const chrome = makeChromeStorage();
  chrome.tabs = {
    async get(id) {
      if (id === 10) return { id: 10, url: 'https://one.example/', status: 'complete' };
      if (id === 20) return { id: 20, url: 'https://two.example/', status: 'complete' };
      throw new Error('unknown tab');
    },
    async query() { return []; },
  };
  chrome.permissions = { async contains() { return true; } };

  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  await manager.create({ id: 'moving', goal: 'Move away from tab one' });
  await manager.create({ id: 'waiting', goal: 'Use tab one afterwards' });
  await manager.updateExecutionPolicy({ maxConcurrentAgents: 2 });
  await manager.update(store => {
    const moving = store.byId.moving;
    const waiting = store.byId.waiting;
    moving.runtime.runState = BrowserAgentRunState.RUNNING;
    moving.runtime.controlEpoch = 1;
    moving.runtime.tabId = 10;
    moving.runtime.knownTabIds = [10, 20];
    moving.runtime.currentUrl = 'https://one.example/';
    waiting.runtime.runState = BrowserAgentRunState.RUNNING;
    waiting.runtime.controlEpoch = 1;
    waiting.runtime.tabId = 10;
    waiting.runtime.knownTabIds = [10];
    waiting.runtime.currentUrl = 'https://one.example/';
    return store;
  });
  manager.reconcileAlarm = async () => 0;
  manager.executionSlotActive.add('moving');

  let waitingStartedResolve;
  const waitingStarted = new Promise(resolve => { waitingStartedResolve = resolve; });
  manager.cycleOne = async id => {
    if (id === 'waiting') waitingStartedResolve();
    return { kind: 'COMPLETED', id };
  };

  const queued = manager.runBurst('waiting', { maxCycles: 1 });
  await Promise.resolve();

  const moving = (await manager.get('moving')).job;
  const switched = await manager.executeAction(
    moving,
    { url: 'https://one.example/' },
    { type: BrowserAgentActionType.SWITCH_TAB, tabId: 20 },
    moving.runtime.controlEpoch,
  );
  assert.equal(switched.kind, 'ACTION');
  assert.equal((await manager.get('moving')).job.runtime.tabId, 20);

  await waitingStarted;
  await queued;
});
