import {
  normalizeAiRoutePolicy,
  normalizeAiRoutePool,
} from './ai-route-pool.js';

export const AGENT_MODEL_POLICY_BINDING_VERSION = 1;

const MAX_ROUTES = 32;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

const INPUT_KEYS = new Set([
  'projectId',
  'agentId',
  'policyRevision',
  'routePoolRevision',
  'routePool',
  'ownerAllowedRouteIds',
  'routePolicy',
  'parentBinding',
]);

const BINDING_KEYS = new Set([
  'schemaVersion',
  'projectId',
  'agentId',
  'parentAgentId',
  'policyRevision',
  'routePoolRevision',
  'bindingKey',
  'authorityRouteIds',
  'effectiveRouteIds',
  'routePolicy',
  'executionAuthority',
  'providerAuthority',
  'credentialAuthority',
  'policyAuthority',
  'persistenceAuthority',
  'schedulingAuthority',
]);

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalId(value, label) {
  if (value == null || value === '') return null;
  return requiredId(value, label);
}

function revision(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 1) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function denseDataArray(value, label, max = MAX_ROUTES) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    out.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string'
        || !/^(?:0|[1-9]\d*)$/u.test(key)
        || Number(key) >= length) {
      throw new Error(`${label} contains a non-index field`);
    }
  }
  return out;
}

function idList(value, label, { allowEmpty = true } = {}) {
  const out = denseDataArray(value, label).map((item, index) => requiredId(item, `${label}[${index}]`));
  if (!allowEmpty && out.length === 0) throw new Error(`${label} must not be empty`);
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreeze(child);
  if (!Object.isFrozen(value)) Object.freeze(value);
  return value;
}

function exactFalse(value, label) {
  if (value !== false) throw new Error(`${label} must be false`);
  return false;
}

function assertKnownRouteIds(routeIds, routeIdSet, label) {
  const unknown = routeIds.filter(routeId => !routeIdSet.has(routeId));
  if (unknown.length) throw new Error(`${label} references unknown route: ${unknown[0]}`);
}

function assertSubset(routeIds, allowed, label) {
  const allowedSet = new Set(allowed);
  const extra = routeIds.filter(routeId => !allowedSet.has(routeId));
  if (extra.length) throw new Error(`${label} exceeds route authority: ${extra[0]}`);
}

function assertInsideAgentAllow(routeIds, allowed, label) {
  const allowedSet = new Set(allowed);
  const extra = routeIds.filter(routeId => !allowedSet.has(routeId));
  if (extra.length) throw new Error(`${label} is outside Agent allow scope: ${extra[0]}`);
}

function canonicalOrder(pool, routeIds) {
  const selected = new Set(routeIds);
  return pool.map(route => route.routeId).filter(routeId => selected.has(routeId));
}

function routePolicyProjection(policy, authorityRouteIds) {
  const requestedAllow = policy.allowRouteIds.length
    ? policy.allowRouteIds
    : authorityRouteIds;
  assertSubset(requestedAllow, authorityRouteIds, 'Agent routePolicy.allowRouteIds');
  assertSubset(policy.denyRouteIds, authorityRouteIds, 'Agent routePolicy.denyRouteIds');
  assertSubset(policy.orderedRouteIds, authorityRouteIds, 'Agent routePolicy.orderedRouteIds');
  if (policy.pinnedRouteId) {
    assertSubset([policy.pinnedRouteId], authorityRouteIds, 'Agent routePolicy.pinnedRouteId');
  }
  assertInsideAgentAllow(policy.denyRouteIds, requestedAllow, 'Agent routePolicy.denyRouteIds');
  assertInsideAgentAllow(policy.orderedRouteIds, requestedAllow, 'Agent routePolicy.orderedRouteIds');
  if (policy.pinnedRouteId) {
    assertInsideAgentAllow([policy.pinnedRouteId], requestedAllow, 'Agent routePolicy.pinnedRouteId');
  }

  const allowSet = new Set(requestedAllow);
  const canonicalAllow = authorityRouteIds.filter(routeId => allowSet.has(routeId));
  const denySet = new Set(policy.denyRouteIds);
  const effectiveRouteIds = canonicalAllow.filter(routeId => !denySet.has(routeId));

  if (!effectiveRouteIds.length) {
    throw new Error('Agent route policy leaves no effective routes');
  }
  if (policy.pinnedRouteId && !effectiveRouteIds.includes(policy.pinnedRouteId)) {
    throw new Error('Agent pinned route is denied or outside effective route scope');
  }

  return {
    routePolicy: deepFreeze({
      ...policy,
      allowRouteIds: canonicalAllow,
      denyRouteIds: canonicalOrder(
        authorityRouteIds.map(routeId => ({ routeId })),
        policy.denyRouteIds,
      ),
      orderedRouteIds: policy.orderedRouteIds.filter(routeId => canonicalAllow.includes(routeId)),
    }),
    effectiveRouteIds,
  };
}

