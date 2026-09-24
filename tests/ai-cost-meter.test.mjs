import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateAiCostRecordsV1,
  meterAiRouteUsageV1,
  normalizeAiCostRecordV1,
  resourceUsageFromAiCostRecordV1,
} from '../src/core/ai-cost-meter.js';
import { normalizeAiRoutePool } from '../src/core/ai-route-pool.js';

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

test('decimal arithmetic stays exact at large safe token counts where binary floats can undercount', () => {
  const record = meterAiRouteUsageV1({
    route: route({ inputPricePerMillionUsd: 2.3, outputPricePerMillionUsd: 0 }),
    invocationId: 'invoke-large-exact',
    inputTokens: 1_125_899_906_842_624,
    outputTokens: 0,
    observedAt: AT,
  });
  assert.equal(record.costUsdMicros, 2_589_569_785_738_036);
});

test('each metered provider invocation always consumes exactly one model call', () => {
  const record = meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-call-count',
    inputTokens: 0,
    outputTokens: 0,
    observedAt: AT,
  });
  assert.equal(resourceUsageFromAiCostRecordV1(record).modelCalls, 1);
  assert.throws(() => normalizeAiCostRecordV1({ ...record, modelCalls: 0 }), /must equal 1/);
});

test('paid routes with entirely unknown pricing fail closed', () => {
  const unknownPriceRoute = route();
  delete unknownPriceRoute.inputPricePerMillionUsd;
  delete unknownPriceRoute.outputPricePerMillionUsd;
  assert.throws(() => meterAiRouteUsageV1({
    route: unknownPriceRoute,
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

test('usage and route price inputs reject implicit numeric coercion', () => {
  assert.throws(() => meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-string-token',
    inputTokens: '100',
    outputTokens: 0,
    observedAt: AT,
  }), /safe integer/);

  assert.throws(() => meterAiRouteUsageV1({
    route: route({ inputPricePerMillionUsd: '1.5' }),
    invocationId: 'invoke-string-price',
    inputTokens: 100,
    outputTokens: 0,
    observedAt: AT,
  }), /must be a number/);
});

test('missing factual usage or paid pricing never becomes an authoritative zero', () => {
  assert.throws(() => meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-missing-input',
    outputTokens: 1,
    observedAt: AT,
  }), /inputTokens is required/);

  assert.throws(() => meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-missing-output',
    inputTokens: 1,
    observedAt: AT,
  }), /outputTokens is required/);

  for (const missingPrice of ['inputPricePerMillionUsd', 'outputPricePerMillionUsd']) {
    const incomplete = route();
    delete incomplete[missingPrice];
    assert.throws(() => meterAiRouteUsageV1({
      route: incomplete,
      invocationId: `invoke-missing-${missingPrice}`,
      inputTokens: 1,
      outputTokens: 1,
      observedAt: AT,
    }), error => error?.code === 'AI_ROUTE_PRICE_UNKNOWN');
  }
});

test('canonical route normalization preserves unknown pricing and metering rejects a used unknown dimension', () => {
  const missingOutput = route();
  delete missingOutput.outputPricePerMillionUsd;
  const [normalizedMissingOutput] = normalizeAiRoutePool([missingOutput]);
  assert.equal(normalizedMissingOutput.outputPriceKnown, false);
  assert.equal(normalizedMissingOutput.outputPricePerMillionUsd, 0);
  assert.throws(() => meterAiRouteUsageV1({
    route: normalizedMissingOutput,
    invocationId: 'invoke-normalized-missing-output',
    inputTokens: 1,
    outputTokens: 1,
    observedAt: AT,
  }), error => error?.code === 'AI_ROUTE_PRICE_UNKNOWN');

  const missingInput = route();
  delete missingInput.inputPricePerMillionUsd;
  const [normalizedMissingInput] = normalizeAiRoutePool([missingInput]);
  assert.equal(normalizedMissingInput.inputPriceKnown, false);
  assert.equal(normalizedMissingInput.inputPricePerMillionUsd, 0);
  assert.throws(() => meterAiRouteUsageV1({
    route: normalizedMissingInput,
    invocationId: 'invoke-normalized-missing-input',
    inputTokens: 1,
    outputTokens: 1,
    observedAt: AT,
  }), error => error?.code === 'AI_ROUTE_PRICE_UNKNOWN');

  const unusedUnknownOutput = meterAiRouteUsageV1({
    route: normalizedMissingOutput,
    invocationId: 'invoke-unused-unknown-output',
    inputTokens: 1,
    outputTokens: 0,
    observedAt: AT,
  });
  assert.equal(unusedUnknownOutput.costUsdMicros, 2);
});

