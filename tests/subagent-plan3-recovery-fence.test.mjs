import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrchestrationHierarchyRuntime,
  OrchestrationNodeLifecycle,
  validateOrchestrationGraphV1,
  validateOrchestrationHierarchyRuntimeV1,
} from '../src/core/orchestration-hierarchy.js';
import { SubagentSpawnInitiator } from '../src/core/subagent-structure-policy.js';
import { mutateOrchestrationSubagentTopologyV1 } from '../src/core/subagent-topology-mutation.js';

const policy = { schemaVersion: 1, allowAgentCreatedChildren: true, maxDepth: 2, maxChildrenPerAgent: 4 };
const graph = validateOrchestrationGraphV1({
  schemaVersion: 1, graphId: 'plan3.fence', controlEpoch: 7,
  loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
  promptProfiles: [
    { id: 'worker', role: 'worker', version: 1, prompt: 'work' },
    { id: 'recovery', role: 'recovery', version: 1, prompt: 'recover' },
  ],
  nodes: [{
    id: 'root', parentId: null, childIds: [], promptProfileId: 'worker',
    recoveryPromptProfileId: 'recovery', chatMode: 'NEW_CHAT_PER_ACTIVATION',
    maxActiveChildren: 0, barrier: { mode: 'NONE', childIds: [] },
    providerBinding: null,
  }],
});
const runtime = createOrchestrationHierarchyRuntime(graph, 100);
runtime.nodesById.root.lifecycle = OrchestrationNodeLifecycle.ACTIVE;
const canonicalRuntime = validateOrchestrationHierarchyRuntimeV1(graph, runtime);
const request = (overrides = {}) => ({
  graph, runtime: canonicalRuntime, policy, initiator: SubagentSpawnInitiator.AGENT,
  parentNodeId: 'root', requestedChildren: 2, resourceBudget: { maxChildAgents: 8 },
  spawnId: 'plan3.spawn', nowMs: 250, ...overrides,
});

test('exact durable restart replay cannot create an orphan or duplicate children', () => {
  const first = mutateOrchestrationSubagentTopologyV1(request());
  assert.equal(first.decision, 'ALLOW');
  assert.equal(first.reused, false);
  assert.equal(first.createdNodeIds.length, 2);
  const restartedGraph = JSON.parse(JSON.stringify(first.graph));
  const restartedRuntime = JSON.parse(JSON.stringify(first.runtime));
  const second = mutateOrchestrationSubagentTopologyV1(request({
    graph: restartedGraph, runtime: restartedRuntime, nowMs: 300,
  }));
  assert.equal(second.decision, 'ALLOW');
  assert.equal(second.reused, true);
  assert.equal(second.graph.nodeOrder.length, first.graph.nodeOrder.length);
  assert.deepEqual(second.createdNodeIds, first.createdNodeIds);
  const collision = mutateOrchestrationSubagentTopologyV1(request({
    graph: restartedGraph, runtime: restartedRuntime, requestedChildren: 1, nowMs: 300,
  }));
  assert.equal(collision.decision, 'DENY');
  assert.equal(collision.reasonCode, 'SPAWN_IDENTITY_CONFLICT');
  assert.equal(collision.executionAuthority, false);
  assert.equal(collision.activationAuthority, false);
});

test('parent pause on recovered tree prevents child auto-activation and keeps stored topology', () => {
  const first = mutateOrchestrationSubagentTopologyV1(request());
  const paused = JSON.parse(JSON.stringify(first.runtime));
  paused.nodesById.root.scopeState = 'PAUSED';
  const checked = mutateOrchestrationSubagentTopologyV1(request({
    graph: first.graph, runtime: paused, nowMs: 350,
  }));
  assert.equal(checked.reused, true);
  assert.deepEqual(checked.activationRequests, []);
  assert.deepEqual(checked.createdNodeIds, first.createdNodeIds);
  assert.equal(checked.executionAuthority, false);
});

