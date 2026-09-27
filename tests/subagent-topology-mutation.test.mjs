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
    nowMs: 300,
  }));

  assert.equal(result.decision, SubagentTopologyMutationDecision.ALLOW);
  assert.deepEqual(result.createdNodeIds, ['subagent-1', 'subagent-2']);
  assert.deepEqual(result.graph.nodesById.root.childIds, ['subagent-1', 'subagent-2']);
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

  assert.equal(result.activationAuthority, false);
  assert.equal(result.executionAuthority, false);
  assert.doesNotThrow(() => validateOrchestrationHierarchyRuntimeV1(result.graph, result.runtime));
  assert.equal(Object.isFrozen(result), true);
});

test('preserves explicit parent barrier semantics and allocates globally unique child ids', () => {
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
  }));

  assert.equal(result.decision, 'ALLOW');
  assert.deepEqual(result.createdNodeIds, ['subagent-2']);
  assert.deepEqual(result.graph.nodesById.root.childIds, ['subagent-1', 'subagent-2']);
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
});
