import { normalizeAiRoutePool } from './ai-route-pool.js';
import { normalizeAgentModelPolicyBindingV1 } from './agent-model-policy-binding.js';
import {
  SubagentModelRouteScopeDecision,
  deriveSubagentModelRouteScopeV1,
} from './subagent-model-route-scope.js';

export const SUBAGENT_MODEL_POLICY_SCOPE_BINDING_VERSION = 1;

const REQUEST_KEYS = new Set([
  'childAuthorityEnvelope',
  'childModelPolicyBinding',
  'routes',
  'currentAgentModelPolicyRevision',
  'currentRoutePoolRevision',
  'taskModelCapabilityIds',
  'taskRequestedRouteIds',
  'role',
  'requiresVision',
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
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(record, key, label) {
  if (!Object.hasOwn(record, key)) throw new Error(label + ' requires ' + key);
  return record[key];
}

function revision(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 1) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function withBindingEvidence(scope, binding, overrides = {}) {
  const result = {
    ...scope,
    schemaVersion: SUBAGENT_MODEL_POLICY_SCOPE_BINDING_VERSION,
    agentModelPolicyBindingKey: binding.bindingKey,
    agentModelPolicyRevision: binding.policyRevision,
    routePoolRevision: binding.routePoolRevision,
    derivedFromDurableAgentModelPolicyBinding: true,
    rawParentPolicyAuthorityAccepted: false,
    rawOwnerPolicyAuthorityAccepted: false,
    routeSelectionAuthority: false,
    providerExecutionAuthority: false,
    policyAuthority: false,
    schedulingAuthority: false,
    recoveryAuthority: false,
    credentialAuthority: false,
    completionAuthority: false,
    persistenceAuthority: false,
    requiresCurrentRouterRevalidation: true,
    ...overrides,
  };
  if (result.decision === SubagentModelRouteScopeDecision.DENY) {
    result.admittedRouteIds = [];
    result.routeBindings = [];
  }
  return deepFreeze(result);
}

function deny(scope, binding, reasonCode, details = {}) {
  return withBindingEvidence(scope, binding, {
    decision: SubagentModelRouteScopeDecision.DENY,
    reasonCode,
    admittedRouteIds: [],
    routeBindings: [],
    ...details,
  });
}

/**
 * Bind one task-level child model route scope to the exact durable
 * AgentModelPolicyBindingV1 for that child.
 *
 * The durable Agent binding already represents owner ∩ parent route authority
 * and inherited no-widening policy. This adapter deliberately supplies that one
 * canonical policy projection to the existing SubagentModelRouteScopeV1
 * selector instead of accepting caller-shaped parent/owner policy authorities.
 *
 * This remains an advisory pure boundary. The runtime owner must supply the
 * current trusted Agent model-policy revision + route-pool revision and re-run the canonical Router against
 * current route state immediately before provider I/O.
 */
export function deriveSubagentModelRouteScopeFromAgentBindingV1(input = {}) {
  const request = strictRecord(
    input,
    REQUEST_KEYS,
    'SubagentModelPolicyScopeBindingRequestV1',
  );
  const binding = normalizeAgentModelPolicyBindingV1(
    own(
      request,
      'childModelPolicyBinding',
      'SubagentModelPolicyScopeBindingRequestV1',
    ),
  );
  const currentAgentModelPolicyRevision = revision(
    own(
      request,
      'currentAgentModelPolicyRevision',
      'SubagentModelPolicyScopeBindingRequestV1',
    ),
    'currentAgentModelPolicyRevision',
  );
  const currentRoutePoolRevision = revision(
    own(
      request,
      'currentRoutePoolRevision',
      'SubagentModelPolicyScopeBindingRequestV1',
    ),
    'currentRoutePoolRevision',
  );
  const routes = normalizeAiRoutePool(
    own(request, 'routes', 'SubagentModelPolicyScopeBindingRequestV1'),
  );

  const scope = deriveSubagentModelRouteScopeV1({
    childAuthorityEnvelope: own(
      request,
      'childAuthorityEnvelope',
      'SubagentModelPolicyScopeBindingRequestV1',
    ),
    routes,
    parentRoutePolicy: binding.routePolicy,
    ownerRoutePolicy: binding.routePolicy,
    taskModelCapabilityIds: own(
      request,
      'taskModelCapabilityIds',
      'SubagentModelPolicyScopeBindingRequestV1',
    ),
    taskRequestedRouteIds: own(
      request,
      'taskRequestedRouteIds',
      'SubagentModelPolicyScopeBindingRequestV1',
    ),
    role: own(request, 'role', 'SubagentModelPolicyScopeBindingRequestV1'),
    requiresVision: own(
      request,
      'requiresVision',
      'SubagentModelPolicyScopeBindingRequestV1',
    ),
  });

  if (!binding.parentAgentId
      || scope.projectId !== binding.projectId
      || scope.childAgentId !== binding.agentId
      || scope.parentAgentId !== binding.parentAgentId) {
    return deny(scope, binding, 'MODEL_POLICY_BINDING_IDENTITY_MISMATCH');
  }

  if (currentAgentModelPolicyRevision !== binding.policyRevision) {
    return deny(scope, binding, 'MODEL_POLICY_REVISION_STALE', {
      currentAgentModelPolicyRevision,
    });
  }

  if (currentRoutePoolRevision !== binding.routePoolRevision) {
    return deny(scope, binding, 'MODEL_POLICY_ROUTE_POOL_REVISION_STALE', {
      currentRoutePoolRevision,
    });
  }

  const currentRouteIds = new Set(routes.map(route => route.routeId));
  const missingAuthorityRouteIds = binding.authorityRouteIds
    .filter(routeId => !currentRouteIds.has(routeId));
  const missingEffectiveRouteIds = binding.effectiveRouteIds
    .filter(routeId => !currentRouteIds.has(routeId));
  if (missingAuthorityRouteIds.length || missingEffectiveRouteIds.length) {
    return deny(scope, binding, 'MODEL_POLICY_ROUTE_POOL_BINDING_DRIFT', {
      missingAuthorityRouteIds: [...missingAuthorityRouteIds],
      missingEffectiveRouteIds: [...missingEffectiveRouteIds],
    });
  }

  if (scope.decision !== SubagentModelRouteScopeDecision.ALLOW) {
    return withBindingEvidence(scope, binding);
  }

  const effective = new Set(binding.effectiveRouteIds);
  const widened = scope.admittedRouteIds.filter(routeId => !effective.has(routeId));
  if (widened.length) {
    return deny(scope, binding, 'MODEL_POLICY_EFFECTIVE_ROUTE_ESCALATION', {
      deniedRouteIds: [...widened],
    });
  }

  return withBindingEvidence(scope, binding);
}
