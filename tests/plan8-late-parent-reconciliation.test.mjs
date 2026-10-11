import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OrchestrationHierarchyActionType, OrchestrationHierarchyEventType,
  createOrchestrationHierarchyRuntime, reduceOrchestrationHierarchyEvent,
  validateOrchestrationGraphV1,
} from '../src/core/orchestration-hierarchy.js';
import { mutateOrchestrationSubagentTopologyV1 } from '../src/core/subagent-topology-mutation.js';
import { SubagentSpawnInitiator } from '../src/core/subagent-structure-policy.js';

const profile = id => ({ id, role: id, version: 1, prompt: id });
const graph = () => validateOrchestrationGraphV1({
  schemaVersion: 1, graphId: 'spawn-test', controlEpoch: 7,
  loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
  promptProfiles: [profile('worker'), profile('recovery')],
  nodes: [{
    id: 'root', parentId: null, childIds: [],
    promptProfileId: 'worker', recoveryPromptProfileId: 'recovery',
    chatMode: 'NEW_CHAT_PER_ACTIVATION', maxActiveChildren: 0,
    barrier: { mode: 'NONE', childIds: [] }, providerBinding: null,
  }],
});
const event = (type, eventId, nodeId, activationId, props = {}) => ({
  type, eventId, controlEpoch: 7, nodeId, generation: 1, activationId, ...props,
});
function simulate() {
  const initial = graph();
  const requested = reduceOrchestrationHierarchyEvent(
    initial, createOrchestrationHierarchyRuntime(initial, 100),
    event(OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
      'parent:start', 'root', 'parent:work', { purpose: 'WORK' }), 101,
  );
  const active = reduceOrchestrationHierarchyEvent(
    initial, requested.runtime,
    event(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
      'parent:active', 'root', 'parent:work', { effectRef: 'effect://parent' }), 102,
  );
  const spawned = mutateOrchestrationSubagentTopologyV1({
    graph: initial, runtime: active.runtime,
    policy: { schemaVersion: 1, allowAgentCreatedChildren: true, maxDepth: 2, maxChildrenPerAgent: 4 },
    initiator: SubagentSpawnInitiator.AGENT, parentNodeId: 'root',
    requestedChildren: 1, resourceBudget: { maxChildAgents: 8 },
    spawnId: 'dynamic-parent-child', nowMs: 300,
  });
  assert.equal(spawned.decision, 'ALLOW');
  const childId = spawned.createdNodeIds[0];
  const activation = spawned.activationRequests[0];
  const prepared = reduceOrchestrationHierarchyEvent(
    spawned.graph, spawned.runtime, activation, 301,
  );
  const confirmed = reduceOrchestrationHierarchyEvent(
    spawned.graph, prepared.runtime,
    event(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
      'child:active', childId, activation.activationId, { effectRef: 'effect://child' }), 302,
  );
  const terminal = reduceOrchestrationHierarchyEvent(
    spawned.graph, confirmed.runtime,
    event(OrchestrationHierarchyEventType.NODE_TERMINAL,
      'child:terminal', childId, activation.activationId, { status: 'COMPLETED' }), 303,
  );
  return {
    graph: spawned.graph, childId, childTerminal: terminal,
    parentTerminalEvent: event(OrchestrationHierarchyEventType.NODE_TERMINAL,
      'parent:terminal', 'root', 'parent:work', { status: 'COMPLETED' }),
  };
}
const reconciliationCount = (actions, nodeId = 'root') => actions.filter(action => (
  action.type === OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT
  && action.nodeId === nodeId
)).length;

test('Plan 8: late WORK parent terminal re-evaluates already terminal spawned child exactly once', () => {
  const { graph, childTerminal, parentTerminalEvent } = simulate();
  assert.equal(reconciliationCount(childTerminal.actions), 0);
  const result = reduceOrchestrationHierarchyEvent(
    graph, childTerminal.runtime, parentTerminalEvent, 304,
  );
  assert.equal(reconciliationCount(result.actions), 1);
  const replay = reduceOrchestrationHierarchyEvent(
    graph, structuredClone(result.runtime),
    { ...parentTerminalEvent, eventId: 'parent:terminal-cold-restart-replay' }, 305,
  );
  assert.equal(reconciliationCount(replay.actions), 0);
});

test('Plan 8: parent terminal before child waits and reconciles only after child terminal', () => {
  const { graph, childId, childTerminal, parentTerminalEvent } = simulate();
  const childRuntime = structuredClone(childTerminal.runtime);
  const activationId = childRuntime.nodesById[childId].currentActivationId;
  const ledger = childRuntime.nodesById[childId].activationLedger[activationId];
  ledger.phase = 'EFFECT_CONFIRMED';
  ledger.terminalAt = 0;
  ledger.terminalStatus = '';
  childRuntime.nodesById[childId].lifecycle = 'ACTIVE';
  const parentTerminal = reduceOrchestrationHierarchyEvent(
    graph, childRuntime, parentTerminalEvent, 304,
  );
  assert.equal(reconciliationCount(parentTerminal.actions), 0);
  const childAfterParent = reduceOrchestrationHierarchyEvent(
    graph, parentTerminal.runtime,
    event(OrchestrationHierarchyEventType.NODE_TERMINAL,
      'child:terminal-after-parent', childId, activationId,
      { status: 'COMPLETED' }), 305,
  );
  assert.equal(reconciliationCount(childAfterParent.actions), 1);
});
