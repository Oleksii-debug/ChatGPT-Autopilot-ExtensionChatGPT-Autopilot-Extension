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
  OrchestrationBarrierMode,
  OrchestrationChatMode,
} from '../../src/core/orchestration-hierarchy.js';
import {
  hierarchyCoreSessionId,
  hierarchyCoreTaskId,
} from '../../src/core/orchestration-hierarchy-core.js';

const START = Date.parse('2026-09-19T00:00:00Z');

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
    projectId: 'controller-l1d-proof',
    targetRepository: 'owner/repo',
    controlRepository: 'owner/repo',
    controlIssueNumber: 1,
    masterCoordinatorPrompt: 'LEGACY CONTROL PROMPT — unused while hierarchy is configured',
    defaultDesiredWorkers: 0,
    absoluteMaxWorkers: 8,
    maxLaunchesPerWindow: 8,
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
    return state;
  });
}

test('L1-D asynchronous Manager subtrees reconcile independently before the Director barrier', async () => {
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
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'manager-a')]);
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'manager-b')]);
  assert.equal(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-a1')], undefined);
  assert.equal(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-b1')], undefined);

  await confirmSend(h, g.graphId, 'manager-a', chats.managerA);
  await confirmSend(h, g.graphId, 'manager-b', chats.managerB);
  readyUrls.add(chats.managerA);

  controller = h.controller();
  cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['manager-a']);

  core = await h.coreRepository.load();
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-a1')]);
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-a2')]);
  assert.equal(
    core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-b1')],
    undefined,
    'Manager A subtree must progress while Manager B remains BUSY',
  );

  await confirmSend(h, g.graphId, 'worker-a1', chats.workerA1);
  await confirmSend(h, g.graphId, 'worker-a2', chats.workerA2);
  readyUrls.add(chats.workerA1);
  readyUrls.add(chats.workerA2);
  controller = h.controller();
  cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(
    cycle.hierarchyProbe.terminal.map(item => item.nodeId).sort(),
    ['worker-a1', 'worker-a2'],
  );

  core = await h.coreRepository.load();
  const managerASession = core.sessionsById[hierarchyCoreSessionId(g.graphId, 'manager-a')];
  assert.equal(managerASession.orchestrationHierarchy.purpose, 'RECONCILE');
  assert.equal(
    managerASession.tasksById[hierarchyCoreTaskId(g.graphId, 'manager-a')].normalizedUrl,
    chats.managerA,
  );

  await confirmSend(h, g.graphId, 'manager-a', chats.managerA);
  controller = h.controller();
  cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['manager-a']);

  let runtime = await h.runtimeRepository.load();
  assert.equal(
    runtime.hierarchy.state.nodesById.director.currentActivationId.startsWith('reconcile:director:'),
    false,
    'Director must not reconcile while Manager B subtree is incomplete',
  );

  readyUrls.add(chats.managerB);
  controller = h.controller();
  cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['manager-b']);

  core = await h.coreRepository.load();
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-b1')]);
  assert.ok(core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-b2')]);

  await confirmSend(h, g.graphId, 'worker-b1', chats.workerB1);
  await confirmSend(h, g.graphId, 'worker-b2', chats.workerB2);
  readyUrls.add(chats.workerB1);
  readyUrls.add(chats.workerB2);
  controller = h.controller();
  cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(
    cycle.hierarchyProbe.terminal.map(item => item.nodeId).sort(),
    ['worker-b1', 'worker-b2'],
  );

  core = await h.coreRepository.load();
  const managerBSession = core.sessionsById[hierarchyCoreSessionId(g.graphId, 'manager-b')];
  assert.equal(managerBSession.orchestrationHierarchy.purpose, 'RECONCILE');
  assert.equal(
    managerBSession.tasksById[hierarchyCoreTaskId(g.graphId, 'manager-b')].normalizedUrl,
    chats.managerB,
  );

  await confirmSend(h, g.graphId, 'manager-b', chats.managerB);
  controller = h.controller();
  cycle = await controller.cycle({ nowMs: h.advance(1) });
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item => item.nodeId), ['manager-b']);

  core = await h.coreRepository.load();
  const directorSession = core.sessionsById[hierarchyCoreSessionId(g.graphId, 'director')];
  assert.equal(directorSession.orchestrationHierarchy.purpose, 'RECONCILE');
  assert.equal(
    directorSession.tasksById[hierarchyCoreTaskId(g.graphId, 'director')].normalizedUrl,
    chats.director,
  );
  assert.equal(core.sessionOrder.length, 7, 'the fixed seven logical role Sessions must be reused');

  runtime = await h.runtimeRepository.load();
  assert.equal(
    runtime.hierarchy.state.nodesById['manager-a'].activationLedger[
      runtime.hierarchy.state.nodesById['manager-a'].currentActivationId
    ].phase,
    'TERMINAL',
  );
  assert.equal(
    runtime.hierarchy.state.nodesById['manager-b'].activationLedger[
      runtime.hierarchy.state.nodesById['manager-b'].currentActivationId
    ].phase,
    'TERMINAL',
  );
  assert.equal(
    runtime.hierarchy.state.nodesById.director.currentActivationId.startsWith('reconcile:director:'),
    true,
  );
});
