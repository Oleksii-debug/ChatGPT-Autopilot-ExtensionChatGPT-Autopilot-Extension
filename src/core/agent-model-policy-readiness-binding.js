import { normalizeAiRoutePool, normalizeAiRoutePolicy } from './ai-route-pool.js';
import {
  normalizeAgentDefinitionSelectionV1,
} from './agent-definition-registry.js';
import {
  normalizeAgentDefinitionModelPolicyBindingV1,
} from './agent-definition-model-policy-binding.js';
import {
  inspectAgentRouteReadinessV1,
} from './agent-route-readiness.js';

export const AGENT_MODEL_POLICY_READINESS_BINDING_VERSION = 1;

export const AGENT_MODEL_POLICY_READINESS_BINDING_AUTHORITY = Object.freeze({
  advisoryOnly: true,
  routeSelectionAuthorized: false,
  providerCallAuthorized: false,
  executionAuthorized: false,
  policyAuthorized: false,
  persistenceAuthorized: false,
  schedulingAuthorized: false,
  recoveryAuthorized: false,
  completionAuthorized: false,
  verificationAuthorized: false,
  requiresCurrentDefinitionBinding: true,
  requiresCurrentRoutePoolRevision: true,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const INPUT_KEYS = new Set([
  'definitionModelPolicyBinding',
  'currentDefinitionModelPolicyBindingKey',
  'currentDefinitionSelection',
  'currentJobId',
  'currentProjectId',
  'currentRoutePoolRevision',
  'routes',
  'routeStates',
  'plannerCapabilityIds',
  'verifierCapabilityIds',
  'requiresVision',
  'requiresVerifier',
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

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactBindingKey(value) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.length > 100_000
      || value !== value.trim()) {
    throw new Error('currentDefinitionModelPolicyBindingKey is invalid');
  }
  return value;
}

function exactRevision(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 1) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function sameDefinitionBinding(binding, selection) {
  return binding.registryId === selection.registryId
    && binding.registryRevision === selection.registryRevision
    && binding.agentDefinitionId === selection.agentDefinitionId
    && binding.definitionRevision === selection.definitionRevision;
}

function readinessPolicy(binding) {
  const effective = binding.effectiveRouteIds;
  const effectiveSet = new Set(effective);
  return normalizeAiRoutePolicy({
    ...binding.routePolicy,
    allowRouteIds: [...effective],
    denyRouteIds: [],
    orderedRouteIds: binding.routePolicy.orderedRouteIds.filter(routeId => effectiveSet.has(routeId)),
  });
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

/**
 * Bind advisory Agent route readiness to the exact current durable
 * AgentDefinition/AgentModelPolicy evidence.
 *
 * This adapter does not select a route. It narrows the existing readiness
 * inspector to the binding's effectiveRouteIds and canonical route policy.
 */
export function inspectBoundAgentModelPolicyReadinessV1(input) {
  const raw = strictRecord(input, INPUT_KEYS, 'Bound Agent model readiness request');
  const binding = normalizeAgentDefinitionModelPolicyBindingV1(
    own(raw, 'definitionModelPolicyBinding'),
  );
  const currentBindingKey = exactBindingKey(
    own(raw, 'currentDefinitionModelPolicyBindingKey'),
  );
  if (binding.bindingKey !== currentBindingKey) {
    throw new Error('Agent definition model policy binding is not the current owner binding');
  }

  const currentJobId = exactId(own(raw, 'currentJobId'), 'currentJobId');
  const currentProjectId = exactId(own(raw, 'currentProjectId'), 'currentProjectId');
  if (binding.jobId !== currentJobId) {
    throw new Error('Agent model readiness job identity is stale');
  }
  if (binding.projectId !== currentProjectId) {
    throw new Error('Agent model readiness Project identity is stale');
  }

  const selection = normalizeAgentDefinitionSelectionV1(
    own(raw, 'currentDefinitionSelection'),
  );
  if (!sameDefinitionBinding(binding.definitionBinding, selection)) {
    throw new Error('Agent model readiness definition selection is stale');
  }

  const currentRoutePoolRevision = exactRevision(
    own(raw, 'currentRoutePoolRevision'),
    'currentRoutePoolRevision',
  );
  if (binding.modelPolicyBinding.routePoolRevision !== currentRoutePoolRevision) {
    throw new Error('Agent model readiness route-pool revision is stale');
  }

  const routes = normalizeAiRoutePool(own(raw, 'routes'));
  const routesById = new Map(routes.map(route => [route.routeId, route]));
  const effectiveRouteIds = binding.modelPolicyBinding.effectiveRouteIds;
  for (const routeId of effectiveRouteIds) {
    if (!routesById.has(routeId)) {
      throw new Error('Agent model readiness bound route is missing from current route pool: ' + routeId);
    }
  }
  const effectiveSet = new Set(effectiveRouteIds);
  const projectedRoutes = routes.filter(route => effectiveSet.has(route.routeId));
  const policy = readinessPolicy(binding.modelPolicyBinding);

  const readiness = inspectAgentRouteReadinessV1({
    routes: projectedRoutes,
    policy,
    routeStates: own(raw, 'routeStates') ?? {},
    plannerCapabilityIds: own(raw, 'plannerCapabilityIds') ?? [],
    verifierCapabilityIds: own(raw, 'verifierCapabilityIds') ?? [],
    requiresVision: own(raw, 'requiresVision') ?? false,
    requiresVerifier: own(raw, 'requiresVerifier') ?? true,
    ...(Object.hasOwn(raw, 'now') ? { now: own(raw, 'now') } : {}),
  });

  return freezeDeep({
    schemaVersion: AGENT_MODEL_POLICY_READINESS_BINDING_VERSION,
    jobId: binding.jobId,
    projectId: binding.projectId,
    registryId: binding.definitionBinding.registryId,
    registryRevision: binding.definitionBinding.registryRevision,
    agentDefinitionId: binding.definitionBinding.agentDefinitionId,
    definitionRevision: binding.definitionBinding.definitionRevision,
    definitionModelPolicyBindingKey: binding.bindingKey,
    modelPolicyBindingKey: binding.modelPolicyBinding.bindingKey,
    routePoolRevision: currentRoutePoolRevision,
    effectiveRouteIds: [...effectiveRouteIds],
    readiness,
    authority: AGENT_MODEL_POLICY_READINESS_BINDING_AUTHORITY,
  });
}
