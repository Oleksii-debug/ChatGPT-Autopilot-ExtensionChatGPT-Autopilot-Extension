import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState, OperationPhase, RunState } from '../src/core/schema.js';
import {
  createOrchestrationRuntime,
  normalizeOrchestrationRuntime,
  validateOrchestrationConfig,
} from '../src/core/orchestration-v2.js';
import { OrchestrationV2Controller } from '../src/core/orchestration-v2-controller.js';
import {
  OrchestrationBarrierMode,
  OrchestrationChatMode,
  OrchestrationHierarchyEventType,
} from '../src/core/orchestration-hierarchy.js';
import {
  hierarchyCoreSessionId,
  hierarchyCoreTaskId,
} from '../src/core/orchestration-hierarchy-core.js';
import { buildThreeLevelHierarchyTemplate } from '../src/core/orchestration-role-prompts.js';

const START = Date.parse('2026-09-19T00:00:00Z');
const MANAGER_CHAT = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const W1_CHAT = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
const W2_CHAT = 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333';

function graph() {
  return {
    schemaVersion: 1,
    graphId: 'controller-proof',
    controlEpoch: 1,
    promptProfiles: [
      { id: 'manager-v1', role: 'DOMAIN_MANAGER', version: 1, prompt: 'MANAGER PROMPT' },
      { id: 'worker-v1', role: 'WORKER', version: 1, prompt: 'WORKER PROMPT' },
    ],
    nodes: [
      {
        id: 'manager',
        parentId: null,
        childIds: ['worker-1', 'worker-2'],
        promptProfileId: 'manager-v1',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 2,
        barrier: { mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN },
      },
      {
        id: 'worker-1',
        parentId: 'manager',
        childIds: [],
        promptProfileId: 'worker-v1',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      },
      {
        id: 'worker-2',
        parentId: 'manager',
        childIds: [],
        promptProfileId: 'worker-v1',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      },
    ],
  };
}

function config() {
  return validateOrchestrationConfig({
    enabled: true,
    projectId: 'controller-proof',
    targetRepository: 'owner/repo',
    controlRepository: 'owner/repo',
    controlIssueNumber: 1,
    masterCoordinatorPrompt: 'LEGACY CONTROL PROMPT — unused while hierarchy is configured',
    defaultDesiredWorkers: 0,
    absoluteMaxWorkers: 4,
    maxLaunchesPerWindow: 4,
    launchWindowSeconds: 300,
    workerProbeIntervalSeconds: 30,
    watchdogIntervalSeconds: 300,
  });
}

class MemoryConfigRepository {
  constructor(value) { this.value = structuredClone(value); }
  async load() { return structuredClone(this.value); }
  async save(value) { this.value = structuredClone(value); return this.load(); }
}

