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

test('policy and admission authority records reject accessors and hidden known fields before reads', () => {
  let reads = 0;

  const getterPolicy = { ...policy };
  Object.defineProperty(getterPolicy, 'allowAgentCreatedChildren', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return true;
    },
  });
  assert.throws(
    () => normalizeSubagentStructurePolicyV1(getterPolicy),
    /allowAgentCreatedChildren.*enumerable own data property/,
  );
  assert.equal(reads, 0);

  const hiddenPolicy = {
    schemaVersion: 1,
    maxDepth: 4,
    maxChildrenPerAgent: 5,
  };
  Object.defineProperty(hiddenPolicy, 'allowAgentCreatedChildren', {
    enumerable: false,
    value: true,
  });
  assert.throws(
    () => evaluateSubagentStructureAdmissionV1({
      policy: hiddenPolicy,
      initiator: SubagentSpawnInitiator.AGENT,
      graph: ROOT_ONLY,
      parentNodeId: 'root',
      requestedChildren: 1,
    }),
    /allowAgentCreatedChildren.*enumerable own data property/,
  );

  const request = {
    policy,
    initiator: SubagentSpawnInitiator.AGENT,
    graph: ROOT_ONLY,
    parentNodeId: 'root',
    requestedChildren: 1,
  };
  Object.defineProperty(request, 'requestedChildren', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 1;
    },
  });
  assert.throws(
    () => evaluateSubagentStructureAdmissionV1(request),
    /requestedChildren.*enumerable own data property/,
  );
  assert.equal(reads, 0);

  const symbolic = { ...policy };
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeSubagentStructurePolicyV1(symbolic), /symbol field/);
});

test('derived structure facts reject request accessors and identity aliases without reads', () => {
  let reads = 0;
  const request = {
    graph: ROOT_ONLY,
    parentNodeId: 'root',
  };
  Object.defineProperty(request, 'parentNodeId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'root';
    },
  });
  assert.throws(
    () => deriveSubagentStructureFactsFromGraphV1(request),
    /parentNodeId.*enumerable own data property/,
  );
  assert.equal(reads, 0, 'facts request getter must never execute');

  assert.throws(
    () => deriveSubagentStructureFactsFromGraphV1({
      graph: ROOT_ONLY,
      parentNodeId: ' root ',
    }),
    /parentNodeId is invalid/,
  );

  assert.throws(
    () => evaluateSubagentStructureAdmissionV1({
      policy,
      initiator: SubagentSpawnInitiator.AGENT,
      graph: ROOT_ONLY,
      parentNodeId: 'root ',
      requestedChildren: 1,
    }),
    /parentNodeId is invalid/,
  );

  const nullProto = Object.assign(Object.create(null), {
    graph: ROOT_ONLY,
    parentNodeId: 'root',
  });
  assert.deepEqual(
    deriveSubagentStructureFactsFromGraphV1(nullProto),
    {
      parentNodeId: 'root',
      parentDepth: 0,
      currentDirectChildren: 0,
    },
  );
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
