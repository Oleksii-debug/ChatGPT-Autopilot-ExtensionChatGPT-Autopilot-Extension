import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateAgentResourceAdmissionV1,
  narrowResourceBudgetWithAgentPlanV1,
  normalizeAgentPlanBudgetCeilingV1,
} from '../src/core/agent-budget-admission.js';

const ownerBudget = {
  maxConcurrentAgents: 12,
  maxChildAgents: 8,
  maxModelCalls: 100,
  maxModelInputTokens: 1_000_000,
  maxModelOutputTokens: 250_000,
  maxRuntimeSeconds: 7200,
  maxCostUsdMicros: 5_000_000,
};

const agentPlanBudget = {
  maxModelCalls: 40,
  maxRuntimeSeconds: 3600,
  maxCostUsdMicros: 2_000_000,
};

test('normalizes the existing AgentPlan budget shape exactly and fail closed', () => {
  assert.deepEqual(normalizeAgentPlanBudgetCeilingV1({ maxModelCalls: 5 }), {
    maxModelCalls: 5,
    maxRuntimeSeconds: 0,
    maxCostUsdMicros: 0,
  });
  assert.throws(() => normalizeAgentPlanBudgetCeilingV1({ maxModelCalls: '5' }), /invalid/);
  assert.throws(() => normalizeAgentPlanBudgetCeilingV1({ maxModelCalls: 5, extra: 1 }), /unknown field/);
  assert.throws(() => normalizeAgentPlanBudgetCeilingV1(Object.create({ maxModelCalls: 5 })), /plain object/);
});

test('AgentPlan only narrows shared owner ceilings and leaves owner-only dimensions intact', () => {
  const narrowed = narrowResourceBudgetWithAgentPlanV1({ ownerBudget, agentPlanBudget });
  assert.equal(narrowed.maxConcurrentAgents, 12);
  assert.equal(narrowed.maxChildAgents, 8);
  assert.equal(narrowed.maxModelCalls, 40);
  assert.equal(narrowed.maxRuntimeSeconds, 3600);
  assert.equal(narrowed.maxCostUsdMicros, 2_000_000);
  assert.equal(narrowed.maxModelInputTokens, 1_000_000);
});

test('owner can be stricter than AgentPlan and is never widened', () => {
  const narrowed = narrowResourceBudgetWithAgentPlanV1({
    ownerBudget: { ...ownerBudget, maxModelCalls: 3, maxCostUsdMicros: 500_000 },
    agentPlanBudget,
  });
  assert.equal(narrowed.maxModelCalls, 3);
  assert.equal(narrowed.maxCostUsdMicros, 500_000);
});

test('already-metered AI resource usage is admitted without a second pricing authority', () => {
  const result = evaluateAgentResourceAdmissionV1({
    ownerBudget,
    agentPlanBudget,
    currentUsage: {
      modelCalls: 4,
      modelInputTokens: 100_000,
      modelOutputTokens: 20_000,
      costUsdMicros: 1_000_000,
    },
    request: {
      modelCalls: 1,
      modelInputTokens: 100_000,
      modelOutputTokens: 20_000,
      costUsdMicros: 320_000,
    },
  });
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.projected.costUsdMicros, 1_320_000);
  assert.equal(result.request.concurrentAgents, 0);
  assert.equal(result.request.runtimeSeconds, 0);
});

test('already-metered usage is denied when aggregate cost crosses the AgentPlan ceiling', () => {
  const result = evaluateAgentResourceAdmissionV1({
    ownerBudget,
    agentPlanBudget,
    currentUsage: {
      modelCalls: 4,
      modelInputTokens: 100_000,
      modelOutputTokens: 20_000,
      costUsdMicros: 1_800_000,
    },
    request: {
      modelCalls: 1,
      modelInputTokens: 100_000,
      modelOutputTokens: 20_000,
      costUsdMicros: 320_000,
    },
  });
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(result.exceeded, ['costUsdMicros']);
});

test('ordinary agent concurrency requests use the same owner envelope', () => {
  const result = evaluateAgentResourceAdmissionV1({
    ownerBudget,
    agentPlanBudget,
    currentUsage: { concurrentAgents: 11, childAgents: 7 },
    request: { concurrentAgents: 2, childAgents: 2 },
  });
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(result.exceeded, ['concurrentAgents', 'childAgents']);
});


test('AgentPlan budget rejects accessor-backed, hidden and symbol fields without executing getters', () => {
  let getterReads = 0;
  const accessorBudget = {};
  Object.defineProperty(accessorBudget, 'maxCostUsdMicros', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 1;
    },
  });
  assert.throws(() => normalizeAgentPlanBudgetCeilingV1(accessorBudget), /own data properties/);
  assert.equal(getterReads, 0);

  const hiddenUnknown = { maxModelCalls: 1 };
  Object.defineProperty(hiddenUnknown, 'hiddenAuthority', {
    enumerable: false,
    value: 1,
  });
  assert.throws(() => normalizeAgentPlanBudgetCeilingV1(hiddenUnknown), /unknown field: hiddenAuthority/);

  const symbolBudget = { maxModelCalls: 1 };
  symbolBudget[Symbol('authority')] = 1;
  assert.throws(() => normalizeAgentPlanBudgetCeilingV1(symbolBudget), /symbol field/);
});