test('persisted zero-cost evidence must carry an explicit costUsdMicros field', () => {
  const freeRecord = meterAiRouteUsageV1({
    route: route({
      routeId: 'ollama-zero-proof',
      provider: 'ollama',
      model: 'local-model',
      locality: 'local',
      costClass: 'free',
      inputPricePerMillionUsd: 0,
      outputPricePerMillionUsd: 0,
    }),
    invocationId: 'invoke-zero-proof',
    inputTokens: 0,
    outputTokens: 0,
    observedAt: AT,
  });
  const truncated = { ...freeRecord };
  delete truncated.costUsdMicros;
  assert.throws(() => normalizeAiCostRecordV1(truncated), /costUsdMicros is required/);
});

test('hostile prototype-bearing evidence and inherited route pricing cannot become cost authority', () => {
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

  const inheritedPriceRoute = route({ inputPricePerMillionUsd: 0, outputPricePerMillionUsd: 0 });
  delete inheritedPriceRoute.inputPricePerMillionUsd;
  delete inheritedPriceRoute.outputPricePerMillionUsd;
  const priorInput = Object.getOwnPropertyDescriptor(Object.prototype, 'inputPricePerMillionUsd');
  const priorOutput = Object.getOwnPropertyDescriptor(Object.prototype, 'outputPricePerMillionUsd');
  try {
    Object.defineProperty(Object.prototype, 'inputPricePerMillionUsd', { value: 100, configurable: true, enumerable: false });
    Object.defineProperty(Object.prototype, 'outputPricePerMillionUsd', { value: 100, configurable: true, enumerable: false });
    assert.throws(() => meterAiRouteUsageV1({
      route: inheritedPriceRoute,
      invocationId: 'invoke-inherited-price',
      inputTokens: 1,
      outputTokens: 1,
      observedAt: AT,
    }), error => error?.code === 'AI_ROUTE_PRICE_UNKNOWN');
  } finally {
    if (priorInput) Object.defineProperty(Object.prototype, 'inputPricePerMillionUsd', priorInput);
    else delete Object.prototype.inputPricePerMillionUsd;
    if (priorOutput) Object.defineProperty(Object.prototype, 'outputPricePerMillionUsd', priorOutput);
    else delete Object.prototype.outputPricePerMillionUsd;
  }
});

test('cost authority rejects accessors, hidden fields, symbols, and accessor-backed aggregate entries without executing getters', () => {
  const record = meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-data-only',
    inputTokens: 10,
    outputTokens: 2,
    observedAt: AT,
  });

  let reads = 0;
  const accessorRecord = { ...record };
  Object.defineProperty(accessorRecord, 'costUsdMicros', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return record.costUsdMicros; },
  });
  assert.throws(() => normalizeAiCostRecordV1(accessorRecord), /data properties/);
  assert.equal(reads, 0, 'financial evidence getter must never execute');

  const accessorRoute = route();
  Object.defineProperty(accessorRoute, 'inputPricePerMillionUsd', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return 1.5; },
  });
  assert.throws(() => meterAiRouteUsageV1({
    route: accessorRoute,
    invocationId: 'invoke-route-getter',
    inputTokens: 1,
    outputTokens: 0,
    observedAt: AT,
  }), /data properties/);
  assert.equal(reads, 0, 'route pricing getter must never execute');

  const hiddenRecord = { ...record };
  Object.defineProperty(hiddenRecord, 'hiddenAuthority', { value: 'secret', enumerable: false });
  assert.throws(() => normalizeAiCostRecordV1(hiddenRecord), /data properties/);

  const symbolRecord = { ...record, [Symbol('hidden-cost-authority')]: 1 };
  assert.throws(() => normalizeAiCostRecordV1(symbolRecord), /symbol field/);

  const records = [record];
  Object.defineProperty(records, '0', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return record; },
  });
  assert.throws(() => aggregateAiCostRecordsV1(records), /data properties/);
  assert.equal(reads, 0, 'aggregate element getter must never execute');
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

test('aggregation is exact-once by invocation identity and rejects replay or conflicting duplicates', () => {
  const record = meterAiRouteUsageV1({
    route: route(),
    invocationId: 'invoke-exact-once',
    inputTokens: 100,
    outputTokens: 10,
    observedAt: AT,
  });

  assert.throws(() => aggregateAiCostRecordsV1([record, record]), /duplicate invocationId/);
  const conflicting = meterAiRouteUsageV1({
    route: route({ routeId: 'openai-backup', inputPricePerMillionUsd: 2, outputPricePerMillionUsd: 8 }),
    invocationId: 'invoke-exact-once',
    inputTokens: 101,
    outputTokens: 10,
    observedAt: AT,
  });
  assert.throws(() => aggregateAiCostRecordsV1([record, conflicting]), /duplicate invocationId/);
  assert.deepEqual(aggregateAiCostRecordsV1([record]), aggregateAiCostRecordsV1([structuredClone(record)]));
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
