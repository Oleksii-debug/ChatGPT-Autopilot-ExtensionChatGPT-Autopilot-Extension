import { AiRouteCostClass, normalizeAiRoutePool } from './ai-route-pool.js';

export const AI_COST_RECORD_VERSION = 1;
export const MAX_AI_COST_RECORDS = 10_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const COST_RECORD_KEYS = new Set([
  'schemaVersion',
  'invocationId',
  'routeId',
  'provider',
  'model',
  'endpointId',
  'costClass',
  'inputTokens',
  'outputTokens',
  'modelCalls',
  'inputPricePerMillionUsd',
  'outputPricePerMillionUsd',
  'costUsdMicros',
  'observedAt',
]);

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains a symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
  }
}

function own(value, key, fallback) {
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

function dataArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be an array of at most ${maximum} items`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\\d*)$/u.test(key) || Number(key) >= value.length) {
      throw new Error(`${label} contains an invalid array field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} entries must be enumerable own data properties`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be dense data-only evidence`);
    }
  }
  return value;
}

function id(value, label, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function text(value, label, max, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if ((!optional && !out) || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}

function integer(value, label, { fallback = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const candidate = value == null ? fallback : value;
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0 || candidate > max) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return candidate;
}

function requiredInteger(value, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) throw new Error(`${label} is required`);
  return integer(value, label, { max });
}

function price(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be a timestamp`);
  return new Date(milliseconds).toISOString();
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function decimalFraction(value, label) {
  const normalized = price(value, label);
  const source = normalized.toString().toLowerCase();
  const match = source.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u);
  if (!match) throw new Error(`${label} cannot be represented exactly`);
  const integerDigits = match[1];
  const fractionalDigits = match[2] || '';
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new Error(`${label} exponent is invalid`);
  }
  let numerator = BigInt(`${integerDigits}${fractionalDigits}` || '0');
  let scale = fractionalDigits.length - exponent;
  if (scale < 0) {
    numerator *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { numerator, denominator: 10n ** BigInt(scale) };
}

function billedUsdMicros(tokens, rate, label) {
  const { numerator, denominator } = decimalFraction(rate, label);
  const rawNumerator = BigInt(tokens) * numerator;
  const rounded = rawNumerator === 0n ? 0n : (rawNumerator + denominator - 1n) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('AI usage cost projection is outside the safe integer range');
  }
  return rounded;
}

function conservativeCostUsdMicros({ inputTokens, outputTokens, inputPricePerMillionUsd, outputPricePerMillionUsd }) {
  const input = billedUsdMicros(inputTokens, inputPricePerMillionUsd, 'AI input price');
  const output = billedUsdMicros(outputTokens, outputPricePerMillionUsd, 'AI output price');
  const total = input + output;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('AI usage cost projection is outside the safe integer range');
  }
  return Number(total);
}

function assertPricing(costClass, inputPricePerMillionUsd, outputPricePerMillionUsd, {
  inputTokens = 0,
  outputTokens = 0,
  inputPriceKnown = true,
  outputPriceKnown = true,
} = {}) {
  if (costClass === AiRouteCostClass.FREE) {
    if (inputPricePerMillionUsd !== 0 || outputPricePerMillionUsd !== 0) {
      throw new Error('Free AI route cannot declare non-zero paid pricing');
    }
    return;
  }
  if (costClass !== AiRouteCostClass.PAID) throw new Error('AI costClass is invalid');
  if ((inputTokens > 0 && !inputPriceKnown) || (outputTokens > 0 && !outputPriceKnown)) {
    const error = new Error('Paid AI route pricing is unknown for a billed token dimension');
    error.code = 'AI_ROUTE_PRICE_UNKNOWN';
    throw error;
  }
}

function normalizeRouteForMetering(route) {
  const raw = plainObject(route, 'AI route for metering');
  for (const key of ['inputPricePerMillionUsd', 'outputPricePerMillionUsd']) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== 'number') {
      throw new Error(`AI route ${key} must be a number for cost metering`);
    }
  }

  // Keep only own fields on a null-prototype object so Object.prototype
  // pollution can never become route identity, pricing, or authority.
  const ownOnly = Object.assign(Object.create(null), raw);
  return normalizeAiRoutePool([ownOnly])[0];
}

export function normalizeAiCostRecordV1(input) {
  const raw = plainObject(input, 'AiCostRecordV1');
  exactKeys(raw, COST_RECORD_KEYS, 'AiCostRecordV1');
  if (own(raw, 'schemaVersion', AI_COST_RECORD_VERSION) !== AI_COST_RECORD_VERSION) {
    throw new Error('Unsupported AiCostRecordV1 schemaVersion');
  }

  const normalized = {
    schemaVersion: AI_COST_RECORD_VERSION,
    invocationId: id(own(raw, 'invocationId', undefined), 'AiCostRecordV1 invocationId'),
    routeId: id(own(raw, 'routeId', undefined), 'AiCostRecordV1 routeId'),
    provider: text(own(raw, 'provider', undefined), 'AiCostRecordV1 provider', 80),
    model: text(own(raw, 'model', undefined), 'AiCostRecordV1 model', 300),
    endpointId: id(own(raw, 'endpointId', ''), 'AiCostRecordV1 endpointId', { optional: true }),
    costClass: text(own(raw, 'costClass', undefined), 'AiCostRecordV1 costClass', 20),
    inputTokens: requiredInteger(own(raw, 'inputTokens', undefined), 'AiCostRecordV1 inputTokens'),
    outputTokens: requiredInteger(own(raw, 'outputTokens', undefined), 'AiCostRecordV1 outputTokens'),
    modelCalls: integer(own(raw, 'modelCalls', undefined), 'AiCostRecordV1 modelCalls', { max: 1 }),
    inputPricePerMillionUsd: price(own(raw, 'inputPricePerMillionUsd', undefined), 'AiCostRecordV1 input price'),
    outputPricePerMillionUsd: price(own(raw, 'outputPricePerMillionUsd', undefined), 'AiCostRecordV1 output price'),
    costUsdMicros: requiredInteger(own(raw, 'costUsdMicros', undefined), 'AiCostRecordV1 costUsdMicros'),
    observedAt: timestamp(own(raw, 'observedAt', undefined), 'AiCostRecordV1 observedAt'),
  };

  if (normalized.modelCalls !== 1) throw new Error('AiCostRecordV1 modelCalls must equal 1');
  assertPricing(
    normalized.costClass,
    normalized.inputPricePerMillionUsd,
    normalized.outputPricePerMillionUsd,
    {
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      inputPriceKnown: true,
      outputPriceKnown: true,
    },
  );
  const expectedCost = normalized.costClass === AiRouteCostClass.FREE
    ? 0
    : conservativeCostUsdMicros(normalized);
  if (normalized.costUsdMicros !== expectedCost) {
    throw new Error('AiCostRecordV1 costUsdMicros does not match the recorded usage and pricing');
  }
  return frozen(normalized);
}

export function meterAiRouteUsageV1({ route, invocationId, inputTokens, outputTokens, observedAt } = {}) {
  const normalizedRoute = normalizeRouteForMetering(route);
  const normalizedInputTokens = requiredInteger(inputTokens, 'AI usage inputTokens');
  const normalizedOutputTokens = requiredInteger(outputTokens, 'AI usage outputTokens');
  assertPricing(
    normalizedRoute.costClass,
    normalizedRoute.inputPricePerMillionUsd,
    normalizedRoute.outputPricePerMillionUsd,
    {
      inputTokens: normalizedInputTokens,
      outputTokens: normalizedOutputTokens,
      inputPriceKnown: normalizedRoute.inputPriceKnown === true,
      outputPriceKnown: normalizedRoute.outputPriceKnown === true,
    },
  );
  const costUsdMicros = normalizedRoute.costClass === AiRouteCostClass.FREE
    ? 0
    : conservativeCostUsdMicros({
      inputTokens: normalizedInputTokens,
      outputTokens: normalizedOutputTokens,
      inputPricePerMillionUsd: normalizedRoute.inputPricePerMillionUsd,
      outputPricePerMillionUsd: normalizedRoute.outputPricePerMillionUsd,
    });

  return normalizeAiCostRecordV1({
    schemaVersion: AI_COST_RECORD_VERSION,
    invocationId,
    routeId: normalizedRoute.routeId,
    provider: normalizedRoute.provider,
    model: normalizedRoute.model,
    endpointId: normalizedRoute.endpointId,
    costClass: normalizedRoute.costClass,
    inputTokens: normalizedInputTokens,
    outputTokens: normalizedOutputTokens,
    modelCalls: 1,
    inputPricePerMillionUsd: normalizedRoute.inputPricePerMillionUsd,
    outputPricePerMillionUsd: normalizedRoute.outputPricePerMillionUsd,
    costUsdMicros,
    observedAt,
  });
}

export function resourceUsageFromAiCostRecordV1(input) {
  const record = normalizeAiCostRecordV1(input);
  return frozen({
    modelCalls: record.modelCalls,
    modelInputTokens: record.inputTokens,
    modelOutputTokens: record.outputTokens,
    costUsdMicros: record.costUsdMicros,
  });
}

export function aggregateAiCostRecordsV1(records) {
  const boundedRecords = dataArray(records, 'AI cost records', MAX_AI_COST_RECORDS);
  const total = {
    modelCalls: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    costUsdMicros: 0,
  };
  const seenInvocationIds = new Set();
  for (const input of boundedRecords) {
    const record = normalizeAiCostRecordV1(input);
    if (seenInvocationIds.has(record.invocationId)) {
      throw new Error(`AI cost aggregate contains duplicate invocationId: ${record.invocationId}`);
    }
    seenInvocationIds.add(record.invocationId);
    const usage = resourceUsageFromAiCostRecordV1(record);
    for (const key of Object.keys(total)) {
      const next = total[key] + usage[key];
      if (!Number.isSafeInteger(next)) throw new Error(`AI cost aggregate ${key} overflow`);
      total[key] = next;
    }
  }
  return frozen({ recordCount: boundedRecords.length, ...total });
}
