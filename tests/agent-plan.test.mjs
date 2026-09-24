import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPlanNodeState, extendAgentPlanV1, normalizeAgentPlanV1, reconcileAgentPlanV1, transitionAgentPlanNodeV1 } from '../src/core/agent-plan.js';

const AT = '2026-09-23T11:30:00.000Z';
const ZERO_ENVELOPE = { maxModelCalls: 0, maxRuntimeSeconds: 0, maxCostUsdMicros: 0 };
function plan(nodes) { return { schemaVersion: 1, planId: 'plan-1', jobId: 'job-1', objective: 'Book a verified course', successCriteria: ['Course is selected'], createdAt: AT, updatedAt: AT, revision: 1, nodes }; }
function node(nodeId, dependsOn = [], conflictKeys = [], budget = {}) { return { nodeId, title: nodeId, objective: `Do ${nodeId}`, dependsOn, conflictKeys, ownerId: 'agent-1', executionPlane: 'BROWSER', acceptanceCriteria: ['Observed complete'], budget, state: 'PENDING', evidence: '', updatedAt: AT }; }

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

test('AgentPlan can append newly discovered work while preserving live execution', () => {
  let current = reconcileAgentPlanV1(plan([node('discover', [], ['site'])]), { at: AT });
  current = transitionAgentPlanNodeV1(current, { nodeId: 'discover', state: 'RUNNING', at: AT });
  const revision = current.revision;
  const extended = extendAgentPlanV1(current, {
    expectedRevision: revision,
    nodes: [node('audit', ['discover'], ['site']), node('independent')],
    resourceEnvelope: ZERO_ENVELOPE,
    at: AT,
  });
  assert.equal(extended.revision, revision + 1);
  assert.equal(extended.nodes.find(item => item.nodeId === 'discover').state, AgentPlanNodeState.RUNNING);
  assert.equal(extended.nodes.find(item => item.nodeId === 'audit').state, AgentPlanNodeState.BLOCKED);
  assert.equal(extended.nodes.find(item => item.nodeId === 'independent').state, AgentPlanNodeState.READY);

  current = transitionAgentPlanNodeV1(extended, { nodeId: 'discover', state: 'VERIFIED', evidence: 'Discovery independently verified', at: AT });
  assert.equal(current.nodes.find(item => item.nodeId === 'audit').state, AgentPlanNodeState.READY);
});

test('AgentPlan live extension fails closed on stale revisions and state/evidence injection', () => {
  const current = reconcileAgentPlanV1(plan([node('discover')]), { at: AT });
  assert.throws(() => extendAgentPlanV1(current, { expectedRevision: current.revision - 1, nodes: [node('later')], resourceEnvelope: ZERO_ENVELOPE, at: AT }), /revision conflict/);
  assert.throws(() => extendAgentPlanV1(current, { expectedRevision: current.revision, nodes: [{ ...node('later'), state: 'RUNNING' }], resourceEnvelope: ZERO_ENVELOPE, at: AT }), /state must be PENDING/);
  assert.throws(() => extendAgentPlanV1(current, { expectedRevision: current.revision, nodes: [{ ...node('later'), evidence: 'forged' }], resourceEnvelope: ZERO_ENVELOPE, at: AT }), /cannot inject evidence/);
});

test('AgentPlan live extension retains canonical duplicate, dependency and cycle validation', () => {
  const current = reconcileAgentPlanV1(plan([node('discover')]), { at: AT });
  assert.throws(() => extendAgentPlanV1(current, { expectedRevision: current.revision, nodes: [node('discover')], resourceEnvelope: ZERO_ENVELOPE, at: AT }), /duplicate nodeId/);
  assert.throws(() => extendAgentPlanV1(current, { expectedRevision: current.revision, nodes: [node('later', ['missing'])], resourceEnvelope: ZERO_ENVELOPE, at: AT }), /unknown node/);
  assert.throws(() => extendAgentPlanV1(current, { expectedRevision: current.revision, nodes: [node('a', ['b']), node('b', ['a'])], resourceEnvelope: ZERO_ENVELOPE, at: AT }), /dependency cycle/);
});

test('AgentPlan live extension cannot mint aggregate resource authority across repeated growth', () => {
  const envelope = { maxModelCalls: 5, maxRuntimeSeconds: 50, maxCostUsdMicros: 500 };
  let current = reconcileAgentPlanV1(plan([
    node('discover', [], [], { maxModelCalls: 2, maxRuntimeSeconds: 10, maxCostUsdMicros: 100 }),
  ]), { at: AT });
  current = extendAgentPlanV1(current, {
    expectedRevision: current.revision,
    nodes: [node('first', ['discover'], [], { maxModelCalls: 2, maxRuntimeSeconds: 10, maxCostUsdMicros: 200 })],
    resourceEnvelope: envelope,
    at: AT,
  });
  assert.equal(current.nodes.length, 2);
  assert.throws(() => extendAgentPlanV1(current, {
    expectedRevision: current.revision,
    nodes: [node('second', ['discover'], [], { maxModelCalls: 2, maxRuntimeSeconds: 10, maxCostUsdMicros: 200 })],
    resourceEnvelope: envelope,
    at: AT,
  }), /exceeds resourceEnvelope maxModelCalls/);
});
