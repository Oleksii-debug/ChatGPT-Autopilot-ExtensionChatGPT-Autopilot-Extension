import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrchestrationNodeLifecycle,
  createOrchestrationHierarchyRuntime,
  validateOrchestrationGraphV1,
  validateOrchestrationHierarchyRuntimeV1,
} from '../src/core/orchestration-hierarchy.js';
import { SubagentSpawnInitiator } from '../src/core/subagent-structure-policy.js';
import {
  SubagentTopologyMutationDecision,
  mutateOrchestrationSubagentTopologyV1,
} from '../src/core/subagent-topology-mutation.js';

const policy = {
  schemaVersion: 1,
  allowAgentCreatedChildren: true,
  maxDepth: 2,
  maxChildrenPerAgent: 4,
};

function node(id, parentId = null, childIds = [], extra = {}) {
  return {
    id,
    parentId,
    childIds,
    promptProfileId: 'worker',
    recoveryPromptProfileId: 'recovery',
    chatMode: 'NEW_CHAT_PER_ACTIVATION',
    maxActiveChildren: childIds.length,
    barrier: childIds.length
      ? { mode: 'ALL_DIRECT_CHILDREN', childIds }
      : { mode: 'NONE', childIds: [] },
    providerBinding: null,
    ...extra,
  };
}

function graph(nodes) {
  return validateOrchestrationGraphV1({
    schemaVersion: 1,
    graphId: 'spawn-test',
    controlEpoch: 7,
    loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
    promptProfiles: [
      { id: 'worker', role: 'worker', version: 1, prompt: 'work' },
      { id: 'recovery', role: 'recovery', version: 1, prompt: 'recover' },
    ],
    nodes,
  });
}

function runtimeFor(canonicalGraph, { active = true, scopeState = 'RUNNING' } = {}) {
  const runtime = createOrchestrationHierarchyRuntime(canonicalGraph, 100);
  runtime.nodesById.root.lifecycle = active
    ? OrchestrationNodeLifecycle.ACTIVE
    : OrchestrationNodeLifecycle.IDLE;
  runtime.nodesById.root.scopeState = scopeState;
  return validateOrchestrationHierarchyRuntimeV1(canonicalGraph, runtime);
}

function request(overrides = {}) {
  const canonicalGraph = overrides.graph || graph([node('root')]);
  return {
    graph: canonicalGraph,
    runtime: overrides.runtime || runtimeFor(canonicalGraph),
    policy: overrides.policy || policy,
    initiator: overrides.initiator || SubagentSpawnInitiator.AGENT,
    parentNodeId: overrides.parentNodeId || 'root',
    requestedChildren: overrides.requestedChildren || 1,
    resourceBudget: overrides.resourceBudget || { maxChildAgents: 8 },
    spawnId: overrides.spawnId || 'spawn-a',
    nowMs: overrides.nowMs ?? 250,
  };
}

test('atomically appends inherited child topology while preserving durable parent runtime', () => {
  const canonicalGraph = graph([node('root')]);
  const runtime = runtimeFor(canonicalGraph);
  runtime.nodesById.root.activationLedger.keep = {
    activationId: 'keep',
    generation: 1,
    purpose: 'WORK',
    phase: 'PREPARED',
    createdAt: 100,
    updatedAt: 100,
  };
  const result = mutateOrchestrationSubagentTopologyV1(request({
    graph: canonicalGraph,
    runtime,
    requestedChildren: 2,
    spawnId: 'effect-17',
    nowMs: 300,
  }));

  assert.equal(result.decision, SubagentTopologyMutationDecision.ALLOW);
  assert.deepEqual(result.createdNodeIds, ['subagent:effect-17:1', 'subagent:effect-17:2']);
  assert.deepEqual(result.graph.nodesById.root.childIds, ['subagent:effect-17:1', 'subagent:effect-17:2']);
  assert.equal(result.runtime.createdAt, runtime.createdAt);
  assert.equal(result.runtime.updatedAt, 300);
  assert.deepEqual(result.runtime.nodesById.root.activationLedger, runtime.nodesById.root.activationLedger);

  for (const childId of result.createdNodeIds) {
    const child = result.graph.nodesById[childId];
    assert.equal(child.parentId, 'root');
    assert.equal(child.promptProfileId, 'worker');
    assert.equal(child.recoveryPromptProfileId, 'recovery');
    assert.equal(child.chatMode, 'NEW_CHAT_PER_ACTIVATION');
    assert.equal(child.providerBinding, null);
    assert.deepEqual(child.childIds, []);
    assert.equal(result.runtime.nodesById[childId].lifecycle, OrchestrationNodeLifecycle.IDLE);
  }

  assert.equal(result.reused, false);
  assert.equal(result.activationAuthority, false);
  assert.equal(result.executionAuthority, false);
  assert.doesNotThrow(() => validateOrchestrationHierarchyRuntimeV1(result.graph, result.runtime));
  assert.equal(Object.isFrozen(result), true);
});

