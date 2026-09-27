import test from 'node:test';
import assert from 'node:assert/strict';

import { ScenarioWorkManager } from '../src/core/scenario-work-manager.js';
import { createEmptyState } from '../src/core/schema.js';

const NOW = 1_800_000_000_000;

class MemoryCoreRepository {
  constructor() {
    this.state = createEmptyState(NOW);
  }

  async load() {
    return structuredClone(this.state);
  }

  async update(mutator) {
    const draft = structuredClone(this.state);
    this.state = await mutator(draft) || draft;
    this.state.revision = Number(this.state.revision || 0) + 1;
    return structuredClone(this.state);
  }
}

function chromeHarness() {
  const storage = {};
  return {
    _storage: storage,
    storage: {
      local: {
        async get(key) { return { [key]: storage[key] }; },
        async set(record) { Object.assign(storage, structuredClone(record)); },
      },
    },
    alarms: {
      async create() {},
      async clear() { return true; },
    },
    tabs: {
      async remove() {},
    },
  };
}

test('Scenario tab recovery at response deadline extends grace instead of replacement', async () => {
  const coreRepository = new MemoryCoreRepository();
  let idCounter = 0;
  const manager = new ScenarioWorkManager({
    coreRepository,
    chromeApi: chromeHarness(),
    now: () => NOW,
    createId: () => `scenario-recovery-${++idCounter}`,
    collectAssistantReport: async () => ({
      status: 'TEMPORARY_ERROR',
      assistantComplete: false,
      safeDiagnosticCode: 'ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING',
      tabRecoveryPending: true,
    }),
  });

  const created = await manager.create({
    name: 'Recovery',
    config: {
      launchUrl: 'https://chatgpt.com/',
      steps: [{ prompt: 'test' }],
      responseTimeoutMinutes: 1,
      pollSeconds: 5,
    },
  });
  const scenarioId = created.scenario.id;
  await manager.start(scenarioId);

  let current = await manager.get(scenarioId);
  const participant = current.scenario.runtime.chat;
  assert.equal(participant.state, 'WAITING');

  await coreRepository.update(state => {
    const session = state.sessionsById[participant.sessionId];
    const task = session.tasksById[participant.taskIdCore || participant.taskId];
    task.lastVerifiedSendAt = NOW - 60_001;
    task.lastConversationUrl = 'https://chatgpt.com/c/recovery-test';
    session.successfulSendCount = 1;
    return state;
  });
  await manager.update(store => {
    store.byId[scenarioId].runtime.chat.deadlineAt = NOW - 1;
    return store;
  });

  await manager.cycleOne(scenarioId);
  current = await manager.get(scenarioId);

  assert.equal(current.scenario.runtime.chat.state, 'WAITING');
  assert.equal(current.scenario.runtime.chat.deadlineAt, NOW + 5 * 60_000);
  assert.equal(current.scenario.runtime.chat.tabRecoveryGraceCount, 1);
  assert.notEqual(current.scenario.runtime.runState, 'ERROR');
});


test('legacy default 15s polling migrates once to 180s without overriding later owner choice', async () => {
  const coreRepository = new MemoryCoreRepository();
  const chromeApi = chromeHarness();
  let idCounter = 0;
  const manager = new ScenarioWorkManager({
    coreRepository,
    chromeApi,
    now: () => NOW,
    createId: () => `scenario-migration-${++idCounter}`,
    collectAssistantReport: async () => null,
  });

  const created = await manager.create({
    name: 'Legacy poll',
    config: {
      launchUrl: 'https://chatgpt.com/',
      steps: [{ prompt: 'test' }],
      pollSeconds: 15,
    },
  });
  const scenarioId = created.scenario.id;
  assert.equal((await manager.get(scenarioId)).scenario.config.pollSeconds, 15);

  delete chromeApi._storage.autopilotScenarioTabRecoveryMigrationV1;
  const migrated = await manager.get(scenarioId);
  assert.equal(migrated.scenario.config.pollSeconds, 180);
  assert.equal(chromeApi._storage.autopilotScenarioTabRecoveryMigrationV1, undefined);

  await manager.update(store => store);
  assert.equal(chromeApi._storage.autopilotScenarioTabRecoveryMigrationV1, true);
  assert.equal((await manager.get(scenarioId)).scenario.config.pollSeconds, 180);

  await manager.update(store => {
    store.byId[scenarioId].config.pollSeconds = 15;
    return store;
  });
  assert.equal((await manager.get(scenarioId)).scenario.config.pollSeconds, 15);
});
