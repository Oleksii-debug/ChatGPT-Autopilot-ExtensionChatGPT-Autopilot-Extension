import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPlanNodeState, evolveAgentPlanV1, extendAgentPlanV1, normalizeAgentPlanV1, reconcileAgentPlanV1, transitionAgentPlanNodeV1 } from '../src/core/agent-plan.js';

const AT = '2026-09-23T11:30:00.000Z';
const ZERO_ENVELOPE = { maxModelCalls: 0, maxRuntimeSeconds: 0, maxCostUsdMicros: 0 };
function plan(nodes) { return { schemaVersion: 1, planId: 'plan-1', jobId: 'job-1', objective: 'Book a verified course', successCriteria: ['Course is selected'], createdAt: AT, updatedAt: AT, revision: 1, nodes }; }
function node(nodeId, dependsOn = [], conflictKeys = [], budget = {}) { return { nodeId, title: nodeId, objective: `Do ${nodeId}`, dependsOn, conflictKeys, ownerId: 'agent-1', executionPlane: 'BROWSER', acceptanceCriteria: ['Observed complete'], budget, state: 'PENDING', evidence: '', updatedAt: AT }; }

test('AgentPlan array boundaries reject getters and non-canonical collections before reads', () => {
  let reads = 0;

  const accessorNodesPlan = plan([node('discover')]);
  const originalNode = accessorNodesPlan.nodes[0];
  Object.defineProperty(accessorNodesPlan.nodes, '0', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return originalNode; },
  });
  assert.throws(() => normalizeAgentPlanV1(accessorNodesPlan), /AgentPlan nodes\[0\].*enumerable own data property/);
  assert.equal(reads, 0);

  const sparseNodesPlan = plan(new Array(1));
  assert.throws(() => normalizeAgentPlanV1(sparseNodesPlan), /AgentPlan nodes\[0\].*enumerable own data property/);

  const symbolNodesPlan = plan([node('discover')]);
  symbolNodesPlan.nodes[Symbol('authority')] = 'ALLOW';
  assert.throws(() => normalizeAgentPlanV1(symbolNodesPlan), /non-canonical array fields/);

  const hiddenIndexPlan = plan([node('discover')]);
  Object.defineProperty(hiddenIndexPlan.nodes, '0', { enumerable: false, configurable: true, value: hiddenIndexPlan.nodes[0] });
  assert.throws(() => normalizeAgentPlanV1(hiddenIndexPlan), /enumerable own data property/);

  const customPrototypePlan = plan([node('discover')]);
  Object.setPrototypeOf(customPrototypePlan.nodes, Object.create(Array.prototype));
  assert.throws(() => normalizeAgentPlanV1(customPrototypePlan), /canonical array/);

  const current = reconcileAgentPlanV1(plan([node('discover')]), { at: AT });
  const extensionNodes = [node('later')];
  const extensionOriginal = extensionNodes[0];
  Object.defineProperty(extensionNodes, '0', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return extensionOriginal; },
  });
  assert.throws(() => extendAgentPlanV1(current, {
    expectedRevision: current.revision,
    nodes: extensionNodes,
    resourceEnvelope: ZERO_ENVELOPE,
    at: AT,
  }), /AgentPlan extension nodes\[0\].*enumerable own data property/);
  assert.equal(reads, 0);

  const dependencyNode = node('later', ['discover']);
  const originalDependency = dependencyNode.dependsOn[0];
  Object.defineProperty(dependencyNode.dependsOn, '0', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return originalDependency; },
  });
  assert.throws(() => extendAgentPlanV1(current, {
    expectedRevision: current.revision,
    nodes: [dependencyNode],
    resourceEnvelope: ZERO_ENVELOPE,
    at: AT,
  }), /AgentPlan node dependsOn\[0\].*enumerable own data property/);
  assert.equal(reads, 0);

  const candidate = structuredClone(current);
  candidate.nodes.push(node('later'));
  const originalCriterion = candidate.successCriteria[0];
  Object.defineProperty(candidate.successCriteria, '0', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return originalCriterion; },
  });
  assert.throws(() => evolveAgentPlanV1(current, candidate, {
    resourceEnvelope: ZERO_ENVELOPE,
    at: AT,
  }), /AgentPlan successCriteria\[0\].*enumerable own data property/);
  assert.equal(reads, 0);
});