test('stale restart clock and resource/child authority exhaustion fail closed', () => {
  assert.throws(
    () => mutateOrchestrationSubagentTopologyV1(request({ nowMs: 99 })),
    /nowMs cannot precede/u,
  );
  const budgetDenied = mutateOrchestrationSubagentTopologyV1(request({
    resourceBudget: { maxChildAgents: 0 },
  }));
  assert.equal(budgetDenied.decision, 'DENY');
  assert.equal(budgetDenied.createdNodeIds.length, 0);
  assert.equal(budgetDenied.activationAuthority, false);
  const policyDenied = mutateOrchestrationSubagentTopologyV1(request({
    policy: { ...policy, allowAgentCreatedChildren: false },
  }));
  assert.equal(policyDenied.decision, 'DENY');
  assert.equal(policyDenied.createdNodeIds.length, 0);
});

test('ALL_DIRECT_CHILDREN barrier allows idempotent durable restart replay without a second spawn', () => {
  const allChildrenGraph = validateOrchestrationGraphV1({
    schemaVersion: graph.schemaVersion,
    graphId: graph.graphId,
    controlEpoch: graph.controlEpoch,
    loopPolicy: structuredClone(graph.loopPolicy),
    promptProfiles: structuredClone(graph.promptProfiles),
    nodes: graph.nodeOrder.map(nodeId => ({
      ...structuredClone(graph.nodesById[nodeId]),
      barrier: { mode: 'ALL_DIRECT_CHILDREN', childIds: [] },
    })),
  });
  const initialRuntime = createOrchestrationHierarchyRuntime(allChildrenGraph, 100);
  initialRuntime.nodesById.root.lifecycle = OrchestrationNodeLifecycle.ACTIVE;
  const initial = validateOrchestrationHierarchyRuntimeV1(allChildrenGraph, initialRuntime);
  const first = mutateOrchestrationSubagentTopologyV1(request({
    graph: allChildrenGraph, runtime: initial,
  }));
  assert.equal(first.decision, 'ALLOW');
  assert.equal(first.reused, false);
  assert.equal(first.graph.nodesById.root.barrier.mode, 'ALL_DIRECT_CHILDREN');
  const replay = mutateOrchestrationSubagentTopologyV1(request({
    graph: JSON.parse(JSON.stringify(first.graph)),
    runtime: JSON.parse(JSON.stringify(first.runtime)),
    nowMs: 300,
  }));
  assert.equal(replay.decision, 'ALLOW');
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.createdNodeIds, first.createdNodeIds);
  assert.equal(replay.graph.nodeOrder.length, first.graph.nodeOrder.length);
  assert.equal(replay.executionAuthority, false);
  assert.equal(replay.activationAuthority, false);
});

test('paused ancestor blocks a new nested durable spawn despite active child state', () => {
  const initial = mutateOrchestrationSubagentTopologyV1(request({
    requestedChildren: 1, spawnId: 'ancestor.top',
  }));
  assert.equal(initial.decision, 'ALLOW');
  const childId = initial.createdNodeIds[0];
  const resumed = structuredClone(initial.runtime);
  resumed.nodesById[childId].lifecycle = OrchestrationNodeLifecycle.ACTIVE;
  const nestedRequest = {
    graph: initial.graph, runtime: resumed, parentNodeId: childId,
    requestedChildren: 1, spawnId: 'ancestor.nested', nowMs: 300,
  };
  const allowed = mutateOrchestrationSubagentTopologyV1(request(nestedRequest));
  assert.equal(allowed.decision, 'ALLOW');
  assert.equal(allowed.activationAuthority, false);
  resumed.nodesById.root.scopeState = 'PAUSED';
  const denied = mutateOrchestrationSubagentTopologyV1(request(nestedRequest));
  assert.equal(denied.decision, 'DENY');
  assert.equal(denied.reasonCode, 'ANCESTOR_SCOPE_NOT_RUNNING');
  assert.deepEqual(denied.createdNodeIds, []);
  assert.deepEqual(denied.activationRequests, []);
  assert.equal(denied.executionAuthority, false);
  assert.equal(denied.activationAuthority, false);
});
