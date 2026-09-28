import {
  AiRouteRole,
  normalizeAiRoutePolicy,
  normalizeAiRoutePool,
  selectAiRouteCandidates,
} from './ai-route-pool.js';
import {
  rankBoundAgentModelRouteCandidatesV1,
} from './agent-model-route-candidate-binding.js';

export const AGENT_MODEL_ROUTE_DISPATCH_AUTHORIZATION_VERSION = 1;

export const AGENT_MODEL_ROUTE_DISPATCH_AUTHORITY = Object.freeze({
  routeSelectionAuthority: true,
  providerCallAuthority: false,
  credentialAuthority: false,
  executionAuthority: false,
  policyAuthority: false,
  persistenceAuthority: false,
  schedulingAuthority: false,
  recoveryAuthority: false,
  completionAuthority: false,
  verificationAuthority: false,
  requiresImmediateProviderBoundaryRevalidation: true,
  requiresCurrentRouterPolicy: true,
  requiresCurrentRoutePoolRevision: true,
  requiresCurrentDefinitionBinding: true,
});

const INPUT_KEYS = new Set([
  'definitionModelPolicyBinding',
  'currentDefinitionModelPolicyBindingKey',
  'currentDefinitionSelection',
  'currentJobId',
  'currentProjectId',
  'currentParentModelPolicyBinding',
  'currentParentModelPolicyBindingKey',
  'currentRoutePoolRevision',
  'routes',
  'routeStates',
  'currentRouterPolicy',
  'role',
  'capabilityIds',
  'requiresVision',
  'now',
]);

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function exactCapabilityIds(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
    throw new Error('Agent model dispatch capabilityIds must be a bounded array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !expected.has(key))) {
    throw new Error('Agent model dispatch capabilityIds must be a dense data-only array');
  }
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    const item = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    if (!descriptor || descriptor.enumerable !== true
        || typeof item !== 'string' || item !== item.trim()
        || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u.test(item)) {
      throw new Error('Agent model dispatch capabilityIds contains an invalid value');
    }
    out.push(item);
  }
  if (new Set(out).size !== out.length) {
    throw new Error('Agent model dispatch capabilityIds contains duplicates');
  }
  return Object.freeze(out);
}

function exactNow(value) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error('Agent model dispatch authorization now is invalid');
  }
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function makeCandidateRequest(raw, now) {
  const out = {
    definitionModelPolicyBinding: own(raw, 'definitionModelPolicyBinding'),
    currentDefinitionModelPolicyBindingKey: own(raw, 'currentDefinitionModelPolicyBindingKey'),
    currentDefinitionSelection: own(raw, 'currentDefinitionSelection'),
    currentJobId: own(raw, 'currentJobId'),
    currentProjectId: own(raw, 'currentProjectId'),
    currentRoutePoolRevision: own(raw, 'currentRoutePoolRevision'),
    routes: own(raw, 'routes'),
    routeStates: own(raw, 'routeStates') ?? {},
    role: own(raw, 'role') ?? AiRouteRole.PLANNER,
    capabilityIds,
    requiresVision: own(raw, 'requiresVision') ?? false,
    now,
  };
  if (Object.hasOwn(raw, 'currentParentModelPolicyBinding')) {
    out.currentParentModelPolicyBinding = own(raw, 'currentParentModelPolicyBinding');
  }
  if (Object.hasOwn(raw, 'currentParentModelPolicyBindingKey')) {
    out.currentParentModelPolicyBindingKey = own(raw, 'currentParentModelPolicyBindingKey');
  }
  return out;
}

function routeIdentity(route) {
  if (!route) return null;
  return Object.freeze({
    routeId: route.routeId,
    provider: route.provider,
    model: route.model,
    endpointId: route.endpointId,
  });
}

