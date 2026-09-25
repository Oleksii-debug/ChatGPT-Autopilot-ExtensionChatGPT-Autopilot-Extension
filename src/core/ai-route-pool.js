export const AI_ROUTE_POOL_VERSION = 1;
export const AiRouteRole = Object.freeze({
  PLANNER: 'planner',
  CODER: 'coder',
  FAST_WORKER: 'fast-worker',
  VERIFIER: 'verifier',
  CRITIC: 'critic',
  VISION: 'vision',
});
export const AiRouteLocality = Object.freeze({ LOCAL: 'local', REMOTE: 'remote' });
export const AiRouteCostClass = Object.freeze({ FREE: 'free', PAID: 'paid' });
export const AiWorkerAllocationMode = Object.freeze({ AUTO: 'auto', MANUAL: 'manual' });

const PROVIDERS = new Set(['ollama', 'openai', 'openai-compatible']);
const ROLES = new Set(Object.values(AiRouteRole));
const LOCALITIES = new Set(Object.values(AiRouteLocality));
const COST_CLASSES = new Set(Object.values(AiRouteCostClass));
const WORKER_ALLOCATION_MODES = new Set(Object.values(AiWorkerAllocationMode));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_ROUTES = 32;
const MAX_PARALLEL_WORKERS = 200;

export const DEFAULT_AI_ROUTE_POLICY = Object.freeze({
  autoSwitch: true,
  pinnedRouteId: '',
  orderedRouteIds: Object.freeze([]),
  allowRouteIds: Object.freeze([]),
  denyRouteIds: Object.freeze([]),
  freeOnly: false,
  locality: 'any',
  maxInputPricePerMillionUsd: null,
  maxOutputPricePerMillionUsd: null,
  retryBackoffSeconds: 60,
  circuitBreakerFailures: 2,
  circuitBreakerSeconds: 300,
});

