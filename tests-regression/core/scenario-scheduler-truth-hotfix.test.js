import test from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioWorkManager } from '../../src/core/scenario-work-manager.js';
import { projectGlobalStatus } from '../../src/core/global-status.js';

function harness({ nowStart = 1_800_000_000_000, report = async () => ({ status: 'READY', assistantComplete: true, assistantText: 'ok' }) } = {}) {
  let now = nowStart;
  let serial = 0;
  const storage = {};
  const state = { sessionsById: {}, sessionOrder: [], tabHintsByTaskId: {}, logs: {}, profile: {} };
  const chromeApi = {
    storage: { local: {
      async get(key) { return { [key]: structuredClone(storage[key]) }; },
      async set(value) { Object.assign(storage, structuredClone(value)); },
    } },
    alarms: { async create() {}, async clear() {} },
    tabs: { async remove() {}, async get() { throw new Error('No tab'); } },
  };
  const coreRepository = {
    async load() { return structuredClone(state); },
    async update(mutator) { await mutator(state); return structuredClone(state); },
  };
  const manager = new ScenarioWorkManager({
    coreRepository,
    chromeApi,
    now: () => now,
    createId: () => `scenario-hotfix-${++serial}`,
    collectAssistantReport: report,
  });
  return {
    manager, state,
    get now() { return now; },
    set now(value) { now = value; },
  };
}

const chessConfig = {
  mode: 'CHAT_CYCLE',
  launchUrl: 'https://chatgpt.com/',
  responseTimeoutMinutes: 40,
  pollSeconds: 15,
  preSendDelaySeconds: 10,
  busyCheckDelaySeconds: 3,
  retryBackoffSeconds: 15,
  restartCurrentRoundOnTimeout: true,
  steps: [
    { prompt: 'START', repeat: 1 },
    { prompt: 'CONTINUE', repeat: 10 },
    { prompt: 'FINAL', repeat: 1 },
  ],
};

test('initial pool stagger accepts three minutes and is stored only as first-launch schedule', async () => {
  const h = harness();
  const created = await h.manager.createChatPool({
    name: 'Accessible Chess',
    count: 8,
    replacementBudget: 0,
    staggerSeconds: 180,
    autoStart: false,
    config: chessConfig,
  });
  assert.equal(created.ids.length, 8);
  const list = await h.manager.list();
  assert.equal(list.pools[0].slots, 8);
  assert.equal(list.pools[0].active, 0);
  const members = list.scenarios.filter(item => item.pool?.id === list.pools[0].id);
  assert.equal(members.length, 8);
  for (const [index, item] of members.entries()) {
    assert.equal(item.runtime.initialStaggerSeconds, 180);
    assert.equal(item.runtime.initialStartAt, 1_800_000_000_000 + index * 180_000);
  }
});

test('active streaming response renews response timeout instead of resetting the chat sequence', async () => {
  const h = harness({
    report: async () => ({
      status: 'BUSY',
      assistantComplete: false,
      safeDiagnosticCode: 'ASSISTANT_RESPONSE_STREAMING',
    }),
  });
  const created = await h.manager.createChatPool({
    name: 'Accessible Chess',
    count: 1,
    replacementBudget: 0,
    staggerSeconds: 0,
    autoStart: true,
    config: chessConfig,
  });
  const id = created.ids[0];
  let scenario = (await h.manager.get(id)).scenario;
  assert.equal(scenario.runtime.chat.state, 'WAITING');
  const sessionId = scenario.runtime.chat.sessionId;
  const taskId = scenario.runtime.chat.taskId;
  const session = h.state.sessionsById[sessionId];
  session.tasksById[taskId].lastVerifiedSendAt = h.now + 1;
  session.tasksById[taskId].lastConversationUrl = 'https://chatgpt.com/c/streaming';
  session.successfulSendCount = 1;

  const oldDeadline = scenario.runtime.chat.deadlineAt;
  h.now = oldDeadline + 1;
  await h.manager.cycleOne(id);
  scenario = (await h.manager.get(id)).scenario;

  assert.equal(scenario.runtime.chat.state, 'WAITING');
  assert.equal(scenario.runtime.chat.sessionId, sessionId);
  assert.equal(scenario.runtime.stepIndex, 0);
  assert.equal(scenario.runtime.repeatIndex, 0);
  assert.equal(scenario.runtime.poolReplacementsUsed, 0);
  assert.ok(scenario.runtime.chat.deadlineAt > h.now);
});

test('global status separates eight scenario chats from ten whole-product work units', () => {
  const coreState = { sessionsById: {}, sessionOrder: [] };
  for (let i = 1; i <= 2; i += 1) {
    const id = `simple-${i}`;
    coreState.sessionOrder.push(id);
    coreState.sessionsById[id] = {
      id,
      name: `Simple ${i}`,
      simplifiedSession: true,
      runState: 'RUNNING',
      successfulSendCount: i,
      cycleCount: i,
      tasksById: {},
      taskOrder: [],
    };
  }

  const scenarios = Array.from({ length: 8 }, (_, index) => ({
    id: `chess-${index + 1}`,
    name: `Accessible Chess — чат ${index + 1}`,
    pool: { id: 'chess-pool', replacementBudget: 0 },
    config: {
      mode: 'CHAT_CYCLE',
      roundsPerGeneration: 1,
      steps: [{ repeat: 1 }, { repeat: 10 }, { repeat: 1 }],
    },
    runtime: {
      mode: 'CHAT_CYCLE',
      runState: 'RUNNING',
      generation: 1,
      totalCompletedTurns: 0,
      retiredVerifiedSends: 0,
      generationRetiredVerifiedSends: 0,
      verifiedSendHistoryComplete: true,
      round: 0,
      stepIndex: 0,
      repeatIndex: 0,
      cleanupPendingSessionIds: [],
      chat: { key: 'chat', role: 'CHAT', state: 'NEW', generation: 1, sessionId: '' },
    },
  }));

  const status = projectGlobalStatus({ coreState, scenarios });
  assert.equal(status.summary.total, 10);
  assert.equal(status.simplifiedSessions.length, 2);
  assert.equal(status.scenarioSlots.length, 8);
  assert.equal(status.scenarioPools.length, 1);
  assert.equal(status.scenarioPools[0].slots, 8);
  assert.equal(status.scenarioPools[0].active, 8);
});
