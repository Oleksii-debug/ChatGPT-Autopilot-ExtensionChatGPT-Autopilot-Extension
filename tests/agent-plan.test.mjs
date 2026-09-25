import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPlanNodeState, normalizeAgentPlanV1, reconcileAgentPlanV1, transitionAgentPlanNodeV1 } from '../src/core/agent-plan.js';

const AT = '2026-09-23T11:30:00.000Z';
function plan(nodes) { return { schemaVersion: 1, planId: 'plan-1', jobId: 'job-1', objective: 'Book a verified course', successCriteria: ['Course is selected'], createdAt: AT, updatedAt: AT, revision: 1, nodes }; }
function node(nodeId, dependsOn = [], conflictKeys = []) { return { nodeId, title: nodeId, objective: `Do ${nodeId}`, dependsOn, conflictKeys, ownerId: 'agent-1', executionPlane: 'BROWSER', acceptanceCriteria: ['Observed complete'], budget: {}, state: 'PENDING', evidence: '', updatedAt: AT }; }

test('AgentPlan validates durable DAG identity and rejects unknown dependencies or cycles', () => {
  assert.equal(normalizeAgentPlanV1(plan([node('discover'), node('enroll', ['discover'])])).nodes.length, 2);
  assert.throws(() => normalizeAgentPlanV1(plan([node('a', ['missing'])])), /unknown node/);
  assert.throws(() => normalizeAgentPlanV1(plan([node('a', ['b']), node('b', ['a'])])), /dependency cycle/);
});

test('AgentPlan reconciliation exposes only dependency-ready, conflict-free work', () => {
  let current = reconcileAgentPlanV1(plan([node('discover', [], ['site']), node('enroll', ['discover'], ['site'])]), { at: AT });
  assert.equal(current.nodes[0].state, AgentPlanNodeState.READY);
  assert.equal(current.nodes[1].state, AgentPlanNodeState.PENDING);
  current = transitionAgentPlanNodeV1(current, { nodeId: 'discover', state: 'RUNNING', at: AT });
  current = transitionAgentPlanNodeV1(current, { nodeId: 'discover', state: 'VERIFIED', evidence: 'Course catalog observed', at: AT });
  assert.equal(current.nodes[1].state, AgentPlanNodeState.READY);
});

test('AgentPlan transition is restart-safe and cannot certify work without running evidence', () => {
  let current = reconcileAgentPlanV1(plan([node('discover')]), { at: AT });
  assert.throws(() => transitionAgentPlanNodeV1(current, { nodeId: 'discover', state: 'VERIFIED', evidence: 'pretend', at: AT }), /requires RUNNING/);
  current = transitionAgentPlanNodeV1(JSON.parse(JSON.stringify(current)), { nodeId: 'discover', state: 'RUNNING', at: AT });
  assert.throws(() => transitionAgentPlanNodeV1(current, { nodeId: 'discover', state: 'VERIFIED', at: AT }), /evidence/);
  current = transitionAgentPlanNodeV1(current, { nodeId: 'discover', state: 'VERIFIED', evidence: 'Catalog visible in fresh snapshot', at: AT });
  assert.equal(current.nodes[0].state, AgentPlanNodeState.VERIFIED);
  assert.throws(() => transitionAgentPlanNodeV1(current, { nodeId: 'discover', state: 'RUNNING', at: AT }), /terminal node/);
});
