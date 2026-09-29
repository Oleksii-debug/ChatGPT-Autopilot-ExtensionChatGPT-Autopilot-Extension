import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState, OperationPhase, RunState } from '../src/core/schema.js';
import {
  OrchestrationActivationPurpose,
  OrchestrationBarrierMode,
  OrchestrationChatMode,
  OrchestrationHierarchyActionType,
  OrchestrationHierarchyEventType,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
} from '../src/core/orchestration-hierarchy.js';
import {
  hierarchyCoreSessionId,
  hierarchyCoreTaskId,
  materializeHierarchyActionsIntoCore,
  hierarchyCompletionProbesFromCore,
  projectHierarchyDeliveryEventsFromCore,
} from '../src/core/orchestration-hierarchy-core.js';

const START = Date.parse('2026-09-19T00:00:00Z');
const MANAGER_CHAT = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const W1_CHAT = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
const W2_CHAT = 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333';

function graph() {
  return {
    schemaVersion: 1,
    graphId: 'l1c-proof',
    controlEpoch: 1,
    promptProfiles: [
      { id: 'manager-v1', role: 'DOMAIN_MANAGER', version: 1, prompt: 'MANAGER ROLE PROMPT' },
      { id: 'worker-v1', role: 'WORKER', version: 1, prompt: 'WORKER ROLE PROMPT' },
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

function event(type, eventId, fields = {}) {
  return { type, eventId, controlEpoch: 1, ...fields };
}

function reduce(g, runtime, e, offset) {
  return reduceOrchestrationHierarchyEvent(g, runtime, e, START + offset);
}

function confirmCoreSend(state, graphId, nodeId, at, conversationUrl) {
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
  return { session, task };
}

test('L1-C materializes hierarchy activation through existing Core Session/Task shape', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  const request = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-request', {
    nodeId: 'manager',
    generation: 1,
    activationId: 'manager-plan-1',
    purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1);
  runtime = request.runtime;

  const state = createEmptyState(START);
  const materialized = materializeHierarchyActionsIntoCore(state, g, runtime, request.actions, { nowMs: START + 2 });
  assert.equal(materialized.materialized.length, 1);
  const sid = hierarchyCoreSessionId(g.graphId, 'manager');
  const tid = hierarchyCoreTaskId(g.graphId, 'manager');
  const session = state.sessionsById[sid];
  assert.ok(session);
  assert.equal(session.runState, RunState.RUNNING);
  assert.equal(session.taskOrder[0], tid);
  assert.equal(session.tasksById[tid].promptOverride, 'MANAGER ROLE PROMPT');
  assert.equal(session.tasksById[tid].normalizedUrl, 'https://chatgpt.com/');
  assert.deepEqual(session.orchestrationHierarchy, {
    managed: true,
    graphId: g.graphId,
    nodeId: 'manager',
    generation: 1,
    activationId: 'manager-plan-1',
    purpose: OrchestrationActivationPurpose.DELEGATE,
    chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
    promptProfileId: 'manager-v1',
    actionType: OrchestrationHierarchyActionType.ACTIVATE_NODE,
  });
});

test('verified Send without an exclusive conversation binding cannot become hierarchy completion evidence', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  const state = createEmptyState(START);
  const request = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'exclusive-binding-request', {
    nodeId: 'manager', generation: 1, activationId: 'exclusive-binding-activation', purpose:OrchestrationActivationPurpose.DELEGATE,
  }), 1);
  runtime = request.runtime;
  materializeHierarchyActionsIntoCore(state, g, runtime, request.actions, { nowMs:START + 2 });
  confirmCoreSend(state, g.graphId, 'manager', START + 3, 'https://chatgpt.com/');
  assert.deepEqual(projectHierarchyDeliveryEventsFromCore(g, runtime, state), [], 'root launch URL is not exclusive proof');

  confirmCoreSend(state, g.graphId, 'manager', START + 4, MANAGER_CHAT);
  const projected = projectHierarchyDeliveryEventsFromCore(g, runtime, state);
  assert.equal(projected.length, 1);
  runtime = reduce(g, runtime, projected[0], 5).runtime;
  state.sessionsById[hierarchyCoreSessionId(g.graphId, 'manager')].tasksById[hierarchyCoreTaskId(g.graphId, 'manager')].lastConversationUrl = 'https://chatgpt.com/';
  assert.deepEqual(hierarchyCompletionProbesFromCore(g, runtime, state), [], 'non-exclusive URL cannot manufacture assistant completion');
});