class MemoryRuntimeRepository {
  constructor(value, configRepository, now) {
    this.value = structuredClone(value);
    this.configRepository = configRepository;
    this.now = now;
    this.chain = Promise.resolve();
  }
  async load() {
    return normalizeOrchestrationRuntime(this.value, await this.configRepository.load(), this.now());
  }
  async save(value) {
    this.value = normalizeOrchestrationRuntime(value, await this.configRepository.load(), this.now());
    return this.load();
  }
  update(mutator) {
    const operation = this.chain.then(async () => {
      const current = await this.load();
      const next = await mutator(current, await this.configRepository.load()) || current;
      this.value = normalizeOrchestrationRuntime(next, await this.configRepository.load(), this.now());
      return structuredClone(this.value);
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }
  async reset() {
    this.value = createOrchestrationRuntime(await this.configRepository.load(), this.now());
    return this.load();
  }
}

class MemoryCoreRepository {
  constructor(value) { this.value = structuredClone(value); this.chain = Promise.resolve(); }
  async load() { return structuredClone(this.value); }
  update(mutator) {
    const operation = this.chain.then(async () => {
      const draft = structuredClone(this.value);
      this.value = structuredClone(await mutator(draft) || draft);
      return this.load();
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }
}

function chromeFake() {
  let currentAlarm = null;
  return {
    alarms: {
      calls: [],
      async get(name) { return currentAlarm?.name === name ? structuredClone(currentAlarm) : null; },
      async create(name, options) {
        this.calls.push({ name, options });
        currentAlarm = { name, scheduledTime:options.when };
      },
      async clear() { currentAlarm = null; return true; },
      current() { return currentAlarm ? structuredClone(currentAlarm) : null; },
    },
  };
}

function harness({ collector = async () => ({ status: 'BUSY', assistantComplete: false }) } = {}) {
  let now = START;
  const cfg = config();
  const configRepository = new MemoryConfigRepository(cfg);
  const runtimeRepository = new MemoryRuntimeRepository(createOrchestrationRuntime(cfg, now), configRepository, () => now);
  const coreRepository = new MemoryCoreRepository(createEmptyState(now));
  const chrome = chromeFake();
  const controller = () => new OrchestrationV2Controller({
    coreRepository,
    chromeApi: chrome,
    configRepository,
    runtimeRepository,
    collectAssistantReport: collector,
    fetchFn: async () => { throw new Error('legacy control transport must not run in hierarchy mode'); },
    now: () => now,
  });
  return {
    controller,
    coreRepository,
    runtimeRepository,
    configRepository,
    chrome,
    now: () => now,
    advance(ms) { now += ms; return now; },
  };
}

async function confirmSend(h, nodeId, conversationUrl, hierarchyGraph = graph()) {
  const at = h.advance(1000);
  await h.coreRepository.update(state => {
    const sid = hierarchyCoreSessionId(hierarchyGraph.graphId, nodeId);
    const tid = hierarchyCoreTaskId(hierarchyGraph.graphId, nodeId);
    const session = state.sessionsById[sid];
    const task = session.tasksById[tid];
    task.lastVerifiedSendAt = at;
    task.lastConversationUrl = conversationUrl;
    task.lastVerifiedFingerprint = `fp-${nodeId}-${at}`;
    task.lastAssistantBaselineCount = 1;
    task.lastAssistantBaselineKnown = true;
    session.runState = RunState.STOPPED;
    session.completedAt = at;
    return state;
  });
  return at;
}

function fiveManagerGraph() {
  return buildThreeLevelHierarchyTemplate({
    graphId:'controller-starvation-proof',
    projectId:'controller-proof',
    targetRepository:'owner/repo',
    controlIssueNumber:1,
    domains:[
      { id:'one', scope:'one' }, { id:'two', scope:'two' }, { id:'three', scope:'three' },
      { id:'four', scope:'four' }, { id:'five', scope:'five' },
    ],
    workersPerManager:1,
    loopMode:'ONE_SHOT',
  });
}

test('hierarchy state survives existing OrchestrationRuntimeRepository normalization authority', async () => {
  const h = harness();
  const c = h.controller();
  await c.configureHierarchy(graph(), { nowMs: h.now() });
  const before = await h.runtimeRepository.load();
  assert.equal(before.hierarchy.graph.graphId, graph().graphId);
  assert.equal(before.hierarchy.state.graphId, graph().graphId);

  const normalizedAgain = normalizeOrchestrationRuntime(before, await h.configRepository.load(), h.advance(1));
  assert.deepEqual(normalizedAgain.hierarchy, before.hierarchy);
});

test('full automatic L1-C controller vertical survives service-worker-style controller restarts', async () => {
  const readyUrls = new Set();
  const h = harness({
    collector: async probe => readyUrls.has(probe.conversationUrl)
      ? { status: 'READY', assistantComplete: true, assistantText: `${probe.nodeId} done` }
      : { status: 'BUSY', assistantComplete: false },
  });

  let c = h.controller();
  await c.configureHierarchy(graph(), { nowMs: h.now() });
  const start = await c.startHierarchy({ nowMs: h.advance(1) });
  assert.equal(start.started.length, 1);

  let core = await h.coreRepository.load();
  const managerSid = hierarchyCoreSessionId(graph().graphId, 'manager');
  const managerTid = hierarchyCoreTaskId(graph().graphId, 'manager');
  assert.equal(core.sessionsById[managerSid].runState, RunState.RUNNING);

  await confirmSend(h, 'manager', MANAGER_CHAT);
  readyUrls.add(MANAGER_CHAT);

  // Simulated service-worker restart: discard controller object, retain repositories.
  c = h.controller();
  let cycle = await c.cycle({ nowMs: h.advance(1) });
  assert.equal(cycle.kind, 'HIERARCHY_CYCLE');
  assert.equal(cycle.sync.hierarchy.projected, 1);
  assert.equal(cycle.hierarchyProbe.terminal.length, 1);

  core = await h.coreRepository.load();
  assert.ok(core.sessionsById[hierarchyCoreSessionId(graph().graphId, 'worker-1')]);
  assert.ok(core.sessionsById[hierarchyCoreSessionId(graph().graphId, 'worker-2')]);
  assert.equal(core.sessionOrder.length, 3);

  await confirmSend(h, 'worker-1', W1_CHAT);
  await confirmSend(h, 'worker-2', W2_CHAT);
  readyUrls.add(W1_CHAT);
  readyUrls.add(W2_CHAT);

  c = h.controller();
  cycle = await c.cycle({ nowMs: h.advance(1) });
  assert.equal(cycle.kind, 'HIERARCHY_CYCLE');
  assert.equal(cycle.sync.hierarchy.projected, 2);
  assert.equal(cycle.hierarchyProbe.terminal.length, 2);

  core = await h.coreRepository.load();
  assert.equal(core.sessionOrder.length, 3, 'barrier reconciliation must reuse manager Session');
  assert.equal(core.sessionsById[managerSid].tasksById[managerTid].normalizedUrl, MANAGER_CHAT);
  assert.equal(core.sessionsById[managerSid].runState, RunState.RUNNING);
  assert.equal(core.sessionsById[managerSid].orchestrationHierarchy.purpose, 'RECONCILE');

  // Restart before reconciliation Send: PREPARED action is recovered idempotently.
  c = h.controller();
  const sync = await c.syncHierarchyAfterCoreCycle({ nowMs: h.advance(1) });
  assert.equal(sync.materialized.length, 0);
  assert.equal(sync.reused.length, 1);
  core = await h.coreRepository.load();
  assert.equal(core.sessionOrder.length, 3);

  await confirmSend(h, 'manager', MANAGER_CHAT);
  cycle = await c.cycle({ nowMs: h.advance(1) });
  assert.equal(cycle.kind, 'HIERARCHY_CYCLE');

  const runtime = await h.runtimeRepository.load();
  const manager = runtime.hierarchy.state.nodesById.manager;
  assert.equal(manager.activationLedger[manager.currentActivationId].phase, 'TERMINAL');
  assert.equal(Object.keys(runtime.hierarchy.state.nodesById['worker-1'].activationLedger).length, 1);
  assert.equal(Object.keys(runtime.hierarchy.state.nodesById['worker-2'].activationLedger).length, 1);
});

test('preserved due alarm survives unrelated reconciliations and restart, then launches five Managers exactly once', async () => {
  const directorChat='https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const g=fiveManagerGraph();
  const h=harness({collector:async probe=>probe.nodeId==='director'
    ? {status:'READY',assistantComplete:true,assistantText:'Director complete'}
    : {status:'BUSY',assistantComplete:false}});
  let c=h.controller();
  await c.configureHierarchy(g,{nowMs:h.now()});
  await c.startHierarchy({nowMs:h.advance(1)});
  const originalWake=h.chrome.alarms.current().scheduledTime;
  await confirmSend(h,'director',directorChat,g);

  for(let index=0;index<20;index+=1){
    await c.syncAfterCoreCycle({nowMs:h.advance(1000)});
    assert.equal(h.chrome.alarms.current().scheduledTime,originalWake,'unrelated reconcile must preserve the earlier probe');
    if(index===9)c=h.controller();
  }

  h.advance(originalWake-h.now());
  c=h.controller();
  const due=await c.cycle({nowMs:h.now()});
  assert.equal(due.hierarchyProbe.terminal.length,1);
  let core=await h.coreRepository.load();
  const managers=Object.values(core.sessionsById).filter(session=>String(session.orchestrationHierarchy?.nodeId||'').startsWith('manager:'));
  assert.equal(managers.length,5);

  await c.cycle({nowMs:h.advance(1)});
  core=await h.coreRepository.load();
  assert.equal(Object.values(core.sessionsById).filter(session=>String(session.orchestrationHierarchy?.nodeId||'').startsWith('manager:')).length,5,'repeated due reconciliation must not duplicate fan-out');
});

test('Pause and Stop before a pending hierarchy probe fence fan-out; Resume consumes preserved evidence once', async () => {
  const directorChat='https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const g=fiveManagerGraph();

  for(const scopeEvent of [OrchestrationHierarchyEventType.PAUSE_SCOPE,OrchestrationHierarchyEventType.STOP_SCOPE]){
    const h=harness({collector:async()=>({status:'READY',assistantComplete:true,assistantText:'Director complete'})});
    const c=h.controller();
    await c.configureHierarchy(g,{nowMs:h.now()});
    await c.startHierarchy({nowMs:h.advance(1)});
    await confirmSend(h,'director',directorChat,g);
    await c.syncAfterCoreCycle({nowMs:h.advance(1)});
    const wake=h.chrome.alarms.current().scheduledTime;
    await c.dispatchHierarchyEvent({type:scopeEvent,eventId:`fence-${scopeEvent.toLowerCase()}`,controlEpoch:1,nodeId:'director'},{nowMs:h.advance(1)});
    h.advance(Math.max(0,wake-h.now()));
    const fenced=await c.cycle({nowMs:h.now()});
    assert.equal(fenced.hierarchyProbe.terminal.length,0);
    let core=await h.coreRepository.load();
    assert.equal(Object.values(core.sessionsById).filter(session=>String(session.orchestrationHierarchy?.nodeId||'').startsWith('manager:')).length,0);

    await c.dispatchHierarchyEvent({type:OrchestrationHierarchyEventType.RESUME_SCOPE,eventId:`resume-${scopeEvent.toLowerCase()}`,controlEpoch:1,nodeId:'director'},{nowMs:h.advance(1)});
    if(scopeEvent===OrchestrationHierarchyEventType.STOP_SCOPE){
      await c.cycle({nowMs:h.advance(1)});
      core=await h.coreRepository.load();
      assert.equal(Object.values(core.sessionsById).filter(session=>String(session.orchestrationHierarchy?.nodeId||'').startsWith('manager:')).length,0);
    }else{
      const afterResume=await c.cycle({nowMs:h.advance(1)});
      assert.equal(afterResume.hierarchyProbe.terminal.length,1);
      await c.cycle({nowMs:h.advance(1)});
      core=await h.coreRepository.load();
      assert.equal(Object.values(core.sessionsById).filter(session=>String(session.orchestrationHierarchy?.nodeId||'').startsWith('manager:')).length,5);
    }
  }
});

test('hierarchy restart never overwrites an ambiguous Core Send operation', async () => {
  const h = harness();
  let c = h.controller();
  await c.configureHierarchy(graph(), { nowMs: h.now() });
  await c.startHierarchy({ nowMs: h.advance(1) });

  const managerSid = hierarchyCoreSessionId(graph().graphId, 'manager');
  const managerTid = hierarchyCoreTaskId(graph().graphId, 'manager');
  await h.coreRepository.update(state => {
    const session = state.sessionsById[managerSid];
    session.runState = RunState.RECOVERING;
    session.operation = {
      operationId: 'ambiguous-manager-send',
      sessionId: managerSid,
      taskId: managerTid,
      promptFingerprint: 'sha256:test',
      phase: OperationPhase.AMBIGUOUS,
      targetUrl: 'https://chatgpt.com/',
      createdAt: h.now(),
      updatedAt: h.now(),
      preSendDeadline: 0,
      submitStartedAt: h.now(),
      verificationDeadline: h.now() + 30000,
    };
    return state;
  });

  c = h.controller();
  const sync = await c.syncHierarchyAfterCoreCycle({ nowMs: h.advance(1) });
  assert.equal(sync.materialized.length, 0);
  assert.equal(sync.reused.length, 1, 'same durable activation is recognized instead of replayed');
  const core = await h.coreRepository.load();
  assert.equal(core.sessionsById[managerSid].operation.operationId, 'ambiguous-manager-send');
  assert.equal(core.sessionsById[managerSid].operation.phase, OperationPhase.AMBIGUOUS);
});

test('master pause prevents a new hierarchy Session from becoming runnable', async () => {
  const h = harness();
  await h.coreRepository.update(state => {
    state.profile.masterPaused = true;
    return state;
  });
  const c = h.controller();
  await c.configureHierarchy(graph(), { nowMs: h.now() });
  await c.startHierarchy({ nowMs: h.advance(1) });
  const core = await h.coreRepository.load();
  const manager = core.sessionsById[hierarchyCoreSessionId(graph().graphId, 'manager')];
  assert.equal(manager.runState, RunState.PAUSED);
});

test('hierarchy Pause and Resume control the already materialized Core Session', async () => {
  const h = harness();
  const c = h.controller();
  await c.configureHierarchy(graph(), { nowMs: h.now() });
  await c.startHierarchy({ nowMs: h.advance(1) });
  const managerSid = hierarchyCoreSessionId(graph().graphId, 'manager');

  await c.dispatchHierarchyEvent({
    type: OrchestrationHierarchyEventType.PAUSE_SCOPE,
    eventId: 'controller-pause-manager',
    controlEpoch: 1,
    nodeId: 'manager',
  }, { nowMs: h.advance(1) });

  let core = await h.coreRepository.load();
  assert.equal(core.sessionsById[managerSid].runState, RunState.PAUSED);
  assert.equal(core.sessionsById[managerSid].orchestrationHierarchy.scopeState, 'PAUSED');

  await c.dispatchHierarchyEvent({
    type: OrchestrationHierarchyEventType.RESUME_SCOPE,
    eventId: 'controller-resume-manager',
    controlEpoch: 1,
    nodeId: 'manager',
  }, { nowMs: h.advance(1) });

  core = await h.coreRepository.load();
  assert.equal(core.sessionsById[managerSid].runState, RunState.RUNNING);
  assert.equal(core.sessionsById[managerSid].orchestrationHierarchy.scopeState, 'RUNNING');
});

test('hierarchy Resume never overrides the owner master pause', async () => {
  const h = harness();
  await h.coreRepository.update(state => {
    state.profile.masterPaused = true;
    return state;
  });
  const c = h.controller();
  await c.configureHierarchy(graph(), { nowMs: h.now() });
  await c.startHierarchy({ nowMs: h.advance(1) });
  const managerSid = hierarchyCoreSessionId(graph().graphId, 'manager');

  await c.dispatchHierarchyEvent({
    type: OrchestrationHierarchyEventType.PAUSE_SCOPE,
    eventId: 'controller-master-pause-scope',
    controlEpoch: 1,
    nodeId: 'manager',
  }, { nowMs: h.advance(1) });
  await c.dispatchHierarchyEvent({
    type: OrchestrationHierarchyEventType.RESUME_SCOPE,
    eventId: 'controller-master-resume-scope',
    controlEpoch: 1,
    nodeId: 'manager',
  }, { nowMs: h.advance(1) });

  const core = await h.coreRepository.load();
  assert.equal(core.sessionsById[managerSid].runState, RunState.PAUSED);
});

test('hierarchy Stop revokes the materialized Core Session authority', async () => {
  const h = harness();
  const c = h.controller();
  await c.configureHierarchy(graph(), { nowMs: h.now() });
  await c.startHierarchy({ nowMs: h.advance(1) });
  const managerSid = hierarchyCoreSessionId(graph().graphId, 'manager');

  await c.dispatchHierarchyEvent({
    type: OrchestrationHierarchyEventType.STOP_SCOPE,
    eventId: 'controller-stop-manager',
    controlEpoch: 1,
    nodeId: 'manager',
  }, { nowMs: h.advance(1) });

  const core = await h.coreRepository.load();
  assert.equal(core.sessionsById[managerSid].enabled, false);
  assert.equal(core.sessionsById[managerSid].runState, RunState.STOPPED);
  assert.equal(core.sessionsById[managerSid].orchestrationHierarchy.scopeState, 'STOPPED');
});

test('disabling Orchestration V2 also revokes hierarchy-managed Core Sessions', async () => {
  const h = harness();
  const c = h.controller();
  await c.configureHierarchy(graph(), { nowMs: h.now() });
  await c.startHierarchy({ nowMs: h.advance(1) });
  const managerSid = hierarchyCoreSessionId(graph().graphId, 'manager');
  const current = await h.configRepository.load();

  await c.updateConfig({ ...current, enabled: false });

  const core = await h.coreRepository.load();
  assert.equal(core.sessionsById[managerSid].enabled, false);
  assert.equal(core.sessionsById[managerSid].runState, RunState.STOPPED);
});

test('hierarchy mode short-circuits legacy flat coordinator control path', async () => {
  const h = harness();
  const c = h.controller();
  await c.configureHierarchy(graph(), { nowMs: h.now() });
  await c.startHierarchy({ nowMs: h.advance(1) });
  const result = await c.cycle({ nowMs: h.advance(1) });
  assert.equal(result.kind, 'HIERARCHY_CYCLE');
  const runtime = await h.runtimeRepository.load();
  assert.equal(runtime.coordinator.lease, null);
  assert.equal(runtime.workerOrder.length, 0);
});
