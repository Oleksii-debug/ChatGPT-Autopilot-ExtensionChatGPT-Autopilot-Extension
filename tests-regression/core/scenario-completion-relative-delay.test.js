import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ScenarioWorkMode,
  createScenarioWorkRuntime,
  startScenarioWork,
  planScenarioWorkActions,
  applyScenarioLaunch,
  applyScenarioCompletion,
} from '../../src/core/scenario-work.js';
import {
  ScenarioWorkManager,
  SCENARIO_WORK_STORAGE_KEY,
} from '../../src/core/scenario-work-manager.js';

function chatConfig(overrides = {}) {
  return {
    id: 'completion-delay-chat',
    name: 'Completion delay',
    mode: ScenarioWorkMode.CHAT_CYCLE,
    enabled: true,
    roundsPerGeneration: 3,
    maxGenerations: 1,
    responseTimeoutMinutes: 40,
    pollSeconds: 15,
    minimumLaunchGapSeconds: 60,
    preSendDelaySeconds: 1,
    busyCheckDelaySeconds: 1,
    retryBackoffSeconds: 5,
    launchUrl: 'https://chatgpt.com/',
    steps: [{ id: 'continue', label: 'Continue', prompt: 'Continue.', repeat: 2 }],
    restartCurrentRoundOnTimeout: true,
    ...overrides,
  };
}

function startAndLaunch(config, at = 1_000) {
  let runtime = createScenarioWorkRuntime(config, at);
  runtime = startScenarioWork(config, runtime, at);
  const planned = planScenarioWorkActions(config, runtime, at);
  assert.equal(planned.actions.length, 1);
  runtime = applyScenarioLaunch(planned.runtime, planned.actions[0], {
    sessionId: 'managed-1',
    taskId: 'managed-1:task',
    now: at,
  });
  return runtime;
}

test('Scenario CHAT_CYCLE delay starts at actual assistant completion, not prior launch', () => {
  const config = chatConfig();
  let runtime = startAndLaunch(config, 1_000);

  runtime = applyScenarioCompletion(config, runtime, 'chat', {
    chatUrl: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    assistantText: 'done',
    now: 21_000,
  });

  assert.equal(runtime.repeatIndex, 1);
  assert.equal(runtime.lastLaunchAt, 1_000);
  assert.equal(runtime.nextLaunchAt, 81_000);

  assert.deepEqual(planScenarioWorkActions(config, runtime, 80_999).actions, []);
  const due = planScenarioWorkActions(config, runtime, 81_000);
  assert.equal(due.actions.length, 1);
  assert.equal(due.actions[0].stage, 'STEP:0:1');
});

test('Scenario zero completion delay advances repeat immediately', () => {
  const config = chatConfig({ minimumLaunchGapSeconds: 0 });
  let runtime = startAndLaunch(config, 1_000);
  runtime = applyScenarioCompletion(config, runtime, 'chat', {
    chatUrl: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    assistantText: 'done',
    now: 21_000,
  });

  assert.equal(runtime.nextLaunchAt, 0);
  const planned = planScenarioWorkActions(config, runtime, 21_000);
  assert.equal(planned.actions.length, 1);
  assert.equal(planned.actions[0].stage, 'STEP:0:1');
});

test('Scenario PAIRS applies completion-relative delay before bootstrap worker', () => {
  const config = {
    ...chatConfig(),
    id: 'completion-delay-pairs',
    mode: ScenarioWorkMode.PAIRS,
    pairCount: 1,
    auditorLaunchUrl: 'https://chatgpt.com/',
    workerLaunchUrl: 'https://chatgpt.com/',
    auditorBootstrapPrompt: 'Audit bootstrap',
    workerBootstrapPrompt: 'Worker bootstrap',
    auditorCyclePrompt: 'Audit',
    workerCyclePrompt: 'Work',
    timeoutAuditorPrompt: 'Timeout audit',
    replacementAuditorPrompt: 'Replacement audit',
  };
  let runtime = createScenarioWorkRuntime(config, 1_000);
  runtime = startScenarioWork(config, runtime, 1_000);
  let planned = planScenarioWorkActions(config, runtime, 1_000);
  assert.equal(planned.actions[0].participantKey, 'pair:1:auditor');
  runtime = applyScenarioLaunch(planned.runtime, planned.actions[0], {
    sessionId: 'pair-auditor', taskId: 'pair-auditor:task', now: 1_000,
  });

  runtime = applyScenarioCompletion(config, runtime, 'pair:1:auditor', {
    chatUrl: 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222',
    assistantText: 'done',
    now: 31_000,
  });
  assert.equal(runtime.nextLaunchAt, 91_000);
  assert.deepEqual(planScenarioWorkActions(config, runtime, 90_999).actions, []);
  planned = planScenarioWorkActions(config, runtime, 91_000);
  assert.equal(planned.actions.length, 1);
  assert.equal(planned.actions[0].participantKey, 'pair:1:worker');
  assert.equal(planned.actions[0].stage, 'BOOTSTRAP_WORKER');
});

