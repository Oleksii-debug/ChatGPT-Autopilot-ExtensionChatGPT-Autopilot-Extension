import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrchestrationActivationPurpose,
  OrchestrationChatMode,
  OrchestrationHierarchyActionType,
  OrchestrationHierarchyEventType,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
  validateOrchestrationGraphV1,
  validateOrchestrationHierarchyRuntimeV1,
} from '../../src/core/orchestration-hierarchy.js';
import { DRIVE_SCALAR_PROVIDER_V1 } from '../../src/core/orchestration-drive-scalar-provider.js';

const START = Date.parse('2026-09-19T00:00:00Z');
const SOURCE_ID = 'file_abcdef';

function graph() {
  const workers = Array.from({ length: 5 }, (_, index) => `worker-${index + 1}`);
  return {
    schemaVersion: 1,
    graphId: 'l2-drive-scalar',
    controlEpoch: 3,
    promptProfiles: [
      { id: 'manager-v1', role: 'DOMAIN_MANAGER', version: 1, prompt: 'MANAGER' },
      { id: 'worker-v1', role: 'WORKER', version: 1, prompt: 'WORKER' },
    ],
    nodes: [
      {
        id: 'manager',
        parentId: null,
        childIds: workers,
        promptProfileId: 'manager-v1',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 5,
        barrier: { mode: 'ALL_DIRECT_CHILDREN' },
        providerBinding: {
          providerId: DRIVE_SCALAR_PROVIDER_V1,
          groupNodeId: 'manager',
          maxSlots: 5,
          sourceId: SOURCE_ID,
          pollIntervalMs: 180000,
        },
      },
      ...workers.map(id => ({
        id,
        parentId: 'manager',
        childIds: [],
        promptProfileId: 'worker-v1',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      })),
    ],
  };
}

function e(type, eventId, fields = {}) {
  return { type, eventId, controlEpoch: 3, ...fields };
}

function reduce(g, runtime, event, tick) {
  return reduceOrchestrationHierarchyEvent(g, runtime, event, START + tick);
}

function startAndFinishManager(g) {
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  let result = reduce(g, runtime, e(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED, 'manager-start', {
    nodeId: 'manager',
    generation: 1,
    activationId: 'manager-plan',
    purpose: OrchestrationActivationPurpose.DELEGATE,
  }), 1);
  runtime = result.runtime;
  result = reduce(g, runtime, e(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED, 'manager-effect', {
    nodeId: 'manager',
    generation: 1,
    activationId: 'manager-plan',
  }), 2);
  runtime = result.runtime;
  result = reduce(g, runtime, e(OrchestrationHierarchyEventType.NODE_TERMINAL, 'manager-terminal', {
    nodeId: 'manager',
    generation: 1,
    activationId: 'manager-plan',
    status: 'COMPLETED',
  }), 3);
  assert.deepEqual(result.actions, [], 'provider-bound Manager must wait for external scalar instead of launching all workers');
  return result.runtime;
}

function providerEvent(revision, count, eventId = `provider-${revision}`) {
  return e(OrchestrationHierarchyEventType.PROVIDER_SLOT_COUNT_REQUESTED, eventId, {
    nodeId: 'manager',
    providerId: DRIVE_SCALAR_PROVIDER_V1,
    sourceId: SOURCE_ID,
    providerRevision: String(revision),
    requestedSlotCount: count,
  });
}

test('L2-A provider-bound Manager terminal waits for stable external slot-count revision', () => {
  const g = validateOrchestrationGraphV1(graph());
  const runtime = startAndFinishManager(g);
  assert.equal(runtime.nodesById.manager.providerState.lastAcceptedRevision, '');
  for (const id of g.nodesById.manager.childIds) {
    assert.equal(runtime.nodesById[id].currentActivationId, '');
  }
});

