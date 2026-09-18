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

function directorGraph() {
  return {
    schemaVersion: 1,
    graphId: 'controller-l1d-proof',
    controlEpoch: 1,
    promptProfiles: [
      { id: 'director-v1', role: 'GLOBAL_DIRECTOR', version: 1, prompt: 'DIRECTOR PROMPT' },
      { id: 'manager-v1', role: 'DOMAIN_MANAGER', version: 1, prompt: 'MANAGER PROMPT' },
      { id: 'worker-v1', role: 'WORKER', version: 1, prompt: 'WORKER PROMPT' },
    ],
    nodes: [
      {
        id: 'director',
        parentId: null,
        childIds: ['manager-a', 'manager-b'],
        promptProfileId: 'director-v1',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 2,
        barrier: { mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN },
      },
      {
        id: 'manager-a',
        parentId: 'director',
        childIds: ['worker-a1', 'worker-a2'],
        promptProfileId: 'manager-v1',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 2,
        barrier: { mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN },
      },
      {
        id: 'manager-b',
        parentId: 'director',
        childIds: ['worker-b1', 'worker-b2'],
        promptProfileId: 'manager-v1',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 2,
        barrier: { mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN },
      },
      {
        id: 'worker-a1',
        parentId: 'manager-a',
        childIds: [],
        promptProfileId: 'worker-v1',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      },
      {
        id: 'worker-a2',
        parentId: 'manager-a',
        childIds: [],
        promptProfileId: 'worker-v1',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      },
      {
        id: 'worker-b1',
        parentId: 'manager-b',
        childIds: [],
        promptProfileId: 'worker-v1',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      },
      {
        id: 'worker-b2',
        parentId: 'manager-b',
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
  return {
    alarms: {
      calls: [],
      async create(name, options) { this.calls.push({ name, options }); },
      async clear() { return true; },
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

async function confirmSend(h, nodeId, conversationUrl, graphId = graph().graphId) {
  const at = h.advance(1000);
  await h.coreRepository.update(state => {
    const sid = hierarchyCoreSessionId(graphId, nodeId);
    const tid = hierarchyCoreTaskId(graphId, nodeId);
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

test('L1-D Director allows asynchronous Manager subtrees and reconciles only after the Manager barrier', async () => {
  const g = directorGraph();
  const readyUrls = new Set();
  const chats = {
    director: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000001',
    managerA: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000002',
    managerB: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000003',
    workerA1: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000004',
    workerA2: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000005',
    workerB1: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000006',
    workerB2: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000007',
  };
  const h = harness({
    collector: async probe => readyUrls.has(probe.conversationUrl)
      ? { status: 'READY', assistantComplete: true, assistantText: `${probe.nodeId} done` }
      : { status: 'BUSY', assistantComplete: false },
  });

  let c = h.controller();
  await c.configureHierarchy(g, { nowMs: h.now() });
  await c.startHierarchy({ nowMs: h.advance(1) });

  await confirmSend(h, 'director', chats.director, g.graphId);
  readyUrls.add(chats.director);
  c = h.controller();
  let cycle = await c.cycle({ nowMs: h.advance(1) });
  assert.equal(cycle.hierarchyProbe.terminal.length, 1);

  let core = await h.coreRepository.load();
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'manager-a')]);
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'manager-b')]);
  assert.equal(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-a1')], undefined);
  assert.equal(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-b1')], undefined);

  await confirmSend(h, 'manager-a', chats.managerA, g.graphId);
  await confirmSend(h, 'manager-b', chats.managerB, g.graphId);
  readyUrls.add(chats.managerA);

  c = h.controller();
  cycle = await c.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['manager-a']);

  core = await h.coreRepository.load();
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-a1')]);
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-a2')]);
  assert.equal(
    core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-b1')],
    undefined,
    'manager-a subtree must progress while manager-b remains BUSY',
  );

  await confirmSend(h, 'worker-a1', chats.workerA1, g.graphId);
  await confirmSend(h, 'worker-a2', chats.workerA2, g.graphId);
  readyUrls.add(chats.workerA1);
  readyUrls.add(chats.workerA2);
  c = h.controller();
  cycle = await c.cycle({ nowMs: h.advance(1) });
  assert.equal(cycle.hierarchyProbe.terminal.length, 2);

  core = await h.coreRepository.load();
  const managerASession = core.sessionsById[hierarchyCoreSessionId(g.graphId, 'manager-a')];
  assert.equal(managerASession.orchestrationHierarchy.purpose, 'RECONCILE');
  assert.equal(managerASession.tasksById[hierarchyCoreTaskId(g.graphId, 'manager-a')].normalizedUrl, chats.managerA);

  await confirmSend(h, 'manager-a', chats.managerA, g.graphId);
  c = h.controller();
  cycle = await c.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['manager-a']);

  let runtime = await h.runtimeRepository.load();
  assert.notEqual(
    runtime.hierarchy.state.nodesById.director.currentActivationId.startsWith('reconcile:director:'),
    true,
    'Director must not reconcile while manager-b subtree is incomplete',
  );

  readyUrls.add(chats.managerB);
  c = h.controller();
  cycle = await c.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['manager-b']);

  core = await h.coreRepository.load();
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-b1')]);
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-b2')]);

  await confirmSend(h, 'worker-b1', chats.workerB1, g.graphId);
  await confirmSend(h, 'worker-b2', chats.workerB2, g.graphId);
  readyUrls.add(chats.workerB1);
  readyUrls.add(chats.workerB2);
  c = h.controller();
  cycle = await c.cycle({ nowMs: h.advance(1) });
  assert.equal(cycle.hierarchyProbe.terminal.length, 2);

  core = await h.coreRepository.load();
  const managerBSession = core.sessionsById[hierarchyCoreSessionId(g.graphId, 'manager-b')];
  assert.equal(managerBSession.orchestrationHierarchy.purpose, 'RECONCILE');
  assert.equal(managerBSession.tasksById[hierarchyCoreTaskId(g.graphId, 'manager-b')].normalizedUrl, chats.managerB);

  await confirmSend(h, 'manager-b', chats.managerB, g.graphId);
  c = h.controller();
  cycle = await c.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['manager-b']);

  core = await h.coreRepository.load();
  const directorSession = core.sessionsById[hierarchyCoreSessionId(g.graphId, 'director')];
  assert.equal(directorSession.orchestrationHierarchy.purpose, 'RECONCILE');
  assert.equal(directorSession.tasksById[hierarchyCoreTaskId(g.graphId, 'director')].normalizedUrl, chats.director);
  assert.equal(core.sessionOrder.length, 7, 'nested hierarchy must reuse the fixed seven logical role Sessions');

  runtime = await h.runtimeRepository.load();
  assert.equal(runtime.hierarchy.state.nodesById['manager-a'].activationLedger[
    runtime.hierarchy.state.nodesById['manager-a'].currentActivationId
  ].phase, 'TERMINAL');
  assert.equal(runtime.hierarchy.state.nodesById['manager-b'].activationLedger[
    runtime.hierarchy.state.nodesById['manager-b'].currentActivationId
  ].phase, 'TERMINAL');
  assert.equal(
    runtime.hierarchy.state.nodesById.director.currentActivationId.startsWith('reconcile:director:'),
    true,
  );
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