test('AgentPlan duplicate text folding is locale-independent', () => {
  const duplicate = plan([node('discover')]);
  duplicate.successCriteria = ['ASCII', 'ascii'];
  assert.throws(() => normalizeAgentPlanV1(duplicate), /successCriteria contains duplicates/);

  const distinct = plan([node('discover')]);
  distinct.successCriteria = ['I', 'ı'];
  const normalized = normalizeAgentPlanV1(distinct);
  assert.deepEqual(normalized.successCriteria, ['I', 'ı']);
});

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

test('AgentPlan expectedRevision is a strict stale-snapshot guard, not a coercing pseudo-CAS', () => {
  const current = reconcileAgentPlanV1(plan([node('discover')]), { at: AT });
  for (const expectedRevision of [String(current.revision), true, { valueOf: () => current.revision }]) {
    assert.throws(() => extendAgentPlanV1(current, {
      expectedRevision,
      nodes: [node('later')],
      resourceEnvelope: ZERO_ENVELOPE,
      at: AT,
    }), /expectedRevision is invalid/);
  }
});

test('AgentPlan extension boundary rejects coerced and inherited model authority', () => {
  const current = reconcileAgentPlanV1(plan([node('discover')]), { at: AT });
  const call = rawNode => extendAgentPlanV1(current, {
    expectedRevision: current.revision,
    nodes: [rawNode],
    resourceEnvelope: { maxModelCalls: 10, maxRuntimeSeconds: 10, maxCostUsdMicros: 10 },
    at: AT,
  });

  assert.throws(() => call({ ...node('numeric-id'), nodeId: 7 }), /nodeId is invalid/);
  assert.throws(() => call({ ...node('boolean-state'), state: false }), /state must be PENDING/);
  assert.throws(() => call({ ...node('numeric-plane'), executionPlane: 1 }), /executionPlane is invalid/);
  assert.throws(() => call({ ...node('string-budget'), budget: { maxModelCalls: '1', maxRuntimeSeconds: 0, maxCostUsdMicros: 0 } }), /budget maxModelCalls is invalid/);

  const inheritedNode = Object.create(node('inherited-node'));
  assert.throws(() => call(inheritedNode), /plain data object/);

  const inheritedBudget = Object.create({ maxModelCalls: 0, maxRuntimeSeconds: 0, maxCostUsdMicros: 0 });
  assert.throws(() => call({ ...node('inherited-budget'), budget: inheritedBudget }), /plain data object/);

  const symbolNode = node('symbol-node');
  symbolNode[Symbol('hidden-authority')] = true;
  assert.throws(() => call(symbolNode), /symbol fields/);

  let budgetReads = 0;
  const accessorBudgetNode = node('accessor-budget');
  Object.defineProperty(accessorBudgetNode, 'budget', {
    enumerable: true,
    configurable: true,
    get() {
      budgetReads += 1;
      return { maxModelCalls: 0, maxRuntimeSeconds: 0, maxCostUsdMicros: 0 };
    },
  });
  assert.throws(() => call(accessorBudgetNode), /own data properties/);
  assert.equal(budgetReads, 0, 'budget getter must never execute before admission');
});