test('same spawn identity is exact-effect idempotent after restart', () => {
  const first = mutateOrchestrationSubagentTopologyV1(request({
    requestedChildren: 2,
    spawnId: 'exact-effect-1',
    nowMs: 300,
  }));
  const second = mutateOrchestrationSubagentTopologyV1(request({
    graph: first.graph,
    runtime: first.runtime,
    requestedChildren: 2,
    spawnId: 'exact-effect-1',
    resourceBudget: { maxChildAgents: 2 },
    nowMs: 999,
  }));

  assert.equal(second.decision, 'ALLOW');
  assert.equal(second.reasonCode, 'SUBAGENT_TOPOLOGY_REUSED');
  assert.equal(second.reused, true);
  assert.deepEqual(second.createdNodeIds, first.createdNodeIds);
  assert.deepEqual(second.graph, first.graph);
  assert.deepEqual(second.runtime, first.runtime);
});

test('spawn id prefix overlap does not corrupt exact-effect replay families', () => {
  const first = mutateOrchestrationSubagentTopologyV1(request({
    spawnId: 'effect',
    nowMs: 300,
  }));
  const second = mutateOrchestrationSubagentTopologyV1(request({
    graph: first.graph,
    runtime: first.runtime,
    spawnId: 'effect:child',
    nowMs: 400,
  }));

  assert.equal(second.decision, 'ALLOW');
  assert.deepEqual(second.createdNodeIds, ['subagent:effect:child:1']);

  const replayFirst = mutateOrchestrationSubagentTopologyV1(request({
    graph: second.graph,
    runtime: second.runtime,
    spawnId: 'effect',
    nowMs: 500,
  }));
  assert.equal(replayFirst.decision, 'ALLOW');
  assert.equal(replayFirst.reasonCode, 'SUBAGENT_TOPOLOGY_REUSED');
  assert.deepEqual(replayFirst.createdNodeIds, ['subagent:effect:1']);

  const replaySecond = mutateOrchestrationSubagentTopologyV1(request({
    graph: second.graph,
    runtime: second.runtime,
    spawnId: 'effect:child',
    nowMs: 600,
  }));
  assert.equal(replaySecond.decision, 'ALLOW');
  assert.equal(replaySecond.reasonCode, 'SUBAGENT_TOPOLOGY_REUSED');
  assert.deepEqual(replaySecond.createdNodeIds, ['subagent:effect:child:1']);
});

test('same spawn identity rejects replay after child authority drift', () => {
  const first = mutateOrchestrationSubagentTopologyV1(request({
    spawnId: 'exact-effect-authority',
  }));
  const tamperedGraph = structuredClone(first.graph);
  tamperedGraph.nodesById[first.createdNodeIds[0]].promptProfileId = 'recovery';

  const conflict = mutateOrchestrationSubagentTopologyV1(request({
    graph: tamperedGraph,
    runtime: first.runtime,
    spawnId: 'exact-effect-authority',
  }));

  assert.equal(conflict.decision, 'DENY');
  assert.equal(conflict.reasonCode, 'SPAWN_IDENTITY_CONFLICT');
});

test('same spawn identity cannot be replayed with a different child count', () => {
  const first = mutateOrchestrationSubagentTopologyV1(request({
    requestedChildren: 2,
    spawnId: 'exact-effect-2',
  }));
  const conflict = mutateOrchestrationSubagentTopologyV1(request({
    graph: first.graph,
    runtime: first.runtime,
    requestedChildren: 1,
    spawnId: 'exact-effect-2',
  }));
  assert.equal(conflict.decision, 'DENY');
  assert.equal(conflict.reasonCode, 'SPAWN_IDENTITY_CONFLICT');
  assert.deepEqual(conflict.createdNodeIds, []);
});

test('preserves explicit parent barrier semantics and unrelated node identities', () => {
  const canonicalGraph = graph([
    node('root', null, ['subagent-1'], {
      barrier: { mode: 'REQUIRED_DIRECT_CHILDREN', childIds: ['subagent-1'] },
      maxActiveChildren: 1,
    }),
    node('subagent-1', 'root'),
  ]);
  const result = mutateOrchestrationSubagentTopologyV1(request({
    graph: canonicalGraph,
    runtime: runtimeFor(canonicalGraph),
    spawnId: 'new-effect',
  }));

  assert.equal(result.decision, 'ALLOW');
  assert.deepEqual(result.createdNodeIds, ['subagent:new-effect:1']);
  assert.equal(result.graph.nodesById.root.childIds.includes('subagent-1'), true);
  assert.equal(result.graph.nodesById.root.childIds.includes('subagent:new-effect:1'), true);
  assert.deepEqual(result.graph.nodesById.root.barrier, {
    mode: 'REQUIRED_DIRECT_CHILDREN',
    childIds: ['subagent-1'],
  });
  assert.equal(result.graph.nodesById.root.maxActiveChildren, 1);
});

