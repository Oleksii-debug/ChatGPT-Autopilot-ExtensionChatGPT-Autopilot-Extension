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

async function confirmSend(h, nodeId, conversationUrl) {
  const at = h.advance(1000);
  await h.coreRepository.update(state => {
    const sid = hierarchyCoreSessionId(graph().graphId, nodeId);
    const tid = hierarchyCoreTaskId(graph().graphId, nodeId);
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