test('L2-A revision 41 activates exactly first three configured slots and reconciles after those three only', () => {
  const g = validateOrchestrationGraphV1(graph());
  let runtime = startAndFinishManager(g);
  let result = reduce(g, runtime, providerEvent(41, 3), 4);
  runtime = result.runtime;

  assert.equal(result.reason, 'PROVIDER_REVISION_ACCEPTED');
  assert.deepEqual(result.actions.map(action => action.nodeId), ['worker-1', 'worker-2', 'worker-3']);
  assert.equal(result.actions.every(action => action.type === OrchestrationHierarchyActionType.ACTIVATE_NODE), true);
  assert.equal(runtime.nodesById.manager.providerState.lastAcceptedRevision, '41');
  assert.deepEqual(runtime.nodesById.manager.providerState.activeChildIds, ['worker-1', 'worker-2', 'worker-3']);
  assert.equal(runtime.nodesById['worker-4'].currentActivationId, '');
  assert.equal(runtime.nodesById['worker-5'].currentActivationId, '');

  for (let index = 1; index <= 3; index += 1) {
    const nodeId = `worker-${index}`;
    const activationId = runtime.nodesById[nodeId].currentActivationId;
    runtime = reduce(g, runtime, e(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED, `worker-effect-${index}`, {
      nodeId,
      generation: 1,
      activationId,
    }), 10 + index).runtime;
    result = reduce(g, runtime, e(OrchestrationHierarchyEventType.NODE_TERMINAL, `worker-terminal-${index}`, {
      nodeId,
      generation: 1,
      activationId,
      status: index === 2 ? 'NO_ACTION' : 'COMPLETED',
    }), 20 + index);
    runtime = result.runtime;
    if (index < 3) assert.deepEqual(result.actions, []);
  }

  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT);
  assert.equal(result.actions[0].nodeId, 'manager');
  assert.match(result.actions[0].activationId, /revision:41/);
  assert.equal(runtime.nodesById['worker-4'].currentActivationId, '');
  assert.equal(runtime.nodesById['worker-5'].currentActivationId, '');
});

test('L2-A same revision is exact-once and divergent content under same revision fails closed', () => {
  const g = validateOrchestrationGraphV1(graph());
  let runtime = startAndFinishManager(g);
  let result = reduce(g, runtime, providerEvent(41, 2), 4);
  runtime = result.runtime;
  assert.equal(result.actions.length, 2);

  const replay = reduce(g, JSON.parse(JSON.stringify(runtime)), providerEvent(41, 2, 'provider-41-replay'), 5);
  assert.equal(replay.reason, 'DUPLICATE_PROVIDER_REVISION');
  assert.deepEqual(replay.actions, []);

  const conflict = reduce(g, replay.runtime, providerEvent(41, 3, 'provider-41-conflict'), 6);
  assert.equal(conflict.reason, 'PROVIDER_REVISION_CONFLICT');
  assert.equal(conflict.actions.length, 1);
  assert.equal(conflict.actions[0].type, OrchestrationHierarchyActionType.MANUAL_REVIEW);
  assert.equal(conflict.runtime.nodesById.manager.providerState.lastRequestedSlotCount, 2);
});

test('L2-A stale revision and foreign source cannot activate any child', () => {
  const g = validateOrchestrationGraphV1(graph());
  let runtime = startAndFinishManager(g);
  runtime = reduce(g, runtime, providerEvent(42, 0), 4).runtime;

  const stale = reduce(g, runtime, providerEvent(41, 5, 'provider-stale'), 5);
  assert.equal(stale.reason, 'STALE_PROVIDER_REVISION');
  assert.deepEqual(stale.actions, []);

  const foreign = reduce(g, runtime, e(OrchestrationHierarchyEventType.PROVIDER_SLOT_COUNT_REQUESTED, 'provider-foreign', {
    nodeId: 'manager',
    providerId: DRIVE_SCALAR_PROVIDER_V1,
    sourceId: 'file_foreign',
    providerRevision: '43',
    requestedSlotCount: 5,
  }), 6);
  assert.equal(foreign.reason, 'PROVIDER_SOURCE_MISMATCH');
  assert.deepEqual(foreign.actions, []);
});

test('L2-A zero slots consumes a new revision and immediately schedules one Manager reconciliation', () => {
  const g = validateOrchestrationGraphV1(graph());
  const runtime = startAndFinishManager(g);
  const result = reduce(g, runtime, providerEvent(41, 0), 4);
  assert.equal(result.reason, 'PROVIDER_REVISION_ACCEPTED');
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT);
  assert.equal(result.actions[0].nodeId, 'manager');
  assert.match(result.actions[0].activationId, /revision:41/);
  assert.equal(result.runtime.nodesById.manager.providerState.lastAcceptedRevision, '41');
  assert.deepEqual(result.runtime.nodesById.manager.providerState.activeChildIds, []);
});