function assertChildPolicyDoesNotWiden(parent, childPolicy) {
  const parentPolicy = parent.routePolicy;

  if (parentPolicy.autoSwitch === false && childPolicy.autoSwitch === true) {
    throw new Error('Child route policy cannot enable autoSwitch disabled by parent');
  }
  if (parentPolicy.freeOnly === true && childPolicy.freeOnly !== true) {
    throw new Error('Child route policy cannot disable parent freeOnly constraint');
  }
  if (parentPolicy.locality !== 'any' && childPolicy.locality !== parentPolicy.locality) {
    throw new Error('Child route policy cannot widen parent locality constraint');
  }

  for (const [key, label] of [
    ['maxInputPricePerMillionUsd', 'input price cap'],
    ['maxOutputPricePerMillionUsd', 'output price cap'],
  ]) {
    const parentCap = parentPolicy[key];
    const childCap = childPolicy[key];
    if (parentCap != null && (childCap == null || childCap > parentCap)) {
      throw new Error(`Child route policy cannot widen parent ${label}`);
    }
  }

  if (parentPolicy.pinnedRouteId
      && childPolicy.pinnedRouteId !== parentPolicy.pinnedRouteId) {
    throw new Error('Child route policy cannot change or clear parent pinned route');
  }

  if (childPolicy.retryBackoffSeconds < parentPolicy.retryBackoffSeconds) {
    throw new Error('Child route policy cannot shorten parent retry backoff');
  }
  if (childPolicy.circuitBreakerFailures > parentPolicy.circuitBreakerFailures) {
    throw new Error('Child route policy cannot weaken parent circuit breaker failure threshold');
  }
  if (childPolicy.circuitBreakerSeconds < parentPolicy.circuitBreakerSeconds) {
    throw new Error('Child route policy cannot shorten parent circuit breaker duration');
  }
}

function bindingKey({
  projectId,
  agentId,
  parentAgentId,
  policyRevision,
  routePoolRevision,
}) {
  return JSON.stringify([
    AGENT_MODEL_POLICY_BINDING_VERSION,
    projectId,
    agentId,
    parentAgentId,
    policyRevision,
    routePoolRevision,
  ]);
}

function assertExactList(actual, expected, label) {
  if (actual.length !== expected.length
      || actual.some((item, index) => item !== expected[index])) {
    throw new Error(`${label} is inconsistent`);
  }
}

/**
 * Normalize a durable per-Agent model policy binding.
 *
 * This validates only the binding representation. The runtime owner must still
 * compare routePoolRevision with its current canonical route-pool snapshot
 * before using the binding.
 */
export function normalizeAgentModelPolicyBindingV1(input) {
  const raw = strictRecord(input, BINDING_KEYS, 'AgentModelPolicyBindingV1');
  const schemaVersion = own(raw, 'schemaVersion');
  if (schemaVersion !== AGENT_MODEL_POLICY_BINDING_VERSION) {
    throw new Error('Unsupported AgentModelPolicyBindingV1 schemaVersion');
  }

  const projectId = requiredId(own(raw, 'projectId'), 'projectId');
  const agentId = requiredId(own(raw, 'agentId'), 'agentId');
  const parentAgentId = optionalId(own(raw, 'parentAgentId'), 'parentAgentId');
  if (parentAgentId === agentId) throw new Error('Agent cannot be its own parent');

  const policyRevision = revision(own(raw, 'policyRevision'), 'policyRevision');
  const routePoolRevision = revision(own(raw, 'routePoolRevision'), 'routePoolRevision');
  const authorityRouteIds = idList(own(raw, 'authorityRouteIds'), 'authorityRouteIds', { allowEmpty: false });
  const effectiveRouteIds = idList(own(raw, 'effectiveRouteIds'), 'effectiveRouteIds', { allowEmpty: false });
  assertSubset(effectiveRouteIds, authorityRouteIds, 'effectiveRouteIds');

  const routePolicy = normalizeAiRoutePolicy(own(raw, 'routePolicy'));
  assertSubset(routePolicy.allowRouteIds, authorityRouteIds, 'routePolicy.allowRouteIds');
  assertSubset(routePolicy.denyRouteIds, authorityRouteIds, 'routePolicy.denyRouteIds');
  assertSubset(routePolicy.orderedRouteIds, authorityRouteIds, 'routePolicy.orderedRouteIds');
  if (routePolicy.pinnedRouteId) {
    assertSubset([routePolicy.pinnedRouteId], authorityRouteIds, 'routePolicy.pinnedRouteId');
  }

  const allow = routePolicy.allowRouteIds.length ? routePolicy.allowRouteIds : authorityRouteIds;
  assertInsideAgentAllow(routePolicy.denyRouteIds, allow, 'routePolicy.denyRouteIds');
  assertInsideAgentAllow(routePolicy.orderedRouteIds, allow, 'routePolicy.orderedRouteIds');
  if (routePolicy.pinnedRouteId) {
    assertInsideAgentAllow([routePolicy.pinnedRouteId], allow, 'routePolicy.pinnedRouteId');
  }
  const deny = new Set(routePolicy.denyRouteIds);
  const expectedEffective = allow.filter(routeId => !deny.has(routeId));
  assertExactList(effectiveRouteIds, expectedEffective, 'effectiveRouteIds');
  if (routePolicy.pinnedRouteId && !effectiveRouteIds.includes(routePolicy.pinnedRouteId)) {
    throw new Error('Pinned route is outside effectiveRouteIds');
  }

  const expectedKey = bindingKey({
    projectId,
    agentId,
    parentAgentId,
    policyRevision,
    routePoolRevision,
  });
  if (own(raw, 'bindingKey') !== expectedKey) {
    throw new Error('Agent model policy bindingKey is inconsistent');
  }

  const normalized = {
    schemaVersion,
    projectId,
    agentId,
    parentAgentId,
    policyRevision,
    routePoolRevision,
    bindingKey: expectedKey,
    authorityRouteIds: [...authorityRouteIds],
    effectiveRouteIds: [...effectiveRouteIds],
    routePolicy,
    executionAuthority: exactFalse(own(raw, 'executionAuthority'), 'executionAuthority'),
    providerAuthority: exactFalse(own(raw, 'providerAuthority'), 'providerAuthority'),
    credentialAuthority: exactFalse(own(raw, 'credentialAuthority'), 'credentialAuthority'),
    policyAuthority: exactFalse(own(raw, 'policyAuthority'), 'policyAuthority'),
    persistenceAuthority: exactFalse(own(raw, 'persistenceAuthority'), 'persistenceAuthority'),
    schedulingAuthority: exactFalse(own(raw, 'schedulingAuthority'), 'schedulingAuthority'),
  };
  return deepFreeze(normalized);
}

