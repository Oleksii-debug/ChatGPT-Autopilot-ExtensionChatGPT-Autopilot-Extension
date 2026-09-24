import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ResourceBudgetDecisionKind,
  deriveChildResourceBudgetV1,
  evaluateResourceBudgetV1,
  normalizeResourceBudgetV1,
  normalizeResourceUsageV1,
  remainingResourceBudgetV1,
} from '../src/core/resource-budget-governor.js';

const budget = {
  maxConcurrentAgents: 8,
  maxChildAgents: 5,
  maxModelCalls: 100,
  maxModelInputTokens: 1_000_000,
  maxModelOutputTokens: 250_000,
  maxRuntimeSeconds: 3600,
  maxCostUsdMicros: 2_500_000,
};

const usage = {
  concurrentAgents: 3,
  childAgents: 2,
  modelCalls: 10,
  modelInputTokens: 100_000,
  modelOutputTokens: 20_000,
  runtimeSeconds: 300,
  costUsdMicros: 400_000,
};

test('normalization is bounded, exact, immutable, and fail closed by default', () => {
  const normalized = normalizeResourceBudgetV1({ maxModelCalls: 7 });
  assert.equal(normalized.maxModelCalls, 7);
  assert.equal(normalized.maxConcurrentAgents, 0);
  assert.equal(normalized.maxCostUsdMicros, 0);
  assert.equal(Object.isFrozen(normalized), true);
  assert.throws(() => normalizeResourceBudgetV1({ maxModelCalls: -1 }), /invalid/);
  assert.throws(() => normalizeResourceBudgetV1({ maxModelCalls: Number.NaN }), /invalid/);
  assert.throws(() => normalizeResourceBudgetV1({ maxModelCalls: '7' }), /invalid/);
  assert.throws(() => normalizeResourceBudgetV1({ maxModelCalls: 2, surprise: 1 }), /unknown field/);
  assert.throws(() => normalizeResourceUsageV1({ costUsdMicros: Number.MAX_SAFE_INTEGER + 1 }), /invalid/);
  assert.throws(() => normalizeResourceUsageV1({ modelCalls: '1' }), /invalid/);
});

test('missing ceilings and usage ignore inherited prototype values', () => {
  const previousBudget = Object.getOwnPropertyDescriptor(Object.prototype, 'maxModelCalls');
  const previousUsage = Object.getOwnPropertyDescriptor(Object.prototype, 'modelCalls');
  try {
    Object.defineProperty(Object.prototype, 'maxModelCalls', { value: 999, configurable: true, enumerable: false });
    Object.defineProperty(Object.prototype, 'modelCalls', { value: 999, configurable: true, enumerable: false });
    assert.equal(normalizeResourceBudgetV1({}).maxModelCalls, 0);
    assert.equal(normalizeResourceUsageV1({}).modelCalls, 0);
    const decision = evaluateResourceBudgetV1({
      budget: { maxModelCalls: 1 },
      usage: {},
      request: { modelCalls: 1 },
    });
    assert.equal(decision.decision, ResourceBudgetDecisionKind.ALLOW);
    assert.equal(decision.projected.modelCalls, 1);
    assert.equal(decision.remaining.modelCalls, 1);
  } finally {
    if (previousBudget) Object.defineProperty(Object.prototype, 'maxModelCalls', previousBudget);
    else delete Object.prototype.maxModelCalls;
    if (previousUsage) Object.defineProperty(Object.prototype, 'modelCalls', previousUsage);
    else delete Object.prototype.modelCalls;
  }

  const exotic = Object.create({ maxModelCalls: 8 });
  assert.throws(() => normalizeResourceBudgetV1(exotic), /plain object/);
});

test('allows a request that remains inside every configured ceiling', () => {
  const result = evaluateResourceBudgetV1({
    budget,
    usage,
    request: { concurrentAgents: 2, childAgents: 1, modelCalls: 5, costUsdMicros: 100_000 },
  });
  assert.equal(result.decision, ResourceBudgetDecisionKind.ALLOW);
  assert.equal(result.reasonCode, 'WITHIN_BUDGET');
  assert.deepEqual(result.exceeded, []);
  assert.equal(result.projected.concurrentAgents, 5);
  assert.equal(result.remaining.concurrentAgents, 5);
  assert.equal(Object.isFrozen(result), true);
});

test('denies deterministically when any parallelism or economic ceiling would be exceeded', () => {
  const result = evaluateResourceBudgetV1({
    budget,
    usage,
    request: {
      concurrentAgents: 6,
      childAgents: 4,
      modelCalls: 95,
      costUsdMicros: 2_200_000,
    },
  });
  assert.equal(result.decision, ResourceBudgetDecisionKind.DENY);
  assert.equal(result.reasonCode, 'BUDGET_EXCEEDED');
  assert.deepEqual(result.exceeded, ['concurrentAgents', 'childAgents', 'modelCalls', 'costUsdMicros']);
});

test('zero defaults deny unconfigured resource consumption rather than silently becoming unlimited', () => {
  const result = evaluateResourceBudgetV1({
    budget: {},
    request: { modelCalls: 1 },
  });
  assert.equal(result.decision, ResourceBudgetDecisionKind.DENY);
  assert.deepEqual(result.exceeded, ['modelCalls']);
});

test('remaining budget never goes negative when historical usage is already over a ceiling', () => {
  const remaining = remainingResourceBudgetV1(
    { ...budget, maxModelCalls: 5 },
    { ...usage, modelCalls: 10 },
  );
  assert.equal(remaining.modelCalls, 0);
  assert.equal(remaining.concurrentAgents, 5);
});

test('child grants can only narrow parent remaining authority', () => {
  const child = deriveChildResourceBudgetV1({
    parentBudget: budget,
    parentUsage: usage,
    requestedBudget: {
      maxConcurrentAgents: 20,
      maxChildAgents: 1,
      maxModelCalls: 20,
      maxModelInputTokens: 2_000_000,
      maxModelOutputTokens: 200_000,
      maxRuntimeSeconds: 4000,
      maxCostUsdMicros: 3_000_000,
    },
  });
  assert.deepEqual(child, {
    maxConcurrentAgents: 5,
    maxChildAgents: 1,
    maxModelCalls: 20,
    maxModelInputTokens: 900_000,
    maxModelOutputTokens: 200_000,
    maxRuntimeSeconds: 3300,
    maxCostUsdMicros: 2_100_000,
  });
});

test('projection overflow fails closed instead of wrapping or losing precision', () => {
  const huge = {
    ...budget,
    maxModelInputTokens: Number.MAX_SAFE_INTEGER,
  };
  assert.throws(() => evaluateResourceBudgetV1({
    budget: huge,
    usage: { modelInputTokens: Number.MAX_SAFE_INTEGER },
    request: { modelInputTokens: 1 },
  }), /projection is invalid/);
});
