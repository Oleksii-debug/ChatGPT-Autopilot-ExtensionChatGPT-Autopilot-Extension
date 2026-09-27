import test from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioWorkManager, SCENARIO_WORK_STORAGE_KEY } from '../src/core/scenario-work-manager.js';
import { ScenarioWorkMode, ScenarioWorkRunState } from '../src/core/scenario-work.js';
import { createEmptyState } from '../src/core/schema.js';

class MemoryStorage {
  constructor() { this.data = {}; }
  async get(key) {
    if (Array.isArray(key)) return Object.fromEntries(key.filter(k => k in this.data).map(k => [k, structuredClone(this.data[k])]));
    return key in this.data ? { [key]: structuredClone(this.data[key]) } : {};
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key]; }
}
class CoreRepo {
  constructor() { this.state = createEmptyState(0); this.chain = Promise.resolve(); }
  async load() { return structuredClone(this.state); }
  update(mutator) {
    const op = this.chain.then(async () => { const draft = structuredClone(this.state); this.state = await mutator(draft) || draft; this.state.revision += 1; return structuredClone(this.state); });
    this.chain = op.catch(() => undefined); return op;
  }
}
function chromeFake() {
  const storage = new MemoryStorage();
  const alarms = { created: [], async create(name, info) { this.created.push({ name, ...info }); }, async clear() { return true; } };
  return { storage: { local: storage }, alarms };
}

test('manager fails safe on malformed persisted Scenario Work stores and prototype-key selection', async () => {
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({
    coreRepository: core,
    chromeApi: chrome,
    now: () => 1000,
    createId: () => 'unused',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }),
  });

  const corruptStores = [
    { schemaVersion: 1, selectedId: 'ghost', order: ['ghost'], byId: null },
    { schemaVersion: 1, selectedId: 'ghost', order: ['ghost'], byId: [] },
    { schemaVersion: 1, selectedId: 'ghost', order: ['ghost'], byId: { ghost: [] } },
    { schemaVersion: 1, selectedId: 'ghost', order: ['ghost'], byId: { ghost: 'not-a-record' } },
    { schemaVersion: 1, selectedId: '__proto__', order: [], byId: {} },
  ];

  for (const stored of corruptStores) {
    await chrome.storage.local.set({ [SCENARIO_WORK_STORAGE_KEY]: stored });
    const listed = await manager.list();
    assert.equal(listed.selectedId, '');
    assert.deepEqual(listed.scenarios, []);
  }
});

test('manager preserves a valid persisted scenario while omitting an invalid sibling record', async () => {
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({
    coreRepository: core,
    chromeApi: chrome,
    now: () => 1000,
    createId: () => 'valid',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }),
  });
  await manager.create({ name: 'Valid', mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });

  const stored = chrome.storage.local.data[SCENARIO_WORK_STORAGE_KEY];
  stored.order.push('corrupt');
  stored.byId.corrupt = [];
  stored.selectedId = 'valid';

  const listed = await manager.list();
  assert.equal(listed.selectedId, 'valid');
  assert.deepEqual(listed.scenarios.map(item => item.id), ['valid']);
  assert.equal(listed.scenarios[0].name, 'Valid');
});


test('manager migrates only known legacy config defaults during recovery', async () => {
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({
    coreRepository: core,
    chromeApi: chrome,
    now: () => 1000,
    createId: () => 'legacy',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }),
  });
  await manager.create({ name: 'Legacy', mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });

  const stored = structuredClone(chrome.storage.local.data[SCENARIO_WORK_STORAGE_KEY]);
  delete stored.byId.legacy.config.schemaVersion;
  delete stored.byId.legacy.config.timeoutPolicy;
  await chrome.storage.local.set({ [SCENARIO_WORK_STORAGE_KEY]: stored });

  const listed = await manager.list();
  assert.equal(listed.selectedId, 'legacy');
  assert.deepEqual(listed.scenarios.map(item => item.id), ['legacy']);
  assert.equal(listed.scenarios[0].config.schemaVersion, 1);
  assert.equal(listed.scenarios[0].config.timeoutPolicy, 'REPLACE_MEMBER');
});

test('manager recovery never turns malformed persisted config into runnable defaults or coercive aliases', async () => {
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({
    coreRepository: core,
    chromeApi: chrome,
    now: () => 1000,
    createId: () => 'valid',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }),
  });
  await manager.create({ name: 'Valid', mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });
  const canonical = structuredClone(chrome.storage.local.data[SCENARIO_WORK_STORAGE_KEY]);

  const corruptions = [
    ['missing executable steps', store => { delete store.byId.valid.config.steps; }],
    ['numeric-string coercion', store => { store.byId.valid.config.roundsPerGeneration = String(store.byId.valid.config.roundsPerGeneration); }],
    ['mismatched persisted config id', store => { store.byId.valid.config.id = 'other'; }],
    ['unknown persisted config authority', store => { store.byId.valid.config.hiddenAuthority = 'RUN'; }],
  ];
  for (const [name, mutate] of corruptions) {
    const stored = structuredClone(canonical);
    mutate(stored);
    await chrome.storage.local.set({ [SCENARIO_WORK_STORAGE_KEY]: stored });
    const listed = await manager.list();
    assert.equal(listed.selectedId, '', name);
    assert.deepEqual(listed.scenarios, [], name);
  }

  const executable = structuredClone(canonical);
  delete executable.byId.valid.config.steps;
  executable.byId.valid.runtime.runState = ScenarioWorkRunState.RUNNING;
  await chrome.storage.local.set({ [SCENARIO_WORK_STORAGE_KEY]: executable });
  const cycle = await manager.cycleAll();
  assert.equal(cycle.kind, 'IDLE');
  assert.deepEqual((await core.load()).sessionOrder, [], 'corrupt RUNNING persistence must not materialize a managed Session');

  await chrome.storage.local.set({ [SCENARIO_WORK_STORAGE_KEY]: canonical });
  const valid = await manager.list();
  assert.equal(valid.selectedId, 'valid');
  assert.deepEqual(valid.scenarios.map(item => item.id), ['valid']);
});

