import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ScenarioWorkManager } from '../../src/core/scenario-work-manager.js';

let now = 1_800_000_000_000;
const events = [];
function event(slot, generation, turn, action, result, conversationUrl = '') {
  events.push({ evidenceClass: 'SIMULATED_NODE_REGRESSION', timestamp: new Date(now).toISOString(),
    slot, generation, turn, action, result,
    conversationHash: conversationUrl ? createHash('sha256').update(conversationUrl).digest('hex').slice(0, 16) : null });
}
const state = { sessionsById: {}, sessionOrder: [], tabHintsByTaskId: {}, logs: {} };
const storage = {};
const openTabs = new Set();
let closeFails = true;
const chromeApi = {
  storage: { local: {
    async get(key) { return { [key]: structuredClone(storage[key]) }; },
    async set(value) { Object.assign(storage, structuredClone(value)); },
  } },
  alarms: { async create() {}, async clear() {} },
  tabs: {
    async remove(id) { if (closeFails && id === 303) throw Error('TEMPORARY_CLOSE_FAILURE'); openTabs.delete(id); },
    async get(id) { if (!openTabs.has(id)) throw Error('No tab with id'); return { id }; },
  },
};
const coreRepository = {
  async load() { return structuredClone(state); },
  async update(mutator) { const result = await mutator(state); if (result && result !== state) Object.assign(state, result); return structuredClone(state); },
};
const makeManager = () => new ScenarioWorkManager({
  coreRepository, chromeApi, now: () => now,
  createId: (() => { let id = 0; return () => `slot-${++id}`; })(),
  collectAssistantReport: async () => ({ status: 'READY', assistantComplete: true, assistantText: 'OK' }),
});
const manager = makeManager();
const ids = [];
const config = {
  mode: 'CHAT_CYCLE', roundsPerGeneration: 1, maxGenerations: 0,
  minimumLaunchGapSeconds: 0, preSendDelaySeconds: 1,
  steps: [
    { prompt: 'START', repeat: 1 },
    { prompt: 'Продовжуй роботу.', repeat: 15 },
    { prompt: 'FINAL', repeat: 1 },
  ],
};
for (let i = 1; i <= 5; i++) {
  const { scenario } = await manager.create({ name: `slot ${i}`, mode: 'CHAT_CYCLE', config });
  ids.push(scenario.id);
  await manager.start(scenario.id);
  event(i, 1, 1, 'LAUNCH', 'CORE_SESSION_CREATED');
  assert.equal((await manager.get(scenario.id)).scenario.runtime.chat.state, 'WAITING');
}
assert.equal(Object.keys(state.sessionsById).length, 5);
const oldSessions = Object.keys(state.sessionsById);
const slot3 = ids[2];
const oldId = oldSessions[2];
const oldChatUrl = 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333';
const otherSnapshots = await Promise.all(ids.filter(id => id !== slot3).map(id => manager.get(id)));

for (let turn = 1; turn <= 17; turn++) {
  const current = (await manager.get(slot3)).scenario.runtime;
  assert.equal(current.generation, 1);
  const session = state.sessionsById[current.chat.sessionId];
  const task = session.tasksById[current.chat.taskId];
  assert.equal(task.promptOverride, turn === 1 ? 'START' : turn === 17 ? 'FINAL' : 'Продовжуй роботу.');
  task.lastVerifiedSendAt = ++now;
  task.lastConversationUrl = oldChatUrl;
  session.successfulSendCount = turn;
  session.onePassCompletedCount = 1;
  session.onePassCompletedTaskIds = [task.id];
  session.runState = 'COMPLETED';
  state.tabHintsByTaskId[task.id] = {
    sessionId: session.id, tabId: 303, ownedByExtension: true, normalizedUrl: oldChatUrl,
  };
  openTabs.add(303);
  event(3, 1, turn, 'SEND', 'SIMULATED_CONFIRMED_EFFECT', oldChatUrl);
  const result = await manager.cycleOne(slot3);
  assert.equal(result.kind, 'CYCLED', `turn ${turn}: ${JSON.stringify(result)}`);
  event(3, 1, turn, 'ASSISTANT_COMPLETE', 'SIMULATED_READY_REPORT', oldChatUrl);
}
const after = (await manager.get(slot3)).scenario.runtime;
assert.equal(after.generation, 2);
assert.equal(after.chat.state, 'WAITING');
assert.equal(after.stepIndex, 0);
assert.notEqual(after.chat.sessionId, oldId);
assert.equal(state.sessionsById[after.chat.sessionId].tasksById[after.chat.taskId].promptOverride, 'START');
assert.equal(state.sessionsById[oldId].runState, 'STOPPED');
assert.equal(state.sessionsById[oldId].enabled, false);
assert.deepEqual(after.cleanupPendingSessionIds, [oldId]);
assert.ok(openTabs.has(303));
event(3, 1, 17, 'RETIRE', 'OLD_SESSION_STOPPED_TAB_CLOSE_PENDING', oldChatUrl);
event(3, 2, 1, 'LAUNCH', 'NEW_CORE_SESSION_CREATED');
for (let index = 0; index < 4; index++) {
  const current = (await manager.get(ids.filter(id => id !== slot3)[index])).scenario.runtime;
  assert.deepEqual(current, otherSnapshots[index].scenario.runtime);
}

