import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrchestrationActivationPhase,
  OrchestrationActivationPurpose,
  OrchestrationBarrierMode,
  OrchestrationChatMode,
  OrchestrationHierarchyActionType,
  OrchestrationHierarchyEventType,
  OrchestrationNodeLifecycle,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
  validateOrchestrationGraphV1,
} from '../src/core/orchestration-hierarchy.js';

const START = Date.parse('2026-09-19T00:00:00Z');

function graph(overrides = {}) {
  return {
    schemaVersion: 1,
    graphId: 'project-hierarchy',
    controlEpoch: 7,
    promptProfiles: [
      { id: 'director-v1', role: 'GLOBAL_DIRECTOR', version: 1 },
      { id: 'manager-v1', role: 'DOMAIN_MANAGER', version: 1 },
      { id: 'worker-v1', role: 'WORKER', version: 1 },
    ],
    nodes: [
      {
        id: 'director',
        parentId: null,
        childIds: ['manager'],
        promptProfileId: 'director-v1',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        barrier: { mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN },
      },
      {
        id: 'manager',
        parentId: 'director',
        childIds: ['worker-2', 'worker-1'],
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
    ...overrides,
  };
}

function event(type, eventId, fields = {}) {
  return { type, eventId, controlEpoch: 7, ...fields };
}

function reduce(g, runtime, e, offset = 1) {
  return reduceOrchestrationHierarchyEvent(g, runtime, e, START + offset);
}

test('L1-A normalizes an N-level graph deterministically', () => {
  const a = validateOrchestrationGraphV1(graph());
  const b = validateOrchestrationGraphV1({
    ...graph(),
    promptProfiles: [...graph().promptProfiles].reverse(),
    nodes: [...graph().nodes].reverse(),
  });
  assert.deepEqual(a, b);
  assert.deepEqual(a.rootIds, ['director']);
  assert.deepEqual(a.nodesById.manager.childIds, ['worker-1', 'worker-2']);
  assert.equal(a.nodesById.manager.barrier.mode, OrchestrationBarrierMode.ALL_DIRECT_CHILDREN);
});

test('L1-A normalized graph is safe to validate again after durable restart', () => {
  const normalized = validateOrchestrationGraphV1(graph());
  assert.deepEqual(validateOrchestrationGraphV1(normalized), normalized);
  const runtime = createOrchestrationHierarchyRuntime(normalized, START);
  assert.equal(runtime.graphId, normalized.graphId);
  assert.deepEqual(runtime.nodeOrder, normalized.nodeOrder);
});

test('L1-A normalized graph identity fails closed when nodeOrder and nodesById diverge', () => {
  const normalized = validateOrchestrationGraphV1(graph());
  normalized.nodeOrder = normalized.nodeOrder.slice(0, -1);
  assert.throws(() => validateOrchestrationGraphV1(normalized), /Invalid normalized nodes/);
});

test('L1-A rejects duplicate node ids', () => {
  const g = graph();
  g.nodes.push({ ...g.nodes[3] });
  assert.throws(() => validateOrchestrationGraphV1(g), /Duplicate node id/);
});

test('L1-A rejects orphan nodes', () => {
  const g = graph();
  const manager = g.nodes.find(node => node.id === 'manager');
  manager.childIds = ['worker-2'];
  manager.maxActiveChildren = 1;
  g.nodes.find(node => node.id === 'worker-1').parentId = 'missing-manager';
  assert.throws(() => validateOrchestrationGraphV1(g), /Orphan node/);
});

test('L1-A rejects mismatched parent-child links', () => {
  const g = graph();
  const manager = g.nodes.find(node => node.id === 'manager');
  manager.childIds = ['worker-1'];
  manager.maxActiveChildren = 1;
  assert.throws(() => validateOrchestrationGraphV1(g), /Mismatched child\/parent link/);
});

test('L1-A rejects cycles', () => {
  const g = graph();
  const director = g.nodes.find(node => node.id === 'director');
  const manager = g.nodes.find(node => node.id === 'manager');
  director.parentId = 'manager';
  manager.childIds = [...manager.childIds, 'director'];
  assert.throws(() => validateOrchestrationGraphV1(g), /cycle/i);
});

test('L1-A rejects unknown prompt profiles', () => {
  const g = graph();
  g.nodes.find(node => node.id === 'worker-1').promptProfileId = 'missing';
  assert.throws(() => validateOrchestrationGraphV1(g), /Unknown prompt profile/);
});

test('L1-A validates an optional recovery prompt profile independently', () => {
  const g = graph();
  g.promptProfiles.push({ id: 'recovery-v1', role: 'RECOVERY', version: 1 });
  g.nodes.find(node => node.id === 'manager').recoveryPromptProfileId = 'recovery-v1';
  const normalized = validateOrchestrationGraphV1(g);
  assert.equal(normalized.nodesById.manager.recoveryPromptProfileId, 'recovery-v1');

  g.nodes.find(node => node.id === 'manager').recoveryPromptProfileId = 'missing-recovery';
  assert.throws(() => validateOrchestrationGraphV1(g), /Unknown recovery prompt profile/);
});

test('L1-A rejects barriers that address nodes outside direct children', () => {
  const g = graph();
  g.nodes.find(node => node.id === 'manager').barrier = {
    mode: OrchestrationBarrierMode.REQUIRED_DIRECT_CHILDREN,
    childIds: ['worker-1', 'director'],
  };
  assert.throws(() => validateOrchestrationGraphV1(g), /references non-child/);
});

test('L1-A provider binding cannot widen local parent authority', () => {
  const g = graph();
  g.nodes.find(node => node.id === 'manager').providerBinding = {
    providerId: 'drive-scalar',
    groupNodeId: 'director',
    maxSlots: 2,
  };
  assert.throws(() => validateOrchestrationGraphV1(g), /cannot widen authority/);
});

test('L1-A provider max slots cannot exceed configured local child slots', () => {
  const g = graph();
  g.nodes.find(node => node.id === 'manager').providerBinding = {
    providerId: 'drive-scalar',
    groupNodeId: 'manager',
    maxSlots: 3,
  };
  assert.throws(() => validateOrchestrationGraphV1(g), /Invalid providerBinding\.maxSlots/);
});

test('L1-B duplicate activation event never emits a second physical action', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  const request = event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'event-manager-1', {
    nodeId: 'manager',
    generation: 1,
    activationId: 'manager-activation-1',
    purpose: OrchestrationActivationPurpose.DELEGATE,
  });
  let result = reduce(g, runtime, request, 1);
  runtime = result.runtime;
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.ACTIVATE_NODE);

  result = reduce(g, runtime, request, 2);
  assert.equal(result.deduplicated, true);
  assert.deepEqual(result.actions, []);
});

