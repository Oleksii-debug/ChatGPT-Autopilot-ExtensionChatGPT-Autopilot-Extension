import {
  AiRouteRole,
  normalizeAiRoutePool,
  normalizeAiRoutePolicy,
  selectAiRouteCandidates,
} from './ai-route-pool.js';
import {
  SUBAGENT_AUTHORITY_ENVELOPE_VERSION,
  SubagentAuthorityDecision,
} from './subagent-authority-envelope.js';

export const SUBAGENT_MODEL_ROUTE_SCOPE_VERSION = 1;

export const SubagentModelRouteScopeDecision = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const ROLES = new Set(Object.values(AiRouteRole));
const REQUEST_KEYS = new Set([
  'childAuthorityEnvelope',
  'routes',
  'parentRoutePolicy',
  'ownerRoutePolicy',
  'taskModelCapabilityIds',
  'taskRequestedRouteIds',
  'role',
  'requiresVision',
]);
const CHILD_AUTHORITY_KEYS = new Set([
  'schemaVersion',
  'decision',
  'reasonCode',
  'projectId',
  'parentAgentId',
  'childAgentId',
  'taskId',
  'providerId',
  'capabilityIds',
  'sourceIds',
  'artifactIds',
  'toolIds',
  'toolDescriptors',
  'executionAuthority',
  'credentialAuthority',
  'policyAuthority',
]);
const MAX_ROUTE_IDS = 32;
const MAX_CAPABILITY_IDS = 64;
const MAX_AUTHORITY_IDS = 256;

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
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
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

function requiredOwn(record, key, label) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new Error(label + ' is required');
  }
  return record[key];
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity');
  }
  return value;
}

function denseDataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' must be a bounded canonical array');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' must be a dense data-only array');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function idList(value, label, max) {
  const values = denseDataArray(value, label, max)
    .map((item, index) => exactId(item, label + '[' + index + ']'));
  if (new Set(values).size !== values.length) {
    throw new Error(label + ' contains duplicates');
  }
  return Object.freeze(values);
}

function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function normalizeChildAuthorityEnvelope(value) {
  const raw = strictRecord(
    value,
    CHILD_AUTHORITY_KEYS,
    'SubagentAuthorityEnvelopeV1',
  );
  if (requiredOwn(raw, 'schemaVersion', 'childAuthorityEnvelope.schemaVersion')
      !== SUBAGENT_AUTHORITY_ENVELOPE_VERSION) {
    throw new Error('childAuthorityEnvelope schemaVersion is unsupported');
  }
  if (requiredOwn(raw, 'decision', 'childAuthorityEnvelope.decision')
      !== SubagentAuthorityDecision.ALLOW
      || requiredOwn(raw, 'reasonCode', 'childAuthorityEnvelope.reasonCode')
        !== 'LEAST_AUTHORITY_DERIVED') {
    throw new Error('childAuthorityEnvelope must be an admitted least-authority envelope');
  }

  const envelope = {
    projectId: exactId(
      requiredOwn(raw, 'projectId', 'childAuthorityEnvelope.projectId'),
      'childAuthorityEnvelope.projectId',
    ),
    parentAgentId: exactId(
      requiredOwn(raw, 'parentAgentId', 'childAuthorityEnvelope.parentAgentId'),
      'childAuthorityEnvelope.parentAgentId',
    ),
    childAgentId: exactId(
      requiredOwn(raw, 'childAgentId', 'childAuthorityEnvelope.childAgentId'),
      'childAuthorityEnvelope.childAgentId',
    ),
    taskId: exactId(
      requiredOwn(raw, 'taskId', 'childAuthorityEnvelope.taskId'),
      'childAuthorityEnvelope.taskId',
    ),
    providerId: exactId(
      requiredOwn(raw, 'providerId', 'childAuthorityEnvelope.providerId'),
      'childAuthorityEnvelope.providerId',
    ),
    capabilityIds: sortedUnique(idList(
      requiredOwn(raw, 'capabilityIds', 'childAuthorityEnvelope.capabilityIds'),
      'childAuthorityEnvelope.capabilityIds',
      MAX_AUTHORITY_IDS,
    )),
  };

  // Validate the complete canonical ALLOW shape, even though model routing only
  // consumes identities + capabilities. This prevents a caller from presenting
  // a partial object that merely resembles the #469 authority result.
  idList(
    requiredOwn(raw, 'sourceIds', 'childAuthorityEnvelope.sourceIds'),
    'childAuthorityEnvelope.sourceIds',
    MAX_AUTHORITY_IDS,
  );
  idList(
    requiredOwn(raw, 'artifactIds', 'childAuthorityEnvelope.artifactIds'),
    'childAuthorityEnvelope.artifactIds',
    MAX_AUTHORITY_IDS,
  );
  const toolIds = idList(
    requiredOwn(raw, 'toolIds', 'childAuthorityEnvelope.toolIds'),
    'childAuthorityEnvelope.toolIds',
    MAX_AUTHORITY_IDS,
  );
  const toolDescriptors = denseDataArray(
    requiredOwn(raw, 'toolDescriptors', 'childAuthorityEnvelope.toolDescriptors'),
    'childAuthorityEnvelope.toolDescriptors',
    MAX_AUTHORITY_IDS,
  );
  if (toolDescriptors.length !== toolIds.length) {
    throw new Error('childAuthorityEnvelope tool identity cardinality is inconsistent');
  }
  for (const key of ['executionAuthority', 'credentialAuthority', 'policyAuthority']) {
    if (requiredOwn(raw, key, 'childAuthorityEnvelope.' + key) !== false) {
      throw new Error('childAuthorityEnvelope.' + key + ' must remain false');
    }
  }
  if (envelope.parentAgentId === envelope.childAgentId) {
    throw new Error('childAuthorityEnvelope child identity is not isolated');
  }
  return freezeDeep(envelope);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      freezeDeep(descriptor.value);
    }
  }
  return Object.freeze(value);
}

