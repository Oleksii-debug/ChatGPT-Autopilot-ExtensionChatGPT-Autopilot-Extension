import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SubagentSpawnInitiator,
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
    parentDepth: 0,
    currentDirectChildren: 0,
    requestedChildren: 2,
  });
  const agent = evaluateSubagentStructureAdmissionV1({
    policy: locked,
    initiator: SubagentSpawnInitiator.AGENT,
    parentDepth: 0,
    currentDirectChildren: 0,
    requestedChildren: 1,
  });
  assert.equal(owner.decision, 'ALLOW');
  assert.equal(agent.decision, 'DENY');
  assert.equal(agent.reasonCode, 'AGENT_CHILD_CREATION_DISABLED');
});

test('depth uses root depth zero and denies children beyond owner maximum', () => {
  const result = evaluateSubagentStructureAdmissionV1({
    policy: { ...policy, maxDepth: 2 },
    initiator: SubagentSpawnInitiator.AGENT,
    parentDepth: 2,
    currentDirectChildren: 0,
    requestedChildren: 1,
  });
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'MAX_DEPTH_EXCEEDED');
  assert.equal(result.childDepth, 3);
});

test('fanout is a hard per-parent ceiling and never partially admits a larger request', () => {
  const result = evaluateSubagentStructureAdmissionV1({
    policy,
    initiator: SubagentSpawnInitiator.AGENT,
    parentDepth: 1,
    currentDirectChildren: 4,
    requestedChildren: 2,
  });
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'MAX_FANOUT_EXCEEDED');
  assert.equal(result.availableDirectChildren, 1);
});

test('remaining capacity is deterministic for owner-selected or agent-selected worker counts', () => {
  const capacity = remainingSubagentStructureCapacityV1({
    policy,
    initiator: SubagentSpawnInitiator.AGENT,
    parentDepth: 1,
    currentDirectChildren: 2,
  });
  assert.deepEqual(capacity, {
    childDepth: 2,
    agentCreationBlocked: false,
    depthBlocked: false,
    availableDirectChildren: 3,
  });

  const result = evaluateSubagentStructureAdmissionV1({
    policy,
    initiator: SubagentSpawnInitiator.AGENT,
    parentDepth: 1,
    currentDirectChildren: 2,
    requestedChildren: 3,
  });
  assert.equal(result.decision, 'ALLOW');
});

test('unknown fields, coercion, exotic objects and invalid initiators fail closed', () => {
  assert.throws(() => normalizeSubagentStructurePolicyV1({ ...policy, maxDepth: '4' }), /invalid/);
  assert.throws(() => normalizeSubagentStructurePolicyV1({ ...policy, surprise: true }), /unknown field/);
  assert.throws(() => normalizeSubagentStructurePolicyV1(Object.create(policy)), /plain object/);
  assert.throws(() => evaluateSubagentStructureAdmissionV1({
    policy,
    initiator: 'SYSTEM',
    parentDepth: 0,
    currentDirectChildren: 0,
    requestedChildren: 1,
  }), /initiator is invalid/);
});