function authorizationKey({
  bound,
  routerPolicy,
  routerEligibleRouteIds,
  routerAvailableRouteIds,
  selectedRoute,
  capabilityIds,
  now,
}) {
  return JSON.stringify([
    AGENT_MODEL_ROUTE_DISPATCH_AUTHORIZATION_VERSION,
    bound.jobId,
    bound.projectId,
    bound.registryId,
    bound.registryRevision,
    bound.agentDefinitionId,
    bound.definitionRevision,
    bound.definitionModelPolicyBindingKey,
    bound.modelPolicyBindingKey,
    bound.parentModelPolicyBindingKey ?? null,
    bound.routePoolRevision,
    bound.role,
    bound.requiresVision,
    bound.eligibleRouteIds,
    bound.availableRouteIds,
    routerPolicy,
    routerEligibleRouteIds,
    routerAvailableRouteIds,
    selectedRoute,
    capabilityIds,
    now,
  ]);
}

/**
 * Produce a least-authority route-attempt authorization by intersecting the
 * exact durable Agent model-policy scope with the canonical Router's current
 * owner policy and route state.
 *
 * This authorizes only the selected route identity at this exact snapshot.
 * It does not authorize a provider call. The provider boundary must re-observe
 * current route/definition/policy authority immediately before I/O.
 */
export function authorizeBoundAgentModelRouteDispatchV1(input) {
  const raw = strictRecord(
    input,
    INPUT_KEYS,
    'Bound Agent model route dispatch authorization request',
  );
  if (!Object.hasOwn(raw, 'currentRouterPolicy')) {
    throw new Error('Bound Agent model route dispatch requires currentRouterPolicy');
  }
  if (!Object.hasOwn(raw, 'now')) {
    throw new Error('Bound Agent model route dispatch requires explicit now');
  }
  const now = exactNow(own(raw, 'now'));
  const capabilityIds = exactCapabilityIds(own(raw, 'capabilityIds') ?? []);

  const routes = normalizeAiRoutePool(own(raw, 'routes'));
  const routerPolicy = normalizeAiRoutePolicy(own(raw, 'currentRouterPolicy'));
  const candidateRequest = makeCandidateRequest(raw, now);
  const bound = rankBoundAgentModelRouteCandidatesV1(candidateRequest);

  const routerRanked = selectAiRouteCandidates({
    routes,
    policy: routerPolicy,
    routeStates: own(raw, 'routeStates') ?? {},
    role: bound.role,
    capabilityIds,
    requiresVision: bound.requiresVision,
    now,
  });

  const routerAvailableRouteIds = routerRanked.candidates.map(route => route.routeId);
  const routerAvailable = new Set(routerAvailableRouteIds);
  const selectedRouteId = bound.availableRouteIds.find(routeId => routerAvailable.has(routeId)) ?? null;
  const selectedRoute = routeIdentity(
    selectedRouteId === null ? null : routes.find(route => route.routeId === selectedRouteId),
  );

  const retryAt = selectedRoute === null
    ? Math.max(bound.retryAt || 0, routerRanked.retryAt || 0)
    : 0;

  const key = authorizationKey({
    bound,
    routerPolicy,
    routerEligibleRouteIds: [...routerRanked.eligibleRouteIds],
    routerAvailableRouteIds,
    selectedRoute,
    capabilityIds,
    now,
  });

  return freezeDeep({
    schemaVersion: AGENT_MODEL_ROUTE_DISPATCH_AUTHORIZATION_VERSION,
    authorizationKey: key,
    jobId: bound.jobId,
    projectId: bound.projectId,
    registryId: bound.registryId,
    registryRevision: bound.registryRevision,
    agentDefinitionId: bound.agentDefinitionId,
    definitionRevision: bound.definitionRevision,
    definitionModelPolicyBindingKey: bound.definitionModelPolicyBindingKey,
    modelPolicyBindingKey: bound.modelPolicyBindingKey,
    ...(bound.parentModelPolicyBindingKey ? {
      parentModelPolicyBindingKey: bound.parentModelPolicyBindingKey,
    } : {}),
    routePoolRevision: bound.routePoolRevision,
    role: bound.role,
    capabilityIds: [...capabilityIds],
    requiresVision: bound.requiresVision,
    boundEligibleRouteIds: [...bound.eligibleRouteIds],
    boundAvailableRouteIds: [...bound.availableRouteIds],
    routerEligibleRouteIds: [...routerRanked.eligibleRouteIds],
    routerAvailableRouteIds,
    selectedRoute,
    routeAttemptAuthorized: selectedRoute !== null,
    retryAt,
    authority: AGENT_MODEL_ROUTE_DISPATCH_AUTHORITY,
  });
}
