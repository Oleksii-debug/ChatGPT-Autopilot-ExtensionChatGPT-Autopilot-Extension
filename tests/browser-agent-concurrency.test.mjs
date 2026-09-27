import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';

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

  let releaseFirst;
  const firstBarrier = new Promise(resolve => { releaseFirst = resolve; });
  const starts = [];
  manager.cycleOne = async id => {
    starts.push(id);
    if (id === 'a') await firstBarrier;
    else await new Promise(resolve => setTimeout(resolve, 10));
    return { kind: 'COMPLETED', id };
  };

  const a = manager.runBurst('a', { maxCycles: 1 });
  const b = manager.runBurst('b', { maxCycles: 1 });
  const c = manager.runBurst('c', { maxCycles: 1 });
  await new Promise(resolve => setTimeout(resolve, 5));
  limit = 1;
  releaseFirst();
  await Promise.all([a, b, c]);
  assert.deepEqual(starts.slice(0, 2), ['a', 'b']);
  assert.equal(starts.at(-1), 'c');
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
  const heldBarrier = new Promise(resolve => { releaseHeld = resolve; });
  let queuedStarted = false;
  manager.cycleOne = async id => {
    if (id === 'held') await heldBarrier;
    else queuedStarted = true;
    return { kind: 'COMPLETED', id };
  };

  const held = manager.runBurst('held', { maxCycles: 1 });
  const queued = manager.runBurst('queued', { maxCycles: 1 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(queuedStarted, false);
  await manager.updateExecutionPolicy({ maxConcurrentAgents: 2 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(queuedStarted, true);
  releaseHeld();
  await Promise.all([held, queued]);
});