test('L1-B same activation identity with a different event id still emits no duplicate action', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  let result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'event-manager-a', {
    nodeId: 'manager', generation: 1, activationId: 'same-activation', purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1);
  runtime = structuredClone(result.runtime);

  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'event-manager-b', {
    nodeId: 'manager', generation: 1, activationId: 'same-activation', purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 2);
  assert.deepEqual(result.actions, []);
  assert.equal(result.reason, 'DUPLICATE_ACTIVATION');
});

test('L1-B crash after PREPARED reconciles existing effect authority instead of blind replay', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'prepare-manager', {
    nodeId: 'manager', generation: 1, activationId: 'activation-prepared', purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1).runtime;

  const restarted = structuredClone(runtime);
  const result = reduce(g, restarted, event(OrchestrationHierarchyEventType.RUNTIME_RECONCILE, 'reconcile-after-crash'), 2);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.RECONCILE_PREPARED_EFFECT);
  assert.equal(result.actions.some(action => action.type === OrchestrationHierarchyActionType.ACTIVATE_NODE), false);
  assert.equal(result.actions[0].authority, 'EXISTING_EFFECT_VERIFIER');
});

test('L1-B confirmed physical effect is not replayed by restart reconciliation', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'prepare-worker', {
    nodeId: 'worker-1', generation: 1, activationId: 'worker-effect', purpose: OrchestrationActivationPurpose.WORK,
  }), 1).runtime;
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED, 'confirm-worker', {
    nodeId: 'worker-1', generation: 1, activationId: 'worker-effect', effectRef: 'core-session:task:1',
  }), 2).runtime;

  const result = reduce(g, structuredClone(runtime), event(OrchestrationHierarchyEventType.RUNTIME_RECONCILE, 'restart-confirmed'), 3);
  assert.deepEqual(result.actions, []);
  assert.equal(result.runtime.nodesById['worker-1'].activationLedger['worker-effect'].phase, OrchestrationActivationPhase.EFFECT_CONFIRMED);
});