test('manager recovery rejects persisted accessors without executing getters', async () => {
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({
    coreRepository: core,
    chromeApi: chrome,
    now: () => 1000,
    createId: () => 'valid',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }),
  });
  await manager.create({ name: 'Valid', mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });

  const stored = chrome.storage.local.data[SCENARIO_WORK_STORAGE_KEY];
  let getterCalls = 0;
  Object.defineProperty(stored, 'order', {
    enumerable: true,
    configurable: true,
    get() { getterCalls += 1; return ['valid']; },
  });
  // Chrome storage serializes persisted values and cannot persist accessors.
  // Return the adversarial object directly here so this regression measures
  // ScenarioWork normalization itself rather than structuredClone invoking
  // the getter inside the in-memory transport fake.
  chrome.storage.local.get = async key => key === SCENARIO_WORK_STORAGE_KEY
    ? { [SCENARIO_WORK_STORAGE_KEY]: stored }
    : {};

  const listed = await manager.list();
  assert.equal(getterCalls, 0);
  assert.equal(listed.selectedId, '');
  assert.deepEqual(listed.scenarios, []);
});

test('manager omits accessor-backed or hidden scenario records while preserving valid siblings', async () => {
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({
    coreRepository: core,
    chromeApi: chrome,
    now: () => 1000,
    createId: () => 'valid',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }),
  });
  await manager.create({ name: 'Valid', mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });

  const stored = chrome.storage.local.data[SCENARIO_WORK_STORAGE_KEY];
  let getterCalls = 0;
  const accessorItem = {};
  Object.defineProperty(accessorItem, 'config', {
    enumerable: true,
    get() { getterCalls += 1; return stored.byId.valid.config; },
  });
  stored.order.push('accessor');
  Object.defineProperty(stored.byId, 'accessor', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: accessorItem,
  });

  const hiddenItem = structuredClone(stored.byId.valid);
  Object.defineProperty(hiddenItem, 'config', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: hiddenItem.config,
  });
  stored.order.push('hidden');
  Object.defineProperty(stored.byId, 'hidden', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: hiddenItem,
  });
  chrome.storage.local.get = async key => key === SCENARIO_WORK_STORAGE_KEY
    ? { [SCENARIO_WORK_STORAGE_KEY]: stored }
    : {};

  const listed = await manager.list();
  assert.equal(getterCalls, 0);
  assert.equal(listed.selectedId, 'valid');
  assert.deepEqual(listed.scenarios.map(item => item.id), ['valid']);
});

test('manager accepts repeated persisted data references while still rejecting cycles', async () => {
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({
    coreRepository: core,
    chromeApi: chrome,
    now: () => 1000,
    createId: () => 'valid',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }),
  });
  await manager.create({ name: 'Valid', mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });

  const stored = chrome.storage.local.data[SCENARIO_WORK_STORAGE_KEY];
  const shared = { evidence: 'same-object' };
  stored.byId.valid.runtime.sharedAliasA = shared;
  stored.byId.valid.runtime.sharedAliasB = shared;
  let listed = await manager.list();
  assert.deepEqual(listed.scenarios.map(item => item.id), ['valid']);

  const cyclic = {};
  cyclic.self = cyclic;
  stored.byId.valid.runtime.cyclic = cyclic;
  chrome.storage.local.get = async key => key === SCENARIO_WORK_STORAGE_KEY
    ? { [SCENARIO_WORK_STORAGE_KEY]: stored }
    : {};
  listed = await manager.list();
  assert.deepEqual(listed.scenarios, []);
});

test('manager materializes scenario turns only as canonical one-pass core sessions', async () => {
  let now = 1000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 's1', collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }) });
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });
  await manager.start('s1');
  const state = await core.load();
  const ids = state.sessionOrder.filter(id => id.startsWith('scenario-work:'));
  assert.equal(ids.length, 1);
  const session = state.sessionsById[ids[0]];
  assert.equal(session.runMode, 'ONE_PASS');
  assert.equal(session.scenarioWork.managed, true);
  assert.equal(session.sharedPrompt, '');
  assert.equal(session.tasksById[session.taskOrder[0]].promptOverride, 'ONE');
});

