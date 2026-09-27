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
  assert.equal(status.scenarioPools[0].launching, 8);
});


test('dormant configuration scenario is not an eleventh physical chat and pool progress is canonical', () => {
  const coreState = { sessionsById: {}, sessionOrder: [] };
  const dormant = {
    id: 'template',
    name: 'Accessible Chess — 5 потоків × 12 повідомлень',
    config: { mode: 'CHAT_CYCLE', roundsPerGeneration: 1, steps: [{ repeat: 1 }, { repeat: 10 }, { repeat: 1 }] },
    runtime: {
      mode: 'CHAT_CYCLE',
      runState: 'STOPPED',
      generation: 1,
      totalLaunches: 0,
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
  };
  const scenarios = [dormant];
  for (let i = 1; i <= 10; i += 1) {
    const scenarioId = `chess-${i}`;
    const sessionId = i <= 7 ? `managed-${i}` : '';
    if (sessionId) {
      coreState.sessionOrder.push(sessionId);
      coreState.sessionsById[sessionId] = {
        id: sessionId,
        runState: 'STOPPED',
        runMode: 'ONE_PASS',
        successfulSendCount: 1,
        operation: { phase: 'SENT_VERIFIED' },
        tasksById: {},
        taskOrder: [],
        scenarioWork: { managed: true, scenarioId, generation: 1 },
      };
    }
    scenarios.push({
      id: scenarioId,
      name: `Accessible Chess — чат ${i}`,
      pool: {
        id: 'chess-pool',
        name: 'Accessible Chess',
        slotIndex: i,
        initialCount: 10,
        initialStaggerSeconds: 120,
        replacementBudget: 0,
      },
      config: {
        mode: 'CHAT_CYCLE',
        roundsPerGeneration: 1,
        steps: [{ repeat: 1 }, { repeat: 10 }, { repeat: 1 }],
      },
      runtime: {
        mode: 'CHAT_CYCLE',
        runState: 'RUNNING',
        generation: 1,
        totalLaunches: sessionId ? 1 : 0,
        totalCompletedTurns: 0,
        retiredVerifiedSends: 0,
        generationRetiredVerifiedSends: 0,
        verifiedSendHistoryComplete: true,
        round: 0,
        stepIndex: 0,
        repeatIndex: 0,
        cleanupPendingSessionIds: [],
        chat: {
          key: 'chat',
          role: 'CHAT',
          state: sessionId ? 'WAITING' : 'NEW',
          generation: 1,
          sessionId,
        },
      },
    });
  }

  const status = projectGlobalStatus({ coreState, scenarios });
  assert.equal(status.summary.total, 10);
  assert.equal(status.scenarioSlots.length, 10);
  assert.equal(status.scenarioPools.length, 1);
  const pool = status.scenarioPools[0];
  assert.equal(pool.name, 'Accessible Chess');
  assert.equal(pool.slots, 10);
  assert.equal(pool.messagesPerChat, 12);
  assert.equal(pool.plannedSends, 120);
  assert.equal(pool.initialStaggerSeconds, 120);
  assert.equal(pool.firstPromptSent, 7);
  assert.equal(pool.firstPromptPending, 3);
  assert.equal(pool.waitingResponse, 7);
  assert.equal(pool.launching, 3);
  assert.equal(pool.verifiedSends, 7);
  assert.equal(pool.completedResponses, 0);
});

test('two-minute first-prompt stagger cannot launch slot two or three early', async () => {
  const h = harness();
  const created = await h.manager.createChatPool({
    name: 'Accessible Chess — 5 потоків × 12 повідомлень',
    count: 3,
    replacementBudget: 0,
    staggerSeconds: 120,
    autoStart: true,
    config: chessConfig,
  });
  assert.equal(created.pool.name, 'Accessible Chess');
  assert.equal(created.pool.slots, 3);
  assert.equal(created.pool.messagesPerChat, 12);
  assert.equal(created.pool.initialStaggerSeconds, 120);

  let list = await h.manager.list();
  let members = list.scenarios.filter(item => item.pool?.id === created.pool.id);
  assert.deepEqual(members.map(item => item.name), [
    'Accessible Chess — чат 1',
    'Accessible Chess — чат 2',
    'Accessible Chess — чат 3',
  ]);
  assert.deepEqual(members.map(item => item.runtime.totalLaunches), [1, 0, 0]);

  h.now += 119_999;
  await h.manager.cycleAll();
  list = await h.manager.list();
  members = list.scenarios.filter(item => item.pool?.id === created.pool.id);
  assert.deepEqual(members.map(item => item.runtime.totalLaunches), [1, 0, 0]);

  h.now += 1;
  await h.manager.cycleAll();
  list = await h.manager.list();
  members = list.scenarios.filter(item => item.pool?.id === created.pool.id);
  assert.deepEqual(members.map(item => item.runtime.totalLaunches), [1, 1, 0]);

  h.now += 119_999;
  await h.manager.cycleAll();
  list = await h.manager.list();
  members = list.scenarios.filter(item => item.pool?.id === created.pool.id);
  assert.deepEqual(members.map(item => item.runtime.totalLaunches), [1, 1, 0]);

  h.now += 1;
  await h.manager.cycleAll();
  list = await h.manager.list();
  members = list.scenarios.filter(item => item.pool?.id === created.pool.id);
  assert.deepEqual(members.map(item => item.runtime.totalLaunches), [1, 1, 1]);
});

test('continuous simplified sessions count verified sends as completed send-cycles, not assistant responses', () => {
  const coreState = {
    sessionOrder: ['simple'],
    sessionsById: {
      simple: {
        id: 'simple',
        name: 'Autosport — спрощена сесія',
        simplifiedSession: true,
        runState: 'RUNNING',
        runMode: 'CONTINUOUS',
        successfulSendCount: 9,
        operation: { phase: 'SENT_VERIFIED' },
        nextAllowedSendAt: 1_800_000_120_000,
        tasksById: {},
        taskOrder: [],
      },
    },
  };
  const status = projectGlobalStatus({ coreState });
  assert.equal(status.simplifiedSessions.length, 1);
  assert.equal(status.simplifiedSessions[0].verifiedSends, 9);
  assert.equal(status.simplifiedSessions[0].completedCycles, 9);
  assert.equal(status.simplifiedSessions[0].category, 'WAITING_NEXT_SEND');
  assert.equal(status.summary.completedResponses, 0);
});


test('whole chat pool can pause, edit safe runtime knobs, and resume without losing slot progress', async () => {
  const h = harness({ report: async () => ({ status: 'WAITING', assistantComplete: false }) });
  const created = await h.manager.createChatPool({
    name: 'Accessible Chess',
    count: 3,
    replacementBudget: 0,
    staggerSeconds: 0,
    autoStart: true,
    config: chessConfig,
  });
  const poolId = created.pool.id;
  let list = await h.manager.list();
  const before = list.scenarios.filter(item => item.pool?.id === poolId)
    .map(item => ({ id: item.id, launches: item.runtime.totalLaunches, step: item.runtime.stepIndex, repeat: item.runtime.repeatIndex }));
  assert.equal(list.pools[0].runState, 'RUNNING');

  await h.manager.pauseChatPool(poolId);
  list = await h.manager.list();
  assert.equal(list.pools[0].runState, 'PAUSED');
  assert.equal(list.pools[0].paused, 3);

  const updated = await h.manager.updateChatPool(poolId, {
    ...chessConfig,
    name: 'Night Chess',
    responseTimeoutMinutes: 55,
    pollSeconds: 30,
    preSendDelaySeconds: 12,
    busyCheckDelaySeconds: 4,
    retryBackoffSeconds: 45,
    minimumLaunchGapSeconds: 7,
    timeoutPolicy: 'REPLACE_MEMBER',
    restartCurrentRoundOnTimeout: false,
  }, { replacementBudget: 5, staggerSeconds: 180 });
  assert.equal(updated.pool.name, 'Night Chess');
  assert.equal(updated.pool.replacementBudget, 5);
  assert.equal(updated.pool.initialStaggerSeconds, 180);

  list = await h.manager.list();
  const afterEdit = list.scenarios.filter(item => item.pool?.id === poolId);
  assert.equal(afterEdit.length, 3);
  for (const item of afterEdit) {
    assert.equal(item.config.responseTimeoutMinutes, 55);
    assert.equal(item.config.pollSeconds, 30);
    assert.equal(item.config.preSendDelaySeconds, 12);
    assert.equal(item.config.busyCheckDelaySeconds, 4);
    assert.equal(item.config.retryBackoffSeconds, 45);
    assert.equal(item.config.minimumLaunchGapSeconds, 7);
    assert.equal(item.config.restartCurrentRoundOnTimeout, false);
    assert.equal(item.config.steps[0].prompt, 'START');
    assert.equal(item.pool.name, 'Night Chess');
    assert.equal(item.pool.replacementBudget, 5);
    assert.equal(item.runtime.runState, 'PAUSED');
  }
  assert.deepEqual(afterEdit.map(item => ({
    id: item.id, launches: item.runtime.totalLaunches, step: item.runtime.stepIndex, repeat: item.runtime.repeatIndex,
  })), before, 'editing runtime knobs must not reset progress');

  await h.manager.resumeChatPool(poolId);
  list = await h.manager.list();
  assert.equal(list.pools[0].runState, 'RUNNING');
});

test('whole pool structural program cannot be changed in place after creation', async () => {
  const h = harness({ report: async () => ({ status: 'WAITING', assistantComplete: false }) });
  const created = await h.manager.createChatPool({
    name: 'Accessible Chess',
    count: 2,
    replacementBudget: 0,
    staggerSeconds: 0,
    autoStart: true,
    config: chessConfig,
  });
  await h.manager.pauseChatPool(created.pool.id);
  await assert.rejects(
    () => h.manager.updateChatPool(created.pool.id, {
      ...chessConfig,
      steps: [
        { prompt: 'CHANGED', repeat: 1 },
        { prompt: 'CONTINUE', repeat: 10 },
        { prompt: 'FINAL', repeat: 1 },
      ],
    }, { replacementBudget: 0, staggerSeconds: 0 }),
    /структура промптів і стартове посилання не змінюються/u,
  );
});

test('assistant-response diagnostics distinguish streaming, completion and timeout extension evidence', async () => {
  let mode = 'BUSY';
  const h = harness({
    report: async () => mode === 'BUSY'
      ? { status: 'BUSY', assistantComplete: false, safeDiagnosticCode: 'ASSISTANT_RESPONSE_STREAMING' }
      : { status: 'READY', assistantComplete: true, safeDiagnosticCode: 'ASSISTANT_RESPONSE_READY', assistantText: 'done' },
  });
  const created = await h.manager.createChatPool({
    name: 'Diagnostic Chess',
    count: 1,
    replacementBudget: 0,
    staggerSeconds: 0,
    autoStart: true,
    config: { ...chessConfig, responseTimeoutMinutes: 1 },
  });
  const id = created.ids[0];
  let scenario = (await h.manager.get(id)).scenario;
  const session = h.state.sessionsById[scenario.runtime.chat.sessionId];
  const task = session.tasksById[scenario.runtime.chat.taskId];
  task.lastVerifiedSendAt = h.now;
  task.lastConversationUrl = 'https://chatgpt.com/c/diagnostic';
  session.successfulSendCount = 1;
  session.onePassCompletedCount = 1;
  session.onePassCompletedTaskIds = [task.id];
  session.runState = 'COMPLETED';

  h.now += 10_000;
  await h.manager.cycleOne(id);
  let events = h.state.diagnostics || [];
  assert.ok(events.some(event => event.event === 'СЦЕНАРІЙ_СПОСТЕРЕЖЕННЯ_ВІДПОВІДІ'
    && event.status === 'BUSY'
    && /waitSeconds=10/u.test(event.message || '')));

  scenario = (await h.manager.get(id)).scenario;
  h.now = scenario.runtime.chat.deadlineAt + 1;
  await h.manager.cycleOne(id);
  events = h.state.diagnostics || [];
  assert.ok(events.some(event => event.event === 'СЦЕНАРІЙ_TIMEOUT_ПРОДОВЖЕНО_ГЕНЕРАЦІЯ_ТРИВАЄ'));
  scenario = (await h.manager.get(id)).scenario;
  assert.ok(scenario.runtime.chat.deadlineAt > h.now);

  mode = 'READY';
  h.now += 5_000;
  await h.manager.cycleOne(id);
  events = h.state.diagnostics || [];
  assert.ok(events.some(event => event.event === 'СЦЕНАРІЙ_ВІДПОВІДЬ_ПІДТВЕРДЖЕНО_ЗАВЕРШЕНОЮ'
    && event.status === 'READY'));
});

test('pool get returns one aggregate controller while keeping physical member ids for diagnostics', async () => {
  const h = harness({ report: async () => ({ status: 'WAITING', assistantComplete: false }) });
  const created = await h.manager.createChatPool({
    name: 'Night Chess',
    count: 10,
    replacementBudget: 2,
    staggerSeconds: 120,
    autoStart: false,
    config: chessConfig,
  });
  const detail = await h.manager.getChatPool(created.pool.id);
  assert.equal(detail.pool.slots, 10);
  assert.equal(detail.pool.name, 'Night Chess');
  assert.equal(detail.pool.representativeId, detail.scenario.id);
  assert.equal(detail.scenario.poolController, true);
  assert.equal(detail.memberIds.length, 10);
});


test('3 physical Sends plus 1 completed response can never be displayed as logical 3/12 progress', () => {
  const coreState = {
    sessionOrder: ['managed-current'],
    sessionsById: {
      'managed-current': {
        id: 'managed-current',
        successfulSendCount: 1,
        operation: { phase: 'SENT_VERIFIED' },
        scenarioWork: { managed: true, scenarioId: 'slot-1', generation: 1 },
      },
    },
  };
  const scenarios = [{
    id: 'slot-1',
    name: 'шахи. — чат 1',
    pool: { id: 'chess-pool', name: 'шахи.', slotIndex: 1, replacementBudget: 3 },
    config: {
      mode: 'CHAT_CYCLE',
      roundsPerGeneration: 1,
      steps: [{ repeat: 1 }, { repeat: 10 }, { repeat: 1 }],
    },
    runtime: {
      mode: 'CHAT_CYCLE',
      runState: 'RUNNING',
      generation: 1,
      totalCompletedTurns: 1,
      retiredVerifiedSends: 2,
      generationRetiredVerifiedSends: 2,
      verifiedSendHistoryComplete: true,
      round: 0,
      stepIndex: 0,
      repeatIndex: 0,
      cleanupPendingSessionIds: [],
      chat: {
        key: 'chat', role: 'CHAT', state: 'WAITING', generation: 1,
        sessionId: 'managed-current', stage: 'STEP:0:0:0',
      },
    },
  }];

  const status = projectGlobalStatus({ coreState, scenarios });
  const row = status.scenarioSlots[0];
  assert.equal(row.transportVerifiedSends, 3, 'physical transport truth is preserved');
  assert.equal(row.completedResponses, 1, 'only one assistant response was actually confirmed');
  assert.equal(row.sequenceVerifiedSends, 2, 'one completed response permits only one current in-flight logical Send');
  assert.equal(row.retryVerifiedSends, 1, 'the extra physical Send is exposed as retry/replacement history');
  assert.equal(row.message, 2, 'logical step is derived from confirmed sequence progress, never stale rewound cursor');
  assert.equal(status.scenarioPools[0].sequenceVerifiedSends, 2);
  assert.equal(status.scenarioPools[0].transportVerifiedSends, 3);
  assert.equal(status.scenarioPools[0].retryVerifiedSends, 1);
});

test('CHAT_CYCLE timeout retries the same logical prompt and never rewinds completed progress to START', async () => {
  let reportMode = 'READY';
  const h = harness({
    report: async () => reportMode === 'READY'
      ? { status: 'READY', assistantComplete: true, safeDiagnosticCode: 'ASSISTANT_RESPONSE_READY', assistantText: 'done' }
      : { status: 'WAITING', assistantComplete: false, safeDiagnosticCode: 'ASSISTANT_RESPONSE_NOT_READY' },
  });
  const created = await h.manager.createChatPool({
    name: 'Chess timeout truth',
    count: 1,
    replacementBudget: 1,
    staggerSeconds: 0,
    autoStart: true,
    config: { ...chessConfig, responseTimeoutMinutes: 1 },
  });
  const id = created.ids[0];

  let scenario = (await h.manager.get(id)).scenario;
  let session = h.state.sessionsById[scenario.runtime.chat.sessionId];
  let task = session.tasksById[scenario.runtime.chat.taskId];
  task.lastVerifiedSendAt = h.now + 1;
  task.lastConversationUrl = 'https://chatgpt.com/c/first';
  session.successfulSendCount = 1;
  session.onePassCompletedCount = 1;
  session.onePassCompletedTaskIds = [task.id];
  session.runState = 'COMPLETED';

  h.now += 10;
  await h.manager.cycleOne(id);
  scenario = (await h.manager.get(id)).scenario;
  assert.equal(scenario.runtime.totalCompletedTurns, 1);
  assert.equal(scenario.runtime.stepIndex, 1);
  assert.equal(scenario.runtime.repeatIndex, 0);
  assert.equal(scenario.runtime.chat.stage, 'STEP:0:1:0');
  session = h.state.sessionsById[scenario.runtime.chat.sessionId];
  task = session.tasksById[scenario.runtime.chat.taskId];
  assert.equal(task.promptOverride, 'CONTINUE');

  reportMode = 'WAITING';
  task.lastVerifiedSendAt = h.now + 1;
  task.lastConversationUrl = 'https://chatgpt.com/c/first';
  session.successfulSendCount += 1;
  session.onePassCompletedCount = 1;
  session.onePassCompletedTaskIds = [task.id];
  session.runState = 'COMPLETED';

  scenario = (await h.manager.get(id)).scenario;
  h.now = scenario.runtime.chat.deadlineAt + 1;
  await h.manager.cycleOne(id);
  scenario = (await h.manager.get(id)).scenario;

  assert.equal(scenario.runtime.totalCompletedTurns, 1, 'timeout is not a completed assistant response');
  assert.equal(scenario.runtime.stepIndex, 1, 'completed START progress is never rewound');
  assert.equal(scenario.runtime.repeatIndex, 0);
  assert.equal(scenario.runtime.chat.stage, 'STEP:0:1:0', 'replacement retries the current logical CONTINUE turn');
  const replacementSession = h.state.sessionsById[scenario.runtime.chat.sessionId];
  const replacementTask = replacementSession.tasksById[scenario.runtime.chat.taskId];
  assert.equal(replacementTask.promptOverride, 'CONTINUE');
});

test('timeout with no replacement budget is ERROR, never false COMPLETED', async () => {
  const h = harness({
    report: async () => ({ status: 'WAITING', assistantComplete: false, safeDiagnosticCode: 'ASSISTANT_RESPONSE_NOT_READY' }),
  });
  const created = await h.manager.createChatPool({
    name: 'No fake completion',
    count: 1,
    replacementBudget: 0,
    staggerSeconds: 0,
    autoStart: true,
    config: { ...chessConfig, responseTimeoutMinutes: 1 },
  });
  const id = created.ids[0];
  let scenario = (await h.manager.get(id)).scenario;
  const session = h.state.sessionsById[scenario.runtime.chat.sessionId];
  const task = session.tasksById[scenario.runtime.chat.taskId];
  task.lastVerifiedSendAt = h.now + 1;
  task.lastConversationUrl = 'https://chatgpt.com/c/no-response';
  session.successfulSendCount = 1;
  scenario = (await h.manager.get(id)).scenario;
  h.now = scenario.runtime.chat.deadlineAt + 1;
  await h.manager.cycleOne(id);
  scenario = (await h.manager.get(id)).scenario;
  assert.equal(scenario.runtime.runState, 'ERROR');
  assert.match(scenario.runtime.lastError, /timeout/u);
  assert.equal(scenario.runtime.totalCompletedTurns, 0);
});


test('one ERROR slot never removes whole-pool Pause control from still-running siblings', async () => {
  const h = harness({
    report: async () => ({ status: 'WAITING', assistantComplete: false, safeDiagnosticCode: 'ASSISTANT_RESPONSE_NOT_READY' }),
  });
  const created = await h.manager.createChatPool({
    name: 'Partial failure control',
    count: 2,
    replacementBudget: 0,
    staggerSeconds: 0,
    autoStart: true,
    config: { ...chessConfig, responseTimeoutMinutes: 1 },
  });
  const [failedId, runningId] = created.ids;
  let failed = (await h.manager.get(failedId)).scenario;
  const failedSession = h.state.sessionsById[failed.runtime.chat.sessionId];
  const failedTask = failedSession.tasksById[failed.runtime.chat.taskId];
  failedTask.lastVerifiedSendAt = h.now + 1;
  failedTask.lastConversationUrl = 'https://chatgpt.com/c/partial-failure';
  failedSession.successfulSendCount = 1;

  h.now = failed.runtime.chat.deadlineAt + 1;
  await h.manager.cycleOne(failedId);
  failed = (await h.manager.get(failedId)).scenario;
  assert.equal(failed.runtime.runState, 'ERROR');
  assert.equal((await h.manager.get(runningId)).scenario.runtime.runState, 'RUNNING');

  let list = await h.manager.list();
  assert.equal(list.pools[0].runState, 'RUNNING');
  assert.equal(list.pools[0].active, 1);
  assert.equal(list.pools[0].error, 1);

  await h.manager.pauseChatPool(created.pool.id);
  list = await h.manager.list();
  assert.equal(list.pools[0].runState, 'PAUSED');
  assert.equal(list.pools[0].paused, 1);
  assert.equal(list.pools[0].error, 1);
});
