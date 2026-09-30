import {
  AiRouteRole,
  normalizeAiRoutePool,
  normalizeAiRoutePolicy,
  selectAiRouteCandidates,
} from './ai-route-pool.js';
import { normalizeAgentDefinitionSelectionV1 } from './agent-definition-registry.js';
import {
  normalizeAgentDefinitionModelPolicyBindingV1,
} from './agent-definition-model-policy-binding.js';
import {
  createAgentModelPolicyBindingV1,
  normalizeAgentModelPolicyBindingV1,
} from './agent-model-policy-binding.js';

export const AGENT_MODEL_ROUTE_CANDIDATE_BINDING_VERSION = 1;

export const AGENT_MODEL_ROUTE_CANDIDATE_BINDING_AUTHORITY = Object.freeze({
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
  providerDispatchRevalidationRequired: true,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const ROUTE_ROLES = new Set(Object.values(AiRouteRole));
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

function exactBindingKey(value, label = 'currentDefinitionModelPolicyBindingKey') {
  if (typeof value !== 'string'
      || value.length < 1
      || value.length > 100_000
      || value !== value.trim()) {
    throw new Error(label + ' is invalid');
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

function exactBoolean(value, label, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function sameDefinitionBinding(binding, selection) {
  return binding.registryId === selection.registryId
    && binding.registryRevision === selection.registryRevision
    && binding.agentDefinitionId === selection.agentDefinitionId
    && binding.definitionRevision === selection.definitionRevision;
}

function scopedPolicy(modelBinding) {
  const effectiveRouteIds = modelBinding.effectiveRouteIds;
  const allowed = new Set(effectiveRouteIds);
  return normalizeAiRoutePolicy({
    ...modelBinding.routePolicy,
    allowRouteIds: [...effectiveRouteIds],
    denyRouteIds: [],
    orderedRouteIds: modelBinding.routePolicy.orderedRouteIds.filter(routeId => allowed.has(routeId)),
  });
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function rankBoundAgentModelRouteCandidatesV1(input) {
  const raw = strictRecord(input, INPUT_KEYS, 'Bound Agent model route candidate request');
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
    throw new Error('Agent model route candidate job identity is stale');
  }
  if (binding.projectId !== currentProjectId) {
    throw new Error('Agent model route candidate Project identity is stale');
  }

  const selection = normalizeAgentDefinitionSelectionV1(
    own(raw, 'currentDefinitionSelection'),
  );
  if (!sameDefinitionBinding(binding.definitionBinding, selection)) {
    throw new Error('Agent model route candidate definition selection is stale');
  }
  if (selection.definition.enabled !== true) {
    throw new Error('Agent model route candidate definition is disabled');
  }

  const currentRoutePoolRevision = exactRevision(
    own(raw, 'currentRoutePoolRevision'),
    'currentRoutePoolRevision',
  );
  if (binding.modelPolicyBinding.routePoolRevision !== currentRoutePoolRevision) {
    throw new Error('Agent model route candidate route-pool revision is stale');
  }

  const routes = normalizeAiRoutePool(own(raw, 'routes'));
  const routesById = new Map(routes.map(route => [route.routeId, route]));
  const authorityRouteIds = binding.modelPolicyBinding.authorityRouteIds;
  for (const routeId of authorityRouteIds) {
    if (!routesById.has(routeId)) {
      throw new Error('Agent model route candidate authority route is missing from current route pool: ' + routeId);
    }
  }
  const authoritySet = new Set(authorityRouteIds);
  const currentAuthorityRouteIds = routes
    .map(route => route.routeId)
    .filter(routeId => authoritySet.has(routeId));
  if (currentAuthorityRouteIds.some((routeId, index) => routeId !== authorityRouteIds[index])) {
    throw new Error('Agent model route candidate authority route order drifted inside current route pool revision');
  }

  let currentParentBinding = null;
  if (binding.modelPolicyBinding.parentAgentId !== null) {
    if (!Object.hasOwn(raw, 'currentParentModelPolicyBinding')
        || !Object.hasOwn(raw, 'currentParentModelPolicyBindingKey')) {
      throw new Error('Agent model route candidate child binding requires current parent model-policy provenance');
    }
    currentParentBinding = normalizeAgentModelPolicyBindingV1(
      own(raw, 'currentParentModelPolicyBinding'),
    );
    const currentParentBindingKey = exactBindingKey(
      own(raw, 'currentParentModelPolicyBindingKey'),
      'currentParentModelPolicyBindingKey',
    );
    if (currentParentBinding.bindingKey !== currentParentBindingKey) {
      throw new Error('Agent model route candidate parent binding is not the current owner binding');
    }
    if (currentParentBinding.agentId !== binding.modelPolicyBinding.parentAgentId
        || currentParentBinding.projectId !== binding.projectId) {
      throw new Error('Agent model route candidate parent model policy identity is stale');
    }
    if (currentParentBinding.routePoolRevision !== currentRoutePoolRevision) {
      throw new Error('Agent model route candidate parent route-pool revision is stale');
    }
  } else if (
    (Object.hasOwn(raw, 'currentParentModelPolicyBinding')
      && own(raw, 'currentParentModelPolicyBinding') != null)
    || Object.hasOwn(raw, 'currentParentModelPolicyBindingKey')
  ) {
    throw new Error('Root Agent model route candidate request must not supply parent model-policy provenance');
  }

  const currentPolicy = selection.definition.modelRoutePolicy;
  const reconstructed = createAgentModelPolicyBindingV1({
    projectId: binding.projectId,
    agentId: binding.jobId,
    policyRevision: binding.definitionBinding.definitionRevision,
    routePoolRevision: currentRoutePoolRevision,
    routePool: routes,
    ownerAllowedRouteIds: authorityRouteIds,
    ...(currentPolicy === null ? {} : { routePolicy: currentPolicy }),
    ...(currentParentBinding ? { parentBinding: currentParentBinding } : {}),
  });
  if (reconstructed.bindingKey !== binding.modelPolicyBinding.bindingKey) {
    throw new Error(
      binding.modelPolicyBinding.parentAgentId === null
        ? 'Agent model route candidate root model policy drifted at the current definition revision'
        : 'Agent model route candidate child model policy drifted from the current parent/definition authority',
    );
  }

  const effectiveRouteIds = binding.modelPolicyBinding.effectiveRouteIds;
  const effectiveSet = new Set(effectiveRouteIds);
  const projectedRoutes = routes.filter(route => effectiveSet.has(route.routeId));
  const role = own(raw, 'role') ?? AiRouteRole.PLANNER;
  if (typeof role !== 'string' || !ROUTE_ROLES.has(role)) {
    throw new Error('Agent model route candidate role is invalid');
  }
  const requiresVision = exactBoolean(
    own(raw, 'requiresVision'),
    'Agent model route candidate requiresVision',
    false,
  );

  const ranked = selectAiRouteCandidates({
    routes: projectedRoutes,
    policy: scopedPolicy(binding.modelPolicyBinding),
    routeStates: own(raw, 'routeStates') ?? {},
    role,
    capabilityIds: own(raw, 'capabilityIds') ?? [],
    requiresVision,
    ...(Object.hasOwn(raw, 'now') ? { now: own(raw, 'now') } : {}),
  });

  const availableRouteIds = ranked.candidates.map(route => route.routeId);
  const preferredRouteId = availableRouteIds[0] ?? null;

  return freezeDeep({
    schemaVersion: AGENT_MODEL_ROUTE_CANDIDATE_BINDING_VERSION,
    jobId: binding.jobId,
    projectId: binding.projectId,
    registryId: binding.definitionBinding.registryId,
    registryRevision: binding.definitionBinding.registryRevision,
    agentDefinitionId: binding.definitionBinding.agentDefinitionId,
    definitionRevision: binding.definitionBinding.definitionRevision,
    definitionModelPolicyBindingKey: binding.bindingKey,
    modelPolicyBindingKey: binding.modelPolicyBinding.bindingKey,
    ...(currentParentBinding ? {
      parentModelPolicyBindingKey: currentParentBinding.bindingKey,
    } : {}),
    routePoolRevision: currentRoutePoolRevision,
    role,
    requiresVision,
    authorityRouteIds: [...authorityRouteIds],
    effectiveRouteIds: [...effectiveRouteIds],
    eligibleRouteIds: [...ranked.eligibleRouteIds],
    availableRouteIds,
    preferredRouteId,
    retryAt: ranked.retryAt,
    authority: AGENT_MODEL_ROUTE_CANDIDATE_BINDING_AUTHORITY,
  });
}
