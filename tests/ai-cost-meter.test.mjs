import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateAiCostRecordsV1,
  meterAiRouteUsageV1,
  normalizeAiCostRecordV1,
  resourceUsageFromAiCostRecordV1,
} from '../src/core/ai-cost-meter.js';

const AT = '2026-09-24T16:30:00Z';

function route(overrides = {}) {
  return {
    schemaVersion: 1,
    routeId: 'openai-main',
    provider: 'openai',
    model: 'model-a',
    endpointId: '',
    roles: ['planner'],
    capabilityIds: [],
    priority: 10,
    enabled: true,
    locality: 'remote',
    costClass: 'paid',
    inputPricePerMillionUsd: 1.5,
    outputPricePerMillionUsd: 6,
    supportsVision: false,
    ...overrides,
  };
}

test('meters a paid route in integer USD micros using conservative rounding', () => {
  const record = meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-1',
    inputTokens: 1_000,
    outputTokens: 250,
    observedAt: AT,
  });

  assert.equal(record.costUsdMicros, 3_000);
  assert.equal(record.modelCalls, 1);
  assert.equal(record.inputTokens, 1_000);
  assert.equal(record.outputTokens, 250);
  assert.equal(record.inputPricePerMillionUsd, 1.5);
  assert.equal(record.outputPricePerMillionUsd, 6);
  assert.equal(record.observedAt, '2026-09-24T16:30:00.000Z');
  assert.equal(Object.isFrozen(record), true);
});

test('fractional microdollar estimates round upward so budget accounting never understates cost', () => {
  const record = meterAiRouteUsageV1({
    route: route({ inputPricePerMillionUsd: 0.15, outputPricePerMillionUsd: 0 }),
    invocationId: 'invoke-rounding',
    inputTokens: 1,
    outputTokens: 0,
    observedAt: AT,
  });
  assert.equal(record.costUsdMicros, 1);
});

test('paid routes with entirely unknown pricing fail closed', () => {
  assert.throws(() => meterAiRouteUsageV1({
    route: route({ inputPricePerMillionUsd: 0, outputPricePerMillionUsd: 0 }),
    invocationId: 'invoke-unknown-price',
    inputTokens: 10,
    outputTokens: 5,
    observedAt: AT,
  }), error => error?.code === 'AI_ROUTE_PRICE_UNKNOWN');
});

test('free routes meter zero cost and cannot carry contradictory non-zero paid pricing', () => {
  const free = meterAiRouteUsageV1({
    route: route({
      routeId: 'ollama-local',
      provider: 'ollama',
      model: 'local-model',
      locality: 'local',
      costClass: 'free',
      inputPricePerMillionUsd: 0,
      outputPricePerMillionUsd: 0,
    }),
    invocationId: 'invoke-free',
    inputTokens: 50_000,
    outputTokens: 2_000,
    observedAt: AT,
  });
  assert.equal(free.costUsdMicros, 0);

  assert.throws(() => meterAiRouteUsageV1({
    route: route({ costClass: 'free', inputPricePerMillionUsd: 1 }),
    invocationId: 'invoke-inconsistent-free',
    inputTokens: 1,
    outputTokens: 0,
    observedAt: AT,
  }), /Free AI route cannot declare non-zero paid pricing/);
});

test('persisted cost evidence is self-consistent and tampering fails closed', () => {
  const record = meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-proof',
    inputTokens: 100,
    outputTokens: 10,
    observedAt: AT,
  });
  assert.equal(normalizeAiCostRecordV1(record).costUsdMicros, 210);
  assert.throws(() => normalizeAiCostRecordV1({ ...record, costUsdMicros: record.costUsdMicros - 1 }), /does not match/);
  assert.throws(() => normalizeAiCostRecordV1({ ...record, surprise: true }), /unknown field/);
});

test('usage inputs are strict numbers and hostile prototype-bearing records are rejected', () => {
  assert.throws(() => meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-string-token',
    inputTokens: '100',
    outputTokens: 0,
    observedAt: AT,
  }), /safe integer/);

  const polluted = Object.create({ costUsdMicros: 1 });
  Object.assign(polluted, {
    schemaVersion: 1,
    invocationId: 'invoke-polluted',
    routeId: 'route-1',
    provider: 'openai',
    model: 'model-a',
    endpointId: '',
    costClass: 'paid',
    inputTokens: 1,
    outputTokens: 0,
    modelCalls: 1,
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 1,
    observedAt: AT,
  });
  assert.throws(() => normalizeAiCostRecordV1(polluted), /plain object/);
});

test('cost records convert directly into the resource-usage dimensions required by budget admission', () => {
  const record = meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-budget',
    inputTokens: 2_000,
    outputTokens: 500,
    observedAt: AT,
  });
  assert.deepEqual(resourceUsageFromAiCostRecordV1(record), {
    modelCalls: 1,
    modelInputTokens: 2_000,
    modelOutputTokens: 500,
    costUsdMicros: 6_000,
  });
});

test('bounded aggregation is deterministic and fails closed on unsafe evidence', () => {
  const first = meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-a',
    inputTokens: 100,
    outputTokens: 50,
    observedAt: AT,
  });
  const second = meterAiRouteUsageV1({
    route: route({ routeId: 'openai-backup', inputPricePerMillionUsd: 2, outputPricePerMillionUsd: 8 }),
    invocationId: 'invoke-b',
    inputTokens: 200,
    outputTokens: 25,
    observedAt: AT,
  });

  const total = aggregateAiCostRecordsV1([first, second]);
  assert.deepEqual(total, {
    recordCount: 2,
    modelCalls: 2,
    modelInputTokens: 300,
    modelOutputTokens: 75,
    costUsdMicros: first.costUsdMicros + second.costUsdMicros,
  });
  assert.equal(Object.isFrozen(total), true);

  assert.throws(() => aggregateAiCostRecordsV1(new Array(10_001).fill(first)), /at most 10000/);
});