/**
 * Bind one Agent to an owner/parent-bounded projection of the canonical AI
 * route pool and the existing AiRoutePolicyV1 semantics.
 *
 * The result is configuration evidence only. It grants no provider call,
 * execution, credential, policy, persistence or scheduling authority.
 */
export function createAgentModelPolicyBindingV1(input) {
  const raw = strictRecord(input, INPUT_KEYS, 'AgentModelPolicyBindingRequestV1');
  const projectId = requiredId(own(raw, 'projectId'), 'projectId');
  const agentId = requiredId(own(raw, 'agentId'), 'agentId');
  const policyRevision = revision(own(raw, 'policyRevision'), 'policyRevision');
  const routePoolRevision = revision(own(raw, 'routePoolRevision'), 'routePoolRevision');

  const routePool = normalizeAiRoutePool(own(raw, 'routePool'));
  if (!routePool.length) throw new Error('Canonical AI route pool must not be empty');
  const routeIds = routePool.map(route => route.routeId);
  const routeIdSet = new Set(routeIds);

  const ownerAllowedRouteIds = idList(
    own(raw, 'ownerAllowedRouteIds'),
    'ownerAllowedRouteIds',
    { allowEmpty: false },
  );
  assertKnownRouteIds(ownerAllowedRouteIds, routeIdSet, 'ownerAllowedRouteIds');

  const parentInput = own(raw, 'parentBinding');
  const parentBinding = parentInput == null
    ? null
    : normalizeAgentModelPolicyBindingV1(parentInput);

  if (parentBinding) {
    if (parentBinding.projectId !== projectId) {
      throw new Error('Parent Agent model policy projectId mismatch');
    }
    if (parentBinding.agentId === agentId) {
      throw new Error('Agent cannot be its own parent');
    }
    if (parentBinding.routePoolRevision !== routePoolRevision) {
      throw new Error('Parent Agent model policy routePoolRevision is stale');
    }
    assertKnownRouteIds(
      parentBinding.effectiveRouteIds,
      routeIdSet,
      'parentBinding.effectiveRouteIds',
    );
  }

  const ownerSet = new Set(ownerAllowedRouteIds);
  const parentSet = parentBinding ? new Set(parentBinding.effectiveRouteIds) : null;
  const authorityRouteIds = routeIds.filter(routeId =>
    ownerSet.has(routeId) && (!parentSet || parentSet.has(routeId)));

  if (!authorityRouteIds.length) {
    throw new Error('Agent has no routes inside owner/parent model authority');
  }

  const routePolicy = normalizeAiRoutePolicy(own(raw, 'routePolicy') || {});
  if (parentBinding) assertChildPolicyDoesNotWiden(parentBinding, routePolicy);

  const projected = routePolicyProjection(routePolicy, authorityRouteIds);
  const parentAgentId = parentBinding?.agentId || null;
  const key = bindingKey({
    projectId,
    agentId,
    parentAgentId,
    policyRevision,
    routePoolRevision,
  });

  return normalizeAgentModelPolicyBindingV1({
    schemaVersion: AGENT_MODEL_POLICY_BINDING_VERSION,
    projectId,
    agentId,
    parentAgentId,
    policyRevision,
    routePoolRevision,
    bindingKey: key,
    authorityRouteIds,
    effectiveRouteIds: projected.effectiveRouteIds,
    routePolicy: projected.routePolicy,
    executionAuthority: false,
    providerAuthority: false,
    credentialAuthority: false,
    policyAuthority: false,
    persistenceAuthority: false,
    schedulingAuthority: false,
  });
}