test('L1-C verified Core Send projects deterministic reducer evidence', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  let result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-request-project', {
    nodeId: 'manager', generation: 1, activationId: 'manager-project', purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1);
  runtime = result.runtime;
  const state = createEmptyState(START);
  materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 2 });
  confirmCoreSend(state, g.graphId, 'manager', START + 3, MANAGER_CHAT);

  const projected = projectHierarchyDeliveryEventsFromCore(g, runtime, state);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].type, OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED);
  assert.equal(projected[0].activationId, 'manager-project');
  assert.match(projected[0].effectRef, /^core:/);

  result = reduce(g, runtime, projected[0], 4);
  assert.equal(result.reason, 'EFFECT_CONFIRMED');
  assert.equal(result.runtime.nodesById.manager.activationLedger['manager-project'].phase, 'EFFECT_CONFIRMED');
  const replay = reduce(g, result.runtime, projected[0], 5);
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(replay.actions, []);
});

test('L1-C vertical: Manager -> two Workers -> one persistent Manager reconciliation Session', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  const state = createEmptyState(START);

  let result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-start', {
    nodeId: 'manager', generation: 1, activationId: 'manager-plan', purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1);
  runtime = result.runtime;
  materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 2 });
  confirmCoreSend(state, g.graphId, 'manager', START + 3, MANAGER_CHAT);
  const managerDelivery = projectHierarchyDeliveryEventsFromCore(g, runtime, state);
  runtime = reduce(g, runtime, managerDelivery[0], 4).runtime;

  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'manager-plan-complete', {
    nodeId: 'manager', generation: 1, activationId: 'manager-plan', status: 'COMPLETED',
  }), 5);
  runtime = result.runtime;
  assert.deepEqual(result.actions.map(action => action.nodeId), ['worker-1', 'worker-2']);
  materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 6 });
  assert.equal(state.sessionOrder.length, 3);
  for (const nodeId of ['worker-1', 'worker-2']) {
    const sid = hierarchyCoreSessionId(g.graphId, nodeId);
    const tid = hierarchyCoreTaskId(g.graphId, nodeId);
    assert.equal(state.sessionsById[sid].tasksById[tid].normalizedUrl, 'https://chatgpt.com/');
    assert.equal(state.sessionsById[sid].tasksById[tid].promptOverride, 'WORKER ROLE PROMPT');
  }

  confirmCoreSend(state, g.graphId, 'worker-1', START + 7, W1_CHAT);
  confirmCoreSend(state, g.graphId, 'worker-2', START + 8, W2_CHAT);
  for (const projected of projectHierarchyDeliveryEventsFromCore(g, runtime, state)) {
    runtime = reduce(g, runtime, projected, 9).runtime;
  }

  const worker1Activation = runtime.nodesById['worker-1'].currentActivationId;
  const worker2Activation = runtime.nodesById['worker-2'].currentActivationId;
  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'worker-1-complete', {
    nodeId: 'worker-1', generation: 1, activationId: worker1Activation, status: 'NO_ACTION',
  }), 10);
  runtime = result.runtime;
  assert.deepEqual(result.actions, []);

  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'worker-2-complete', {
    nodeId: 'worker-2', generation: 1, activationId: worker2Activation, status: 'COMPLETED',
  }), 11);
  runtime = result.runtime;
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT);
  assert.equal(result.actions[0].nodeId, 'manager');

  const beforeCount = state.sessionOrder.length;
  const reconcileMaterialization = materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 12 });
  assert.equal(reconcileMaterialization.materialized.length, 1);
  assert.equal(state.sessionOrder.length, beforeCount, 'persistent Manager role must reuse its existing Core Session');
  const managerSid = hierarchyCoreSessionId(g.graphId, 'manager');
  const managerTid = hierarchyCoreTaskId(g.graphId, 'manager');
  assert.equal(state.sessionsById[managerSid].tasksById[managerTid].normalizedUrl, MANAGER_CHAT);
  assert.equal(state.sessionsById[managerSid].orchestrationHierarchy.activationId, result.actions[0].activationId);
  assert.equal(state.sessionsById[managerSid].orchestrationHierarchy.purpose, OrchestrationActivationPurpose.RECONCILE);

  const duplicateMaterialization = materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 13 });
  assert.equal(duplicateMaterialization.materialized.length, 0);
  assert.equal(duplicateMaterialization.reused.length, 1);
  assert.equal(state.sessionOrder.length, 3);
});

