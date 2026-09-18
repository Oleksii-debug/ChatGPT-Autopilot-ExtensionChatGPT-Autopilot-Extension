import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState, OperationPhase, RunState } from '../../src/core/schema.js';
import {
  createOrchestrationRuntime,
  normalizeOrchestrationRuntime,
  validateOrchestrationConfig,
} from '../../src/core/orchestration-v2.js';
import { OrchestrationV2Controller } from '../../src/core/orchestration-v2-controller.js';
import {
  OrchestrationActivationPurpose,
  OrchestrationBarrierMode,
  OrchestrationChatMode,
  OrchestrationHierarchyEventType,
} from '../../src/core/orchestration-hierarchy.js';
import {
  hierarchyCoreSessionId,
  hierarchyCoreTaskId,
} from '../../src/core/orchestration-hierarchy-core.js';
import { resolveTaskTab } from '../../src/core/tabs.js';

const START = Date.parse('2026-09-19T01:00:00Z');
const OLD_CHAT = 'https://chatgpt.com/c/20000000-0000-4000-8000-000000000017';
const NEW_CHAT = 'https://chatgpt.com/c/20000000-0000-4000-8000-000000000018';

function recoveryGraph() {
  return {
    schemaVersion: 1,
    graphId: 'controller-l1e-proof',
    controlEpoch: 1,
    promptProfiles: [
      { id: 'manager-v1', role: 'DOMAIN_MANAGER', version: 1, prompt: 'MANAGER NORMAL PROMPT' },
      { id: 'manager-recovery-v1', role: 'RECOVERY', version: 1, prompt: 'MANAGER RECOVERY PROMPT' },
      { id: 'worker-v1', role: 'WORKER', version: 1, prompt: 'WORKER PROMPT' },
    ],
    nodes: [
      {
        id: 'manager',
        parentId: null,
        childIds: ['worker'],
        promptProfileId: 'manager-v1',
        recoveryPromptProfileId: 'manager-recovery-v1',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 1,
        barrier: { mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN },
      },
      {
        id: 'worker',
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
    projectId: 'controller-l1e-proof',
    targetRepository: 'owner/repo',
    controlRepository: 'owner/repo',
    controlIssueNumber: 1,
    masterCoordinatorPrompt: 'legacy path unused in hierarchy mode',
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
}

class MemoryCoreRepository {
  constructor(value) {
    this.value = structuredClone(value);
    this.chain = Promise.resolve();
  }
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

function harness(readyUrls) {
  let now = START;
  const cfg = config();
  const configRepository = new MemoryConfigRepository(cfg);
  const runtimeRepository = new MemoryRuntimeRepository(
    createOrchestrationRuntime(cfg, now),
    configRepository,
    () => now,
  );
  const coreRepository = new MemoryCoreRepository(createEmptyState(now));
  const chromeApi = {
    alarms: {
      async create() {},
      async clear() { return true; },
    },
  };
  const controller = () => new OrchestrationV2Controller({
    coreRepository,
    chromeApi,
    configRepository,
    runtimeRepository,
    collectAssistantReport: async probe => readyUrls.has(probe.conversationUrl)
      ? { status: 'READY', assistantComplete: true, assistantText: 'recovered role complete' }
      : { status: 'BUSY', assistantComplete: false },
    fetchFn: async () => { throw new Error('legacy control transport must not run in hierarchy mode'); },
    now: () => now,
  });
  return {
    controller,
    coreRepository,
    runtimeRepository,
    now: () => now,
    advance(ms) { now += ms; return now; },
  };
}

async function confirmSend(h, nodeId, conversationUrl) {
  const g = recoveryGraph();
  const at = h.advance(1000);
  await h.coreRepository.update(state => {
    const sid = hierarchyCoreSessionId(g.graphId, nodeId);
    const tid = hierarchyCoreTaskId(g.graphId, nodeId);
    const session = state.sessionsById[sid];
    assert.ok(session);
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
}

test('L1-E lost Manager chat recovers as one new generation and stale generation cannot regain authority', async () => {
  const g = recoveryGraph();
  const readyUrls = new Set();
  const h = harness(readyUrls);
  let controller = h.controller();

  await controller.configureHierarchy(g, { nowMs: h.now() });
  await controller.startHierarchy({ nowMs: h.advance(1) });

  await controller.dispatchHierarchyEvent({
    type: OrchestrationHierarchyEventType.GENERATION_SUPERSEDED,
    eventId: 'seed-manager-generation-17',
    controlEpoch: 1,
    nodeId: 'manager',
    generation: 1,
    newGeneration: 17,
  }, { nowMs: h.advance(1) });

  await controller.dispatchHierarchyEvent({
    type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    eventId: 'manager-g17-activation-request',
    controlEpoch: 1,
    nodeId: 'manager',
    generation: 17,
    activationId: 'manager-g17',
    purpose: OrchestrationActivationPurpose.DELEGATE,
  }, { nowMs: h.advance(1) });

  await confirmSend(h, 'manager', OLD_CHAT);
  await controller.syncHierarchyAfterCoreCycle({ nowMs: h.advance(1) });

  let runtime = await h.runtimeRepository.load();
  assert.equal(runtime.hierarchy.state.nodesById.manager.generation, 17);
  assert.equal(
    runtime.hierarchy.state.nodesById.manager.activationLedger['manager-g17'].phase,
    'EFFECT_CONFIRMED',
  );

  const recovery = await controller.recoverHierarchyNode('manager', {
    expectedGeneration: 17,
    nowMs: h.advance(1),
  });
  assert.equal(recovery.kind, 'HIERARCHY_GENERATION_RECOVERY');
  assert.equal(recovery.previousGeneration, 17);
  assert.equal(recovery.generation, 18);

  runtime = await h.runtimeRepository.load();
  const managerRuntime = runtime.hierarchy.state.nodesById.manager;
  assert.equal(managerRuntime.generation, 18);
  assert.equal(managerRuntime.activationLedger['manager-g17'].phase, 'SUPERSEDED');
  assert.equal(managerRuntime.currentActivationId, recovery.activationId);
  assert.equal(managerRuntime.activationLedger[recovery.activationId].purpose, 'RECOVERY');

  let core = await h.coreRepository.load();
  const managerSid = hierarchyCoreSessionId(g.graphId, 'manager');
  const managerTid = hierarchyCoreTaskId(g.graphId, 'manager');
  const managerSession = core.sessionsById[managerSid];
  const managerTask = managerSession.tasksById[managerTid];
  assert.equal(managerSession.orchestrationHierarchy.generation, 18);
  assert.equal(managerSession.orchestrationHierarchy.purpose, 'RECOVERY');
  assert.equal(managerSession.orchestrationHierarchy.promptProfileId, 'manager-recovery-v1');
  assert.equal(managerTask.promptOverride, 'MANAGER RECOVERY PROMPT');
  assert.equal(managerTask.normalizedUrl, 'https://chatgpt.com/');
  assert.equal(managerTask.lastConversationUrl, '');
  assert.equal(core.sessionOrder.length, 1, 'logical Manager Session identity survives chat loss');

  // Prove a stale extension-owned tab for generation 17 cannot override the
  // generation-18 root launch target. Existing tab authority retires it.
  core.tabHintsByTaskId[managerTid] = {
    tabId: 17,
    sessionId: managerSid,
    normalizedUrl: OLD_CHAT,
    kind: 'TASK',
    ownedByExtension: true,
    retirePending: false,
    boundAt: h.now(),
  };
  const tabs = new Map([[17, { id: 17, url: OLD_CHAT, status: 'complete' }]]);
  const removed = [];
  let nextTabId = 18;
  const tabChrome = {
    tabs: {
      async get(tabId) {
        if (!tabs.has(tabId)) throw new Error('No tab with id');
        return structuredClone(tabs.get(tabId));
      },
      async remove(tabId) {
        removed.push(tabId);
        tabs.delete(tabId);
      },
      async query() { return [...tabs.values()].map(structuredClone); },
      async create({ url }) {
        const tab = { id: nextTabId++, url, status: 'complete' };
        tabs.set(tab.id, tab);
        return structuredClone(tab);
      },
      async update(tabId, update) {
        const current = tabs.get(tabId);
        if (!current) throw new Error('No tab with id');
        const next = { ...current, ...update, status: 'complete' };
        tabs.set(tabId, next);
        return structuredClone(next);
      },
    },
  };
  const resolvedTab = await resolveTaskTab(tabChrome, core, managerSid, managerTask);
  assert.deepEqual(removed, [17]);
  assert.notEqual(resolvedTab.id, 17);
  assert.equal(resolvedTab.url, 'https://chatgpt.com/');

  // Restart after the generation switch: the PREPARED recovery activation is
  // recovered idempotently instead of producing generation 19 or a new Session.
  controller = h.controller();
  const sync = await controller.syncHierarchyAfterCoreCycle({ nowMs: h.advance(1) });
  assert.equal(sync.materialized.length, 0);
  assert.equal(sync.reused.length, 1);

  const staleRetry = await controller.recoverHierarchyNode('manager', {
    expectedGeneration: 17,
    nowMs: h.advance(1),
  });
  assert.equal(staleRetry.kind, 'STALE_GENERATION');
  assert.equal(staleRetry.currentGeneration, 18);

  const lateOld = await controller.dispatchHierarchyEvent({
    type: OrchestrationHierarchyEventType.NODE_TERMINAL,
    eventId: 'late-manager-g17-completion',
    controlEpoch: 1,
    nodeId: 'manager',
    generation: 17,
    activationId: 'manager-g17',
    status: 'COMPLETED',
  }, { nowMs: h.advance(1) });
  assert.equal(lateOld.reason, 'STALE_GENERATION');
  assert.deepEqual(lateOld.actions, []);

  core = await h.coreRepository.load();
  assert.equal(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker')], undefined);

  // Generation 18 remains the same logical Manager but runs in a fresh chat
  // with the recovery profile. Its terminal transition may continue the role.
  await confirmSend(h, 'manager', NEW_CHAT);
  readyUrls.add(NEW_CHAT);
  controller = h.controller();
  const cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['manager']);

  core = await h.coreRepository.load();
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker')]);
  runtime = await h.runtimeRepository.load();
  assert.equal(runtime.hierarchy.state.nodesById.manager.generation, 18);
  assert.equal(
    runtime.hierarchy.state.nodesById.manager.activationLedger[recovery.activationId].phase,
    'TERMINAL',
  );
});


test('L1-E generation recovery waits behind an AMBIGUOUS Core Send and never blind-replays it', async () => {
  const g = recoveryGraph();
  const readyUrls = new Set();
  const h = harness(readyUrls);
  let controller = h.controller();

  await controller.configureHierarchy(g, { nowMs: h.now() });
  await controller.startHierarchy({ nowMs: h.advance(1) });
  await controller.dispatchHierarchyEvent({
    type: OrchestrationHierarchyEventType.GENERATION_SUPERSEDED,
    eventId: 'seed-manager-generation-17-ambiguous',
    controlEpoch: 1,
    nodeId: 'manager',
    generation: 1,
    newGeneration: 17,
  }, { nowMs: h.advance(1) });
  await controller.dispatchHierarchyEvent({
    type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    eventId: 'manager-g17-ambiguous-request',
    controlEpoch: 1,
    nodeId: 'manager',
    generation: 17,
    activationId: 'manager-g17-ambiguous',
    purpose: OrchestrationActivationPurpose.DELEGATE,
  }, { nowMs: h.advance(1) });

  const managerSid = hierarchyCoreSessionId(g.graphId, 'manager');
  const managerTid = hierarchyCoreTaskId(g.graphId, 'manager');
  await h.coreRepository.update(state => {
    const session = state.sessionsById[managerSid];
    session.runState = RunState.RECOVERING;
    session.operation = {
      operationId: 'ambiguous-g17-send',
      sessionId: managerSid,
      taskId: managerTid,
      promptFingerprint: 'sha256:g17-ambiguous',
      phase: OperationPhase.AMBIGUOUS,
      targetUrl: OLD_CHAT,
      launchUrl: 'https://chatgpt.com/',
      promptText: 'MANAGER NORMAL PROMPT',
      generation: 17,
      createdAt: h.now(),
      updatedAt: h.now(),
      preSendDeadline: 0,
      submitStartedAt: h.now(),
      verificationDeadline: h.now() + 30000,
    };
    return state;
  });

  const recovery = await controller.recoverHierarchyNode('manager', {
    expectedGeneration: 17,
    nowMs: h.advance(1),
  });
  assert.equal(recovery.kind, 'HIERARCHY_GENERATION_RECOVERY');
  assert.equal(recovery.generation, 18);
  assert.deepEqual(
    recovery.result.blocked.map(item => item.reason),
    ['CORE_OPERATION_UNRESOLVED'],
  );

  let core = await h.coreRepository.load();
  assert.equal(core.sessionsById[managerSid].operation.operationId, 'ambiguous-g17-send');
  assert.equal(core.sessionsById[managerSid].operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(core.sessionsById[managerSid].orchestrationHierarchy.generation, 17);

  let runtime = await h.runtimeRepository.load();
  const managerRuntime = runtime.hierarchy.state.nodesById.manager;
  assert.equal(managerRuntime.generation, 18);
  assert.equal(managerRuntime.activationLedger[recovery.activationId].phase, 'PREPARED');

  controller = h.controller();
  let sync = await controller.syncHierarchyAfterCoreCycle({ nowMs: h.advance(1) });
  assert.equal(sync.materialized.length, 0);
  assert.deepEqual(sync.blocked.map(item => item.reason), ['CORE_OPERATION_UNRESOLVED']);

  core = await h.coreRepository.load();
  assert.equal(core.sessionsById[managerSid].operation.operationId, 'ambiguous-g17-send');
  assert.equal(core.sessionsById[managerSid].operation.phase, OperationPhase.AMBIGUOUS);

  // Only after the existing exact-effect authority resolves the old operation
  // to a safe terminal phase may the prepared recovery activation reuse the
  // logical role Session.
  await h.coreRepository.update(state => {
    const session = state.sessionsById[managerSid];
    session.operation.phase = OperationPhase.FAILED_SAFE;
    session.operation.updatedAt = h.now();
    session.runState = RunState.STOPPED;
    return state;
  });

  controller = h.controller();
  sync = await controller.syncHierarchyAfterCoreCycle({ nowMs: h.advance(1) });
  assert.equal(sync.blocked.length, 0);
  assert.equal(sync.materialized.length, 1);

  core = await h.coreRepository.load();
  assert.equal(core.sessionsById[managerSid].operation, null);
  assert.equal(core.sessionsById[managerSid].orchestrationHierarchy.generation, 18);
  assert.equal(core.sessionsById[managerSid].orchestrationHierarchy.purpose, 'RECOVERY');
  assert.equal(core.sessionsById[managerSid].tasksById[managerTid].promptOverride, 'MANAGER RECOVERY PROMPT');
  assert.equal(core.sessionsById[managerSid].tasksById[managerTid].normalizedUrl, 'https://chatgpt.com/');
  assert.equal(core.sessionOrder.length, 1);

  runtime = await h.runtimeRepository.load();
  assert.equal(runtime.hierarchy.state.nodesById.manager.generation, 18);
  assert.equal(runtime.hierarchy.state.nodesById.manager.activationLedger[recovery.activationId].phase, 'PREPARED');
});