test('manager waits for assistant completion, preserves conversation URL, and launches next prompt in same chat', async () => {
  let now = 1000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  let assistantReady = false;
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 's1', collectAssistantReport: async () => ({ status: assistantReady ? 'READY' : 'WAITING', assistantComplete: assistantReady }) });
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: { roundsPerGeneration: 2, steps: [{ prompt: 'ONE' }, { prompt: 'TWO' }] } });
  await manager.start('s1');
  let state = await core.load();
  let sid = state.sessionOrder.find(id => id.startsWith('scenario-work:'));
  await markOnlyManagedSessionSent(core, 'https://chatgpt.com/c/abc');
  now = 1300; assistantReady = true;
  await manager.cycleOne('s1');
  state = await core.load();
  const live = state.sessionOrder.map(id => state.sessionsById[id]).find(item => item?.scenarioWork?.managed);
  const liveTask = live.tasksById[live.taskOrder[0]];
  assert.equal(live.id, sid, 'the same Core Session must own the next prompt');
  assert.equal(live.successfulSendCount, 1, 'cumulative send proof survives the new turn');
  assert.equal(liveTask.lastVerifiedSendAt, 0, 'old send proof must not complete the new turn');
  assert.equal(liveTask.normalizedUrl, 'https://chatgpt.com/c/abc');
  assert.equal(liveTask.promptOverride, 'TWO');
});

test('five independent chats each keep one Core Session and tab for 17 completed turns across restart', async () => {
  let now = 20_000;
  let ordinal = 0;
  const chrome = chromeFake();
  const retired = [];
  chrome.tabs = {
    async remove(id) { retired.push(id); },
    async get(id) { return { id }; },
  };
  const core = new CoreRepo();
  const build = () => new ScenarioWorkManager({
    coreRepository: core, chromeApi: chrome, now: () => now,
    createId: () => `slot-${++ordinal}`,
    collectAssistantReport: async () => ({ status: 'READY', assistantComplete: true, assistantText: 'done' }),
  });
  let manager = build();
  const ids = [];
  const sessionIds = new Map();
  for (let slot = 0; slot < 5; slot += 1) {
    const id = `slot-${slot + 1}`;
    ids.push(id);
    await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: {
      roundsPerGeneration: 1, maxGenerations: 0,
      steps: [{ prompt: 'BOOT' }, { prompt: 'CONT', repeat: 15 }, { prompt: 'FINAL' }],
    } });
    await manager.start(id);
    const session = (await core.load()).sessionOrder.find(sid => core.state.sessionsById[sid]?.scenarioWork?.scenarioId === id);
    sessionIds.set(id, session);
    const taskId = core.state.sessionsById[session].taskOrder[0];
    core.state.tabHintsByTaskId[taskId] = { sessionId: session, kind: 'TASK', tabId: 100 + slot,
      normalizedUrl: 'https://chatgpt.com/', ownedByExtension: true, retirePending: false };
  }

  for (let turn = 1; turn <= 17; turn += 1) {
    for (const [slot, id] of ids.entries()) {
      const sid = sessionIds.get(id);
      const taskId = core.state.sessionsById[sid].taskOrder[0];
      const expectedPrompt = turn === 1 ? 'BOOT' : turn === 17 ? 'FINAL' : 'CONT';
      assert.equal(core.state.sessionsById[sid].tasksById[taskId].promptOverride, expectedPrompt);
      const url = `https://chatgpt.com/c/slot-${slot + 1}`;
      const session = core.state.sessionsById[sid];
      session.tasksById[taskId].lastVerifiedSendAt = now + 1;
      session.tasksById[taskId].lastConversationUrl = url;
      session.operation = { phase: 'SENT_VERIFIED' };
      session.successfulSendCount += 1;
      session.onePassCompletedCount = 1;
      session.onePassCompletedTaskIds = [taskId];
      session.runState = 'COMPLETED';
      now += 100;
      if (turn === 9 && slot === 0) manager = build();
      await manager.cycleOne(id);
      const runtime = (await manager.get(id)).scenario.runtime;
      assert.equal(runtime.totalCompletedTurns, turn);
      if (turn < 17) {
        const state = await core.load();
        assert.equal(state.sessionsById[sid]?.successfulSendCount, turn);
        assert.equal(state.sessionsById[sid]?.tasksById[taskId].lastVerifiedSendAt, 0);
        assert.equal(state.tabHintsByTaskId[taskId]?.tabId, 100 + slot);
        assert.equal(state.tabHintsByTaskId[taskId]?.normalizedUrl, url);
        assert.equal(retired.length, 0, 'no physical tab may be retired before turn 17');
      } else {
        const state = await core.load();
        assert.equal(runtime.runState, 'COMPLETED');
        assert.equal(runtime.generation, 1, 'standalone CHAT_CYCLE never manufactures a second physical chat');
        assert.equal(runtime.retiredVerifiedSends, 17);
        assert.equal(runtime.generationRetiredVerifiedSends, 17);
        assert.equal(runtime.verifiedSendHistoryComplete, true);
        assert.equal(state.sessionsById[sid], undefined);
        assert.equal(state.sessionOrder.filter(candidate => state.sessionsById[candidate]?.scenarioWork?.scenarioId === id).length, 0);
      }
    }
  }
  assert.deepEqual(retired, [100, 101, 102, 103, 104]);
});

