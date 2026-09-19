import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState } from '../../src/core/schema.js';
import {
  OrchestrationActivationPurpose,
  OrchestrationChatMode,
  OrchestrationHierarchyActionType,
  OrchestrationHierarchyEventType,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
  validateOrchestrationGraphV1,
} from '../../src/core/orchestration-hierarchy.js';
import {
  hierarchyCoreSessionId,
  hierarchyCoreTaskId,
  materializeHierarchyActionsIntoCore,
  preparedHierarchyActions,
} from '../../src/core/orchestration-hierarchy-core.js';
import { DRIVE_FOLDER_DISPATCH_PROVIDER_V1 } from '../../src/core/orchestration-drive-folder-provider.js';

const START = Date.parse('2026-09-19T00:00:00Z');
const SOURCE_ID = 'folder_dispatch_root';
const FP41 = 'a'.repeat(64);
const FP42 = 'b'.repeat(64);
const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);

function graph() {
  return validateOrchestrationGraphV1({
    schemaVersion: 1,
    graphId: 'l3-folder-dispatch',
    controlEpoch: 7,
    promptProfiles: [
      { id: 'manager-v1', role: 'DOMAIN_MANAGER', version: 1, prompt: 'MANAGER PROMPT' },
      { id: 'w1-v1', role: 'WORKER', version: 1, prompt: 'LOCAL WORKER ONE' },
      { id: 'w2-v1', role: 'WORKER', version: 1, prompt: 'LOCAL WORKER TWO' },
      { id: 'w3-v1', role: 'WORKER', version: 1, prompt: 'LOCAL WORKER THREE' },
    ],
    nodes: [
      {
        id: 'manager',
        parentId: null,
        childIds: ['worker-1', 'worker-2', 'worker-3'],
        promptProfileId: 'manager-v1',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 3,
        barrier: { mode: 'ALL_DIRECT_CHILDREN' },
        providerBinding: {
          providerId: DRIVE_FOLDER_DISPATCH_PROVIDER_V1,
          groupNodeId: 'manager',
          maxSlots: 3,
          sourceId: SOURCE_ID,
          pollIntervalMs: 180000,
        },
      },
      {
        id: 'worker-1',
        parentId: 'manager',
        childIds: [],
        promptProfileId: 'w1-v1',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      },
      {
        id: 'worker-2',
        parentId: 'manager',
        childIds: [],
        promptProfileId: 'w2-v1',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      },
      {
        id: 'worker-3',
        parentId: 'manager',
        childIds: [],
        promptProfileId: 'w3-v1',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      },
    ],
  });
}

function event(type, eventId, fields = {}) {
  return { type, eventId, controlEpoch: 7, ...fields };
}

function reduce(g, runtime, raw, tick) {
  return reduceOrchestrationHierarchyEvent(g, runtime, raw, START + tick);
}

function managerTerminal(g) {
  let runtime = createOrchestrationHierarchyRuntime(g, START);
  let out = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    'manager-start',
    {
      nodeId: 'manager',
      generation: 1,
      activationId: 'manager-plan',
      purpose: OrchestrationActivationPurpose.DELEGATE,
    },
  ), 1);
  runtime = out.runtime;
  runtime = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
    'manager-effect',
    { nodeId: 'manager', generation: 1, activationId: 'manager-plan' },
  ), 2).runtime;
  out = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.NODE_TERMINAL,
    'manager-terminal',
    { nodeId: 'manager', generation: 1, activationId: 'manager-plan', status: 'COMPLETED' },
  ), 3);
  assert.deepEqual(out.actions, [], 'provider-bound Manager must wait for folder dispatch');
  return out.runtime;
}

function folderEvent({
  revision = '41',
  fingerprint = FP41,
  eventId = `folder-${revision}`,
  dispatches = [
    {
      fileId: 'file_a',
      fileVersion: '8',
      dispatchIdentity: D1,
      targetChildId: 'worker-1',
      promptPayload: 'REMOTE BOUNDED WORK',
      promptProfileId: '',
    },
    {
      fileId: 'file_b',
      fileVersion: '9',
      dispatchIdentity: D2,
      targetChildId: 'worker-2',
      promptPayload: '',
      promptProfileId: 'w2-v1',
    },
  ],
} = {}) {
  return event(
    OrchestrationHierarchyEventType.PROVIDER_FOLDER_DISPATCH_REQUESTED,
    eventId,
    {
      nodeId: 'manager',
      providerId: DRIVE_FOLDER_DISPATCH_PROVIDER_V1,
      sourceId: SOURCE_ID,
      providerRevision: revision,
      dispatchFingerprint: fingerprint,
      dispatches,
    },
  );
}

