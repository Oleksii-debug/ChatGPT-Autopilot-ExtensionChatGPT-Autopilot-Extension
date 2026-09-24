/**
 * ResourceBudgetGovernorV1 is a pure admission contract, not a scheduler,
 * persistence layer, policy engine, or reservation lock. Callers must perform
 * the final admission + durable reservation atomically in their canonical
 * execution authority.
 */
export const RESOURCE_BUDGET_GOVERNOR_VERSION = 1;

export const ResourceBudgetDecisionKind = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
});

const DIMENSIONS = Object.freeze([
  'concurrentAgents',
  'childAgents',
  'modelCalls',
  'modelInputTokens',
  'modelOutputTokens',
  'runtimeSeconds',
  'costUsdMicros',
]);

const LIMIT_KEYS = new Set(DIMENSIONS.map(dimension => `max${dimension[0].toUpperCase()}${dimension.slice(1)}`));
const USAGE_KEYS = new Set(DIMENSIONS);
const MAX_BY_DIMENSION = Object.freeze({
  concurrentAgents: 100_000,
  childAgents: 100_000,
  modelCalls: 10_000_000,
  modelInputTokens: Number.MAX_SAFE_INTEGER,
  modelOutputTokens: Number.MAX_SAFE_INTEGER,
  runtimeSeconds: 31_536_000,
  costUsdMicros: Number.MAX_SAFE_INTEGER,
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} fields must be own data properties`);
    }
  }
  return value;
}

function exact(raw, allowed, label) {
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function own(raw, key) {
  if (!Object.hasOwn(raw, key)) return undefined;
  return Object.getOwnPropertyDescriptor(raw, key).value;
}

function boundedInteger(value, label, max, fallback = 0) {
  const number = value == null ? fallback : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > max) {
    throw new Error(`${label} is invalid`);
  }
  return number;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function limitKey(dimension) {
  return `max${dimension[0].toUpperCase()}${dimension.slice(1)}`;
}

export function normalizeResourceBudgetV1(input = {}) {
  const raw = object(input, 'ResourceBudgetV1');
  exact(raw, LIMIT_KEYS, 'ResourceBudgetV1');
  const entries = [];
  for (const dimension of DIMENSIONS) {
    const key = limitKey(dimension);
    entries.push([key, boundedInteger(own(raw, key), `ResourceBudgetV1 ${key}`, MAX_BY_DIMENSION[dimension])]);
  }
  return frozen(Object.fromEntries(entries));
}

export function normalizeResourceUsageV1(input = {}, { label = 'ResourceUsageV1' } = {}) {
  const raw = object(input, label);
  exact(raw, USAGE_KEYS, label);
  const entries = [];
  for (const dimension of DIMENSIONS) {
    entries.push([dimension, boundedInteger(own(raw, dimension), `${label} ${dimension}`, MAX_BY_DIMENSION[dimension])]);
  }
  return frozen(Object.fromEntries(entries));
}

export function remainingResourceBudgetV1(budgetInput, usageInput = {}) {
  const budget = normalizeResourceBudgetV1(budgetInput);
  const usage = normalizeResourceUsageV1(usageInput);
  const entries = [];
  for (const dimension of DIMENSIONS) {
    const key = limitKey(dimension);
    entries.push([dimension, Math.max(0, budget[key] - usage[dimension])]);
  }
  return frozen(Object.fromEntries(entries));
}

export function evaluateResourceBudgetV1({ budget, usage = {}, request = {} } = {}) {
  const normalizedBudget = normalizeResourceBudgetV1(budget);
  const normalizedUsage = normalizeResourceUsageV1(usage);
  const normalizedRequest = normalizeResourceUsageV1(request, { label: 'ResourceRequestV1' });
  const exceeded = [];
  const projectedEntries = [];
  const remainingEntries = [];

  for (const dimension of DIMENSIONS) {
    const key = limitKey(dimension);
    const next = normalizedUsage[dimension] + normalizedRequest[dimension];
    if (!Number.isSafeInteger(next)) throw new Error(`ResourceBudgetV1 ${dimension} projection is invalid`);
    projectedEntries.push([dimension, next]);
    remainingEntries.push([dimension, Math.max(0, normalizedBudget[key] - normalizedUsage[dimension])]);
    if (next > normalizedBudget[key]) exceeded.push(dimension);
  }

  return frozen({
    decision: exceeded.length === 0 ? ResourceBudgetDecisionKind.ALLOW : ResourceBudgetDecisionKind.DENY,
    reasonCode: exceeded.length === 0 ? 'WITHIN_BUDGET' : 'BUDGET_EXCEEDED',
    exceeded,
    budget: normalizedBudget,
    usage: normalizedUsage,
    request: normalizedRequest,
    projected: Object.fromEntries(projectedEntries),
    remaining: Object.fromEntries(remainingEntries),
  });
}

/**
 * Narrows a requested child budget to the parent's currently remaining
 * envelope. This never expands authority and performs no reservation itself.
 */
export function deriveChildResourceBudgetV1({ parentBudget, parentUsage = {}, requestedBudget } = {}) {
  const remaining = remainingResourceBudgetV1(parentBudget, parentUsage);
  const requested = normalizeResourceBudgetV1(requestedBudget);
  const entries = [];
  for (const dimension of DIMENSIONS) {
    const key = limitKey(dimension);
    entries.push([key, Math.min(requested[key], remaining[dimension])]);
  }
  return frozen(Object.fromEntries(entries));
}

export const ResourceBudgetDimensions = DIMENSIONS;
