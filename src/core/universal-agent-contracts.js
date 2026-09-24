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
  // Authority/evidence contracts are untrusted input. Inspect descriptors
  // without evaluating accessors so a getter cannot change a value between
  // validation and normalization (for example DENY -> ALLOW).
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be own data properties`);
    }
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
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
  const out = value.trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
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
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

function integer(value, label, min, max, { optional = false, fallback = 0 } = {}) {
  if (value == null && optional) return fallback;
  if (typeof value !== 'number'
      || !Number.isInteger(value)
      || !Number.isFinite(value)
      || value < min
      || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function bool(value, label, fallback = false) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function idList(value, label, { optional = true, max = MAX_LIST } = {}) {
  if (value == null && optional) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`);
  const out = value.map((item, index) => id(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function stringList(value, label, { optional = true, max = MAX_LIST, itemMax = 500 } = {}) {
  if (value == null && optional) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`);
  return value.map((item, index) => text(item, `${label}[${index}]`, { max: itemMax }));
}

function jsonData(value, label, { optional = true } = {}) {
  if (value == null && optional) return {};
  plain(value, label);
  const cloned = structuredClone(value);
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
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`);
  return value.map((item, index) => {
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
    readOnly: bool(raw.readOnly, 'readOnly', false),
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
  const decision = raw.decision.trim().toUpperCase();
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
    sensitive: bool(raw.sensitive, 'sensitive', false),
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
  const status = raw.status.trim().toUpperCase();
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
  const status = raw.status.trim().toUpperCase();
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

export function capabilityV1FromRegistry(capabilityId, {
  description = '',
  riskClass = 'R0',
  attributes = {},
} = {}) {
  return normalizeCapabilityV1({
    schemaVersion: 1,
    capabilityId,
    description,
    riskClass,
    attributes,
  });
}

export function toolDescriptorV1FromAgentProvider(provider, {
  toolId,
  label = '',
  description = '',
  readOnly = false,
} = {}) {
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

export function assertToolInvocationAuthorizedV1({
  invocation,
  policyDecision,
  toolDescriptor,
  grantedCapabilityIds = [],
} = {}) {
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