test('timed-out verified Send remains in durable totals after its Core Session is retired', async () => {
  let now = 11_000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  const build = () => new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => now,
    createId: () => 'timeout-ledger', collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }) });
  let manager = build();
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: {
    steps: [{ prompt: 'FIRST' }, { prompt: 'SECOND' }], responseTimeoutMinutes: 1,
  } });
  await manager.start('timeout-ledger');
  const sid = core.state.sessionOrder[0];
  await markOnlyManagedSessionSent(core, 'https://chatgpt.com/c/timeout-ledger', now + 1);
  now += 61_000;
  await manager.cycleOne('timeout-ledger');
  let runtime = (await manager.get('timeout-ledger')).scenario.runtime;
  assert.equal(runtime.totalCompletedTurns, 0);
  assert.equal(runtime.retiredVerifiedSends, 1);
  assert.equal(runtime.generationRetiredVerifiedSends, 1);
  assert.equal(core.state.sessionsById[sid]?.successfulSendCount, 0,
    'replacement chat starts a fresh Core Session after retiring the timed-out effect');
  assert.equal(core.state.sessionsById[sid]?.createdAt, now);
  manager = build();
  await manager.cycleOne('timeout-ledger');
  runtime = (await manager.get('timeout-ledger')).scenario.runtime;
  assert.equal(runtime.retiredVerifiedSends, 1, 'restart cannot count the retired send twice');
});

test('replayed launch never resets verified send or unresolved operation', async () => {
  let now = 9_000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => now,
    createId: () => 'replay', collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }) });
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }, { prompt: 'TWO' }] } });
  await manager.start('replay');
  const sid = core.state.sessionOrder[0];
  const taskId = core.state.sessionsById[sid].taskOrder[0];
  const firstAction = { participantKey: 'chat', generation: 1, stage: 'STEP:0:0:0', url: 'https://chatgpt.com/', prompt: 'ONE' };
  let snapshot = (await manager.get('replay')).scenario;
  await manager.materializeLaunch(snapshot, firstAction, now);
  assert.equal(core.state.sessionsById[sid].successfulSendCount, 0);

  core.state.sessionsById[sid].operation = { phase: 'AMBIGUOUS' };
  core.state.sessionsById[sid].runState = 'RECOVERING';
  await manager.materializeLaunch(snapshot, firstAction, now);
  assert.equal(core.state.sessionsById[sid].operation.phase, 'AMBIGUOUS');
  assert.equal(core.state.sessionsById[sid].runState, 'RECOVERING');
  const nextAction = { participantKey: 'chat', generation: 1, stage: 'STEP:0:1:0', url: 'https://chatgpt.com/c/replay', prompt: 'TWO' };
  snapshot.runtime.chat.state = 'READY';
  await assert.rejects(() => manager.materializeLaunch(snapshot, nextAction, now), /IDENTITY_COLLISION/);
});

test('restart between rearming a turn and its manager checkpoint reuses the same pending task', async () => {
  const chrome = chromeFake();
  const core = new CoreRepo();
  const build = () => new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => 10_000,
    createId: () => 'checkpoint', collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }) });
  let manager = build();
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'FIRST' }, { prompt: 'SECOND' }] } });
  await manager.start('checkpoint');
  const sid = core.state.sessionOrder[0];
  const taskId = core.state.sessionsById[sid].taskOrder[0];
  await markOnlyManagedSessionSent(core, 'https://chatgpt.com/c/checkpoint');
  const scenario = (await manager.get('checkpoint')).scenario;
  scenario.runtime.chat.state = 'READY'; // completion already durably checkpointed
  const next = { participantKey: 'chat', generation: 1, stage: 'STEP:0:1:0',
    url: 'https://chatgpt.com/c/checkpoint', prompt: 'SECOND' };
  await manager.materializeLaunch(scenario, next, 10_000);
  assert.equal(core.state.sessionsById[sid].successfulSendCount, 1);
  assert.equal(core.state.sessionsById[sid].tasksById[taskId].lastVerifiedSendAt, 0);
  manager = build();
  await manager.materializeLaunch(scenario, next, 10_001);
  assert.equal(core.state.sessionsById[sid].successfulSendCount, 1);
  assert.equal(core.state.sessionsById[sid].tasksById[taskId].promptOverride, 'SECOND');
  core.state.sessionsById[sid].tasksById[taskId].lastVerifiedSendAt = 10_002;
  core.state.sessionsById[sid].onePassCompletedCount = 1;
  core.state.sessionsById[sid].onePassCompletedTaskIds = [taskId];
  core.state.sessionsById[sid].successfulSendCount = 2;
  await manager.materializeLaunch(scenario, next, 10_003);
  assert.equal(core.state.sessionsById[sid].tasksById[taskId].lastVerifiedSendAt, 10_002,
    'a replay after a verified effect must never re-arm that send');
});

test('pause survives alarm reconciliation and resume launches pending work immediately', async () => {
  let now = 1000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 's1', collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }) });
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });
  await manager.start('s1');
  await manager.pause('s1');
  const paused = await manager.get('s1');
  assert.equal(paused.scenario.runtime.runState, ScenarioWorkRunState.PAUSED);
  const before = (await core.load()).sessionOrder.length;
  now = 5000;
  await manager.cycleAll();
  assert.equal((await core.load()).sessionOrder.length, before);
  await manager.resume('s1');
  assert.equal((await manager.get('s1')).scenario.runtime.runState, ScenarioWorkRunState.RUNNING);
});