test('L1-B ambiguous effect routes to existing verifier and never emits a new activation', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'prepare-ambiguous', {
    nodeId: 'worker-1', generation: 1, activationId: 'ambiguous-1', purpose: OrchestrationActivationPurpose.WORK,
  }), 1).runtime;

  const result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_EFFECT_AMBIGUOUS, 'ambiguous-effect', {
    nodeId: 'worker-1', generation: 1, activationId: 'ambiguous-1',
  }), 2);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.VERIFY_AMBIGUOUS_EFFECT);
  assert.equal(result.actions[0].authority, 'EXISTING_EFFECT_VERIFIER');
});

test('L1-B stale control epoch blocks physical effects', () => {
  const g = graph();
  const runtime = createOrchestrationHierarchyRuntime(g, START);
  const result = reduceOrchestrationHierarchyEvent(g, runtime, {
    type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    eventId: 'stale-control-event',
    controlEpoch: 6,
    nodeId: 'worker-1',
    generation: 1,
    activationId: 'must-not-launch',
  }, START + 1);
  assert.equal(result.reason, 'STALE_CONTROL_EPOCH');
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.WAIT);
  assert.equal(result.runtime.nodesById['worker-1'].activationLedger['must-not-launch'], undefined);
});

test('L1-B Manager terminal activates configured child workers exactly once', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-request', {
    nodeId: 'manager', generation: 1, activationId: 'manager-round-1', purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1).runtime;
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED, 'manager-confirmed', {
    nodeId: 'manager', generation: 1, activationId: 'manager-round-1',
  }), 2).runtime;

  let result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'manager-terminal', {
    nodeId: 'manager', generation: 1, activationId: 'manager-round-1', status: 'COMPLETED',
  }), 3);
  runtime = result.runtime;
  assert.deepEqual(result.actions.map(action => action.nodeId), ['worker-1', 'worker-2']);
  assert.equal(result.actions.every(action => action.type === OrchestrationHierarchyActionType.ACTIVATE_NODE), true);

  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'manager-terminal-duplicate-id', {
    nodeId: 'manager', generation: 1, activationId: 'manager-round-1', status: 'COMPLETED',
  }), 4);
  assert.deepEqual(result.actions, []);
  assert.equal(result.reason, 'ALREADY_TERMINAL');
});

test('L1-B worker barrier produces exactly one Manager reconciliation action', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-request-2', {
    nodeId: 'manager', generation: 1, activationId: 'manager-plan', purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1).runtime;
  let result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'manager-plan-terminal', {
    nodeId: 'manager', generation: 1, activationId: 'manager-plan', status: 'COMPLETED',
  }), 2);
  runtime = result.runtime;
  const childActions = result.actions;
  assert.equal(childActions.length, 2);

  for (const [index, action] of childActions.entries()) {
    runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED, `child-confirm-${index}`, {
      nodeId: action.nodeId, generation: action.generation, activationId: action.activationId,
    }), 10 + index).runtime;
  }

  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'worker-1-terminal', {
    nodeId: 'worker-1', generation: 1, activationId: childActions.find(action => action.nodeId === 'worker-1').activationId, status: 'NO_ACTION',
  }), 20);
  runtime = result.runtime;
  assert.equal(result.actions.length, 0);

  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'worker-2-terminal', {
    nodeId: 'worker-2', generation: 1, activationId: childActions.find(action => action.nodeId === 'worker-2').activationId, status: 'COMPLETED',
  }), 21);
  runtime = result.runtime;
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT);
  assert.equal(result.actions[0].nodeId, 'manager');
  assert.equal(result.actions[0].purpose, OrchestrationActivationPurpose.RECONCILE);

  const recheck = reduce(g, runtime, event(OrchestrationHierarchyEventType.BARRIER_REEVALUATE, 'barrier-recheck', {
    nodeId: 'manager', generation: 1,
  }), 22);
  assert.deepEqual(recheck.actions, []);
});