test('Scenario AUDITOR_GROUP applies completion-relative delay before worker wave', () => {
  const config = {
    ...chatConfig(),
    id: 'completion-delay-group',
    mode: ScenarioWorkMode.AUDITOR_GROUP,
    workerCount: 2,
    auditorLaunchUrl: 'https://chatgpt.com/',
    workerLaunchUrl: 'https://chatgpt.com/',
    auditorBootstrapPrompt: 'Audit bootstrap',
    workerBootstrapPrompt: 'Worker bootstrap',
    auditorCyclePrompt: 'Audit',
    workerCyclePrompt: 'Work',
    timeoutAuditorPrompt: 'Timeout audit',
    replacementAuditorPrompt: 'Replacement audit',
  };
  let runtime = createScenarioWorkRuntime(config, 1_000);
  runtime = startScenarioWork(config, runtime, 1_000);
  let planned = planScenarioWorkActions(config, runtime, 1_000);
  runtime = applyScenarioLaunch(planned.runtime, planned.actions[0], {
    sessionId: 'group-auditor', taskId: 'group-auditor:task', now: 1_000,
  });

  runtime = applyScenarioCompletion(config, runtime, 'group:auditor', {
    chatUrl: 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333',
    assistantText: 'done',
    now: 41_000,
  });
  assert.equal(runtime.nextLaunchAt, 101_000);
  assert.deepEqual(planScenarioWorkActions(config, runtime, 100_999).actions, []);
  planned = planScenarioWorkActions(config, runtime, 101_000);
  assert.equal(planned.actions.length, 1);
  assert.match(planned.actions[0].participantKey, /^group:worker:/);
});

class MemoryStorage {
  constructor(initial = {}) { this.data = structuredClone(initial); }
  async get(key) {
    if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, structuredClone(this.data[k])]));
    return { [key]: structuredClone(this.data[key]) };
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
}

test('Scenario manager persists nextLaunchAt and wakes at completion deadline instead of poll-looping', async () => {
  const config = chatConfig();
  let runtime = createScenarioWorkRuntime(config, 1_000);
  runtime = startScenarioWork(config, runtime, 1_000);
  runtime.chat.state = 'READY';
  runtime.lastLaunchAt = 1_000;
  runtime.nextLaunchAt = 81_000;

  const store = {
    schemaVersion: 1,
    selectedId: config.id,
    order: [config.id],
    byId: {
      [config.id]: {
        id: config.id,
        name: config.name,
        config,
        runtime,
        createdAt: 1_000,
        updatedAt: 21_000,
      },
    },
  };
  const storage = new MemoryStorage({ [SCENARIO_WORK_STORAGE_KEY]: store });
  const alarmCalls = [];
  const chromeApi = {
    storage: { local: storage },
    alarms: {
      async create(name, details) { alarmCalls.push(['create', name, details.when]); },
      async clear(name) { alarmCalls.push(['clear', name]); return true; },
    },
  };
  const coreRepository = {
    async load() { return { sessionsById: {}, sessionOrder: [], tabHintsByTaskId: {} }; },
    async update(fn) {
      const state = { sessionsById: {}, sessionOrder: [], tabHintsByTaskId: {} };
      return fn(state);
    },
  };
  const manager = new ScenarioWorkManager({
    coreRepository,
    chromeApi,
    collectAssistantReport: async () => ({ status: 'BUSY', assistantComplete: false }),
    now: () => 21_000,
  });

  const loaded = await manager.load();
  assert.equal(loaded.byId[config.id].runtime.nextLaunchAt, 81_000);
  assert.equal(await manager.nextWakeAt(), 81_000);
  assert.equal(await manager.reconcileAlarm(), 81_000);
  assert.deepEqual(alarmCalls.at(-1), ['create', 'autopilot-scenario-work-wake', 81_000]);
});

test('Scenario manager normalizes legacy runtime without nextLaunchAt to zero', async () => {
  const config = chatConfig();
  const runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 1_000), 1_000);
  delete runtime.nextLaunchAt;
  const store = {
    schemaVersion: 1,
    selectedId: config.id,
    order: [config.id],
    byId: {
      [config.id]: { id: config.id, name: config.name, config, runtime, createdAt: 1_000, updatedAt: 1_000 },
    },
  };
  const storage = new MemoryStorage({ [SCENARIO_WORK_STORAGE_KEY]: store });
  const manager = new ScenarioWorkManager({
    coreRepository: { async load(){ return { sessionsById:{}, sessionOrder:[], tabHintsByTaskId:{} }; }, async update(fn){ return fn({sessionsById:{},sessionOrder:[],tabHintsByTaskId:{}}); } },
    chromeApi: { storage:{local:storage}, alarms:{async create(){},async clear(){return true;}} },
    collectAssistantReport: async () => ({ status: 'BUSY' }),
    now: () => 2_000,
  });
  const loaded = await manager.load();
  assert.equal(loaded.byId[config.id].runtime.nextLaunchAt, 0);
});
