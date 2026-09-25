import test from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioWorkManager } from '../../src/core/scenario-work-manager.js';

test('three uneven chats exhaust 50 shared replacements after ten verified turns per chat', async () => {
  let now = 1_800_000_000_000;
  let serial = 0;
  const state = { sessionsById: {}, sessionOrder: [], tabHintsByTaskId: {}, logs: {} };
  const storage = {};
  const chromeApi = { storage: { local: {
    async get(key) { return { [key]: structuredClone(storage[key]) }; },
    async set(value) { Object.assign(storage, structuredClone(value)); },
  } }, alarms: { async create() {}, async clear() {} }, tabs: { async remove() {} } };
  const coreRepository = {
    async load() { return structuredClone(state); },
    async update(mutator) { await mutator(state); return structuredClone(state); },
  };
  const makeManager = () => new ScenarioWorkManager({ coreRepository, chromeApi, now: () => now,
    createId: () => `load-${++serial}`,
    collectAssistantReport: async () => ({ status: 'READY', assistantComplete: true, assistantText: 'OK' }) });
  let manager = makeManager();
  const { ids } = await manager.createChatPool({ count: 3, replacementBudget: 50, config: {
    mode: 'CHAT_CYCLE', roundsPerGeneration: 1, launchUrl: 'https://chatgpt.com/',
    steps: [{ prompt: 'OPEN', repeat: 1 }, { prompt: 'CONTINUE', repeat: 8 }, { prompt: 'CLOSE', repeat: 1 }],
  } });
  for (const id of ids) await manager.start(id);
  const sends = new Map(ids.map(id => [id, 0]));
  for (let iteration = 0; iteration < 530; iteration++) {
    // Different response orders exercise whichever slot completes first.
    const id = ids[(iteration * 7 + Math.floor(iteration / 11)) % ids.length];
    let scenario = (await manager.get(id)).scenario;
    if (scenario.runtime.runState !== 'RUNNING') {
      const runnable = await Promise.all(ids.map(async value => (await manager.get(value)).scenario));
      scenario = runnable.find(value => value.runtime.runState === 'RUNNING');
    }
    assert.ok(scenario, `iteration ${iteration} still has runnable work`);
    const sid = scenario.runtime.chat.sessionId;
    const taskId = scenario.runtime.chat.taskId;
    const session = state.sessionsById[sid];
    const task = session.tasksById[taskId];
    const turn = scenario.runtime.stepIndex === 0 ? 0 : scenario.runtime.stepIndex === 2 ? 9 : scenario.runtime.repeatIndex + 1;
    assert.equal(task.promptOverride, turn === 0 ? 'OPEN' : turn === 9 ? 'CLOSE' : 'CONTINUE');
    const expectedUrl = turn === 0 ? 'https://chatgpt.com/' : `https://chatgpt.com/c/${scenario.id}-${scenario.runtime.generation}`;
    assert.equal(task.normalizedUrl, expectedUrl);
    await manager.cycleOne(scenario.id); // materializes waiting state
    task.lastVerifiedSendAt = ++now;
    task.lastConversationUrl = `https://chatgpt.com/c/${scenario.id}-${scenario.runtime.generation}`;
    session.successfulSendCount++;
    session.onePassCompletedCount = 1;
    session.onePassCompletedTaskIds = [taskId];
    session.runState = 'COMPLETED';
    await manager.cycleOne(scenario.id);
    sends.set(scenario.id, sends.get(scenario.id) + 1);
    if (iteration === 175 || iteration === 400) manager = makeManager(); // worker restart
  }
  const final = await manager.list();
  assert.equal(final.pools[0].replacementsUsed, 50);
  assert.equal([...sends.values()].reduce((a, b) => a + b, 0), 530);
  for (const id of ids) assert.equal((await manager.get(id)).scenario.runtime.runState, 'COMPLETED');
  assert.equal(Object.keys(state.sessionsById).length, 0);
});