import { SCENARIO_RESULT_MARKER, SCENARIO_RESULT_END_MARKER, AUDITOR_ALLOCATION_MARKER, AUDITOR_ALLOCATION_END_MARKER } from '../src/core/scenario-semantic.js';

function semanticBlock(payload) { return `${SCENARIO_RESULT_MARKER}\n${JSON.stringify(payload)}\n${SCENARIO_RESULT_END_MARKER}`; }
function auditBlock(payload) { return `${AUDITOR_ALLOCATION_MARKER}\n${JSON.stringify(payload)}\n${AUDITOR_ALLOCATION_END_MARKER}`; }

async function markOnlyManagedSessionSent(core, url, at = 1200) {
  const state = await core.load();
  const ids = state.sessionOrder.filter(id => state.sessionsById[id]?.scenarioWork?.managed && state.sessionsById[id]?.runState === 'RUNNING');
  assert.equal(ids.length, 1);
  const session = state.sessionsById[ids[0]];
  const taskId = session.taskOrder[0];
  session.tasksById[taskId].lastVerifiedSendAt = at;
  session.tasksById[taskId].lastConversationUrl = url;
  session.operation = { phase: 'SENT_VERIFIED' };
  session.successfulSendCount += 1;
  session.onePassCompletedCount = 1;
  session.onePassCompletedTaskIds = [taskId];
  session.runState = 'COMPLETED';
  core.state.sessionsById[ids[0]] = session;
  return { sessionId: ids[0], participantKey: session.scenarioWork.participantKey };
}

test('AUDITOR_PIPELINE manager enforces worker-result -> verified allocation -> dependency-ready SECOND end to end', async () => {
  let now = 1000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  const reports = new Map();
  const manager = new ScenarioWorkManager({
    coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 'pipe1',
    collectAssistantReport: async ({ id }) => reports.get(id) || ({ status: 'WAITING', assistantComplete: false }),
  });
  await manager.create({ mode: ScenarioWorkMode.AUDITOR_PIPELINE, config: {
    firstCount: 1, secondCount: 1, roundsPerGeneration: 1, maxGenerations: 1,
    barrierPolicy: 'WAIT_ALL_TERMINAL', minimumLaunchGapSeconds: 0,
    firstWorkerPrompt: 'FIRST', secondWorkerPrompt: 'SECOND', auditorPrompt: 'AUDIT',
  }});
  await manager.start('pipe1');
  let sent = await markOnlyManagedSessionSent(core, 'https://chatgpt.com/c/f1');
  assert.match(sent.participantKey, /first-01/);
  reports.set(`scenario-work:pipe1:${sent.participantKey}`, { status: 'READY', assistantComplete: true, assistantText: semanticBlock({
    scenario_id:'pipe1', generation:1, round:1, phase:'FIRST', slot:'FIRST-01', task_id:'F1', exclusive_key:'KF1', outcome:'DONE', slot_consumed:true, evidence_published:true, evidence_refs:['drive:f1'], dependencies_consumed:[], retry_required:false,
  }) });
  now = 1300; await manager.cycleOne('pipe1');

  sent = await markOnlyManagedSessionSent(core, 'https://chatgpt.com/c/a1', 1400);
  assert.equal(sent.participantKey, 'pipeline:auditor');
  reports.set(`scenario-work:pipe1:${sent.participantKey}`, { status: 'READY', assistantComplete: true, assistantText: auditBlock({
    scenario_id:'pipe1', generation:1, round:1, allocation_id:'A1', readback_verified:true, allocation_evidence_refs:['drive:allocation'], first_audit:[{task_id:'F1',slot:'FIRST-01',classification:'DONE',slot_consumed:true,evidence_ref:'drive:f1'}],
    reservations:[{ generation:1, round:1, phase:'SECOND', slot:'SECOND-01', task_id:'S1', exclusive_key:'KS1', scheduler_dependencies:['F1'], source_ref:'drive:a1', prompt:'' }],
  }) });
  now = 1500; await manager.cycleOne('pipe1');

  sent = await markOnlyManagedSessionSent(core, 'https://chatgpt.com/c/s1', 1600);
  assert.match(sent.participantKey, /second-01/);
  reports.set(`scenario-work:pipe1:${sent.participantKey}`, { status:'READY', assistantComplete:true, assistantText: semanticBlock({
    scenario_id:'pipe1', generation:1, round:1, phase:'SECOND', slot:'SECOND-01', task_id:'S1', exclusive_key:'KS1', outcome:'PASS', slot_consumed:true, evidence_published:true, evidence_refs:['drive:s1'], dependencies_consumed:['F1'], retry_required:false,
  }) });
  now = 1700; await manager.cycleOne('pipe1');
  const final = await manager.get('pipe1');
  assert.equal(final.scenario.runtime.runState, 'COMPLETED');
  assert.equal(final.scenario.runtime.totalVerifiedSlots, 2);
  assert.equal(final.scenario.runtime.allocation.allocationId, 'A1');
});

