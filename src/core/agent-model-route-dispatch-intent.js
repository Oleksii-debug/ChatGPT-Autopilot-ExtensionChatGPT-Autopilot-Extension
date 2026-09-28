import { normalizeAiRoutePool } from './ai-route-pool.js';
import { rankBoundAgentModelRouteCandidatesV1 } from './agent-model-route-candidate-binding.js';

export const AGENT_MODEL_ROUTE_DISPATCH_INTENT_VERSION = 1;

export const AGENT_MODEL_ROUTE_DISPATCH_INTENT_AUTHORITY = Object.freeze({
  advisoryOnly: true,
  dispatchPrepared: true,
  routeSelectionAuthorized: false,
  providerCallAuthorized: false,
  credentialAccessAuthorized: false,
  executionAuthorized: false,
  policyAuthorized: false,
  persistenceAuthorized: false,
  schedulingAuthorized: false,
  recoveryAuthorized: false,
  completionAuthorized: false,
  verificationAuthorized: false,
  requiresCanonicalAiOrchestrator: true,
  requiresProviderCallLifecycleRevalidation: true,
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
  'role',
  'capabilityIds',
  'requiresVision',
  'now',
  'expectedPreferredRouteId',
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

function cleanOptionalId(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value !== value.trim() || value.length > 180) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function createBoundAgentModelRouteDispatchIntentV1(input) {
  const raw = strictRecord(input, INPUT_KEYS, 'Bound Agent model route dispatch request');
  const expectedPreferredRouteId = cleanOptionalId(
    raw.expectedPreferredRouteId,
    'expectedPreferredRouteId',
  );

  const rankingInput = Object.create(null);
  for (const key of INPUT_KEYS) {
    if (key === 'expectedPreferredRouteId') continue;
    if (Object.hasOwn(raw, key)) rankingInput[key] = raw[key];
  }

  const ranking = rankBoundAgentModelRouteCandidatesV1(rankingInput);
  if (!ranking.preferredRouteId) {
    const error = new Error(
      ranking.retryAt
        ? 'No bound Agent model route is dispatchable before retryAt'
        : 'No bound Agent model route is dispatchable',
    );
    error.code = 'AGENT_MODEL_ROUTE_DISPATCH_UNAVAILABLE';
    error.retryAt = ranking.retryAt;
    error.eligibleRouteIds = [...ranking.eligibleRouteIds];
    throw error;
  }

  if (expectedPreferredRouteId && expectedPreferredRouteId !== ranking.preferredRouteId) {
    throw new Error('Bound Agent model route preference changed before dispatch preparation');
  }

  const routes = normalizeAiRoutePool(raw.routes);
  const route = routes.find(item => item.routeId === ranking.preferredRouteId);
  if (!route) {
    throw new Error('Preferred bound Agent model route disappeared before dispatch preparation');
  }

  return freezeDeep({
    schemaVersion: AGENT_MODEL_ROUTE_DISPATCH_INTENT_VERSION,
    jobId: ranking.jobId,
    projectId: ranking.projectId,
    registryId: ranking.registryId,
    registryRevision: ranking.registryRevision,
    agentDefinitionId: ranking.agentDefinitionId,
    definitionRevision: ranking.definitionRevision,
    definitionModelPolicyBindingKey: ranking.definitionModelPolicyBindingKey,
    modelPolicyBindingKey: ranking.modelPolicyBindingKey,
    routePoolRevision: ranking.routePoolRevision,
    role: ranking.role,
    requiresVision: ranking.requiresVision,
    routeId: route.routeId,
    route: {
      routeId: route.routeId,
      provider: route.provider,
      model: route.model,
      endpointId: route.endpointId,
    },
    eligibleRouteIds: [...ranking.eligibleRouteIds],
    availableRouteIds: [...ranking.availableRouteIds],
    retryAt: ranking.retryAt,
    authority: AGENT_MODEL_ROUTE_DISPATCH_INTENT_AUTHORITY,
  });
}
