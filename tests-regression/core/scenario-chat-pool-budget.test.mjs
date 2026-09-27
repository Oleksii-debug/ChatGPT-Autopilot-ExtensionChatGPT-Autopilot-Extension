import test from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioWorkManager } from '../../src/core/scenario-work-manager.js';

test('a shared replacement budget follows whichever persistent chat finishes first and survives restart', async () => {
  let now = 1800000000000;
  let nextId = 0;
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
  const manager = () => new ScenarioWorkManager({ coreRepository, chromeApi, now: () => now,
    createId: () => `pool-slot-${++nextId}`,
    collectAssistantReport: async () => ({ status: 'READY', assistantComplete: true, assistantText: 'OK' }) });
  const first = manager();
  const config = { mode: 'CHAT_CYCLE', roundsPerGeneration: 5, maxGenerations: 9, steps: [
    { prompt: 'FIRST', repeat: 1 }, { prompt: 'CONTINUE', repeat: 1 } ], launchUrl: 'https://chatgpt.com/' };
  const { pool, ids } = await first.createChatPool({ name: 'Приклад', count: 3, replacementBudget: 2, config });
  assert.equal(ids.length, 3);
  for (const id of ids) {
    const created = (await first.get(id)).scenario;
    assert.equal(created.config.roundsPerGeneration, 1);
    assert.equal(created.config.maxGenerations, 0);
    await first.start(id);
  }
  async function finish(id, expectedPrompt, expectedUrl) {
    const before = (await first.get(id)).scenario.runtime;
    const session = state.sessionsById[before.chat.sessionId];
    const task = session.tasksById[before.chat.taskId];
    assert.equal(task.promptOverride, expectedPrompt);
    assert.equal(task.normalizedUrl, expectedUrl);
    assert.equal((await first.cycleOne(id)).runtime.chat.state, 'WAITING');
    task.lastVerifiedSendAt = ++now;
    task.lastConversationUrl = expectedUrl === 'https://chatgpt.com/'
      ? `https://chatgpt.com/c/chat-${before.generation}-${id}` : expectedUrl;
    session.successfulSendCount += 1;
    session.onePassCompletedCount = 1;
    session.onePassCompletedTaskIds = [task.id];
    session.runState = 'COMPLETED';
    await first.cycleOne(id);
    return (await first.get(id)).scenario.runtime;
  }
  const initial = 'https://chatgpt.com/';
  const chat1 = `https://chatgpt.com/c/chat-1-${ids[0]}`;
  await finish(ids[0], 'FIRST', initial);
  await finish(ids[0], 'CONTINUE', chat1);
  const second = manager(); // simulates a restarted extension service worker
  let summary = (await second.list()).pools[0];
  assert.equal(summary.replacementsUsed, 1);
  assert.equal((await second.get(ids[0])).scenario.runtime.generation, 2);
  await finish(ids[1], 'FIRST', initial);
  await finish(ids[1], 'CONTINUE', `https://chatgpt.com/c/chat-1-${ids[1]}`);
  summary = (await second.list()).pools[0];
  assert.equal(summary.replacementsUsed, 2);
  await finish(ids[2], 'FIRST', initial);
  await finish(ids[2], 'CONTINUE', `https://chatgpt.com/c/chat-1-${ids[2]}`);
  assert.equal((await second.get(ids[2])).scenario.runtime.runState, 'COMPLETED');
  assert.equal((await second.list()).pools[0].replacementsUsed, 2);
  assert.equal((await second.get(ids[0])).scenario.runtime.chat.state, 'WAITING');
  for (const id of ids.slice(0, 2)) {
    const chat2 = `https://chatgpt.com/c/chat-2-${id}`;
    await finish(id, 'FIRST', initial);
    await finish(id, 'CONTINUE', chat2);
    assert.equal((await second.get(id)).scenario.runtime.runState, 'COMPLETED');
  }
  assert.equal((await second.list()).pools[0].replacementsUsed, 2);
  assert.equal(Object.keys(state.sessionsById).length, 0);
  const config30 = { ...config, steps: [{ prompt: 'A', repeat: 1 }, { prompt: 'B', repeat: 29 }] };
  const flexible = await second.createChatPool({ count: 15, replacementBudget: 500, config: config30 });
  assert.equal(flexible.ids.length, 15);
  assert.equal(flexible.pool.replacementBudget, 500);
  assert.equal(pool.replacementBudget, 2);
});
