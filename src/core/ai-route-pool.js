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

const PROVIDERS = new Set(['ollama', 'openai', 'openai-compatible']);
const ROLES = new Set(Object.values(AiRouteRole));
const LOCALITIES = new Set(Object.values(AiRouteLocality));
const COST_CLASSES = new Set(Object.values(AiRouteCostClass));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_ROUTES = 32;

export const DEFAULT_AI_ROUTE_POLICY = Object.freeze({
  autoSwitch: true,
  pinnedRouteId: '',
  orderedRouteIds: Object.freeze([]),
  allowRouteIds: Object.freeze([]),
  denyRouteIds: Object.freeze([]),
  freeOnly: false,
  locality: 'any',
  maxInputPricePerMillionUsd: 0,
  maxOutputPricePerMillionUsd: 0,
  retryBackoffSeconds: 60,
  circuitBreakerFailures: 2,
  circuitBreakerSeconds: 300,
});

function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function exact(value, allowed, label) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`); }
function clean(value, max = 4000) { const out = typeof value === 'string' ? value.trim() : ''; if (out.length > max) throw new Error('AI route text is too long'); return out; }
function id(value, label, optional = false) { if (optional && (value == null || value === '')) return ''; const out = clean(value, 180); if (!ID.test(out)) throw new Error(`${label} is invalid`); return out; }
function integer(value, label, min, max) { const out = Number(value); if (!Number.isInteger(out) || out < min || out > max) throw new Error(`${label} is invalid`); return out; }
function price(value, label) { const out = Number(value ?? 0); if (!Number.isFinite(out) || out < 0 || out > 1_000_000) throw new Error(`${label} is invalid`); return out; }
function ids(value, label, max = MAX_ROUTES) { if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`); const out = value.map((item, index) => id(item, `${label}[${index}]`)); if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`); return out; }

export function normalizeAiRoutePool(raw = []) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ROUTES) throw new Error(`AI route pool must contain at most ${MAX_ROUTES} routes`);
  const routes = raw.map((item, index) => {
    object(item, `AI route ${index + 1}`);
    exact(item, new Set(['schemaVersion','routeId','provider','model','endpointId','roles','capabilityIds','priority','enabled','locality','costClass','inputPricePerMillionUsd','outputPricePerMillionUsd','supportsVision']), `AI route ${index + 1}`);
    if (Number(item.schemaVersion ?? AI_ROUTE_POOL_VERSION) !== AI_ROUTE_POOL_VERSION) throw new Error('Unsupported AI route schemaVersion');
    const provider = clean(item.provider, 40);
    if (!PROVIDERS.has(provider)) throw new Error('AI route provider is invalid');
    const model = clean(item.model, 300);
    if (!model) throw new Error('AI route model is required');
    const roles = ids(item.roles || [], `AI route ${index + 1} roles`, 12);
    if (roles.some(role => !ROLES.has(role))) throw new Error('AI route role is invalid');
    const locality = clean(item.locality || (provider === 'ollama' ? AiRouteLocality.LOCAL : AiRouteLocality.REMOTE), 20);
    if (!LOCALITIES.has(locality)) throw new Error('AI route locality is invalid');
    const costClass = clean(item.costClass || (provider === 'ollama' ? AiRouteCostClass.FREE : AiRouteCostClass.PAID), 20);
    if (!COST_CLASSES.has(costClass)) throw new Error('AI route costClass is invalid');
    return Object.freeze({
      schemaVersion: AI_ROUTE_POOL_VERSION,
      routeId: id(item.routeId, 'AI route routeId'),
      provider,
      model,
      endpointId: id(item.endpointId, 'AI route endpointId', true),
      roles,
      capabilityIds: ids(item.capabilityIds || [], `AI route ${index + 1} capabilityIds`, 64),
      priority: integer(item.priority ?? 0, 'AI route priority', 0, 1_000_000),
      enabled: item.enabled !== false,
      locality,
      costClass,
      inputPricePerMillionUsd: price(item.inputPricePerMillionUsd, 'AI route input price'),
      outputPricePerMillionUsd: price(item.outputPricePerMillionUsd, 'AI route output price'),
      supportsVision: item.supportsVision === true,
    });
  });
  if (new Set(routes.map(route => route.routeId)).size !== routes.length) throw new Error('AI route pool contains duplicate routeId');
  return Object.freeze(routes);
}

export function normalizeAiRoutePolicy(raw = {}) {
  if (raw == null) raw = {};
  object(raw, 'AI route policy');
  exact(raw, new Set(['autoSwitch','pinnedRouteId','orderedRouteIds','allowRouteIds','denyRouteIds','freeOnly','locality','maxInputPricePerMillionUsd','maxOutputPricePerMillionUsd','retryBackoffSeconds','circuitBreakerFailures','circuitBreakerSeconds']), 'AI route policy');
  const locality = clean(raw.locality || DEFAULT_AI_ROUTE_POLICY.locality, 20);
  if (!['any', ...LOCALITIES].includes(locality)) throw new Error('AI route policy locality is invalid');
  return Object.freeze({
    autoSwitch: raw.autoSwitch !== false,
    pinnedRouteId: id(raw.pinnedRouteId, 'AI route pinnedRouteId', true),
    orderedRouteIds: ids(raw.orderedRouteIds || [], 'AI route orderedRouteIds'),
    allowRouteIds: ids(raw.allowRouteIds || [], 'AI route allowRouteIds'),
    denyRouteIds: ids(raw.denyRouteIds || [], 'AI route denyRouteIds'),
    freeOnly: raw.freeOnly === true,
    locality,
    maxInputPricePerMillionUsd: price(raw.maxInputPricePerMillionUsd, 'AI route maximum input price'),
    maxOutputPricePerMillionUsd: price(raw.maxOutputPricePerMillionUsd, 'AI route maximum output price'),
    retryBackoffSeconds: integer(raw.retryBackoffSeconds ?? DEFAULT_AI_ROUTE_POLICY.retryBackoffSeconds, 'AI route retryBackoffSeconds', 1, 86_400),
    circuitBreakerFailures: integer(raw.circuitBreakerFailures ?? DEFAULT_AI_ROUTE_POLICY.circuitBreakerFailures, 'AI route circuitBreakerFailures', 1, 100),
    circuitBreakerSeconds: integer(raw.circuitBreakerSeconds ?? DEFAULT_AI_ROUTE_POLICY.circuitBreakerSeconds, 'AI route circuitBreakerSeconds', 1, 86_400),
  });
}

function stateNumber(value) { const out = Number(value); return Number.isFinite(out) && out >= 0 ? out : 0; }

export function normalizeAiRouteStates(raw = {}, routes = []) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const allowed = new Set(routes.map(route => route.routeId));
  const out = {};
  for (const [routeId, value] of Object.entries(source)) {
    if (!allowed.has(routeId) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    out[routeId] = {
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
    };
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
    && (normalizedPolicy.locality === 'any' || route.locality === normalizedPolicy.locality)
    && (!normalizedPolicy.maxInputPricePerMillionUsd || route.inputPricePerMillionUsd <= normalizedPolicy.maxInputPricePerMillionUsd)
    && (!normalizedPolicy.maxOutputPricePerMillionUsd || route.outputPricePerMillionUsd <= normalizedPolicy.maxOutputPricePerMillionUsd)
    && (!route.roles.length || route.roles.includes(normalizedRole))
    && capabilities.every(capabilityId => route.capabilityIds.includes(capabilityId))
    && (!requiresVision || route.supportsVision));
  if (normalizedPolicy.pinnedRouteId) candidates = candidates.filter(route => route.routeId === normalizedPolicy.pinnedRouteId);
  candidates.sort((a, b) => {
    const orderedA = order.has(a.routeId) ? order.get(a.routeId) : Number.MAX_SAFE_INTEGER;
    const orderedB = order.has(b.routeId) ? order.get(b.routeId) : Number.MAX_SAFE_INTEGER;
    return orderedA - orderedB || b.priority - a.priority || (states[a.routeId]?.lastLatencyMs || Number.MAX_SAFE_INTEGER) - (states[b.routeId]?.lastLatencyMs || Number.MAX_SAFE_INTEGER) || a.routeId.localeCompare(b.routeId);
  });
  const available = candidates.filter(route => Math.max(states[route.routeId]?.backoffUntil || 0, states[route.routeId]?.circuitOpenUntil || 0) <= now);
  const retryAt = candidates.length && !available.length
    ? Math.min(...candidates.map(route => Math.max(states[route.routeId]?.backoffUntil || 0, states[route.routeId]?.circuitOpenUntil || 0)).filter(value => value > now))
    : 0;
  return Object.freeze({ candidates: Object.freeze((normalizedPolicy.autoSwitch ? available : available.slice(0, 1))), eligibleRouteIds: Object.freeze(candidates.map(route => route.routeId)), retryAt });
}

export function recordAiRouteOutcome(routeStates, route, policy, { ok, classification = null, at = Date.now(), latencyMs = 0 } = {}) {
  const normalizedPolicy = normalizeAiRoutePolicy(policy);
  const states = normalizeAiRouteStates(routeStates, [route]);
  const current = states[route.routeId] || { consecutiveFailures:0, successes:0, failures:0, backoffUntil:0, circuitOpenUntil:0, lastErrorCode:'', lastErrorCategory:'', lastErrorAt:0, lastSuccessAt:0, lastLatencyMs:0 };
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