test('structure policy denial performs no topology mutation', () => {
  const result = mutateOrchestrationSubagentTopologyV1(request({
    requestedChildren: 2,
    policy: { ...policy, maxChildrenPerAgent: 1 },
  }));
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'STRUCTURE_DENIED');
  assert.equal(result.structure.reasonCode, 'MAX_FANOUT_EXCEEDED');
  assert.deepEqual(result.createdNodeIds, []);
});

test('global child budget is consumed from canonical graph facts and fails closed', () => {
  const canonicalGraph = graph([
    node('root', null, ['existing']),
    node('existing', 'root'),
  ]);
  const result = mutateOrchestrationSubagentTopologyV1(request({
    graph: canonicalGraph,
    runtime: runtimeFor(canonicalGraph),
    resourceBudget: { maxChildAgents: 1 },
  }));
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'RESOURCE_BUDGET_DENIED');
  assert.deepEqual(result.resource.exceeded, ['childAgents']);
  assert.equal(result.resource.usage.childAgents, 1);
});

test('agent-created children require live RUNNING parent authority', () => {
  const canonicalGraph = graph([node('root')]);

  const idle = mutateOrchestrationSubagentTopologyV1(request({
    graph: canonicalGraph,
    runtime: runtimeFor(canonicalGraph, { active: false }),
  }));
  assert.equal(idle.reasonCode, 'AGENT_PARENT_NOT_ACTIVE');

  const paused = mutateOrchestrationSubagentTopologyV1(request({
    graph: canonicalGraph,
    runtime: runtimeFor(canonicalGraph, { active: true, scopeState: 'PAUSED' }),
  }));
  assert.equal(paused.reasonCode, 'PARENT_SCOPE_NOT_RUNNING');
});

test('owner topology creation is limited to idle parents', () => {
  const canonicalGraph = graph([node('root')]);
  const allowed = mutateOrchestrationSubagentTopologyV1(request({
    graph: canonicalGraph,
    runtime: runtimeFor(canonicalGraph, { active: false }),
    initiator: SubagentSpawnInitiator.OWNER,
  }));
  assert.equal(allowed.decision, 'ALLOW');

  const active = mutateOrchestrationSubagentTopologyV1(request({
    graph: canonicalGraph,
    runtime: runtimeFor(canonicalGraph, { active: true }),
    initiator: SubagentSpawnInitiator.OWNER,
  }));
  assert.equal(active.reasonCode, 'OWNER_PARENT_NOT_IDLE');
});

test('provider-bound parents cannot mix dynamic provider authority with static child spawn', () => {
  const canonicalGraph = graph([
    node('root', null, ['slot'], {
      providerBinding: {
        providerId: 'drive-scalar-v1',
        groupNodeId: 'root',
        maxSlots: 1,
        sourceId: 'source',
        pollIntervalMs: 60000,
      },
    }),
    node('slot', 'root'),
  ]);
  const result = mutateOrchestrationSubagentTopologyV1(request({
    graph: canonicalGraph,
    runtime: runtimeFor(canonicalGraph),
  }));
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'PARENT_PROVIDER_BOUND');
});

test('spawned children cannot amplify prompt, recovery, chat or provider authority', () => {
  const canonicalGraph = graph([
    node('root', null, [], {
      promptProfileId: 'worker',
      recoveryPromptProfileId: 'recovery',
      chatMode: 'PERSISTENT_CHAT',
    }),
  ]);
  const result = mutateOrchestrationSubagentTopologyV1(request({
    graph: canonicalGraph,
    runtime: runtimeFor(canonicalGraph),
  }));
  const child = result.graph.nodesById[result.createdNodeIds[0]];
  const parent = result.graph.nodesById.root;
  assert.equal(child.promptProfileId, parent.promptProfileId);
  assert.equal(child.recoveryPromptProfileId, parent.recoveryPromptProfileId);
  assert.equal(child.chatMode, parent.chatMode);
  assert.equal(child.providerBinding, null);
});

test('mutation time is explicit trusted input with no ambient clock fallback', () => {
  const raw = request();
  delete raw.nowMs;
  assert.throws(
    () => mutateOrchestrationSubagentTopologyV1(raw),
    /nowMs is invalid/,
  );
});

test('request boundary rejects accessors, hidden authority and unknown fields without getter reads', () => {
  let reads = 0;
  const raw = request();
  Object.defineProperty(raw, 'requestedChildren', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 1;
    },
  });
  assert.throws(
    () => mutateOrchestrationSubagentTopologyV1(raw),
    /requestedChildren.*enumerable own data property/,
  );
  assert.equal(reads, 0);

  const unknown = { ...request(), spawnAuthority: true };
  assert.throws(
    () => mutateOrchestrationSubagentTopologyV1(unknown),
    /unknown field: spawnAuthority/,
  );

  const symbolic = request();
  symbolic[Symbol('authority')] = true;
  assert.throws(
    () => mutateOrchestrationSubagentTopologyV1(symbolic),
    /symbol field/,
  );

  assert.throws(
    () => mutateOrchestrationSubagentTopologyV1(request({ spawnId: 'bad id' })),
    /spawnId is invalid/,
  );
});