function sortedUnique(values) {
  return Object.freeze([...new Set(values)].sort());
}

function missing(values, allowedValues) {
  const allowed = new Set(allowedValues);
  return values.filter(value => !allowed.has(value));
}

function intersect(left, right) {
  const rightSet = new Set(right);
  return sortedUnique(left.filter(value => rightSet.has(value)));
}

function policyCandidateRouteIds({
  routes,
  policy,
  role,
  capabilityIds,
  requiresVision,
}) {
  const selected = selectAiRouteCandidates({
    routes,
    policy,
    routeStates: {},
    role,
    capabilityIds,
    requiresVision,
    now: 0,
  });
  return sortedUnique(selected.candidates.map(route => route.routeId));
}

function routeBinding(route) {
  return freezeDeep({
    routeId: route.routeId,
    provider: route.provider,
    model: route.model,
    endpointId: route.endpointId,
    roles: [...route.roles].sort(),
    capabilityIds: [...route.capabilityIds].sort(),
    locality: route.locality,
    costClass: route.costClass,
    inputPricePerMillionUsd: route.inputPricePerMillionUsd,
    outputPricePerMillionUsd: route.outputPricePerMillionUsd,
    inputPriceKnown: route.inputPriceKnown,
    outputPriceKnown: route.outputPriceKnown,
    supportsVision: route.supportsVision,
  });
}

function baseResult({
  identities,
  role,
  modelCapabilityIds,
  requiresVision,
  taskRequestedRouteIds,
  parentPolicyRouteIds,
  ownerPolicyRouteIds,
  commonRouteIds,
}) {
  return {
    schemaVersion: SUBAGENT_MODEL_ROUTE_SCOPE_VERSION,
    projectId: identities.projectId,
    parentAgentId: identities.parentAgentId,
    childAgentId: identities.childAgentId,
    taskId: identities.taskId,
    childAuthorityProviderId: childAuthority.providerId,
    role,
    modelCapabilityIds: [...modelCapabilityIds],
    requiresVision,
    taskRequestedRouteIds: [...taskRequestedRouteIds],
    parentPolicyRouteIds: [...parentPolicyRouteIds],
    ownerPolicyRouteIds: [...ownerPolicyRouteIds],
    commonRouteIds: [...commonRouteIds],
    advisoryOnly: true,
    routeSelectionAuthority: false,
    providerExecutionAuthority: false,
    policyAuthority: false,
    schedulingAuthority: false,
    recoveryAuthority: false,
    credentialAuthority: false,
    completionAuthority: false,
    derivedFromTransientRouteState: false,
    requiresCurrentRouterRevalidation: true,
  };
}

function denied(reasonCode, context, details = {}) {
  return freezeDeep({
    ...baseResult(context),
    decision: SubagentModelRouteScopeDecision.DENY,
    reasonCode,
    routeBindings: [],
    ...details,
  });
}

/**
 * Derive a least-authority, non-executable model-route scope for one child Agent.
 *
 * This function deliberately does not consume route runtime/backoff state and does
 * not select a provider for execution. Parent and owner policy are evaluated
 * independently by the existing canonical Router selector against the same route
 * pool and task model requirements. The child may only narrow their intersection.
 *
 * The childAuthorityEnvelope must be the trusted current ALLOW result from the
 * integrated #469 least-authority boundary. Caller/model identity aliases are
 * intentionally absent from this request.
 *
 * Any consumer must re-run the canonical Router against current settings/policy/
 * route state before provider I/O. This result grants no provider-call authority.
 */
