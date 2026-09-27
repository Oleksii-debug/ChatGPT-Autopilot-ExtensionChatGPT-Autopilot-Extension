import test from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioWorkManager } from '../../src/core/scenario-work-manager.js';

test('seven-chat pool persists its full start and stagger across UI closure and worker restart', async () => {
  let now = 1_800_000_000_000;
  let nextId = 0;
  const storage = {};
  const core = { sessionsById: {}, sessionOrder: [], tabHintsByTaskId: {}, logs: {} };
  const chromeApi = {
    storage: { local: {
      async get(key) { return { [key]: structuredClone(storage[key]) }; },
      async set(value) { Object.assign(storage, structuredClone(value)); },
    } },
    alarms: { async create() {}, async clear() {} },
    tabs: { async remove() {} },
  };
  const coreRepository = {
    async load() { return structuredClone(core); },
    async update(mutator) { await mutator(core); return structuredClone(core); },
  };
  const manager = () => new ScenarioWorkManager({ coreRepository, chromeApi,
    now: () => now, createId: () => `stagger-${++nextId}`,
    collectAssistantReport: async () => ({ status: 'TEMPORARY_ERROR', assistantComplete: false }) });
  let running = manager();
  const created = await running.createChatPool({ count: 7, replacementBudget: 50,
    staggerSeconds: 10, autoStart: true, config: { mode: 'CHAT_CYCLE',
      launchUrl: 'https://chatgpt.com/', steps: [{ prompt: 'START', repeat: 1 },
        { prompt: 'CONTINUE', repeat: 10 }, { prompt: 'FINISH', repeat: 1 }] } });
  assert.equal(created.ids.length, 7);
  assert.equal(Object.keys(core.sessionsById).length, 1, 'only first physical chat is initially eligible');
  for (const [index, id] of created.ids.entries()) {
    const slot = (await running.get(id)).scenario;
    assert.equal(slot.runtime.runState, 'RUNNING', 'all slots were atomically started');
    assert.equal(slot.runtime.initialStartAt, now + index * 10_000);
  }

  // No options page or caller loop survives; a fresh background manager owns
  // the remaining launches at the scheduled times.
  running = manager();
  now += 30_000;
  await running.cycleAll();
  assert.equal(Object.keys(core.sessionsById).length, 2,
    'overdue starts do not burst after a sleeping service worker wakes');
  await running.cycleAll();
  assert.equal(Object.keys(core.sessionsById).length, 2, 'a repeated wake at the same time cannot skip the gap');
  for (let index = 3; index <= 7; index++) {
    now += 10_000;
    await running.cycleAll();
    assert.equal(Object.keys(core.sessionsById).length, index);
  }
  assert.equal(Object.keys(core.sessionsById).length, 7);
  const slots = await Promise.all(created.ids.map(async id => (await running.get(id)).scenario));
  assert.ok(slots.every(slot => slot.runtime.chat.state === 'WAITING'));
  assert.ok(slots.every(slot => slot.runtime.poolReplacementsUsed === 0));
});