const restarted = makeManager();
await restarted.pause(slot3);
assert.equal(state.sessionsById[oldId].enabled, false);
await restarted.resume(slot3);
assert.equal(state.sessionsById[oldId].enabled, false);
state.sessionsById[oldId].operation = { phase: 'SUBMITTING' };
const unsafe = await restarted.cycleOne(slot3);
assert.equal(unsafe.kind, 'CLEANUP_PENDING');
assert.equal(state.sessionsById[oldId].enabled, false);
state.sessionsById[oldId].operation = null;
const recovered = await restarted.cycleOne(slot3);
assert.equal(recovered.kind, 'CYCLED');
assert.equal(state.sessionsById[oldId].enabled, false);
assert.equal((await restarted.get(slot3)).scenario.runtime.generation, 2);
closeFails = false;
const cleaned = await restarted.cycleOne(slot3);
assert.equal(cleaned.kind, 'CYCLED');
assert.ok(!state.sessionsById[oldId]);
assert.ok(!openTabs.has(303));
event(3, 1, 17, 'DEFERRED_CLOSE', 'TAB_CLOSED', oldChatUrl);
for (let slot = 1; slot <= 5; slot++) {
  const id = ids[slot - 1];
  if (slot !== 3) {
    const first = (await restarted.get(id)).scenario.runtime;
    const oldSessionId = first.chat.sessionId;
    const chatUrl = `https://chatgpt.com/c/${slot}0000000-0000-4000-8000-000000000000`;
    const tabId = 300 + slot;
    for (let turn = 1; turn <= 17; turn++) {
      const before = (await restarted.get(id)).scenario.runtime;
      assert.equal(before.generation, 1, `slot ${slot} turn ${turn} generation`);
      assert.equal(before.chat.sessionId, oldSessionId, `slot ${slot} turn ${turn} persistent chat`);
      const session = state.sessionsById[oldSessionId];
      const task = session.tasksById[before.chat.taskId];
      assert.equal(task.promptOverride, turn === 1 ? 'START' : turn === 17 ? 'FINAL' : 'Продовжуй роботу.');
      task.lastVerifiedSendAt = ++now;
      task.lastConversationUrl = chatUrl;
      session.successfulSendCount = turn;
      session.onePassCompletedCount = 1;
      session.onePassCompletedTaskIds = [task.id];
      session.runState = 'COMPLETED';
      state.tabHintsByTaskId[task.id] = { sessionId: oldSessionId, tabId, ownedByExtension: true, normalizedUrl: chatUrl };
      openTabs.add(tabId);
      event(slot, 1, turn, 'SEND', 'SIMULATED_CONFIRMED_EFFECT', chatUrl);
      const result = await restarted.cycleOne(id);
      assert.equal(result.kind, 'CYCLED', `slot ${slot} turn ${turn}: ${JSON.stringify(result)}`);
      event(slot, 1, turn, 'ASSISTANT_COMPLETE', 'SIMULATED_READY_REPORT', chatUrl);
    }
    const next = (await restarted.get(id)).scenario.runtime;
    assert.equal(next.generation, 2, `slot ${slot} replacement generation`);
    assert.notEqual(next.chat.sessionId, oldSessionId);
    assert.equal(next.chat.state, 'WAITING');
    assert.equal(state.sessionsById[next.chat.sessionId].tasksById[next.chat.taskId].promptOverride, 'START');
    assert.equal(state.sessionsById[oldSessionId], undefined);
    assert.ok(!openTabs.has(tabId));
    event(slot, 1, 17, 'RETIRE', 'OLD_CHAT_CLOSED', chatUrl);
  }
  const next = (await restarted.get(id)).scenario.runtime;
  const newSession = state.sessionsById[next.chat.sessionId];
  const newTask = newSession.tasksById[next.chat.taskId];
  assert.equal(newTask.promptOverride, 'START');
  newTask.lastVerifiedSendAt = ++now;
  newTask.lastConversationUrl = `https://chatgpt.com/c/${slot}0000000-0000-4000-8000-111111111111`;
  newSession.successfulSendCount = 1;
  newSession.onePassCompletedCount = 1;
  newSession.onePassCompletedTaskIds = [newTask.id];
  newSession.runState = 'COMPLETED';
  assert.equal((await restarted.cycleOne(id)).kind, 'CYCLED');
  assert.equal((await restarted.get(id)).scenario.runtime.generation, 2);
  event(slot, 2, 1, 'SEND', 'SIMULATED_CONFIRMED_EFFECT', newTask.lastConversationUrl);
}
for (const id of ids) {
  const scenario = (await restarted.get(id)).scenario.runtime;
  assert.equal(scenario.generation, 2);
  assert.equal(scenario.totalCompletedTurns, 18);
}
if (process.env.EVIDENCE_PATH) writeFileSync(process.env.EVIDENCE_PATH, events.map(item => JSON.stringify(item)).join('\n') + '\n');
console.log('PASS five persistent chats × 17 completed turns + generation 2 first turn each; retirement, restart and deferred tab cleanup');
