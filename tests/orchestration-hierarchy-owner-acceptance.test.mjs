import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildThreeLevelHierarchyTemplate,
} from '../src/core/orchestration-role-prompts.js';
import {
  OrchestrationActivationPurpose,
  OrchestrationBarrierMode,
  OrchestrationChatMode,
  OrchestrationHierarchyActionType,
  OrchestrationHierarchyEventType,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
  validateOrchestrationGraphV1,
} from '../src/core/orchestration-hierarchy.js';

const START = Date.parse('2026-09-22T20:30:00Z');
const REPO = 'Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension';

function domains(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `d${String(index + 1).padStart(2, '0')}`,
    scope: `Domain ${index + 1} bounded responsibility.`,
  }));
}

function template(domainCount, workersPerManager, extras = {}) {
  return buildThreeLevelHierarchyTemplate({
    graphId: `acceptance-${domainCount}-x-${workersPerManager}`,
    projectId: 'autopilot-owner-acceptance',
    targetRepository: REPO,
    controlIssueNumber: 150,
    domains: domains(domainCount),
    workersPerManager,
    ...extras,
  });
}

function event(type, eventId, fields = {}) {
  return { type, eventId, controlEpoch: 1, ...fields };
}

test('OWNER-ACCEPTANCE: manager and worker counts are configurable, not a fixed 5x5 script', () => {
  for (const [managerCount, workerCount] of [[1, 1], [2, 3], [5, 5], [10, 8], [24, 40]]) {
    const graph = template(managerCount, workerCount);
    assert.equal(graph.nodesById.director.childIds.length, managerCount);
    assert.equal(graph.nodeOrder.length, 1 + managerCount + managerCount * workerCount);

    for (const domain of domains(managerCount)) {
      const manager = graph.nodesById[`manager:${domain.id}`];
      assert.ok(manager);
      assert.equal(manager.chatMode, OrchestrationChatMode.PERSISTENT_CHAT);
      assert.equal(manager.childIds.length, workerCount);
      assert.equal(manager.maxActiveChildren, workerCount);
      assert.equal(manager.barrier.mode, OrchestrationBarrierMode.ALL_DIRECT_CHILDREN);

      for (const childId of manager.childIds) {
        const worker = graph.nodesById[childId];
        assert.ok(worker);
        assert.equal(worker.parentId, manager.id);
        assert.equal(worker.chatMode, OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION);
        assert.deepEqual(worker.childIds, []);
      }
    }
  }
});

test('OWNER-ACCEPTANCE: configured safety bounds fail closed instead of silently truncating topology', () => {
  assert.throws(() => template(1, 0), /workersPerManager/);
  assert.throws(() => template(1, 41), /workersPerManager/);
  assert.throws(() => template(25, 40), /exceeds 1000 logical nodes/);
});

test('OWNER-ACCEPTANCE: generic hierarchy graph supports different worker counts per manager', () => {
  const graph = validateOrchestrationGraphV1({
    schemaVersion: 1,
    graphId: 'heterogeneous-owner-graph',
    controlEpoch: 1,
    promptProfiles: [
      { id: 'director-p', role: 'GLOBAL_DIRECTOR', version: 1 },
      { id: 'manager-p', role: 'DOMAIN_MANAGER', version: 1 },
      { id: 'worker-p', role: 'WORKER', version: 1 },
    ],
    nodes: [
      {
        id: 'director',
        parentId: null,
        childIds: ['manager:a', 'manager:b'],
        promptProfileId: 'director-p',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 2,
        barrier: { mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN },
      },
      {
        id: 'manager:a',
        parentId: 'director',
        childIds: ['worker:a:01'],
        promptProfileId: 'manager-p',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 1,
        barrier: { mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN },
      },
      {
        id: 'manager:b',
        parentId: 'director',
        childIds: ['worker:b:01', 'worker:b:02', 'worker:b:03'],
        promptProfileId: 'manager-p',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 3,
        barrier: { mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN },
      },
      {
        id: 'worker:a:01',
        parentId: 'manager:a',
        childIds: [],
        promptProfileId: 'worker-p',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      },
      ...['01', '02', '03'].map(suffix => ({
        id: `worker:b:${suffix}`,
        parentId: 'manager:b',
        childIds: [],
        promptProfileId: 'worker-p',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      })),
    ],
  });

  assert.equal(graph.nodesById['manager:a'].childIds.length, 1);
  assert.equal(graph.nodesById['manager:b'].childIds.length, 3);
});