export const DEFAULT_AI_WORKER_POLICY = Object.freeze({
  allocationMode: AiWorkerAllocationMode.AUTO,
  maxParallelWorkers: 8,
  manualRouteWorkers: Object.freeze({}),
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain data object`);
  return value;
}
function exact(value, allowed, label) {
  object(value, label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains a symbol field`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label} field must be an enumerable own data property: ${key}`);
    }
  }
}
function dataRecord(value, allowed, label) {
  object(value, label);
  const keys = Reflect.ownKeys(value);
  const out = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error(`${label} contains a symbol field`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label} field must be an enumerable own data property: ${key}`);
    }
    Object.defineProperty(out, key, {
      value:descriptor.value,
      enumerable:true,
      writable:false,
      configurable:false,
    });
  }
  return Object.freeze(out);
}
function denseDataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded array`);
  }
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(descriptors);
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  if (ownKeys.length !== expected.size || ownKeys.some(key => typeof key !== 'string' || !expected.has(key))) {
    throw new Error(`${label} must be a dense data-only array`);
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    out.push(descriptor.value);
  }
  return out;
}
function clean(value, max = 4000) { const out = typeof value === 'string' ? value.trim() : ''; if (out.length > max) throw new Error('AI route text is too long'); return out; }
function id(value, label, optional = false) { if (optional && (value == null || value === '')) return ''; const out = clean(value, 180); if (!ID.test(out)) throw new Error(`${label} is invalid`); return out; }
function integer(value, label, min, max) { if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label} is invalid`); const out = Number(value); if (!Number.isInteger(out) || out < min || out > max) throw new Error(`${label} is invalid`); return out; }
function strictInteger(value, label, min, max) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is invalid`); return value; }
function own(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function price(value, label) { if (value == null) return 0; if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label} is invalid`); const out = Number(value); if (!Number.isFinite(out) || out < 0 || out > 1_000_000) throw new Error(`${label} is invalid`); return out; }
function priceCap(value, label) {
  if (value == null) return null;
  return price(value, label);
}
function knownPriceDimension(item, priceKey, knownKey, label) {
  if (Object.hasOwn(item, knownKey)) {
    const explicitKnown = own(item, knownKey);
    if (typeof explicitKnown !== 'boolean') throw new Error(`${label} must be boolean`);
    if (explicitKnown && !Object.hasOwn(item, priceKey)) throw new Error(`${label} cannot be true without an explicit price`);
    return explicitKnown;
  }
  return Object.hasOwn(item, priceKey);
}
function ids(value, label, max = MAX_ROUTES) {
  const source = denseDataArray(value, label, max);
  const out = source.map((item, index) => id(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

export function normalizeAiRoutePool(raw = []) {
  if (raw == null) return [];
  const source = denseDataArray(raw, 'AI route pool', MAX_ROUTES);
  const routes = source.map((rawItem, index) => {
    const item = dataRecord(rawItem, new Set(['schemaVersion','routeId','provider','model','endpointId','roles','capabilityIds','priority','enabled','locality','costClass','inputPricePerMillionUsd','outputPricePerMillionUsd','inputPriceKnown','outputPriceKnown','supportsVision','maxWorkers']), `AI route ${index + 1}`);
    if (integer(own(item, 'schemaVersion') ?? AI_ROUTE_POOL_VERSION, 'AI route schemaVersion', AI_ROUTE_POOL_VERSION, AI_ROUTE_POOL_VERSION) !== AI_ROUTE_POOL_VERSION) throw new Error('Unsupported AI route schemaVersion');
    const provider = clean(own(item, 'provider'), 40);
    if (!PROVIDERS.has(provider)) throw new Error('AI route provider is invalid');
    const model = clean(own(item, 'model'), 300);
    if (!model) throw new Error('AI route model is required');
    const roles = ids(own(item, 'roles') || [], `AI route ${index + 1} roles`, 12);
    if (roles.some(role => !ROLES.has(role))) throw new Error('AI route role is invalid');
    const locality = clean(own(item, 'locality') || (provider === 'ollama' ? AiRouteLocality.LOCAL : AiRouteLocality.REMOTE), 20);
    if (!LOCALITIES.has(locality)) throw new Error('AI route locality is invalid');
    const costClass = clean(own(item, 'costClass') || (provider === 'ollama' ? AiRouteCostClass.FREE : AiRouteCostClass.PAID), 20);
    if (!COST_CLASSES.has(costClass)) throw new Error('AI route costClass is invalid');
    const inputPriceKnown = knownPriceDimension(item, 'inputPricePerMillionUsd', 'inputPriceKnown', `AI route ${index + 1} inputPriceKnown`);
    const outputPriceKnown = knownPriceDimension(item, 'outputPricePerMillionUsd', 'outputPriceKnown', `AI route ${index + 1} outputPriceKnown`);
    return Object.freeze({
      schemaVersion: AI_ROUTE_POOL_VERSION,
      routeId: id(own(item, 'routeId'), 'AI route routeId'),
      provider,
      model,
      endpointId: id(own(item, 'endpointId'), 'AI route endpointId', true),
      roles,
      capabilityIds: ids(own(item, 'capabilityIds') || [], `AI route ${index + 1} capabilityIds`, 64),
      priority: integer(own(item, 'priority') ?? 0, 'AI route priority', 0, 1_000_000),
      enabled: own(item, 'enabled') !== false,
      locality,
      costClass,
      inputPricePerMillionUsd: price(own(item, 'inputPricePerMillionUsd'), 'AI route input price'),
      outputPricePerMillionUsd: price(own(item, 'outputPricePerMillionUsd'), 'AI route output price'),
      inputPriceKnown,
      outputPriceKnown,
      supportsVision: own(item, 'supportsVision') === true,
      maxWorkers: strictInteger(own(item, 'maxWorkers') ?? 0, 'AI route maxWorkers', 0, MAX_PARALLEL_WORKERS),
    });
  });
  if (new Set(routes.map(route => route.routeId)).size !== routes.length) throw new Error('AI route pool contains duplicate routeId');
  return Object.freeze(routes);
}

export function normalizeAiRoutePolicy(raw = {}) {
  if (raw == null) raw = {};
  const source = dataRecord(raw, new Set(['autoSwitch','pinnedRouteId','orderedRouteIds','allowRouteIds','denyRouteIds','freeOnly','locality','maxInputPricePerMillionUsd','maxOutputPricePerMillionUsd','retryBackoffSeconds','circuitBreakerFailures','circuitBreakerSeconds']), 'AI route policy');
  const locality = clean(own(source, 'locality') || DEFAULT_AI_ROUTE_POLICY.locality, 20);
  if (!['any', ...LOCALITIES].includes(locality)) throw new Error('AI route policy locality is invalid');
  return Object.freeze({
    autoSwitch: own(source, 'autoSwitch') !== false,
    pinnedRouteId: id(own(source, 'pinnedRouteId'), 'AI route pinnedRouteId', true),
    orderedRouteIds: ids(own(source, 'orderedRouteIds') || [], 'AI route orderedRouteIds'),
    allowRouteIds: ids(own(source, 'allowRouteIds') || [], 'AI route allowRouteIds'),
    denyRouteIds: ids(own(source, 'denyRouteIds') || [], 'AI route denyRouteIds'),
    freeOnly: own(source, 'freeOnly') === true,
    locality,
    maxInputPricePerMillionUsd: priceCap(own(source, 'maxInputPricePerMillionUsd'), 'AI route maximum input price'),
    maxOutputPricePerMillionUsd: priceCap(own(source, 'maxOutputPricePerMillionUsd'), 'AI route maximum output price'),
    retryBackoffSeconds: integer(own(source, 'retryBackoffSeconds') ?? DEFAULT_AI_ROUTE_POLICY.retryBackoffSeconds, 'AI route retryBackoffSeconds', 1, 86_400),
    circuitBreakerFailures: integer(own(source, 'circuitBreakerFailures') ?? DEFAULT_AI_ROUTE_POLICY.circuitBreakerFailures, 'AI route circuitBreakerFailures', 1, 100),
    circuitBreakerSeconds: integer(own(source, 'circuitBreakerSeconds') ?? DEFAULT_AI_ROUTE_POLICY.circuitBreakerSeconds, 'AI route circuitBreakerSeconds', 1, 86_400),
  });
}

export function normalizeAiWorkerPolicy(raw = {}, routes = []) {
  if (raw == null) raw = {};
  object(raw, 'AI worker policy');
  exact(raw, new Set(['allocationMode','maxParallelWorkers','manualRouteWorkers']), 'AI worker policy');
  const allocationMode = clean(raw.allocationMode || DEFAULT_AI_WORKER_POLICY.allocationMode, 20);
  if (!WORKER_ALLOCATION_MODES.has(allocationMode)) throw new Error('AI worker allocationMode is invalid');
  const maxParallelWorkers = strictInteger(raw.maxParallelWorkers ?? DEFAULT_AI_WORKER_POLICY.maxParallelWorkers, 'AI worker maxParallelWorkers', 1, MAX_PARALLEL_WORKERS);
  const pool = normalizeAiRoutePool(routes);
  const routeIds = new Set(pool.map(route => route.routeId));
  const source = raw.manualRouteWorkers ?? {};
  object(source, 'AI worker manualRouteWorkers');
  if (Object.keys(source).length > MAX_ROUTES) throw new Error('AI worker manualRouteWorkers is too large');
  const manualRouteWorkers = {};
  let manualTotal = 0;
  for (const [rawRouteId, value] of Object.entries(source)) {
    const routeId = id(rawRouteId, 'AI worker manual routeId');
    if (!routeIds.has(routeId)) throw new Error(`AI worker manual route is unknown: ${routeId}`);
    const count = strictInteger(value, `AI worker manualRouteWorkers.${routeId}`, 0, MAX_PARALLEL_WORKERS);
    const route = pool.find(item => item.routeId === routeId);
    if (route.maxWorkers > 0 && count > route.maxWorkers) throw new Error(`AI worker manual allocation exceeds maxWorkers for route: ${routeId}`);
    Object.defineProperty(manualRouteWorkers, routeId, { value:count, enumerable:true, writable:true, configurable:true });
    manualTotal += count;
  }
  if (allocationMode === AiWorkerAllocationMode.MANUAL && manualTotal > maxParallelWorkers) {
    throw new Error('AI worker manual allocation exceeds maxParallelWorkers');
  }
  return Object.freeze({ allocationMode, maxParallelWorkers, manualRouteWorkers: Object.freeze(manualRouteWorkers) });
}

function stateNumber(value) { const out = Number(value); return Number.isFinite(out) && out >= 0 ? out : 0; }

export function normalizeAiRouteStates(raw = {}, routes = []) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const allowed = new Set(routes.map(route => route.routeId));
  const out = {};
  for (const [routeId, value] of Object.entries(source)) {
    if (!allowed.has(routeId) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    Object.defineProperty(out, routeId, { value:{
      consecutiveFailures: Math.floor(stateNumber(value.consecutiveFailures)),
      successes: Math.floor(stateNumber(value.successes)),
      failures: Math.floor(stateNumber(value.failures)),
      backoffUntil: stateNumber(value.backoffUntil),
      circuitOpenUntil: stateNumber(value.circuitOpenUntil),
      lastErrorCode: clean(value.lastErrorCode, 120),
      lastErrorCategory: clean(value.lastErrorCategory, 80),
      lastErrorAt: stateNumber(value.lastErrorAt),
      lastSuccessAt: stateNumber(value.lastSuccessAt),
      lastLatencyMs: stateNumber(value.lastLatencyMs),
    }, enumerable:true, writable:true, configurable:true });
  }
  return out;
}

export function classifyAiRouteError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.httpStatus ?? 0);
  const code = clean(error?.code || '', 120).toUpperCase();
  const message = clean(error?.message || error || '', 2000).toLowerCase();
  const evidence = `${code} ${message}`;
  if (/POLICY|SAFETY|CONTENT_FILTER|AUTH|PERMISSION|INVALID_|UNSUPPORTED|BAD_REQUEST/.test(evidence) || [400, 401, 403, 404, 422].includes(status)) {
    return Object.freeze({ retryable: false, category: 'non-retryable', code: code || (status ? `HTTP_${status}` : 'AI_ROUTE_REJECTED') });
  }
  if (status === 429 || /QUOTA|RATE_LIMIT|THROTTL|TOKEN_EXHAUST|QUEUE_FULL/.test(evidence)) {
    return Object.freeze({ retryable: true, category: 'quota-or-rate', code: code || (status ? `HTTP_${status}` : 'AI_ROUTE_RATE_LIMITED') });
  }
  if ([408, 425].includes(status) || status >= 500 || /TIMEOUT|TIMED OUT|UNAVAILABLE|OFFLINE|NETWORK|ECONN|ABORT|UPSTREAM/.test(evidence)) {
    return Object.freeze({ retryable: true, category: 'transient', code: code || (status ? `HTTP_${status}` : 'AI_ROUTE_TRANSIENT_FAILURE') });
  }
  return Object.freeze({ retryable: false, category: 'unknown', code: code || (status ? `HTTP_${status}` : 'AI_ROUTE_UNKNOWN_FAILURE') });
}

export function selectAiRouteCandidates({ routes, policy, routeStates = {}, role = AiRouteRole.PLANNER, capabilityIds = [], requiresVision = false, now = Date.now() } = {}) {
  const pool = normalizeAiRoutePool(routes);
  const normalizedPolicy = normalizeAiRoutePolicy(policy);
  const normalizedRole = clean(role, 40);
  if (!ROLES.has(normalizedRole)) throw new Error('AI route requested role is invalid');
  const capabilities = ids(capabilityIds || [], 'AI route requested capabilityIds', 64);
  const states = normalizeAiRouteStates(routeStates, pool);
  const allow = new Set(normalizedPolicy.allowRouteIds);
  const deny = new Set(normalizedPolicy.denyRouteIds);
  const order = new Map(normalizedPolicy.orderedRouteIds.map((routeId, index) => [routeId, index]));
  let candidates = pool.filter(route => route.enabled
    && (!allow.size || allow.has(route.routeId))
    && !deny.has(route.routeId)
    && (!normalizedPolicy.freeOnly || route.costClass === AiRouteCostClass.FREE)
    && (route.costClass === AiRouteCostClass.FREE || (route.inputPriceKnown && route.outputPriceKnown))
    && (normalizedPolicy.locality === 'any' || route.locality === normalizedPolicy.locality)
    && (normalizedPolicy.maxInputPricePerMillionUsd === null
      || route.inputPricePerMillionUsd <= normalizedPolicy.maxInputPricePerMillionUsd)
    && (normalizedPolicy.maxOutputPricePerMillionUsd === null
      || route.outputPricePerMillionUsd <= normalizedPolicy.maxOutputPricePerMillionUsd)
    && (!route.roles.length || route.roles.includes(normalizedRole))
    && capabilities.every(capabilityId => route.capabilityIds.includes(capabilityId))
    && (!requiresVision || route.supportsVision));
  if (normalizedPolicy.pinnedRouteId) candidates = candidates.filter(route => route.routeId === normalizedPolicy.pinnedRouteId);
  candidates.sort((a, b) => {
    const orderedA = order.has(a.routeId) ? order.get(a.routeId) : Number.MAX_SAFE_INTEGER;
    const orderedB = order.has(b.routeId) ? order.get(b.routeId) : Number.MAX_SAFE_INTEGER;
    return orderedA - orderedB
      || b.priority - a.priority
      || (own(states, a.routeId)?.lastLatencyMs || Number.MAX_SAFE_INTEGER)
        - (own(states, b.routeId)?.lastLatencyMs || Number.MAX_SAFE_INTEGER)
      || (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0);
  });
  const available = candidates.filter(route => {
    const state = own(states, route.routeId);
    return Math.max(state?.backoffUntil || 0, state?.circuitOpenUntil || 0) <= now;
  });
  const retryAt = candidates.length && !available.length
    ? Math.min(...candidates.map(route => {
      const state = own(states, route.routeId);
      return Math.max(state?.backoffUntil || 0, state?.circuitOpenUntil || 0);
    }).filter(value => value > now))
    : 0;
  return Object.freeze({ candidates: Object.freeze((normalizedPolicy.autoSwitch ? available : available.slice(0, 1))), eligibleRouteIds: Object.freeze(candidates.map(route => route.routeId)), retryAt });
}

export function allocateAiRouteWorkers({ routes, routePolicy = {}, workerPolicy = {}, routeStates = {}, role = AiRouteRole.FAST_WORKER, capabilityIds = [], requiresVision = false, desiredWorkers = 0, now = Date.now() } = {}) {
  const pool = normalizeAiRoutePool(routes);
  const normalizedWorkerPolicy = normalizeAiWorkerPolicy(workerPolicy, pool);
  const requested = strictInteger(desiredWorkers, 'AI worker desiredWorkers', 0, MAX_PARALLEL_WORKERS);
  const target = Math.min(requested, normalizedWorkerPolicy.maxParallelWorkers);
  const selected = selectAiRouteCandidates({
    routes: pool,
    policy: { ...normalizeAiRoutePolicy(routePolicy), autoSwitch: true },
    routeStates,
    role,
    capabilityIds,
    requiresVision,
    now,
  });
  const candidates = selected.candidates;
  const allocations = Object.fromEntries(pool.map(route => [route.routeId, 0]));
  if (!target || !candidates.length) return Object.freeze({ allocations: Object.freeze(allocations), assignedWorkers: 0, unassignedWorkers: target, eligibleRouteIds: selected.eligibleRouteIds, retryAt: selected.retryAt });

  if (normalizedWorkerPolicy.allocationMode === AiWorkerAllocationMode.MANUAL) {
    let remaining = target;
    for (const route of candidates) {
      if (remaining <= 0) break;
      const configured = own(normalizedWorkerPolicy.manualRouteWorkers, route.routeId) ?? 0;
      const cap = route.maxWorkers > 0 ? Math.min(configured, route.maxWorkers) : configured;
      const assigned = Math.min(remaining, cap);
      allocations[route.routeId] = assigned;
      remaining -= assigned;
    }
    return Object.freeze({ allocations: Object.freeze(allocations), assignedWorkers: target - remaining, unassignedWorkers: remaining, eligibleRouteIds: selected.eligibleRouteIds, retryAt: selected.retryAt });
  }

  let remaining = target;
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    for (const route of candidates) {
      if (remaining <= 0) break;
      const cap = route.maxWorkers > 0 ? route.maxWorkers : normalizedWorkerPolicy.maxParallelWorkers;
      if (allocations[route.routeId] >= cap) continue;
      allocations[route.routeId] += 1;
      remaining -= 1;
      progressed = true;
    }
  }
  return Object.freeze({ allocations: Object.freeze(allocations), assignedWorkers: target - remaining, unassignedWorkers: remaining, eligibleRouteIds: selected.eligibleRouteIds, retryAt: selected.retryAt });
}