test('AgentPlan evolution boundary rejects coerced and inherited full-plan authority', () => {
  const current = reconcileAgentPlanV1(plan([node('discover')]), { at: AT });
  const candidate = () => {
    const out = structuredClone(current);
    out.nodes.push(node('later', ['discover']));
    return out;
  };
  const evolve = value => evolveAgentPlanV1(current, value, {
    resourceEnvelope: { maxModelCalls: 10, maxRuntimeSeconds: 10, maxCostUsdMicros: 10 },
    at: AT,
  });

  const stringSchema = candidate();
  stringSchema.schemaVersion = '1';
  assert.throws(() => evolve(stringSchema), /schemaVersion/);

  const stringRevision = candidate();
  stringRevision.revision = String(current.revision);
  assert.throws(() => evolve(stringRevision), /revision is invalid/);

  const numericPlanId = candidate();
  numericPlanId.planId = 1;
  assert.throws(() => evolve(numericPlanId), /planId is invalid/);

  const falseState = candidate();
  falseState.nodes.at(-1).state = false;
  assert.throws(() => evolve(falseState), /state is invalid/);

  const numericPlane = candidate();
  numericPlane.nodes.at(-1).executionPlane = 1;
  assert.throws(() => evolve(numericPlane), /executionPlane is invalid/);

  const stringBudget = candidate();
  stringBudget.nodes.at(-1).budget.maxCostUsdMicros = '0';
  assert.throws(() => evolve(stringBudget), /budget maxCostUsdMicros is invalid/);

  const inheritedPlan = Object.assign(Object.create({ schemaVersion: 1 }), candidate());
  assert.throws(() => evolve(inheritedPlan), /plain data object/);

  const inheritedNodeCandidate = candidate();
  inheritedNodeCandidate.nodes[inheritedNodeCandidate.nodes.length - 1] = Object.assign(
    Object.create({ ownerId: 'forged-owner' }),
    node('inherited-node-candidate', ['discover']),
  );
  assert.throws(() => evolve(inheritedNodeCandidate), /plain data object/);

  const inheritedBudgetCandidate = candidate();
  inheritedBudgetCandidate.nodes.at(-1).budget = Object.create({
    maxModelCalls: 0,
    maxRuntimeSeconds: 0,
    maxCostUsdMicros: 0,
  });
  assert.throws(() => evolve(inheritedBudgetCandidate), /plain data object/);
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

test('AgentPlan live extension rejects inherited resource-envelope authority', () => {
  const current = reconcileAgentPlanV1(plan([node('discover')]), { at: AT });
  const inheritedEnvelope = Object.create({ maxModelCalls: 1, maxRuntimeSeconds: 1, maxCostUsdMicros: 1 });
  assert.throws(() => extendAgentPlanV1(current, {
    expectedRevision: current.revision,
    nodes: [node('later', ['discover'], [], { maxModelCalls: 1, maxRuntimeSeconds: 1, maxCostUsdMicros: 1 })],
    resourceEnvelope: inheritedEnvelope,
    at: AT,
  }), /resourceEnvelope must be a plain data object/);
});

test('AgentPlan live evolution converts a full echoed candidate into append-only growth', () => {
  let current = reconcileAgentPlanV1(plan([node('discover')]), { at: AT });
  current = transitionAgentPlanNodeV1(current, { nodeId: 'discover', state: 'RUNNING', at: AT });
  const candidate = structuredClone(current);
  candidate.nodes.push(node('audit', ['discover']));
  const evolved = evolveAgentPlanV1(current, candidate, { resourceEnvelope: ZERO_ENVELOPE, at: AT });
  assert.equal(evolved.nodes.length, 2);
  assert.equal(evolved.nodes[0].state, AgentPlanNodeState.RUNNING);
  assert.equal(evolved.nodes[1].state, AgentPlanNodeState.PENDING);
  assert.equal(evolved.revision, current.revision + 1);
});

test('AgentPlan live evolution rejects stale, shrinking or mutating replacement candidates', () => {
  const current = reconcileAgentPlanV1(plan([node('discover')]), { at: AT });
  const stale = structuredClone(current);
  stale.revision -= 1;
  stale.nodes.push(node('later', ['discover']));
  assert.throws(() => evolveAgentPlanV1(current, stale, { resourceEnvelope: ZERO_ENVELOPE, at: AT }), /revision conflict/);

  const shrinking = structuredClone(current);
  assert.throws(() => evolveAgentPlanV1(current, shrinking, { resourceEnvelope: ZERO_ENVELOPE, at: AT }), /requires appended nodes/);

  const mutating = structuredClone(current);
  mutating.nodes[0].objective = 'Rewrite durable work';
  mutating.nodes.push(node('later', ['discover']));
  assert.throws(() => evolveAgentPlanV1(current, mutating, { resourceEnvelope: ZERO_ENVELOPE, at: AT }), /cannot replace existing nodes/);
});
