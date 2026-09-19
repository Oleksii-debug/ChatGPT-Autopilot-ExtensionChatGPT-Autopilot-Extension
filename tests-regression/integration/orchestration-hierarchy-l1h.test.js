import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState, RunState } from '../../src/core/schema.js';
import {
  createOrchestrationRuntime,
  normalizeOrchestrationRuntime,
  validateOrchestrationConfig,
} from '../../src/core/orchestration-v2.js';
import { OrchestrationV2Controller } from '../../src/core/orchestration-v2-controller.js';
import {
  OrchestrationHierarchyEventType,
} from '../../src/core/orchestration-hierarchy.js';
import {
  hierarchyCoreSessionId,
  hierarchyCoreTaskId,
} from '../../src/core/orchestration-hierarchy-core.js';
import {
  buildThreeLevelHierarchyTemplate,
} from '../../src/core/orchestration-role-prompts.js';

const START = Date.parse('2026-09-19T00:00:00Z');

function config() {
  return validateOrchestrationConfig({
    enabled: true,
    projectId: 'l1h-scale-chaos',
    targetRepository: 'owner/repo',
    controlRepository: 'owner/repo',
    controlIssueNumber: 1,
    masterCoordinatorPrompt: 'LEGACY CONTROL PROMPT — unused while hierarchy is configured',
    defaultDesiredWorkers: 0,
    absoluteMaxWorkers: 50,
    maxLaunchesPerWindow: 50,
    launchWindowSeconds: 300,
    workerProbeIntervalSeconds: 30,
    watchdogIntervalSeconds: 300,
  });
}

