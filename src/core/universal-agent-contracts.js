export const UniversalAgentContractVersion = 1;

export const PolicyDecisionKind = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
});

export const ObservationStatus = Object.freeze({
  OK: 'OK',
  PARTIAL: 'PARTIAL',
  ERROR: 'ERROR',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const VerificationStatus = Object.freeze({
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  AMBIGUOUS: 'AMBIGUOUS',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
});

const POLICY_KINDS = new Set(Object.values(PolicyDecisionKind));
const OBSERVATION_STATUSES = new Set(Object.values(ObservationStatus));
const VERIFICATION_STATUSES = new Set(Object.values(VerificationStatus));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TEXT = 16_000;
const MAX_DATA_JSON = 256_000;
const MAX_LIST = 128;

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  // Authority/evidence contracts are untrusted input. Snapshot descriptor
  // values without evaluating accessors so validation and normalization read
  // the exact same immutable input view.
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error(`${label} contains unknown field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field`);
    }
  }
  for (const key of allowed) {
    if (key in value && !Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} contains inherited field: ${key}`);
    }
  }
}

function version(value, label) {
  if (typeof value !== 'number'
      || !Number.isInteger(value)
      || value !== UniversalAgentContractVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return UniversalAgentContractVersion;
}

function id(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  if (value !== value.trim()) throw new Error(`${label} is invalid: must be an exact canonical ID; exact canonical identity required`);
  if (!ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!out || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}

function timestamp(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return null;
  // All durable authority/evidence clocks must be explicit, zone-bound ISO
  // instants. Date.parse accepts shorthand and rolls impossible calendar dates.
  // Year 10000+ requires the ISO 8601 signed six-digit extended-year form.
  // The calendar round-trip must compare the full wall-clock width; fixed
  // slicing at 19 characters rejects valid extended years or hides rollover.
  const format = /^(?:\d{4}|\+\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
  if (typeof value !== 'string' || !format.test(value)) {
    throw new Error(`${label} must be an ISO timestamp with an explicit timezone`);
  }
  const wallClock = value.match(/^(?:\d{4}|\+\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u)[0];
  const calendar = new Date(wallClock + 'Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, wallClock.length) !== wallClock) {
    throw new Error(`${label} contains an invalid calendar date`);
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return instant.toISOString();
}

function integer(value, label, min, max, { optional = false, fallback = 0 } = {}) {
  if (value == null && optional) return fallback;
  if (typeof value !== 'number'
      || !Number.isInteger(value)
      || !Number.isFinite(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function bool(value, label, fallback = false, { present = false } = {}) {
  // Omitted legacy metadata may use a default. An explicitly present null
  // or undefined must not silently change a privacy or execution permission
  // flag during a durable JSON round-trip.
  if (value == null) {
    if (present) throw new Error(`${label} must be boolean`);
    return fallback;
  }
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function dataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded array`);
  }
  const length = lengthDescriptor.value;
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) {
      throw new Error(`${label} contains a non-index field`);
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} entries must be enumerable own data properties`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    out[index] = descriptor.value;
  }
  return out;
}
function idList(value, label, { optional = true, max = MAX_LIST } = {}) {
  if (value == null && optional) return [];
  const items = dataArray(value, label, max);
  const out = items.map((item, index) => id(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function stringList(value, label, { optional = true, max = MAX_LIST, itemMax = 500 } = {}) {
  if (value == null && optional) return [];
  const items = dataArray(value, label, max);
  return items.map((item, index) => text(item, `${label}[${index}]`, { max: itemMax }));
}

function cloneJsonData(value, label, stack = new WeakSet(), depth = 0) {
  if (depth > 64) throw new Error(`${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    // JSON.stringify(-0) is 0; reject rather than mutate exact effect identity on restart.
    if (Object.is(value, -0)) throw new Error(`${label} contains non-canonical negative zero`);
    return value;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} must contain JSON-compatible data only`);
  }
  if (stack.has(value)) throw new Error(`${label} must not contain cycles`);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const items = dataArray(value, label, MAX_DATA_JSON);
      return items.map((item, index) => cloneJsonData(item, `${label}[${index}]`, stack, depth + 1));
    }
    const raw = plain(value, label);
    const out = {};
    for (const key of Object.keys(raw)) {
      Object.defineProperty(out, key, {
        // Never interpolate attacker-owned JSON member names into errors:
        // key names can carry credentials and are not diagnostic authority.
        value: cloneJsonData(raw[key], label + ' nested field', stack, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

function jsonData(value, label, { optional = true } = {}) {
  if (value == null && optional) return {};
  const cloned = cloneJsonData(value, label);
  const serialized = JSON.stringify(cloned);
  if (serialized.length > MAX_DATA_JSON) throw new Error(`${label} is too large`);
  return cloned;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function normalizedObjectList(value, label, normalizeItem, { max = MAX_LIST } = {}) {
  if (value == null) return [];
  const items = dataArray(value, label, max);
  return items.map((item, index) => {
    try { return normalizeItem(item); }
    catch (error) { throw new Error(`${label}[${index}]: ${error.message}`); }
  });
}

const CAPABILITY_KEYS = new Set(['schemaVersion', 'capabilityId', 'description', 'riskClass', 'attributes']);
export function normalizeCapabilityV1(input) {
  const raw = plain(input, 'CapabilityV1');
  exactKeys(raw, CAPABILITY_KEYS, 'CapabilityV1');
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'CapabilityV1'),
    capabilityId: id(raw.capabilityId, 'capabilityId'),
    description: text(raw.description, 'description', { optional: true, max: 2000 }),
    riskClass: id(raw.riskClass == null ? 'R0' : raw.riskClass, 'riskClass'),
    attributes: jsonData(raw.attributes, 'attributes'),
  });
}

const TOOL_KEYS = new Set([
  'schemaVersion', 'toolId', 'providerId', 'label', 'description',
  'capabilityIds', 'inputSchemaRef', 'outputSchemaRef', 'readOnly',
]);
export function normalizeToolDescriptorV1(input) {
  const raw = plain(input, 'ToolDescriptorV1');
  exactKeys(raw, TOOL_KEYS, 'ToolDescriptorV1');
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'ToolDescriptorV1'),
    toolId: id(raw.toolId, 'toolId'),
    providerId: id(raw.providerId, 'providerId'),
    label: text(raw.label, 'label', { max: 300 }),
    description: text(raw.description, 'description', { optional: true, max: 4000 }),
    capabilityIds: idList(raw.capabilityIds, 'capabilityIds', { optional: false }),
    inputSchemaRef: id(raw.inputSchemaRef, 'inputSchemaRef', { optional: true }),
    outputSchemaRef: id(raw.outputSchemaRef, 'outputSchemaRef', { optional: true }),
    readOnly: bool(raw.readOnly, 'readOnly', false, { present: Object.hasOwn(raw, 'readOnly') }),
  });
}

const POLICY_KEYS = new Set([
  'schemaVersion', 'decisionId', 'invocationId', 'decision',
  'reasonCode', 'reason', 'approvalId', 'decidedAt',
]);
export function normalizePolicyDecisionV1(input) {
  const raw = plain(input, 'PolicyDecisionV1');
  exactKeys(raw, POLICY_KEYS, 'PolicyDecisionV1');
  if (typeof raw.decision !== 'string') throw new Error('decision must be text');
  // Persisted permission decisions are exact canonical enum values, not case/space aliases.
  // Never turn malformed input into ALLOW during an authorization readback.
  const decision = raw.decision;
  if (!POLICY_KINDS.has(decision)) throw new Error('decision is invalid');
  const approvalId = id(raw.approvalId, 'approvalId', { optional: true });
  if (decision === PolicyDecisionKind.REQUIRE_APPROVAL && !approvalId) {
    throw new Error('REQUIRE_APPROVAL requires approvalId');
  }
  if (decision !== PolicyDecisionKind.REQUIRE_APPROVAL && approvalId) {
    throw new Error('approvalId is only valid for REQUIRE_APPROVAL');
  }
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'PolicyDecisionV1'),
    decisionId: id(raw.decisionId, 'decisionId'),
    invocationId: id(raw.invocationId, 'invocationId'),
    decision,
    reasonCode: id(raw.reasonCode, 'reasonCode'),
    reason: text(raw.reason, 'reason', { optional: true, max: 4000 }),
    approvalId,
    decidedAt: timestamp(raw.decidedAt, 'decidedAt'),
  });
}

const INVOCATION_KEYS = new Set([
  'schemaVersion', 'invocationId', 'toolId', 'providerId', 'requestedCapabilityIds',
  'policyDecisionId', 'arguments', 'createdAt', 'parentInvocationId',
]);
export function normalizeToolInvocationV1(input) {
  const raw = plain(input, 'ToolInvocationV1');
  exactKeys(raw, INVOCATION_KEYS, 'ToolInvocationV1');
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'ToolInvocationV1'),
    invocationId: id(raw.invocationId, 'invocationId'),
    toolId: id(raw.toolId, 'toolId'),
    providerId: id(raw.providerId, 'providerId'),
    requestedCapabilityIds: idList(raw.requestedCapabilityIds, 'requestedCapabilityIds', { optional: false }),
    policyDecisionId: id(raw.policyDecisionId, 'policyDecisionId'),
    arguments: jsonData(raw.arguments, 'arguments', { optional: false }),
    createdAt: timestamp(raw.createdAt, 'createdAt'),
    parentInvocationId: id(raw.parentInvocationId, 'parentInvocationId', { optional: true }),
  });
}

const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);
export function normalizeArtifactRefV1(input) {
  const raw = plain(input, 'ArtifactRefV1');
  exactKeys(raw, ARTIFACT_KEYS, 'ArtifactRefV1');
  if (raw.sha256 != null && raw.sha256 !== '' && typeof raw.sha256 !== 'string') {
    throw new Error('sha256 must be text');
  }
  const digest = raw.sha256 == null || raw.sha256 === '' ? '' : raw.sha256.trim().toLowerCase();
  if (digest && !SHA256.test(digest)) throw new Error('sha256 is invalid');
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'ArtifactRefV1'),
    artifactId: id(raw.artifactId, 'artifactId'),
    kind: id(raw.kind, 'kind'),
    uri: text(raw.uri, 'uri', { max: 4096 }),
    mediaType: text(raw.mediaType, 'mediaType', { optional: true, max: 300 }),
    sha256: digest,
    sizeBytes: integer(raw.sizeBytes, 'sizeBytes', 0, Number.MAX_SAFE_INTEGER, { optional: true, fallback: 0 }),
    createdAt: timestamp(raw.createdAt, 'createdAt'),
    producerInvocationId: id(raw.producerInvocationId, 'producerInvocationId', { optional: true }),
    sensitive: bool(raw.sensitive, 'sensitive', false, { present: Object.hasOwn(raw, 'sensitive') }),
  });
}

const OBSERVATION_KEYS = new Set([
  'schemaVersion', 'observationId', 'invocationId', 'status', 'summary',
  'data', 'artifactRefs', 'observedAt',
]);
export function normalizeObservationV1(input) {
  const raw = plain(input, 'ObservationV1');
  exactKeys(raw, OBSERVATION_KEYS, 'ObservationV1');
  if (typeof raw.status !== 'string') throw new Error('status must be text');
  // Persisted evidence status must retain exact canonical identity across restarts.
  const status = raw.status;
  if (!OBSERVATION_STATUSES.has(status)) throw new Error('status is invalid');
  const artifactRefs = normalizedObjectList(raw.artifactRefs, 'artifactRefs', normalizeArtifactRefV1);
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'ObservationV1'),
    observationId: id(raw.observationId, 'observationId'),
    invocationId: id(raw.invocationId, 'invocationId'),
    status,
    summary: text(raw.summary, 'summary', { optional: true, max: 8000 }),
    data: jsonData(raw.data, 'data'),
    artifactRefs,
    observedAt: timestamp(raw.observedAt, 'observedAt'),
  });
}

const VERIFICATION_KEYS = new Set([
  'schemaVersion', 'verificationId', 'invocationId', 'observationId',
  'status', 'reasonCode', 'summary', 'evidenceArtifactIds', 'verifiedAt',
  'verifierId', 'verificationAuthorityId', 'effectId', 'executionId', 'attempt',
]);
export function normalizeVerificationV1(input) {
  const raw = plain(input, 'VerificationV1');
  exactKeys(raw, VERIFICATION_KEYS, 'VerificationV1');
  if (typeof raw.status !== 'string') throw new Error('status must be text');
  // Persisted evidence status must retain exact canonical identity across restarts.
  const status = raw.status;
  if (!VERIFICATION_STATUSES.has(status)) throw new Error('status is invalid');
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'VerificationV1'),
    verificationId: id(raw.verificationId, 'verificationId'),
    invocationId: id(raw.invocationId, 'invocationId'),
    observationId: id(raw.observationId, 'observationId', { optional: status === VerificationStatus.NOT_APPLICABLE }),
    status,
    reasonCode: id(raw.reasonCode, 'reasonCode'),
    summary: text(raw.summary, 'summary', { optional: true, max: 8000 }),
    evidenceArtifactIds: idList(raw.evidenceArtifactIds, 'evidenceArtifactIds'),
    verifiedAt: timestamp(raw.verifiedAt, 'verifiedAt'),
    verifierId: id(raw.verifierId, 'verifierId', { optional: true }),
    verificationAuthorityId: id(raw.verificationAuthorityId, 'verificationAuthorityId', { optional: true }),
    effectId: id(raw.effectId, 'effectId', { optional: true }),
    executionId: id(raw.executionId, 'executionId', { optional: true }),
    attempt: integer(raw.attempt, 'attempt', 0, 64, { optional: true, fallback: 0 }),
  });
}

const CREDENTIAL_KEYS = new Set([
  'schemaVersion', 'credentialId', 'brokerId', 'kind', 'scope', 'expiresAt',
]);
export function normalizeCredentialRefV1(input) {
  const raw = plain(input, 'CredentialRefV1');
  exactKeys(raw, CREDENTIAL_KEYS, 'CredentialRefV1');
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'CredentialRefV1'),
    credentialId: id(raw.credentialId, 'credentialId'),
    brokerId: id(raw.brokerId, 'brokerId'),
    kind: id(raw.kind, 'kind'),
    scope: stringList(raw.scope, 'scope', { optional: false, max: 64, itemMax: 1000 }),
    expiresAt: timestamp(raw.expiresAt, 'expiresAt', { optional: true }),
  });
}

const HANDOFF_KEYS = new Set([
  'schemaVersion', 'handoffId', 'specialistId', 'goal', 'requestedCapabilityIds',
  'artifactRefs', 'credentialRefs', 'maxModelCalls', 'maxRuntimeSeconds',
  'maxCostUsdMicros', 'createdAt', 'parentInvocationId',
]);
export function normalizeSpecialistHandoffV1(input) {
  const raw = plain(input, 'SpecialistHandoffV1');
  exactKeys(raw, HANDOFF_KEYS, 'SpecialistHandoffV1');
  const artifactRefs = normalizedObjectList(raw.artifactRefs, 'artifactRefs', normalizeArtifactRefV1);
  const credentialRefs = normalizedObjectList(raw.credentialRefs, 'credentialRefs', normalizeCredentialRefV1, { max: 64 });
  const requestedCapabilityIds = idList(raw.requestedCapabilityIds, 'requestedCapabilityIds', { optional: false });
  if (!requestedCapabilityIds.length) throw new Error('requestedCapabilityIds must not be empty');
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'SpecialistHandoffV1'),
    handoffId: id(raw.handoffId, 'handoffId'),
    specialistId: id(raw.specialistId, 'specialistId'),
    goal: text(raw.goal, 'goal', { max: 50_000 }),
    requestedCapabilityIds,
    artifactRefs,
    credentialRefs,
    maxModelCalls: integer(raw.maxModelCalls, 'maxModelCalls', 0, 1_000_000, { optional: true, fallback: 0 }),
    maxRuntimeSeconds: integer(raw.maxRuntimeSeconds, 'maxRuntimeSeconds', 0, 31_536_000, { optional: true, fallback: 0 }),
    maxCostUsdMicros: integer(raw.maxCostUsdMicros, 'maxCostUsdMicros', 0, Number.MAX_SAFE_INTEGER, { optional: true, fallback: 0 }),
    createdAt: timestamp(raw.createdAt, 'createdAt'),
    parentInvocationId: id(raw.parentInvocationId, 'parentInvocationId', { optional: true }),
  });
}

const CAPABILITY_ADAPTER_OPTION_KEYS = new Set(['description', 'riskClass', 'attributes']);
const TOOL_ADAPTER_OPTION_KEYS = new Set(['toolId', 'label', 'description', 'readOnly']);

export function capabilityV1FromRegistry(capabilityId, options = {}) {
  // Provider metadata and adapter options are descriptors, not executable
  // authority. Reject accessors before unpacking user-controlled values.
  const config = plain(options, 'capability adapter options');
  exactKeys(config, CAPABILITY_ADAPTER_OPTION_KEYS, 'capability adapter options');
  const { description = '', riskClass = 'R0', attributes = {} } = config;
  return normalizeCapabilityV1({
    schemaVersion: 1,
    capabilityId,
    description,
    riskClass,
    attributes,
  });
}

export function toolDescriptorV1FromAgentProvider(provider, options = {}) {
  const config = plain(options, 'tool adapter options');
  exactKeys(config, TOOL_ADAPTER_OPTION_KEYS, 'tool adapter options');
  const { toolId, label = '', description = '', readOnly = false } = config;
  const raw = plain(provider, 'agent provider');
  return normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId,
    providerId: raw.id,
    label: label || raw.label || toolId,
    description,
    capabilityIds: raw.capabilities || [],
    inputSchemaRef: null,
    outputSchemaRef: null,
    readOnly,
  });
}


function assertSubset(requested, allowed, label) {
  const allowedSet = new Set(allowed);
  const missing = requested.filter(item => !allowedSet.has(item));
  if (missing.length) throw new Error(`${label} exceeds granted capabilities: ${missing.join(', ')}`);
}

const TOOL_AUTHORIZATION_ENVELOPE_KEYS = new Set([
  'invocation', 'policyDecision', 'toolDescriptor', 'grantedCapabilityIds',
]);
export function assertToolInvocationAuthorizedV1(input = {}) {
  // Treat the authorization wrapper as untrusted too. Destructuring directly
  // from caller input invokes getters before the policy check and can conceal
  // injected authority fields. The same descriptor-only boundary used by the
  // canonical V1 contracts must apply before any nested normalization.
  const request = plain(input, 'Tool authorization request');
  exactKeys(request, TOOL_AUTHORIZATION_ENVELOPE_KEYS, 'Tool authorization request');
  const { invocation, policyDecision, toolDescriptor, grantedCapabilityIds = [] } = request;
  const normalizedInvocation = normalizeToolInvocationV1(invocation);
  const normalizedDecision = normalizePolicyDecisionV1(policyDecision);
  const normalizedTool = normalizeToolDescriptorV1(toolDescriptor);
  const granted = idList(grantedCapabilityIds, 'grantedCapabilityIds', { optional: false });

  if (normalizedDecision.decision !== PolicyDecisionKind.ALLOW) {
    throw new Error(`Tool invocation is not authorized by policy decision: ${normalizedDecision.decision}`);
  }
  if (normalizedDecision.decisionId !== normalizedInvocation.policyDecisionId) {
    throw new Error('Tool invocation policyDecisionId does not match policy decision');
  }
  if (normalizedDecision.invocationId !== normalizedInvocation.invocationId) {
    throw new Error('Policy decision invocationId does not match tool invocation');
  }
  if (normalizedTool.toolId !== normalizedInvocation.toolId) {
    throw new Error('Tool descriptor toolId does not match invocation');
  }
  if (normalizedTool.providerId !== normalizedInvocation.providerId) {
    throw new Error('Tool descriptor providerId does not match invocation');
  }
  assertSubset(normalizedInvocation.requestedCapabilityIds, normalizedTool.capabilityIds, 'Tool invocation');
  assertSubset(normalizedInvocation.requestedCapabilityIds, granted, 'Tool invocation');
  return frozen({
    invocation: normalizedInvocation,
    policyDecision: normalizedDecision,
    toolDescriptor: normalizedTool,
    grantedCapabilityIds: granted,
  });
}

export function assertSpecialistHandoffScopedV1(handoff, grantedCapabilityIds = []) {
  const normalized = normalizeSpecialistHandoffV1(handoff);
  const granted = idList(grantedCapabilityIds, 'grantedCapabilityIds', { optional: false });
  assertSubset(normalized.requestedCapabilityIds, granted, 'Specialist handoff');
  return normalized;
}