test('L1-B pause subtree blocks child launch and resume restores eligibility', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.PAUSE_SCOPE, 'pause-manager', {
    nodeId: 'manager',
  }), 1).runtime;
  assert.equal(runtime.nodesById.manager.lifecycle, OrchestrationNodeLifecycle.PAUSED);
  assert.equal(runtime.nodesById['worker-1'].scopeState, 'PAUSED');

  let result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'paused-worker-request', {
    nodeId: 'worker-1', generation: 1, activationId: 'paused-worker',
  }), 2);
  runtime = result.runtime;
  assert.deepEqual(result.actions, []);
  assert.equal(result.reason, 'SCOPE_PAUSED');

  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.RESUME_SCOPE, 'resume-manager', {
    nodeId: 'manager',
  }), 3).runtime;
  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'resumed-worker-request', {
    nodeId: 'worker-1', generation: 1, activationId: 'resumed-worker',
  }), 4);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.ACTIVATE_NODE);
});

test('L1-B Stop is sticky and Resume cannot reauthorize a stopped subtree', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.STOP_SCOPE, 'stop-manager', {
    nodeId: 'manager',
  }), 1).runtime;
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.RESUME_SCOPE, 'resume-stopped-manager', {
    nodeId: 'manager',
  }), 2).runtime;
  assert.equal(runtime.nodesById.manager.scopeState, 'STOPPED');
  assert.equal(runtime.nodesById['worker-1'].scopeState, 'STOPPED');

  const result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'stopped-worker-request', {
    nodeId: 'worker-1', generation: 1, activationId: 'stopped-worker',
  }), 3);
  assert.deepEqual(result.actions, []);
  assert.equal(result.reason, 'SCOPE_STOPPED');
});

test('L1-E generation recovery atomically supersedes the old generation and prepares one recovery activation', () => {
  const g = graph();
  g.promptProfiles.push({ id: 'recovery-v1', role: 'RECOVERY', version: 1 });
  g.nodes.find(node => node.id === 'manager').recoveryPromptProfileId = 'recovery-v1';

  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-g1-request', {
    nodeId: 'manager',
    generation: 1,
    activationId: 'manager-g1',
    purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1).runtime;

  const recovered = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.GENERATION_RECOVERY_REQUESTED,
    'manager-recover-g2',
    {
      nodeId: 'manager',
      generation: 1,
      newGeneration: 2,
      activationId: 'recovery:manager:g2:r2',
    },
  ), 2);

  assert.equal(recovered.reason, 'GENERATION_RECOVERY_PREPARED');
  assert.equal(recovered.actions.length, 1);
  assert.equal(recovered.actions[0].purpose, OrchestrationActivationPurpose.RECOVERY);
  assert.equal(recovered.actions[0].promptProfileId, 'recovery-v1');
  assert.equal(recovered.runtime.nodesById.manager.generation, 2);
  assert.equal(recovered.runtime.nodesById.manager.currentActivationId, 'recovery:manager:g2:r2');
  assert.equal(
    recovered.runtime.nodesById.manager.activationLedger['manager-g1'].phase,
    OrchestrationActivationPhase.SUPERSEDED,
  );

  const replay = reduce(g, recovered.runtime, event(
    OrchestrationHierarchyEventType.GENERATION_RECOVERY_REQUESTED,
    'manager-recover-g2',
    {
      nodeId: 'manager',
      generation: 1,
      newGeneration: 2,
      activationId: 'recovery:manager:g2:r2',
    },
  ), 3);
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(replay.actions, []);

  const staleRetry = reduce(g, recovered.runtime, event(
    OrchestrationHierarchyEventType.GENERATION_RECOVERY_REQUESTED,
    'manager-recover-g2-retry',
    {
      nodeId: 'manager',
      generation: 1,
      newGeneration: 2,
      activationId: 'recovery:manager:g2:r2',
    },
  ), 4);
  assert.equal(staleRetry.reason, 'STALE_GENERATION');
  assert.deepEqual(staleRetry.actions, []);
  assert.equal(staleRetry.runtime.nodesById.manager.generation, 2);
});