test('L1-C unresolved Core operation blocks rearm instead of overwriting Send recovery evidence', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  const state = createEmptyState(START);
  let result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'first-worker-request', {
    nodeId: 'worker-1', generation: 1, activationId: 'worker-first',
  }), 1);
  runtime = result.runtime;
  materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 2 });
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'first-worker-terminal', {
    nodeId: 'worker-1', generation: 1, activationId: 'worker-first', status: 'COMPLETED',
  }), 3).runtime;

  const sid = hierarchyCoreSessionId(g.graphId, 'worker-1');
  state.sessionsById[sid].operation = {
    operationId: 'op-in-flight',
    sessionId: sid,
    taskId: hierarchyCoreTaskId(g.graphId, 'worker-1'),
    promptFingerprint: 'sha256:test',
    phase: OperationPhase.SUBMITTING,
    targetUrl: 'https://chatgpt.com/',
    createdAt: START + 2,
    updatedAt: START + 2,
    preSendDeadline: 0,
    submitStartedAt: START + 2,
    verificationDeadline: START + 32000,
  };

  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'second-worker-request', {
    nodeId: 'worker-1', generation: 1, activationId: 'worker-second',
  }), 4);
  runtime = result.runtime;
  const materialized = materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 5 });
  assert.equal(materialized.materialized.length, 0);
  assert.equal(materialized.blocked.length, 1);
  assert.equal(materialized.blocked[0].reason, 'CORE_OPERATION_UNRESOLVED');
  assert.equal(state.sessionsById[sid].operation.operationId, 'op-in-flight');
  assert.equal(state.sessionsById[sid].orchestrationHierarchy.activationId, 'worker-first');
});

test('L1-C safe terminal Core operation can be rearmed for the next activation', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  const state = createEmptyState(START);
  let result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'safe-first', {
    nodeId: 'worker-1', generation: 1, activationId: 'safe-worker-first',
  }), 1);
  runtime = result.runtime;
  materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 2 });
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'safe-first-terminal', {
    nodeId: 'worker-1', generation: 1, activationId: 'safe-worker-first', status: 'COMPLETED',
  }), 3).runtime;

  const sid = hierarchyCoreSessionId(g.graphId, 'worker-1');
  state.sessionsById[sid].operation = { phase: OperationPhase.SENT_VERIFIED };

  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'safe-second', {
    nodeId: 'worker-1', generation: 1, activationId: 'safe-worker-second',
  }), 4);
  runtime = result.runtime;
  const materialized = materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 5 });
  assert.equal(materialized.materialized.length, 1);
  assert.equal(state.sessionsById[sid].operation, null);
  assert.equal(state.sessionsById[sid].orchestrationHierarchy.activationId, 'safe-worker-second');
});

test('L1-C role generation recovery forgets old persistent chat while retaining logical Session identity', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  const state = createEmptyState(START);
  let result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-gen1-request', {
    nodeId: 'manager', generation: 1, activationId: 'manager-gen1-activation', purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1);
  runtime = result.runtime;
  materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 2 });
  confirmCoreSend(state, g.graphId, 'manager', START + 3, MANAGER_CHAT);

  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.GENERATION_SUPERSEDED, 'manager-gen2', {
    nodeId: 'manager', generation: 1, newGeneration: 2,
  }), 4);
  runtime = result.runtime;
  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-gen2-request', {
    nodeId: 'manager', generation: 2, activationId: 'manager-gen2-activation', purpose: OrchestrationActivationPurpose.RECOVERY,
  }), 5);
  runtime = result.runtime;
  const materialized = materializeHierarchyActionsIntoCore(state, g, runtime, result.actions, { nowMs: START + 6 });
  assert.equal(materialized.materialized.length, 1);
  assert.equal(state.sessionOrder.length, 1);
  const sid = hierarchyCoreSessionId(g.graphId, 'manager');
  const tid = hierarchyCoreTaskId(g.graphId, 'manager');
  assert.equal(state.sessionsById[sid].tasksById[tid].normalizedUrl, 'https://chatgpt.com/');
  assert.equal(state.sessionsById[sid].orchestrationHierarchy.generation, 2);
});
