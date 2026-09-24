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
  let session = state.sessionsById[sid];
  let task = session.tasksById[session.taskOrder[0]];
  task.lastVerifiedSendAt = 1200; task.lastConversationUrl = 'https://chatgpt.com/c/abc';
  core.state.sessionsById[sid] = session;
  now = 1300; assistantReady = true;
  await manager.cycleOne('s1');
  state = await core.load();
  const live = state.sessionOrder.map(id => state.sessionsById[id]).find(item => item?.scenarioWork?.managed);
  const liveTask = live.tasksById[live.taskOrder[0]];
  assert.equal(liveTask.normalizedUrl, 'https://chatgpt.com/c/abc');
  assert.equal(liveTask.promptOverride, 'TWO');
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

test('completion checkpoint survives tab-close failure and blocks next launch until restart cleanup succeeds', async () => {
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
  await manager.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: { roundsPerGeneration: 2, steps: [{ prompt: 'ONE' }, { prompt: 'TWO' }] } });
  await manager.start('cleanup1');
  let state = await core.load();
  const sid = state.sessionOrder.find(id => state.sessionsById[id]?.scenarioWork?.managed);
  const taskId = state.sessionsById[sid].taskOrder[0];
  core.state.sessionsById[sid].tasksById[taskId].lastVerifiedSendAt = now + 1;
  core.state.sessionsById[sid].tasksById[taskId].lastConversationUrl = 'https://chatgpt.com/c/cleanup';
  core.state.sessionsById[sid].operation = { phase: 'SENT_VERIFIED' };
  core.state.tabHintsByTaskId[taskId] = { sessionId: sid, kind: 'TASK', tabId: 55, normalizedUrl: 'https://chatgpt.com/c/cleanup', ownedByExtension: true, retirePending: false };
  ready = true;
  now += 100;
  const first = await manager.cycleOne('cleanup1');
  assert.equal(first.kind, 'CLEANUP_PENDING');
  let scenario = (await manager.get('cleanup1')).scenario;
  assert.deepEqual(scenario.runtime.cleanupPendingSessionIds, [sid]);
  assert.equal(scenario.runtime.stepIndex, 1, 'semantic completion must be durable before physical cleanup');
  state = await core.load();
  assert.ok(state.sessionsById[sid]);
  assert.equal(state.tabHintsByTaskId[taskId].retirePending, true);
  assert.equal(state.sessionOrder.filter(id => state.sessionsById[id]?.scenarioWork?.managed && id !== sid).length, 0, 'next turn must not launch while cleanup is pending');

  manager = build();
  failClose = false;
  now += 100;
  const second = await manager.cycleOne('cleanup1');
  assert.equal(second.kind, 'CYCLED');
  state = await core.load();
  assert.equal(state.sessionsById[sid], undefined, 'old managed Session is retired after restart');
  const active = state.sessionOrder.map(id => state.sessionsById[id]).filter(item => item?.scenarioWork?.managed && item.runState === 'RUNNING');
  assert.equal(active.length, 1);
  assert.equal(active[0].tasksById[active[0].taskOrder[0]].promptOverride, 'TWO');
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
  const action = { participantKey: 'chat', generation: 1, stage: 'STEP:0:0', url: 'https://chatgpt.com/', prompt: 'DIFFERENT' };
  await assert.rejects(() => manager.materializeLaunch(replay, action, now + 1), /SCENARIO_MANAGED_SESSION_IDENTITY_COLLISION/);
});
