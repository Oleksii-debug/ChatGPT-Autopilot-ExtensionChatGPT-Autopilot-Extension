import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrchestrationActivationPhase,
  OrchestrationActivationPurpose,
  OrchestrationHierarchyActionType,
  OrchestrationHierarchyEventType,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
} from '../../src/core/orchestration-hierarchy.js';
import { buildThreeLevelHierarchyTemplate } from '../../src/core/orchestration-role-prompts.js';

const START = Date.parse('2026-09-19T00:00:00Z');

function graph() {
  return buildThreeLevelHierarchyTemplate({
    graphId: 'l1h-chaos-reducer',
    controlEpoch: 9,
    projectId: 'l1h-chaos-reducer',
    targetRepository: 'owner/repo',
    controlIssueNumber: 1,
    domains: Array.from({ length: 5 }, (_, index) => ({
      id: `domain-${index + 1}`,
      scope: `Domain ${index + 1}.`,
    })),
    workersPerManager: 5,
  });
}

function event(type, eventId, fields = {}) {
  return { type, eventId, controlEpoch: 9, ...fields };
}

function reduce(g, runtime, raw, tick = 1) {
  return reduceOrchestrationHierarchyEvent(g, runtime, raw, START + tick);
}

test('L1-H ambiguous effect survives durable restart and stale generation can never replay it', () => {
  const g = graph();
  const workerId = 'worker:domain-1:01';
  let runtime = createOrchestrationHierarchyRuntime(g, START);

  let result = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    'prepare-worker-g1',
    {
      nodeId: workerId,
      generation: 1,
      activationId: 'worker-g1-effect',
      purpose: OrchestrationActivationPurpose.WORK,
    },
  ), 1);
  runtime = result.runtime;
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.ACTIVATE_NODE);

  result = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.NODE_EFFECT_AMBIGUOUS,
    'ambiguous-worker-g1',
    {
      nodeId: workerId,
      generation: 1,
      activationId: 'worker-g1-effect',
    },
  ), 2);
  runtime = result.runtime;
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, OrchestrationHierarchyActionType.VERIFY_AMBIGUOUS_EFFECT);
  assert.equal(
    runtime.nodesById[workerId].activationLedger['worker-g1-effect'].phase,
    OrchestrationActivationPhase.AMBIGUOUS,
  );

  runtime = JSON.parse(JSON.stringify(runtime));
  result = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.RUNTIME_RECONCILE,
    'restart-reconcile-ambiguous',
  ), 3);
  runtime = result.runtime;
  assert.equal(
    result.actions.filter(action => action.type === OrchestrationHierarchyActionType.ACTIVATE_NODE).length,
    0,
    'restart reconciliation must never blindly replay an ambiguous physical effect',
  );
  assert.deepEqual(
    result.actions.map(action => [action.type, action.nodeId, action.activationId]),
    [[OrchestrationHierarchyActionType.VERIFY_AMBIGUOUS_EFFECT, workerId, 'worker-g1-effect']],
  );

  result = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.GENERATION_RECOVERY_REQUESTED,
    'recover-worker-g2',
    {
      nodeId: workerId,
      generation: 1,
      newGeneration: 2,
      activationId: 'worker-g2-recovery',
    },
  ), 4);
  runtime = result.runtime;
  assert.equal(runtime.nodesById[workerId].generation, 2);
  assert.equal(
    runtime.nodesById[workerId].activationLedger['worker-g1-effect'].phase,
    OrchestrationActivationPhase.SUPERSEDED,
  );
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].purpose, OrchestrationActivationPurpose.RECOVERY);

  const lateOldGeneration = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.NODE_TERMINAL,
    'late-worker-g1-terminal',
    {
      nodeId: workerId,
      generation: 1,
      activationId: 'worker-g1-effect',
      status: 'COMPLETED',
    },
  ), 5);
  assert.equal(lateOldGeneration.reason, 'STALE_GENERATION');
  assert.deepEqual(lateOldGeneration.actions, []);
  assert.equal(
    lateOldGeneration.runtime.nodesById[workerId].activationLedger['worker-g1-effect'].phase,
    OrchestrationActivationPhase.SUPERSEDED,
  );
});

test('L1-H Pause Resume Stop race remains subtree-local and Stop is sticky across 5 workers', () => {
  const g = graph();
  const managerId = 'manager:domain-3';
  const workerIds = g.nodesById[managerId].childIds;
  let runtime = createOrchestrationHierarchyRuntime(g, START);

  runtime = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.PAUSE_SCOPE,
    'race-pause-1',
    { nodeId: managerId },
  ), 1).runtime;
  assert.equal(runtime.nodesById[managerId].scopeState, 'PAUSED');
  assert.equal(workerIds.every(id => runtime.nodesById[id].scopeState === 'PAUSED'), true);
  assert.equal(runtime.nodesById['manager:domain-2'].scopeState, 'RUNNING');

  const blocked = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    'paused-worker-attempt',
    {
      nodeId: workerIds[0],
      generation: 1,
      activationId: 'must-not-run-while-paused',
      purpose: OrchestrationActivationPurpose.WORK,
    },
  ), 2);
  runtime = blocked.runtime;
  assert.equal(blocked.reason, 'SCOPE_PAUSED');
  assert.deepEqual(blocked.actions, []);
  assert.equal(runtime.nodesById[workerIds[0]].activationLedger['must-not-run-while-paused'], undefined);

  runtime = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.RESUME_SCOPE,
    'race-resume-1',
    { nodeId: managerId },
  ), 3).runtime;
  assert.equal(workerIds.every(id => runtime.nodesById[id].scopeState === 'RUNNING'), true);

  const allowed = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    'resumed-worker-attempt',
    {
      nodeId: workerIds[0],
      generation: 1,
      activationId: 'allowed-after-resume',
      purpose: OrchestrationActivationPurpose.WORK,
    },
  ), 4);
  runtime = allowed.runtime;
  assert.equal(allowed.actions.length, 1);
  assert.equal(allowed.actions[0].type, OrchestrationHierarchyActionType.ACTIVATE_NODE);

  runtime = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.STOP_SCOPE,
    'race-stop-final',
    { nodeId: managerId },
  ), 5).runtime;
  runtime = JSON.parse(JSON.stringify(runtime));
  runtime = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.RESUME_SCOPE,
    'race-resume-after-stop',
    { nodeId: managerId },
  ), 6).runtime;

  assert.equal(runtime.nodesById[managerId].scopeState, 'STOPPED');
  assert.equal(workerIds.every(id => runtime.nodesById[id].scopeState === 'STOPPED'), true);
  assert.equal(runtime.nodesById['manager:domain-2'].scopeState, 'RUNNING');

  const afterStop = reduce(g, runtime, event(
    OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    'post-stop-worker-attempt',
    {
      nodeId: workerIds[1],
      generation: 1,
      activationId: 'must-never-run-after-stop',
      purpose: OrchestrationActivationPurpose.WORK,
    },
  ), 7);
  assert.equal(afterStop.reason, 'SCOPE_STOPPED');
  assert.deepEqual(afterStop.actions, []);
});
