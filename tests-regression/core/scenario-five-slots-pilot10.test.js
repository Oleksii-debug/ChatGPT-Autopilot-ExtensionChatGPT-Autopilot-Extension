import test from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioWorkManager } from '../../src/core/scenario-work-manager.js';

test('five persistent chats advance independently through 17 messages and replace a finished slot', async () => {
  let now = 1_800_000_000_000;
  let serial = 0;
  const state = { sessionsById: {}, sessionOrder: [], tabHintsByTaskId: {}, logs: {} };
  const storage = {};
  const openTabs = new Set();
  let failClose = true;
  const chromeApi = {
    storage: { local: {
      async get(key) { return { [key]: structuredClone(storage[key]) }; },
      async set(value) { Object.assign(storage, structuredClone(value)); },
    } },
    alarms: { async create() {}, async clear() {} },
    tabs: {
      async remove(id) { if (failClose && id === 303) throw Error('TRANSIENT_TAB_CLOSE'); openTabs.delete(id); },
      async get(id) { if (!openTabs.has(id)) throw Error('No tab with id'); return { id }; },
    },
  };
  const coreRepository = {
    async load() { return structuredClone(state); },
    async update(mutator) { await mutator(state); return structuredClone(state); },
  };
  const makeManager = () => new ScenarioWorkManager({ coreRepository, chromeApi, now: () => now,
    createId: () => `slot-${++serial}`,
    collectAssistantReport: async () => ({ status: 'READY', assistantComplete: true, assistantText: 'OK' }) });
  let manager = makeManager();
  const { ids } = await manager.createChatPool({ count: 5, replacementBudget: 2, config: {
    mode: 'CHAT_CYCLE', roundsPerGeneration: 1, launchUrl: 'https://chatgpt.com/',
    steps: [{ prompt: 'START', repeat: 1 }, { prompt: 'CONTINUE', repeat: 15 }, { prompt: 'FINAL', repeat: 1 }],
  } });
  for (const id of ids) await manager.start(id);
  assert.equal(Object.keys(state.sessionsById).length, 5);
  assert.deepEqual((await manager.get(ids[2])).scenario.verifiedSends,
    { confirmedInThisChat: 0, confirmedOverall: 0 });

  async function completeTurn(id, turn, generation = 1, tabId = 303) {
    const before = (await manager.get(id)).scenario.runtime;
    assert.equal(before.generation, generation);
    const sessionId = before.chat.sessionId;
    const session = state.sessionsById[sessionId];
    const task = session.tasksById[before.chat.taskId];
    const chatUrl = `https://chatgpt.com/c/${id}-generation-${generation}`;
    assert.equal(task.promptOverride, turn === 1 ? 'START' : turn === 17 ? 'FINAL' : 'CONTINUE');
    assert.equal(task.normalizedUrl, turn === 1 ? 'https://chatgpt.com/' : chatUrl);
    assert.equal((await manager.cycleOne(id)).runtime.chat.state, 'WAITING');
    task.lastVerifiedSendAt = ++now;
    task.lastConversationUrl = chatUrl;
    session.successfulSendCount += 1;
    session.onePassCompletedCount = 1;
    session.onePassCompletedTaskIds = [task.id];
    session.runState = 'COMPLETED';
    state.tabHintsByTaskId[task.id] = { sessionId, tabId, ownedByExtension: true, normalizedUrl: chatUrl };
    openTabs.add(tabId);
    const result = await manager.cycleOne(id);
    assert.equal(result.kind, 'CYCLED', `slot ${id}, generation ${generation}, turn ${turn}`);
    return { sessionId, chatUrl };
  }

  // Every initial slot sends without waiting for the others to finish.
  for (const [index, id] of ids.entries()) await completeTurn(id, 1, 1, 301 + index);
  assert.deepEqual((await manager.get(ids[2])).scenario.verifiedSends,
    { confirmedInThisChat: 1, confirmedOverall: 1 });
  const uncertainSession = state.sessionsById[(await manager.get(ids[2])).scenario.runtime.chat.sessionId];
  uncertainSession.operation = { phase: 'AMBIGUOUS' };
  assert.deepEqual((await manager.list()).scenarios.find(item => item.id === ids[2]).verifiedSends,
    { confirmedInThisChat: 1, confirmedOverall: 1 }, 'an attempted or ambiguous Send is not counted');
  uncertainSession.operation = null;
  const snapshots = await Promise.all(ids.filter(id => id !== ids[2]).map(id => manager.get(id)));
  let retired;
  for (let turn = 2; turn <= 17; turn++) {
    retired = await completeTurn(ids[2], turn);
    if (turn === 3) assert.deepEqual((await manager.get(ids[2])).scenario.verifiedSends,
      { confirmedInThisChat: 3, confirmedOverall: 3 });
    if (turn === 8) manager = makeManager(); // service worker restart while one chat runs
  }
  assert.equal((await manager.get(ids[2])).scenario.runtime.generation, 2);
  assert.deepEqual((await manager.get(ids[2])).scenario.verifiedSends,
    { confirmedInThisChat: 0, confirmedOverall: 17 });
  assert.equal((await manager.list()).pools[0].replacementsUsed, 1);
  assert.equal(state.sessionsById[retired.sessionId].enabled, false);
  assert.equal((await manager.get(ids[2])).scenario.runtime.chat.chatUrl, '');
  for (const [index, id] of ids.filter(id => id !== ids[2]).entries()) {
    assert.deepEqual((await manager.get(id)).scenario.runtime, snapshots[index].scenario.runtime);
  }
  await completeTurn(ids[2], 1, 2);
  assert.notEqual((await manager.get(ids[2])).scenario.runtime.chat.chatUrl, retired.chatUrl);
  assert.equal((await manager.list()).pools[0].replacementsUsed, 1);
  failClose = false;
  await manager.cycleOne(ids[2]);
  assert.equal(state.sessionsById[retired.sessionId], undefined);
  assert.ok(!openTabs.has(303));
});