test('L3 READY generation stores prompt authority durably and materializes through existing Core Sessions', () => {
  const g = graph();
  let runtime = managerTerminal(g);
  const out = reduce(g, runtime, folderEvent(), 4);
  runtime = out.runtime;

  assert.equal(out.reason, 'PROVIDER_REVISION_ACCEPTED');
  assert.deepEqual(out.actions.map(action => action.nodeId), ['worker-1', 'worker-2']);
  assert.equal(out.actions.every(action => action.type === OrchestrationHierarchyActionType.ACTIVATE_NODE), true);
  assert.equal(out.actions[0].promptPayload, 'REMOTE BOUNDED WORK');
  assert.equal(out.actions[0].providerDispatchIdentity, D1);
  assert.equal(out.actions[1].promptProfileId, 'w2-v1');
  assert.equal(runtime.nodesById.manager.providerState.lastAcceptedRevision, '41');
  assert.equal(runtime.nodesById.manager.providerState.lastAcceptedDispatchFingerprint, FP41);
  assert.deepEqual(runtime.nodesById.manager.providerState.activeChildIds, ['worker-1', 'worker-2']);

  const durable = JSON.parse(JSON.stringify(runtime));
  const recovered = preparedHierarchyActions(g, durable);
  const workerOne = recovered.find(action => action.nodeId === 'worker-1');
  const workerTwo = recovered.find(action => action.nodeId === 'worker-2');
  assert.equal(workerOne.promptPayload, 'REMOTE BOUNDED WORK');
  assert.equal(workerOne.providerDispatchIdentity, D1);
  assert.equal(workerTwo.promptProfileId, 'w2-v1');

  const core = createEmptyState(START);
  const materialized = materializeHierarchyActionsIntoCore(core, g, durable, recovered, { nowMs: START + 5 });
  assert.equal(materialized.materialized.length, 2);

  const w1 = core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-1')];
  const w1Task = w1.tasksById[hierarchyCoreTaskId(g.graphId, 'worker-1')];
  assert.equal(w1Task.promptOverride, 'REMOTE BOUNDED WORK');
  assert.equal(w1.orchestrationHierarchy.providerDispatchIdentity, D1);

  const w2 = core.sessionsById[hierarchyCoreSessionId(g.graphId, 'worker-2')];
  const w2Task = w2.tasksById[hierarchyCoreTaskId(g.graphId, 'worker-2')];
  assert.equal(w2Task.promptOverride, 'LOCAL WORKER TWO');
  assert.equal(w2.orchestrationHierarchy.providerDispatchIdentity, D2);
});

test('L3 same generation same snapshot is exact-once; mutation under same generation is manual-review conflict', () => {
  const g = graph();
  let runtime = managerTerminal(g);
  runtime = reduce(g, runtime, folderEvent(), 4).runtime;

  const replay = reduce(g, JSON.parse(JSON.stringify(runtime)), folderEvent({
    eventId: 'folder-41-replay',
  }), 5);
  assert.equal(replay.reason, 'DUPLICATE_PROVIDER_REVISION');
  assert.deepEqual(replay.actions, []);

  const conflict = reduce(g, replay.runtime, folderEvent({
    eventId: 'folder-41-conflict',
    fingerprint: 'c'.repeat(64),
  }), 6);
  assert.equal(conflict.reason, 'PROVIDER_REVISION_CONFLICT');
  assert.equal(conflict.actions.length, 1);
  assert.equal(conflict.actions[0].type, OrchestrationHierarchyActionType.MANUAL_REVIEW);
  assert.equal(conflict.runtime.nodesById.manager.providerState.lastAcceptedDispatchFingerprint, FP41);
});

test('L3 newer generation is not consumed while any local child slot is still active', () => {
  const g = graph();
  let runtime = managerTerminal(g);
  runtime = reduce(g, runtime, folderEvent(), 4).runtime;

  const newer = reduce(g, runtime, folderEvent({
    revision: '42',
    fingerprint: FP42,
    eventId: 'folder-42',
    dispatches: [{
      fileId: 'file_c',
      fileVersion: '1',
      dispatchIdentity: '3'.repeat(64),
      targetChildId: 'worker-3',
      promptPayload: 'GENERATION 42',
      promptProfileId: '',
    }],
  }), 5);
  assert.equal(newer.reason, 'PROVIDER_SLOTS_BUSY');
  assert.equal(newer.runtime.nodesById.manager.providerState.lastAcceptedRevision, '41');
  assert.equal(newer.runtime.processedEventIds['folder-42'], undefined);
});

test('L3 empty READY generation is valid no-work and schedules one Manager reconciliation', () => {
  const g = graph();
  const runtime = managerTerminal(g);
  const out = reduce(g, runtime, folderEvent({
    dispatches: [],
  }), 4);
  assert.equal(out.reason, 'PROVIDER_REVISION_ACCEPTED');
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].type, OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT);
  assert.equal(out.actions[0].nodeId, 'manager');
  assert.match(out.actions[0].activationId, /revision:41/);
  assert.deepEqual(out.runtime.nodesById.manager.providerState.activeChildIds, []);
});

test('L3 reducer rejects foreign provider/source, non-child targets and external recovery-profile authority', () => {
  const g = graph();
  const runtime = managerTerminal(g);

  const foreignProvider = reduce(g, runtime, {
    ...folderEvent({ eventId: 'foreign-provider' }),
    providerId: 'foreign-provider',
  }, 4);
  assert.equal(foreignProvider.reason, 'PROVIDER_AUTHORITY_MISMATCH');
  assert.deepEqual(foreignProvider.actions, []);

  const foreignSource = reduce(g, runtime, {
    ...folderEvent({ eventId: 'foreign-source' }),
    sourceId: 'other_folder',
  }, 5);
  assert.equal(foreignSource.reason, 'PROVIDER_SOURCE_MISMATCH');
  assert.deepEqual(foreignSource.actions, []);

  assert.throws(() => reduce(g, runtime, folderEvent({
    eventId: 'non-child',
    dispatches: [{
      fileId: 'bad_file',
      fileVersion: '1',
      dispatchIdentity: '4'.repeat(64),
      targetChildId: 'worker-foreign',
      promptPayload: 'bad',
      promptProfileId: '',
    }],
  }), 6), /non-child/);

  assert.throws(() => reduce(g, runtime, folderEvent({
    eventId: 'profile-escalation',
    dispatches: [{
      fileId: 'bad_profile',
      fileVersion: '1',
      dispatchIdentity: '5'.repeat(64),
      targetChildId: 'worker-1',
      promptPayload: '',
      promptProfileId: 'manager-v1',
    }],
  }), 7), /not locally allowed/);
});