test('L1-E recovery request is fail-closed while the node scope is paused', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.PAUSE_SCOPE, 'pause-before-recovery', {
    nodeId: 'manager',
  }), 1).runtime;

  const result = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.GENERATION_RECOVERY_REQUESTED,
    'paused-manager-recovery',
    {
      nodeId: 'manager',
      generation: 1,
      newGeneration: 2,
      activationId: 'paused-recovery',
    },
  ), 2);

  assert.equal(result.reason, 'SCOPE_PAUSED');
  assert.deepEqual(result.actions, []);
  assert.equal(result.runtime.nodesById.manager.generation, 1);
  assert.equal(result.runtime.nodesById.manager.currentActivationId, '');
});

test('L1-E recovery generation can continue the logical Manager role but old generation cannot launch descendants', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-g1-request-recovery-flow', {
    nodeId: 'manager',
    generation: 1,
    activationId: 'manager-g1-flow',
    purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1).runtime;

  let result = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.GENERATION_RECOVERY_REQUESTED,
    'manager-recover-flow',
    {
      nodeId: 'manager',
      generation: 1,
      newGeneration: 2,
      activationId: 'manager-g2-recovery',
    },
  ), 2);
  runtime = result.runtime;

  const lateOld = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'manager-g1-late-terminal', {
    nodeId: 'manager',
    generation: 1,
    activationId: 'manager-g1-flow',
    status: 'COMPLETED',
  }), 3);
  assert.equal(lateOld.reason, 'STALE_GENERATION');
  assert.deepEqual(lateOld.actions, []);

  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED, 'manager-g2-effect', {
    nodeId: 'manager',
    generation: 2,
    activationId: 'manager-g2-recovery',
  }), 4).runtime;
  result = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'manager-g2-terminal', {
    nodeId: 'manager',
    generation: 2,
    activationId: 'manager-g2-recovery',
    status: 'COMPLETED',
  }), 5);

  assert.equal(result.actions.length, 2);
  assert.deepEqual(result.actions.map(action => action.nodeId).sort(), ['worker-1', 'worker-2']);
  assert.equal(result.runtime.nodesById.manager.generation, 2);
});

test('L1-B old generation terminal event cannot wake descendants after role recovery', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-gen1-request', {
    nodeId: 'manager', generation: 1, activationId: 'manager-gen1', purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1).runtime;
  runtime = reduce(g, runtime, event(OrchestrationHierarchyEventType.GENERATION_SUPERSEDED, 'manager-gen2', {
    nodeId: 'manager', generation: 1, newGeneration: 2,
  }), 2).runtime;

  const stale = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_TERMINAL, 'late-gen1-terminal', {
    nodeId: 'manager', generation: 1, activationId: 'manager-gen1', status: 'COMPLETED',
  }), 3);
  assert.equal(stale.reason, 'STALE_GENERATION');
  assert.deepEqual(stale.actions, []);
  assert.equal(stale.runtime.nodesById.manager.generation, 2);
  assert.equal(stale.runtime.nodesById['worker-1'].currentActivationId, '');
});

test('L1-B same durable activation identity after restart yields one activation total', () => {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  const first = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'restart-event-1', {
    nodeId: 'worker-1', generation: 1, activationId: 'restart-stable-id',
  }), 1);
  assert.equal(first.actions.length, 1);

  runtime = JSON.parse(JSON.stringify(first.runtime));
  const afterRestart = reduce(g, runtime, event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'restart-event-2', {
    nodeId: 'worker-1', generation: 1, activationId: 'restart-stable-id',
  }), 2);
  assert.deepEqual(afterRestart.actions, []);
  assert.equal(Object.keys(afterRestart.runtime.nodesById['worker-1'].activationLedger).length, 1);
});