test('OWNER-ACCEPTANCE: manager completion launches every configured worker exactly once and reconciles once after the barrier', () => {
  const graph = template(1, 4);
  const managerId = 'manager:d01';
  let runtime = createOrchestrationHierarchyRuntime(graph, START);

  runtime = reduceOrchestrationHierarchyEvent(graph, runtime, event(
    OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    'manager-request',
    {
      nodeId: managerId,
      generation: 1,
      activationId: 'manager-g1',
      purpose: OrchestrationActivationPurpose.DELEGATE,
    },
  ), START + 1).runtime;

  runtime = reduceOrchestrationHierarchyEvent(graph, runtime, event(
    OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
    'manager-effect',
    { nodeId: managerId, generation: 1, activationId: 'manager-g1' },
  ), START + 2).runtime;

  let result = reduceOrchestrationHierarchyEvent(graph, runtime, event(
    OrchestrationHierarchyEventType.NODE_TERMINAL,
    'manager-terminal',
    { nodeId: managerId, generation: 1, activationId: 'manager-g1', status: 'COMPLETED' },
  ), START + 3);
  runtime = result.runtime;

  assert.equal(result.actions.length, 4);
  assert.equal(new Set(result.actions.map(a => a.nodeId)).size, 4);
  assert.equal(result.actions.every(a => a.type === OrchestrationHierarchyActionType.ACTIVATE_NODE), true);

  const duplicate = reduceOrchestrationHierarchyEvent(graph, runtime, event(
    OrchestrationHierarchyEventType.NODE_TERMINAL,
    'manager-terminal-again',
    { nodeId: managerId, generation: 1, activationId: 'manager-g1', status: 'COMPLETED' },
  ), START + 4);
  assert.deepEqual(duplicate.actions, []);

  const workerActions = result.actions;
  for (let i = 0; i < workerActions.length; i += 1) {
    const action = workerActions[i];
    runtime = reduceOrchestrationHierarchyEvent(graph, runtime, event(
      OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
      `worker-effect-${i}`,
      { nodeId: action.nodeId, generation: action.generation, activationId: action.activationId },
    ), START + 10 + i).runtime;

    result = reduceOrchestrationHierarchyEvent(graph, runtime, event(
      OrchestrationHierarchyEventType.NODE_TERMINAL,
      `worker-terminal-${i}`,
      {
        nodeId: action.nodeId,
        generation: action.generation,
        activationId: action.activationId,
        status: i === 0 ? 'NO_ACTION' : 'COMPLETED',
      },
    ), START + 20 + i);
    runtime = result.runtime;

    if (i < workerActions.length - 1) {
      assert.equal(result.actions.length, 0);
    } else {
      assert.equal(result.actions.length, 1);
      assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT);
      assert.equal(result.actions[0].nodeId, managerId);
      assert.equal(result.actions[0].purpose, OrchestrationActivationPurpose.RECONCILE);
    }
  }

  const barrierAgain = reduceOrchestrationHierarchyEvent(graph, runtime, event(
    OrchestrationHierarchyEventType.BARRIER_REEVALUATE,
    'barrier-again',
    { nodeId: managerId, generation: 1 },
  ), START + 50);
  assert.deepEqual(barrierAgain.actions, []);
});

test('OWNER-ACCEPTANCE: subtree Pause/Resume works and Stop cannot be silently undone', () => {
  const graph = template(1, 3);
  const managerId = 'manager:d01';
  let runtime = createOrchestrationHierarchyRuntime(graph, START);

  runtime = reduceOrchestrationHierarchyEvent(graph, runtime, event(
    OrchestrationHierarchyEventType.PAUSE_SCOPE,
    'pause',
    { nodeId: managerId },
  ), START + 1).runtime;

  for (const workerId of graph.nodesById[managerId].childIds) {
    assert.equal(runtime.nodesById[workerId].scopeState, 'PAUSED');
  }

  runtime = reduceOrchestrationHierarchyEvent(graph, runtime, event(
    OrchestrationHierarchyEventType.RESUME_SCOPE,
    'resume',
    { nodeId: managerId },
  ), START + 2).runtime;

  for (const workerId of graph.nodesById[managerId].childIds) {
    assert.equal(runtime.nodesById[workerId].scopeState, 'RUNNING');
  }

  runtime = reduceOrchestrationHierarchyEvent(graph, runtime, event(
    OrchestrationHierarchyEventType.STOP_SCOPE,
    'stop',
    { nodeId: managerId },
  ), START + 3).runtime;

  runtime = reduceOrchestrationHierarchyEvent(graph, runtime, event(
    OrchestrationHierarchyEventType.RESUME_SCOPE,
    'resume-after-stop',
    { nodeId: managerId },
  ), START + 4).runtime;

  assert.equal(runtime.nodesById[managerId].scopeState, 'STOPPED');
  for (const workerId of graph.nodesById[managerId].childIds) {
    assert.equal(runtime.nodesById[workerId].scopeState, 'STOPPED');
  }
});