export function deriveSubagentModelRouteScopeV1(input = {}) {
  const request = strictRecord(input, REQUEST_KEYS, 'SubagentModelRouteScopeRequestV1');

  const childAuthority = normalizeChildAuthorityEnvelope(
    requiredOwn(request, 'childAuthorityEnvelope', 'childAuthorityEnvelope'),
  );
  const identities = freezeDeep({
    projectId: childAuthority.projectId,
    parentAgentId: childAuthority.parentAgentId,
    childAgentId: childAuthority.childAgentId,
    taskId: childAuthority.taskId,
  });

  const routes = normalizeAiRoutePool(requiredOwn(request, 'routes', 'routes'));
  const parentRoutePolicy = normalizeAiRoutePolicy(
    requiredOwn(request, 'parentRoutePolicy', 'parentRoutePolicy'),
  );
  const ownerRoutePolicy = normalizeAiRoutePolicy(
    requiredOwn(request, 'ownerRoutePolicy', 'ownerRoutePolicy'),
  );
  const childCapabilityIds = childAuthority.capabilityIds;
  const modelCapabilityIds = sortedUnique(idList(
    requiredOwn(request, 'taskModelCapabilityIds', 'taskModelCapabilityIds'),
    'taskModelCapabilityIds',
    MAX_CAPABILITY_IDS,
  ));
  const taskRequestedRouteIds = sortedUnique(idList(
    requiredOwn(request, 'taskRequestedRouteIds', 'taskRequestedRouteIds'),
    'taskRequestedRouteIds',
    MAX_ROUTE_IDS,
  ));
  const role = requiredOwn(request, 'role', 'role');
  if (typeof role !== 'string' || role !== role.trim() || !ROLES.has(role)) {
    throw new Error('role must be a canonical AI route role');
  }
  const requiresVision = requiredBoolean(
    requiredOwn(request, 'requiresVision', 'requiresVision'),
    'requiresVision',
  );

  const capabilityEscalation = missing(modelCapabilityIds, childCapabilityIds);
  const emptyContext = {
    identities,
    role,
    modelCapabilityIds,
    requiresVision,
    taskRequestedRouteIds,
    parentPolicyRouteIds: [],
    ownerPolicyRouteIds: [],
    commonRouteIds: [],
  };
  if (capabilityEscalation.length) {
    return denied('MODEL_CAPABILITY_ESCALATION', emptyContext, {
      deniedCapabilityIds: sortedUnique(capabilityEscalation),
    });
  }

  const selectorInput = {
    routes,
    role,
    capabilityIds: modelCapabilityIds,
    requiresVision,
  };
  const parentPolicyRouteIds = policyCandidateRouteIds({
    ...selectorInput,
    policy: parentRoutePolicy,
  });
  const ownerPolicyRouteIds = policyCandidateRouteIds({
    ...selectorInput,
    policy: ownerRoutePolicy,
  });
  const commonRouteIds = intersect(parentPolicyRouteIds, ownerPolicyRouteIds);
  const context = {
    identities,
    role,
    modelCapabilityIds,
    requiresVision,
    taskRequestedRouteIds,
    parentPolicyRouteIds,
    ownerPolicyRouteIds,
    commonRouteIds,
  };

  if (!commonRouteIds.length) {
    return denied('NO_COMMON_MODEL_ROUTE', context);
  }

  const routeEscalation = missing(taskRequestedRouteIds, commonRouteIds);
  if (routeEscalation.length) {
    return denied('MODEL_ROUTE_ESCALATION', context, {
      deniedRouteIds: sortedUnique(routeEscalation),
    });
  }

  const admittedRouteIds = taskRequestedRouteIds.length
    ? sortedUnique(taskRequestedRouteIds)
    : commonRouteIds;
  if (!admittedRouteIds.length) {
    return denied('NO_TASK_MODEL_ROUTE', context);
  }

  const routeById = new Map(routes.map(route => [route.routeId, route]));
  const routeBindings = admittedRouteIds.map(routeId => routeBinding(routeById.get(routeId)));

  return freezeDeep({
    ...baseResult(context),
    decision: SubagentModelRouteScopeDecision.ALLOW,
    reasonCode: 'MODEL_ROUTE_SCOPE_ADMITTED',
    admittedRouteIds: [...admittedRouteIds],
    routeBindings,
  });
}