test('AUDITOR_PIPELINE invalid worker final answer opens correction in same conversation, not next slot', async () => {
  let now = 1000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  let report = { status: 'WAITING', assistantComplete: false };
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 'pipe2', collectAssistantReport: async () => report });
  await manager.create({ mode: ScenarioWorkMode.AUDITOR_PIPELINE, config: { firstCount: 1, secondCount: 1, roundsPerGeneration: 1, barrierPolicy:'WAIT_ALL_TERMINAL', firstWorkerPrompt:'FIRST' } });
  await manager.start('pipe2');
  await markOnlyManagedSessionSent(core, 'https://chatgpt.com/c/fixme');
  report = { status:'READY', assistantComplete:true, assistantText:'Готово.' };
  now=1300; await manager.cycleOne('pipe2');
  const state = await core.load();
  const live = state.sessionOrder.map(id=>state.sessionsById[id]).find(s=>s?.scenarioWork?.managed && s.runState==='RUNNING');
  assert.ok(live);
  const task=live.tasksById[live.taskOrder[0]];
  assert.equal(task.normalizedUrl,'https://chatgpt.com/c/fixme');
  assert.match(task.promptOverride,/AUTOPILOT_SCENARIO_RESULT/);
  const snap=await manager.get('pipe2');
  assert.equal(snap.scenario.runtime.totalVerifiedSlots,0);
  assert.equal(snap.scenario.runtime.firstSlots['1'].correctionPending,true);
});

test('AUDITOR_PIPELINE auditor lease survives manager reconstruction and prevents duplicate auditor launch', async () => {
  let now = 1000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  const reports = new Map();
  const build = () => new ScenarioWorkManager({
    coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 'pipe-restart-auditor',
    collectAssistantReport: async ({ id }) => reports.get(id) || ({ status:'WAITING', assistantComplete:false }),
  });
  let manager = build();
  await manager.create({ mode: ScenarioWorkMode.AUDITOR_PIPELINE, config: {
    firstCount:1, secondCount:1, roundsPerGeneration:1, maxGenerations:1,
    barrierPolicy:'WAIT_ALL_TERMINAL', minimumLaunchGapSeconds:0,
  }});
  await manager.start('pipe-restart-auditor');
  const first = await markOnlyManagedSessionSent(core, 'https://chatgpt.com/c/restart-first');
  reports.set(`scenario-work:pipe-restart-auditor:${first.participantKey}`, { status:'READY', assistantComplete:true, assistantText: semanticBlock({
    scenario_id:'pipe-restart-auditor', generation:1, round:1, phase:'FIRST', slot:'FIRST-01', task_id:'F1', exclusive_key:'KF1', outcome:'DONE', slot_consumed:true, evidence_published:true, evidence_refs:['drive:f1'], dependencies_consumed:[], retry_required:false,
  })});
  now=1300; await manager.cycleOne('pipe-restart-auditor');
  let snap=await manager.get('pipe-restart-auditor');
  assert.equal(snap.scenario.runtime.auditorLease?.active,true);
  const launchesBefore=snap.scenario.runtime.totalLaunches;

  manager = build();
  now=1400; await manager.cycleOne('pipe-restart-auditor');
  snap=await manager.get('pipe-restart-auditor');
  assert.equal(snap.scenario.runtime.auditorLease?.active,true);
  assert.equal(snap.scenario.runtime.totalLaunches, launchesBefore);
  const state=await core.load();
  const auditorSessions=state.sessionOrder.map(id=>state.sessionsById[id]).filter(s=>s?.scenarioWork?.participantKey==='pipeline:auditor' && s.runState==='RUNNING');
  assert.equal(auditorSessions.length,1);
});