export function recordAiRouteOutcome(routeStates, route, policy, { ok, classification = null, at = Date.now(), latencyMs = 0 } = {}) {
  const normalizedPolicy = normalizeAiRoutePolicy(policy);
  const states = normalizeAiRouteStates(routeStates, [route]);
  const current = own(states, route.routeId) || { consecutiveFailures:0, successes:0, failures:0, backoffUntil:0, circuitOpenUntil:0, lastErrorCode:'', lastErrorCategory:'', lastErrorAt:0, lastSuccessAt:0, lastLatencyMs:0 };
  if (ok) {
    return { ...current, consecutiveFailures:0, successes:current.successes + 1, backoffUntil:0, circuitOpenUntil:0, lastErrorCode:'', lastErrorCategory:'', lastSuccessAt:at, lastLatencyMs:Math.max(0, Number(latencyMs) || 0) };
  }
  const failures = current.consecutiveFailures + 1;
  const retryable = classification?.retryable === true;
  return {
    ...current,
    consecutiveFailures: failures,
    failures: current.failures + 1,
    backoffUntil: retryable ? at + normalizedPolicy.retryBackoffSeconds * 1000 : current.backoffUntil,
    circuitOpenUntil: retryable && failures >= normalizedPolicy.circuitBreakerFailures ? at + normalizedPolicy.circuitBreakerSeconds * 1000 : current.circuitOpenUntil,
    lastErrorCode: clean(classification?.code || 'AI_ROUTE_FAILURE', 120),
    lastErrorCategory: clean(classification?.category || 'unknown', 80),
    lastErrorAt: at,
    lastLatencyMs: Math.max(0, Number(latencyMs) || 0),
  };
}

export function createAiRoutePoolExhaustedError({ attempts = [], retryAt = 0, message = 'No eligible AI route is currently available' } = {}) {
  const error = new Error(message);
  error.code = 'AI_ROUTE_POOL_EXHAUSTED';
  error.retryAt = Math.max(0, Number(retryAt) || 0);
  error.routeAttempts = structuredClone(attempts).slice(-32);
  return error;
}
