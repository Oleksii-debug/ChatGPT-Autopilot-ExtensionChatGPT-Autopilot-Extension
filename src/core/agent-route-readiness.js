import { AiRouteRole, normalizeAiRoutePool, normalizeAiRoutePolicy, selectAiRouteCandidates } from './ai-route-pool.js';

export const AGENT_ROUTE_READINESS_VERSION = 1;
export const AgentRouteReadinessState = Object.freeze({
  READY: 'READY',
  WAITING_RETRY: 'WAITING_RETRY',
  UNAVAILABLE_CONFIG: 'UNAVAILABLE_CONFIG',
});

const REQUEST_KEYS = new Set([
  'routes',
  'policy',
  'routeStates',
  'plannerCapabilityIds',
  'verifierCapabilityIds',
  'requiresVision',
  'requiresVerifier',
  'now',
]);

function snapshotRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !REQUEST_KEYS.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${String(key)} must be an enumerable own data property`);
    }
    Object.defineProperty(out, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
}

function exactBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function exactNow(value) {
  if (value === undefined) return Date.now();
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error('Agent route readiness now is invalid');
  }
  return value;
}

function copyIds(items) {
  return Object.freeze(items.map(item => item.routeId));
}

function roleProjection(selection) {
  return Object.freeze({
    availableRouteIds: copyIds(selection.candidates),
    eligibleRouteIds: Object.freeze([...selection.eligibleRouteIds]),
    retryAt: selection.retryAt,
  });
}

function retryAtFor(required) {
  const values = required
    .filter(item => item.eligibleRouteIds.length > 0 && item.availableRouteIds.length === 0)
    .map(item => item.retryAt)
    .filter(value => Number.isSafeInteger(value) && value > 0);
  return values.length ? Math.min(...values) : 0;
}

export function inspectAgentRouteReadinessV1(input = {}) {
  const raw = snapshotRecord(input, 'Agent route readiness request');
  const routes = normalizeAiRoutePool(raw.routes ?? []);
  const policy = normalizeAiRoutePolicy(raw.policy ?? {});
  const routeStates = raw.routeStates ?? {};
  const plannerCapabilityIds = raw.plannerCapabilityIds ?? [];
  const verifierCapabilityIds = raw.verifierCapabilityIds ?? [];
  const requiresVision = exactBoolean(raw.requiresVision, 'Agent route readiness requiresVision', false);
  const requiresVerifier = exactBoolean(raw.requiresVerifier, 'Agent route readiness requiresVerifier', true);
  const now = exactNow(raw.now);

  const planner = roleProjection(selectAiRouteCandidates({
    routes,
    policy,
    routeStates,
    role: AiRouteRole.PLANNER,
    capabilityIds: plannerCapabilityIds,
    requiresVision,
    now,
  }));

  const verifier = requiresVerifier
    ? roleProjection(selectAiRouteCandidates({
      routes,
      policy,
      routeStates,
      role: AiRouteRole.VERIFIER,
      capabilityIds: verifierCapabilityIds,
      requiresVision: false,
      now,
    }))
    : Object.freeze({ availableRouteIds: Object.freeze([]), eligibleRouteIds: Object.freeze([]), retryAt: 0 });

  const required = requiresVerifier ? [planner, verifier] : [planner];
  const configUnavailable = required.some(item => item.eligibleRouteIds.length === 0);
  const temporarilyUnavailable = !configUnavailable && required.some(item => item.availableRouteIds.length === 0);
  const state = configUnavailable
    ? AgentRouteReadinessState.UNAVAILABLE_CONFIG
    : temporarilyUnavailable
      ? AgentRouteReadinessState.WAITING_RETRY
      : AgentRouteReadinessState.READY;

  return Object.freeze({
    schemaVersion: AGENT_ROUTE_READINESS_VERSION,
    state,
    ready: state === AgentRouteReadinessState.READY,
    requiresVerifier,
    planner,
    verifier,
    retryAt: state === AgentRouteReadinessState.WAITING_RETRY ? retryAtFor(required) : 0,
    authority: Object.freeze({
      executionAuthorized: false,
      providerCallAuthorized: false,
      policyAuthorized: false,
      schedulingAuthorized: false,
      recoveryAuthorized: false,
      completionAuthorized: false,
      verificationAuthorized: false,
    }),
  });
}