test('AUDITOR_PIPELINE dependency wait survives manager reconstruction without materializing blocked SECOND', async () => {
  let now=1000;
  const chrome=chromeFake();
  const core=new CoreRepo();
  const reports=new Map();
  const build=()=>new ScenarioWorkManager({
    coreRepository:core, chromeApi:chrome, now:()=>now, createId:()=> 'pipe-restart-deps',
    collectAssistantReport:async ({id})=>reports.get(id)||({status:'WAITING',assistantComplete:false}),
  });
  let manager=build();
  await manager.create({ mode:ScenarioWorkMode.AUDITOR_PIPELINE, config:{ firstCount:1, secondCount:2, roundsPerGeneration:1, maxGenerations:1, barrierPolicy:'WAIT_ALL_TERMINAL', minimumLaunchGapSeconds:0 }});
  await manager.start('pipe-restart-deps');
  let sent=await markOnlyManagedSessionSent(core,'https://chatgpt.com/c/d-first');
  reports.set(`scenario-work:pipe-restart-deps:${sent.participantKey}`,{status:'READY',assistantComplete:true,assistantText:semanticBlock({scenario_id:'pipe-restart-deps',generation:1,round:1,phase:'FIRST',slot:'FIRST-01',task_id:'F1',exclusive_key:'KF1',outcome:'DONE',slot_consumed:true,evidence_published:true,evidence_refs:['drive:f1'],dependencies_consumed:[],retry_required:false})});
  now=1300; await manager.cycleOne('pipe-restart-deps');
  sent=await markOnlyManagedSessionSent(core,'https://chatgpt.com/c/d-auditor',1400);
  reports.set(`scenario-work:pipe-restart-deps:${sent.participantKey}`,{status:'READY',assistantComplete:true,assistantText:auditBlock({scenario_id:'pipe-restart-deps',generation:1,round:1,allocation_id:'DEP-A1',readback_verified:true,allocation_evidence_refs:['drive:allocation'],first_audit:[{task_id:'F1',slot:'FIRST-01',classification:'DONE',slot_consumed:true,evidence_ref:'drive:f1'}],reservations:[
    {generation:1,round:1,phase:'SECOND',slot:'SECOND-01',task_id:'S1',exclusive_key:'KS1',scheduler_dependencies:['F1'],source_ref:'drive:a1',prompt:''},
    {generation:1,round:1,phase:'SECOND',slot:'SECOND-02',task_id:'S2',exclusive_key:'KS2',scheduler_dependencies:['S1'],source_ref:'drive:a1',prompt:''},
  ]})});
  now=1500; await manager.cycleOne('pipe-restart-deps');
  let snap=await manager.get('pipe-restart-deps');
  assert.equal(snap.scenario.runtime.secondSlots['1'].state,'WAITING');
  assert.equal(snap.scenario.runtime.secondSlots['2'].state,'READY');

  manager=build();
  now=1600; await manager.cycleOne('pipe-restart-deps');
  snap=await manager.get('pipe-restart-deps');
  assert.equal(snap.scenario.runtime.secondSlots['2'].state,'READY');
  const state=await core.load();
  const blocked=state.sessionOrder.map(id=>state.sessionsById[id]).filter(s=>s?.scenarioWork?.participantKey?.includes('second-02') && s.runState==='RUNNING');
  assert.equal(blocked.length,0);
});

test('Scenario Pause/Resume/Stop synchronizes the actual managed Core Session lifecycle', async () => {
  let now = 10_000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 'life1', collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }) });
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });
  await manager.start('life1');
  let state = await core.load();
  const sid = state.sessionOrder.find(id => state.sessionsById[id]?.scenarioWork?.managed);
  assert.equal(state.sessionsById[sid].runState, 'RUNNING');
  await manager.pause('life1');
  state = await core.load();
  assert.equal(state.sessionsById[sid].runState, 'PAUSED');
  await manager.resume('life1');
  state = await core.load();
  assert.equal(state.sessionsById[sid].runState, 'RUNNING');
  await manager.stop('life1');
  state = await core.load();
  assert.equal(state.sessionsById[sid].runState, 'STOPPED');
  assert.equal(state.sessionsById[sid].enabled, false);
});

test('owner Pause racing assistant observation cannot be overwritten by stale Scenario cycle', async () => {
  let now = 20_000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const manager = new ScenarioWorkManager({
    coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 'race1',
    collectAssistantReport: async () => { enter(); await gate; return { status: 'READY', assistantComplete: true, assistantText: 'done' }; },
  });
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: { roundsPerGeneration: 2, steps: [{ prompt: 'ONE' }, { prompt: 'TWO' }] } });
  await manager.start('race1');
  let state = await core.load();
  const sid = state.sessionOrder.find(id => state.sessionsById[id]?.scenarioWork?.managed);
  const taskId = state.sessionsById[sid].taskOrder[0];
  core.state.sessionsById[sid].tasksById[taskId].lastVerifiedSendAt = now + 1;
  core.state.sessionsById[sid].tasksById[taskId].lastConversationUrl = 'https://chatgpt.com/c/race';
  core.state.sessionsById[sid].operation = { phase: 'SENT_VERIFIED' };
  const cycling = manager.cycleOne('race1');
  await entered;
  await manager.pause('race1');
  release();
  const result = await cycling;
  assert.equal(result.kind, 'CANCELLED_BY_OWNER');
  const live = await manager.get('race1');
  assert.equal(live.scenario.runtime.runState, 'PAUSED');
  state = await core.load();
  assert.ok(state.sessionsById[sid], 'completion evidence source must not be deleted after owner epoch changed');
  assert.equal(state.sessionsById[sid].runState, 'PAUSED');
});