function graph() {
  return buildThreeLevelHierarchyTemplate({
    graphId: 'l1h-scale-chaos',
    controlEpoch: 1,
    projectId: 'l1h-scale-chaos',
    targetRepository: 'owner/repo',
    controlIssueNumber: 1,
    domains: Array.from({ length: 5 }, (_, index) => ({
      id: `domain-${index + 1}`,
      scope: `Domain ${index + 1} bounded implementation scope.`,
    })),
    workersPerManager: 5,
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

function harness(collector) {
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
    collectAssistantReport: collector,
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

function chatUrl(index) {
  return `https://chatgpt.com/c/10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function confirmSend(h, graphId, nodeId, conversationUrl) {
  const at = h.advance(1000);
  await h.coreRepository.update(state => {
    const sid = hierarchyCoreSessionId(graphId, nodeId);
    const tid = hierarchyCoreTaskId(graphId, nodeId);
    const session = state.sessionsById[sid];
    assert.ok(session, `missing Core Session for ${nodeId}`);
    const task = session.tasksById[tid];
    task.lastVerifiedSendAt = at;
    task.lastConversationUrl = conversationUrl;
    task.lastVerifiedFingerprint = `fp-${nodeId}-${at}`;
    task.lastAssistantBaselineCount = 1;
    task.lastAssistantBaselineKnown = true;
    session.runState = RunState.STOPPED;
    session.completedAt = at;
    session.operation = null;
    return state;
  });
}

function deterministicShuffle(values) {
  return [...values].sort((a, b) => {
    const score = value => [...value].reduce((sum, ch, index) => (sum + ch.charCodeAt(0) * (index + 17)) % 10007, 0);
    return (score(a) % 17) - (score(b) % 17) || b.localeCompare(a);
  });
}

test('L1-H fixed 5x5 pool survives restart plus wake/barrier storms without duplicate roles or activations', async () => {
  const g = graph();
  assert.equal(g.nodeOrder.length, 31);
  assert.equal(g.promptProfiles.length, 62);
  assert.equal(new Set(g.nodeOrder).size, 31);

  const managers = g.nodeOrder.filter(nodeId => nodeId.startsWith('manager:'));
  const workers = g.nodeOrder.filter(nodeId => nodeId.startsWith('worker:'));
  assert.equal(managers.length, 5);
  assert.equal(workers.length, 25);

  const chats = Object.fromEntries(g.nodeOrder.map((nodeId, index) => [nodeId, chatUrl(index + 1)]));
  const readyUrls = new Set();
  const h = harness(async probe => readyUrls.has(probe.conversationUrl)
    ? { status: 'READY', assistantComplete: true, assistantText: `${probe.nodeId} done` }
    : { status: 'BUSY', assistantComplete: false });

  let controller = h.controller();
  await controller.configureHierarchy(g, { nowMs: h.now() });
  await controller.startHierarchy({ nowMs: h.advance(1) });

  await confirmSend(h, g.graphId, 'director', chats.director);
  readyUrls.add(chats.director);
  controller = h.controller();
  let cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['director']);

  let core = await h.coreRepository.load();
  assert.equal(managers.filter(id => core.sessionsById[hierarchyCoreSessionId(g.graphId, id)]).length, 5);
  assert.equal(workers.filter(id => core.sessionsById[hierarchyCoreSessionId(g.graphId, id)]).length, 0);

  for (const managerId of managers) {
    await confirmSend(h, g.graphId, managerId, chats[managerId]);
    readyUrls.add(chats[managerId]);
  }

  controller = h.controller();
  cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(
    cycle.hierarchyProbe.terminal.map(item => item.nodeId).sort(),
    [...managers].sort(),
  );

  core = await h.coreRepository.load();
  assert.equal(workers.filter(id => core.sessionsById[hierarchyCoreSessionId(g.graphId, id)]).length, 25);
  assert.equal(core.sessionOrder.length, 31, 'fixed role pool must materialize exactly 31 logical Sessions');

  for (const workerId of workers) {
    await confirmSend(h, g.graphId, workerId, chats[workerId]);
  }

  const shuffledWorkers = deterministicShuffle(workers);
  const completedWorkers = new Set();
  for (let offset = 0; offset < shuffledWorkers.length; offset += 4) {
    for (const workerId of shuffledWorkers.slice(offset, offset + 4)) readyUrls.add(chats[workerId]);
    controller = h.controller();
    cycle = await controller.cycle({ nowMs: h.advance(1) });
    for (const item of cycle.hierarchyProbe.terminal || []) {
      if (item.nodeId.startsWith('worker:')) completedWorkers.add(item.nodeId);
    }
  }
  assert.equal(completedWorkers.size, 25, 'randomized completion ordering must lose no worker terminal');

  let runtime = await h.runtimeRepository.load();
  const managerReconcileIds = Object.fromEntries(managers.map(managerId => [
    managerId,
    runtime.hierarchy.state.nodesById[managerId].currentActivationId,
  ]));
  for (const managerId of managers) {
    assert.match(managerReconcileIds[managerId], /^reconcile:/);
  }

  // Barrier reevaluation storms with distinct event identities must not prepare
  // second reconciliation effects once the direct-child barrier was consumed.
  controller = h.controller();
  for (const managerId of managers) {
    for (let index = 0; index < 20; index += 1) {
      const out = await controller.dispatchHierarchyEvent({
        type: OrchestrationHierarchyEventType.BARRIER_REEVALUATE,
        eventId: `l1h-barrier-storm:${managerId}:${index}`,
        controlEpoch: 1,
        nodeId: managerId,
        generation: 1,
      }, { nowMs: h.advance(1) });
      assert.equal(
        out.actions.every(action =>
          action.type === 'SEND_RECONCILIATION_PROMPT'
          && Object.values(managerReconcileIds).includes(action.activationId)
        ),
        true,
        'barrier storm may rematerialize only already-prepared Manager reconciliation identities',
      );
    }
  }

  runtime = await h.runtimeRepository.load();
  for (const managerId of managers) {
    assert.equal(
      runtime.hierarchy.state.nodesById[managerId].currentActivationId,
      managerReconcileIds[managerId],
      `barrier storm must not replace ${managerId} reconciliation identity`,
    );
  }

  core = await h.coreRepository.load();
  assert.equal(core.sessionOrder.length, 31);

  for (const managerId of managers) {
    await confirmSend(h, g.graphId, managerId, chats[managerId]);
  }

  // One controller instance receives a wake storm. Its single-flight contract
  // must coalesce physical work instead of running parallel hierarchy cycles.
  controller = h.controller();
  const wakeAt = h.advance(1);
  await Promise.all(Array.from({ length: 25 }, () => controller.cycle({ nowMs: wakeAt })));

  core = await h.coreRepository.load();
  assert.equal(core.sessionOrder.length, 31, 'wake storm must not multiply logical role Sessions');
  const director = core.sessionsById[hierarchyCoreSessionId(g.graphId, 'director')];
  assert.ok(director);
  assert.equal(director.orchestrationHierarchy.purpose, 'RECONCILE');
  assert.equal(
    director.tasksById[hierarchyCoreTaskId(g.graphId, 'director')].normalizedUrl,
    chats.director,
  );

  runtime = await h.runtimeRepository.load();
  const directorReconcileId = runtime.hierarchy.state.nodesById.director.currentActivationId;
  assert.match(directorReconcileId, /^reconcile:director:/);

  for (let index = 0; index < 50; index += 1) {
    const out = await h.controller().dispatchHierarchyEvent({
      type: OrchestrationHierarchyEventType.BARRIER_REEVALUATE,
      eventId: `l1h-director-barrier-storm:${index}`,
      controlEpoch: 1,
      nodeId: 'director',
      generation: 1,
    }, { nowMs: h.advance(1) });
    assert.equal(
      out.actions.every(action =>
        action.type === 'SEND_RECONCILIATION_PROMPT'
        && action.activationId === directorReconcileId
      ),
      true,
      'Director barrier storm may expose only the already-prepared reconciliation identity',
    );
  }

  // Reconstruct the controller again, modelling service-worker termination.
  controller = h.controller();
  await controller.cycle({ nowMs: h.advance(1) });

  core = await h.coreRepository.load();
  runtime = await h.runtimeRepository.load();
  assert.equal(core.sessionOrder.length, 31);
  assert.equal(runtime.hierarchy.state.nodesById.director.currentActivationId, directorReconcileId);

  for (const workerId of workers) {
    assert.equal(
      Object.keys(runtime.hierarchy.state.nodesById[workerId].activationLedger).length,
      1,
      `${workerId} must have exactly one physical activation identity`,
    );
  }
  for (const managerId of managers) {
    assert.equal(
      Object.keys(runtime.hierarchy.state.nodesById[managerId].activationLedger).length,
      2,
      `${managerId} must have one delegation and one reconciliation activation`,
    );
  }
  assert.equal(
    Object.keys(runtime.hierarchy.state.nodesById.director.activationLedger).length,
    2,
    'Director must have one initial and one reconciliation activation',
  );
});


test('L1-H tab/probe loss and rate-limit signals wait safely, then recover without duplicate descendant launch', async () => {
  const g = graph();
  const directorChat = chatUrl(900);
  let probeMode = 'TAB_GONE';
  const h = harness(async probe => {
    if (probeMode === 'TAB_GONE') {
      const error = new Error('No tab with id');
      error.safeDiagnosticCode = 'TAB_GONE';
      throw error;
    }
    if (probeMode === 'RATE_LIMITED') {
      return { status: 'RATE_LIMITED', assistantComplete: false };
    }
    return { status: 'READY', assistantComplete: true, assistantText: `${probe.nodeId} recovered` };
  });

  let controller = h.controller();
  await controller.configureHierarchy(g, { nowMs: h.now() });
  await controller.startHierarchy({ nowMs: h.advance(1) });
  await confirmSend(h, g.graphId, 'director', directorChat);

  controller = h.controller();
  let cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal, []);
  assert.equal(cycle.hierarchyProbe.waiting.length, 1);
  assert.equal(cycle.hierarchyProbe.waiting[0].status, 'TEMPORARY_ERROR');

  let runtime = await h.runtimeRepository.load();
  const activationId = runtime.hierarchy.state.nodesById.director.currentActivationId;
  assert.equal(
    runtime.hierarchy.state.nodesById.director.activationLedger[activationId].phase,
    'EFFECT_CONFIRMED',
    'temporary tab/probe loss must preserve verified Send authority without inventing completion',
  );
  let core = await h.coreRepository.load();
  assert.equal(
    g.nodeOrder.filter(id => id.startsWith('manager:'))
      .filter(id => core.sessionsById[hierarchyCoreSessionId(g.graphId, id)]).length,
    0,
  );

  probeMode = 'RATE_LIMITED';
  controller = h.controller();
  cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal, []);
  assert.equal(cycle.hierarchyProbe.waiting[0].status, 'RATE_LIMITED');
  runtime = await h.runtimeRepository.load();
  assert.equal(runtime.hierarchy.state.nodesById.director.currentActivationId, activationId);

  probeMode = 'READY';
  controller = h.controller();
  cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['director']);

  core = await h.coreRepository.load();
  const managers = g.nodeOrder.filter(id => id.startsWith('manager:'));
  assert.equal(
    managers.filter(id => core.sessionsById[hierarchyCoreSessionId(g.graphId, id)]).length,
    5,
    'recovered Director terminal must launch each configured Manager exactly once',
  );
  assert.equal(core.sessionOrder.length, 6);

  controller = h.controller();
  await controller.cycle({ nowMs: h.advance(1) });
  core = await h.coreRepository.load();
  assert.equal(core.sessionOrder.length, 6, 'restart after recovery must not duplicate Manager role Sessions');
});
