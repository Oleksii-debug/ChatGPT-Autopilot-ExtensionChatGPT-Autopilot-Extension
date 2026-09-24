import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SubagentSpawnInitiator,
  deriveSubagentStructureFactsFromGraphV1,
  evaluateSubagentStructureAdmissionV1,
  normalizeSubagentStructurePolicyV1,
  remainingSubagentStructureCapacityV1,
} from '../src/core/subagent-structure-policy.js';

const policy = {
  schemaVersion: 1,
  allowAgentCreatedChildren: true,
  maxDepth: 4,
  maxChildrenPerAgent: 5,
};

function node(id, parentId = null, childIds = []) {
  return {
    id,
    parentId,
    childIds,
    promptProfileId: 'worker',
  };
}

function graph(nodes) {
  return {
    schemaVersion: 1,
    graphId: 'subagent-structure-test',
    controlEpoch: 1,
    loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
    promptProfiles: [{
      id: 'worker',
      role: 'worker',
      version: 1,
      prompt: 'work',
    }],
    nodes,
  };
}

const ROOT_ONLY = graph([
  node('root'),
]);

test('defaults fail closed for automatic child creation, depth and fanout', () => {
  assert.deepEqual(normalizeSubagentStructurePolicyV1({}), {
    schemaVersion: 1,
    allowAgentCreatedChildren: false,
    maxDepth: 0,
    maxChildrenPerAgent: 0,
  });
});

test('owner may create within structural bounds while automatic agent creation can be disabled', () => {
  const locked = { ...policy, allowAgentCreatedChildren: false };
  const owner = evaluateSubagentStructureAdmissionV1({
    policy: locked,
    initiator: SubagentSpawnInitiator.OWNER,
    graph: ROOT_ONLY,
    parentNodeId: 'root',
    requestedChildren: 2,
  });
  const agent = evaluateSubagentStructureAdmissionV1({
    policy: locked,
    initiator: SubagentSpawnInitiator.AGENT,
    graph: ROOT_ONLY,
    parentNodeId: 'root',
    requestedChildren: 1,
  });
  assert.equal(owner.decision, 'ALLOW');
  assert.equal(agent.decision, 'DENY');
  assert.equal(agent.reasonCode, 'AGENT_CHILD_CREATION_DISABLED');
});

test('depth is derived from canonical graph and denies children beyond owner maximum', () => {
  const canonical = graph([
    node('root', null, ['manager']),
    node('manager', 'root', ['worker-a']),
    node('worker-a', 'manager'),
  ]);
  assert.deepEqual(
    deriveSubagentStructureFactsFromGraphV1({ graph: canonical, parentNodeId: 'manager' }),
    {
      parentNodeId: 'manager',
      parentDepth: 1,
      currentDirectChildren: 1,
    },
  );

  const result = evaluateSubagentStructureAdmissionV1({
    policy: { ...policy, maxDepth: 1 },
    initiator: SubagentSpawnInitiator.AGENT,
    graph: canonical,
    parentNodeId: 'manager',
    requestedChildren: 1,
  });
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'MAX_DEPTH_EXCEEDED');
  assert.equal(result.childDepth, 2);
});

test('fanout is derived from canonical graph and never partially admits a larger request', () => {
  const canonical = graph([
    node('root', null, ['a', 'b', 'c', 'd']),
    node('a', 'root'),
    node('b', 'root'),
    node('c', 'root'),
    node('d', 'root'),
  ]);
  const result = evaluateSubagentStructureAdmissionV1({
    policy,
    initiator: SubagentSpawnInitiator.AGENT,
    graph: canonical,
    parentNodeId: 'root',
    requestedChildren: 2,
  });
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'MAX_FANOUT_EXCEEDED');
  assert.equal(result.availableDirectChildren, 1);
});

test('remaining capacity is deterministic for owner-selected or agent-selected worker counts', () => {
  const canonical = graph([
    node('root', null, ['a', 'b']),
    node('a', 'root'),
    node('b', 'root'),
  ]);
  const capacity = remainingSubagentStructureCapacityV1({
    policy,
    initiator: SubagentSpawnInitiator.AGENT,
    graph: canonical,
    parentNodeId: 'root',
  });
  assert.deepEqual(capacity, {
    parentNodeId: 'root',
    childDepth: 1,
    agentCreationBlocked: false,
    depthBlocked: false,
    availableDirectChildren: 3,
  });

  const result = evaluateSubagentStructureAdmissionV1({
    policy,
    initiator: SubagentSpawnInitiator.AGENT,
    graph: canonical,
    parentNodeId: 'root',
    requestedChildren: 3,
  });
  assert.equal(result.decision, 'ALLOW');
});

test('caller-supplied depth or child counts are rejected instead of overriding canonical tree facts', () => {
  const canonical = graph([
    node('root', null, ['manager']),
    node('manager', 'root', ['a', 'b']),
    node('a', 'manager'),
    node('b', 'manager'),
  ]);

  assert.throws(() => evaluateSubagentStructureAdmissionV1({
    policy: { ...policy, maxDepth: 1, maxChildrenPerAgent: 2 },
    initiator: SubagentSpawnInitiator.AGENT,
    graph: canonical,
    parentNodeId: 'manager',
    parentDepth: 0,
    currentDirectChildren: 0,
    requestedChildren: 1,
  }), /unknown field/);

  const result = evaluateSubagentStructureAdmissionV1({
    policy: { ...policy, maxDepth: 1, maxChildrenPerAgent: 2 },
    initiator: SubagentSpawnInitiator.AGENT,
    graph: canonical,
    parentNodeId: 'manager',
    requestedChildren: 1,
  });
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'MAX_DEPTH_EXCEEDED');
});

test('unknown fields, coercion, exotic objects and invalid identities fail closed', () => {
  assert.throws(() => normalizeSubagentStructurePolicyV1({ ...policy, maxDepth: '4' }), /invalid/);
  assert.throws(() => normalizeSubagentStructurePolicyV1({ ...policy, surprise: true }), /unknown field/);
  assert.throws(() => normalizeSubagentStructurePolicyV1(Object.create(policy)), /plain object/);
  assert.throws(() => evaluateSubagentStructureAdmissionV1({
    policy,
    initiator: 'SYSTEM',
    graph: ROOT_ONLY,
    parentNodeId: 'root',
    requestedChildren: 1,
  }), /initiator is invalid/);
  assert.throws(() => deriveSubagentStructureFactsFromGraphV1({
    graph: ROOT_ONLY,
    parentNodeId: 1,
  }), /parentNodeId is invalid/);
  assert.throws(() => deriveSubagentStructureFactsFromGraphV1({
    graph: ROOT_ONLY,
    parentNodeId: 'missing',
  }), /not present/);
});