test('standalone CHAT_CYCLE completes one physical chat while retired tab cleanup is retried', async () => {
  let now = 30_000;
  const chrome = chromeFake();
  const liveTabs = new Set([55]);
  let failClose = true;
  chrome.tabs = {
    async remove(id) { if (failClose) throw new Error('temporary close failure'); liveTabs.delete(id); },
    async get(id) { if (!liveTabs.has(id)) throw new Error(`No tab with id: ${id}`); return { id }; },
  };
  const core = new CoreRepo();
  let ready = false;
  const build = () => new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 'cleanup1', collectAssistantReport: async () => ({ status: ready ? 'READY' : 'WAITING', assistantComplete: ready, assistantText: ready ? 'done' : '' }) });
  let manager = build();
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: { roundsPerGeneration: 1, steps: [{ prompt: 'ONE' }] } });
  await manager.start('cleanup1');
  let state = await core.load();
  const sid = state.sessionOrder.find(id => state.sessionsById[id]?.scenarioWork?.managed);
  const taskId = state.sessionsById[sid].taskOrder[0];
  await markOnlyManagedSessionSent(core, 'https://chatgpt.com/c/cleanup', now + 1);
  core.state.tabHintsByTaskId[taskId] = { sessionId: sid, kind: 'TASK', tabId: 55, normalizedUrl: 'https://chatgpt.com/c/cleanup', ownedByExtension: true, retirePending: false };
  ready = true;
  now += 100;
  const first = await manager.cycleOne('cleanup1');
  assert.equal(first.kind, 'COMPLETED');
  let scenario = (await manager.get('cleanup1')).scenario;
  assert.deepEqual(scenario.runtime.cleanupPendingSessionIds, [sid]);
  assert.equal(scenario.runtime.runState, 'COMPLETED');
  assert.equal(scenario.runtime.generation, 1, 'standalone CHAT_CYCLE remains one physical chat');
  state = await core.load();
  assert.ok(state.sessionsById[sid]);
  assert.equal(state.sessionsById[sid].enabled, false);
  assert.equal(state.sessionsById[sid].runState, 'STOPPED');
  assert.equal(state.tabHintsByTaskId[taskId].retirePending, true);
  assert.equal(state.sessionOrder.filter(id => state.sessionsById[id]?.scenarioWork?.managed && id !== sid).length, 0, 'standalone CHAT_CYCLE must not launch a replacement generation');

  manager = build();
  failClose = false;
  now += 100;
  const second = await manager.cycleAll();
  assert.equal(second.kind, 'CYCLED');
  state = await core.load();
  assert.equal(state.sessionsById[sid], undefined, 'old managed Session is retired after restart');
  const active = state.sessionOrder.map(id => state.sessionsById[id]).filter(item => item?.scenarioWork?.managed && item.runState === 'RUNNING');
  assert.equal(active.length, 0, 'completed standalone CHAT_CYCLE has no replacement Session');
});

test('deterministic managed Session replay fails closed on identity collision', async () => {
  let now = 40_000;
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 'identity1', collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }) });
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });
  await manager.start('identity1');
  const current = (await manager.get('identity1')).scenario;
  const replay = structuredClone(current);
  replay.runtime.totalLaunches = 0;
  const action = { participantKey: 'chat', generation: 1, stage: 'STEP:0:0:0', url: 'https://chatgpt.com/', prompt: 'DIFFERENT' };
  await assert.rejects(() => manager.materializeLaunch(replay, action, now + 1), /SCENARIO_MANAGED_SESSION_IDENTITY_COLLISION/);
});

test('manager consumes persisted descriptor snapshots without Proxy get re-entry', async () => {
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({
    coreRepository: core,
    chromeApi: chrome,
    now: () => 1000,
    createId: () => 'valid',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }),
  });
  await manager.create({ name: 'Valid', mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });

  const stored = chrome.storage.local.data[SCENARIO_WORK_STORAGE_KEY];
  let reads = 0;
  const hostile = target => new Proxy(target, {
    get(object, property, receiver) {
      reads += 1;
      if (property === '0') return 'ghost';
      if (property === 'name') return 'Forged through get trap';
      return Reflect.get(object, property, receiver);
    },
  });

  const originalItem = stored.byId.valid;
  originalItem.config = hostile(originalItem.config);
  const itemProxy = hostile(originalItem);
  Object.defineProperty(stored.byId, 'valid', {
    value: itemProxy,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  stored.order = hostile(['valid']);

  chrome.storage.local.get = async key => key === SCENARIO_WORK_STORAGE_KEY
    ? { [SCENARIO_WORK_STORAGE_KEY]: stored }
    : {};

  const listed = await manager.list();
  assert.equal(reads, 0, 'recovery must consume descriptor snapshots, not caller get traps');
  assert.equal(listed.selectedId, 'valid');
  assert.deepEqual(listed.scenarios.map(item => item.id), ['valid']);
  assert.equal(listed.scenarios[0].name, 'Valid');
});



test('manager bounds persisted collection length and recursive depth bombs', async () => {
  const chrome = chromeFake();
  const core = new CoreRepo();
  const manager = new ScenarioWorkManager({
    coreRepository: core,
    chromeApi: chrome,
    now: () => 1000,
    createId: () => 'valid',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }),
  });
  await manager.create({ name: 'Valid', mode: ScenarioWorkMode.CHAT_CYCLE, config: { steps: [{ prompt: 'ONE' }] } });

  const stored = chrome.storage.local.data[SCENARIO_WORK_STORAGE_KEY];
  stored.order = new Array(10001);
  stored.order[0] = 'valid';
  chrome.storage.local.get = async key => key === SCENARIO_WORK_STORAGE_KEY
    ? { [SCENARIO_WORK_STORAGE_KEY]: stored }
    : {};

  let listed = await manager.list();
  assert.equal(listed.selectedId, '');
  assert.deepEqual(listed.scenarios, []);

  stored.order = ['valid'];
  const root = {};
  let cursor = root;
  for (let index = 0; index < 70; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  stored.byId.valid.runtime.persistedDepthBomb = root;

  listed = await manager.list();
  assert.equal(listed.selectedId, '');
  assert.deepEqual(listed.scenarios, []);
});