test('L2-A newer same scalar is a distinct request but waits without consuming revision while slots are busy', () => {
  const g = validateOrchestrationGraphV1(graph());
  let runtime = startAndFinishManager(g);
  let result = reduce(g, runtime, providerEvent(41, 2), 4);
  runtime = result.runtime;

  const whileBusy = reduce(g, runtime, providerEvent(42, 2), 5);
  assert.equal(whileBusy.reason, 'PROVIDER_SLOTS_BUSY');
  assert.equal(whileBusy.runtime.nodesById.manager.providerState.lastAcceptedRevision, '41');
  assert.equal(whileBusy.runtime.processedEventIds['provider-42'], undefined);

  for (const nodeId of ['worker-1', 'worker-2']) {
    const activationId = runtime.nodesById[nodeId].currentActivationId;
    runtime = reduce(g, runtime, e(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED, `effect-${nodeId}`, {
      nodeId, generation: 1, activationId,
    }), 10).runtime;
    result = reduce(g, runtime, e(OrchestrationHierarchyEventType.NODE_TERMINAL, `terminal-${nodeId}`, {
      nodeId, generation: 1, activationId, status: 'COMPLETED',
    }), 11);
    runtime = result.runtime;
  }

  const managerReconcileId = runtime.nodesById.manager.currentActivationId;
  runtime = reduce(g, runtime, e(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED, 'manager-reconcile-effect', {
    nodeId: 'manager', generation: 1, activationId: managerReconcileId,
  }), 12).runtime;
  runtime = reduce(g, runtime, e(OrchestrationHierarchyEventType.NODE_TERMINAL, 'manager-reconcile-terminal', {
    nodeId: 'manager', generation: 1, activationId: managerReconcileId, status: 'COMPLETED',
  }), 13).runtime;

  result = reduce(g, runtime, providerEvent(42, 2), 14);
  assert.equal(result.reason, 'PROVIDER_REVISION_ACCEPTED');
  assert.equal(result.runtime.nodesById.manager.providerState.lastAcceptedRevision, '42');
  assert.equal(result.actions.length, 2);
  assert.notEqual(
    result.runtime.nodesById['worker-1'].currentActivationId,
    'provider:drive-scalar-v1:revision:41:child:worker-1:g1',
  );
});

test('L2-A provider cannot address foreign group, exceed local max, or bypass Pause', () => {
  const g = validateOrchestrationGraphV1(graph());
  let runtime = startAndFinishManager(g);

  const wrongProvider = reduce(g, runtime, e(OrchestrationHierarchyEventType.PROVIDER_SLOT_COUNT_REQUESTED, 'wrong-provider', {
    nodeId: 'manager',
    providerId: 'foreign-provider',
    sourceId: SOURCE_ID,
    providerRevision: '41',
    requestedSlotCount: 1,
  }), 4);
  assert.equal(wrongProvider.reason, 'PROVIDER_AUTHORITY_MISMATCH');
  assert.deepEqual(wrongProvider.actions, []);

  assert.throws(
    () => reduce(g, runtime, providerEvent(41, 6, 'too-many'), 5),
    /Invalid event\.requestedSlotCount/,
  );

  runtime = reduce(g, runtime, e(OrchestrationHierarchyEventType.PAUSE_SCOPE, 'pause-manager', {
    nodeId: 'manager',
  }), 6).runtime;
  const paused = reduce(g, runtime, providerEvent(41, 1, 'provider-paused'), 7);
  assert.equal(paused.reason, 'SCOPE_PAUSED');
  assert.deepEqual(paused.actions, []);
  assert.equal(paused.runtime.nodesById.manager.providerState.lastAcceptedRevision, '');
  assert.equal(paused.runtime.processedEventIds['provider-paused'], undefined);
});


test('L2-A durable provider state cannot be corrupted to claim a foreign child after restart', () => {
  const g = validateOrchestrationGraphV1(graph());
  let runtime = startAndFinishManager(g);
  runtime = reduce(g, runtime, providerEvent(41, 2), 4).runtime;
  const persisted = JSON.parse(JSON.stringify(runtime));
  persisted.nodesById.manager.providerState.activeChildIds.push('foreign-worker');
  assert.throws(
    () => validateOrchestrationHierarchyRuntimeV1(g, persisted),
    /Invalid provider child authority state/,
  );
});
