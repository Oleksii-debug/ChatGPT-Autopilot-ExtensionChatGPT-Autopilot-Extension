export const AGENT_SPECIALIST_DELEGATION_PROFILE_VERSION = 1;

const PROFILE_KEYS = new Set([
  'schemaVersion',
  'registryId',
  'requiredCapabilityIds',
  'requiredToolIds',
  'policyEnvelopeId',
  'deadlineSeconds',
  'maxConcurrentHandoffs',
  'leaseSeconds',
  'priority',
  'enabled',
]);

const MATERIALIZE_KEYS = new Set([
  'profile',
  'parentCapabilityIds',
  'parentToolIds',
  'expectedRegistryRevision',
  'expectedPlanRevision',
  'nodeId',
  'at',
  'childBudget',
  'parentInvocationId',
]);

const CHILD_BUDGET_KEYS = new Set([
  'maxModelCalls',
  'maxRuntimeSeconds',
  'maxCostUsdMicros',
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function snapshot(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${String(key)} must be an enumerable own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function canonicalArray(value, label, { min = 0, max = 128 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    throw new Error(`${label} must contain ${min}-${max} items`);
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-canonical array fields`);
    }
  }
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function identity(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function identities(value, label, max, min = 0) {
  const output = canonicalArray(value, label, { min, max })
    .map((item, index) => identity(item, `${label}[${index}]`));
  if (new Set(output).size !== output.length) {
    throw new Error(`${label} contains duplicate identity`);
  }
  return Object.freeze([...output].sort(compareIdentity));
}

function compareIdentity(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function subset(required, parent, label) {
  const parentSet = new Set(parent);
  for (const item of required) {
    if (!parentSet.has(item)) {
      throw new Error(`${label} exceeds parent authority: ${item}`);
    }
  }
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function normalizeChildBudget(input) {
  if (input === undefined) return undefined;
  const raw = snapshot(input, CHILD_BUDGET_KEYS, 'Agent specialist delegation childBudget');
  const output = {};
  for (const key of Object.keys(raw)) {
    output[key] = exactInteger(raw[key], `childBudget.${key}`);
  }
  return freeze(output);
}

export function normalizeAgentSpecialistDelegationProfileV1(input) {
  const raw = snapshot(input, PROFILE_KEYS, 'AgentSpecialistDelegationProfileV1');
  for (const key of PROFILE_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error(`AgentSpecialistDelegationProfileV1 requires ${key}`);
    }
  }
  if (raw.schemaVersion !== AGENT_SPECIALIST_DELEGATION_PROFILE_VERSION) {
    throw new Error('Unsupported AgentSpecialistDelegationProfileV1 schemaVersion');
  }
  if (typeof raw.enabled !== 'boolean') {
    throw new Error('AgentSpecialistDelegationProfileV1.enabled must be boolean');
  }
  const profile = {
    schemaVersion: AGENT_SPECIALIST_DELEGATION_PROFILE_VERSION,
    registryId: identity(raw.registryId, 'registryId'),
    requiredCapabilityIds: identities(
      raw.requiredCapabilityIds,
      'requiredCapabilityIds',
      64,
      1,
    ),
    requiredToolIds: identities(raw.requiredToolIds, 'requiredToolIds', 128),
    policyEnvelopeId: identity(raw.policyEnvelopeId, 'policyEnvelopeId'),
    deadlineSeconds: exactInteger(
      raw.deadlineSeconds,
      'deadlineSeconds',
      { min: 1, max: 31_536_000 },
    ),
    maxConcurrentHandoffs: exactInteger(
      raw.maxConcurrentHandoffs,
      'maxConcurrentHandoffs',
      { min: 0, max: 256 },
    ),
    leaseSeconds: exactInteger(
      raw.leaseSeconds,
      'leaseSeconds',
      { min: 1, max: 86_400 },
    ),
    priority: exactInteger(raw.priority, 'priority', { min: 0, max: 1_000_000 }),
    enabled: raw.enabled,
  };
  return freeze(profile);
}

/**
 * Converts owner-qualified profile data into the existing automatic-delegation
 * intent shape. This is a pure, non-authorizing projection only: the canonical
 * BrowserAgentManager must still re-read plan, registry, hierarchy, policy,
 * provider readiness and product-wide capacity before persisting or executing.
 */
export function materializeAgentSpecialistDelegationIntentV1(input = {}) {
  const raw = snapshot(input, MATERIALIZE_KEYS, 'Agent specialist delegation materialization request');
  for (const key of [
    'profile',
    'parentCapabilityIds',
    'parentToolIds',
    'expectedRegistryRevision',
    'expectedPlanRevision',
    'nodeId',
    'at',
  ]) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error(`Agent specialist delegation materialization request requires ${key}`);
    }
  }

  const profile = normalizeAgentSpecialistDelegationProfileV1(raw.profile);
  if (!profile.enabled) {
    throw new Error('Agent specialist delegation profile is disabled');
  }
  const parentCapabilityIds = identities(raw.parentCapabilityIds, 'parentCapabilityIds', 64);
  const parentToolIds = identities(raw.parentToolIds, 'parentToolIds', 128);
  subset(profile.requiredCapabilityIds, parentCapabilityIds, 'Required specialist capabilities');
  subset(profile.requiredToolIds, parentToolIds, 'Required specialist tools');

  const at = timestamp(raw.at, 'at');
  const startMs = Date.parse(at);
  const deadlineMs = startMs + profile.deadlineSeconds * 1000;
  if (!Number.isSafeInteger(deadlineMs)) {
    throw new Error('Agent specialist delegation deadline exceeds exact timestamp range');
  }
  const deadlineAt = new Date(deadlineMs).toISOString();
  if (!Number.isFinite(Date.parse(deadlineAt))) {
    throw new Error('Agent specialist delegation deadline is invalid');
  }

  const parentInvocationId = Object.hasOwn(raw, 'parentInvocationId') && raw.parentInvocationId !== ''
    ? identity(raw.parentInvocationId, 'parentInvocationId')
    : '';

  return freeze({
    schemaVersion: AGENT_SPECIALIST_DELEGATION_PROFILE_VERSION,
    request: {
      registryId: profile.registryId,
      expectedRegistryRevision: exactInteger(
        raw.expectedRegistryRevision,
        'expectedRegistryRevision',
        { min: 1 },
      ),
      expectedPlanRevision: exactInteger(
        raw.expectedPlanRevision,
        'expectedPlanRevision',
        { min: 1 },
      ),
      nodeId: identity(raw.nodeId, 'nodeId'),
      requiredCapabilityIds: profile.requiredCapabilityIds,
      requiredToolIds: profile.requiredToolIds,
      policyEnvelopeId: profile.policyEnvelopeId,
      deadlineAt,
      priority: profile.priority,
      ...(Object.hasOwn(raw, 'childBudget')
        ? { childBudget: normalizeChildBudget(raw.childBudget) }
        : {}),
      parentInvocationId,
      maxConcurrentHandoffs: profile.maxConcurrentHandoffs,
      leaseSeconds: profile.leaseSeconds,
    },
    authority: {
      proposalOnly: true,
      executionAuthorized: false,
      policyAuthorized: false,
      schedulingAuthorized: false,
      recoveryAuthorized: false,
      credentialAuthorized: false,
      completionAuthorized: false,
      verificationAuthorized: false,
      capacityReserved: false,
    },
  });
}
