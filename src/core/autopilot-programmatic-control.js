import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const AUTOPILOT_PROGRAMMATIC_CONTROL_VERSION = 1;

export const AutopilotProgrammaticOperation = Object.freeze({
  PROJECT_OPEN: 'PROJECT_OPEN',
  OUTCOME_SUBMIT: 'OUTCOME_SUBMIT',
  AGENT_START: 'AGENT_START',
  AGENT_PAUSE: 'AGENT_PAUSE',
  AGENT_RESUME: 'AGENT_RESUME',
  AGENT_STOP: 'AGENT_STOP',
  STATUS_GET: 'STATUS_GET',
  PLAN_GET: 'PLAN_GET',
  EVIDENCE_GET: 'EVIDENCE_GET',
  ASK_DECIDE: 'ASK_DECIDE',
  RECIPE_TRIGGER: 'RECIPE_TRIGGER',
  SKILL_TRIGGER: 'SKILL_TRIGGER',
  PROVIDER_CAPABILITIES_GET: 'PROVIDER_CAPABILITIES_GET',
  EVENTS_SUBSCRIBE: 'EVENTS_SUBSCRIBE',
  ARTIFACT_GET: 'ARTIFACT_GET',
});

export const AutopilotProgrammaticDispatchStatus = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
});

const OPERATIONS = new Set(Object.values(AutopilotProgrammaticOperation));
const DISPATCH_STATUSES = new Set(Object.values(AutopilotProgrammaticDispatchStatus));
const MUTATING_OPERATIONS = new Set([
  AutopilotProgrammaticOperation.PROJECT_OPEN,
  AutopilotProgrammaticOperation.OUTCOME_SUBMIT,
  AutopilotProgrammaticOperation.AGENT_START,
  AutopilotProgrammaticOperation.AGENT_PAUSE,
  AutopilotProgrammaticOperation.AGENT_RESUME,
  AutopilotProgrammaticOperation.AGENT_STOP,
  AutopilotProgrammaticOperation.ASK_DECIDE,
  AutopilotProgrammaticOperation.RECIPE_TRIGGER,
  AutopilotProgrammaticOperation.SKILL_TRIGGER,
  AutopilotProgrammaticOperation.EVENTS_SUBSCRIBE,
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'requestId',
  'principalId',
  'projectId',
  'operation',
  'targetId',
  'payloadArtifactRef',
  'requestedAt',
  'assessedAt',
]);
const DEPENDENCY_KEYS = new Set(['resolveTrustedScope', 'dispatchCanonicalControl']);
const SCOPE_KEYS = new Set([
  'schemaVersion',
  'scopeRevisionId',
  'requestId',
  'principalId',
  'projectId',
  'operation',
  'targetId',
  'payloadSha256',
  'allowed',
  'verifiedAt',
  'validThrough',
]);
const RECEIPT_KEYS = new Set([
  'schemaVersion',
  'requestId',
  'projectId',
  'operation',
  'dispatchId',
  'status',
  'resultArtifactRef',
  'observedAt',
]);
const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactId',
  'kind',
  'uri',
  'mediaType',
  'sha256',
  'sizeBytes',
  'createdAt',
  'producerInvocationId',
  'sensitive',
]);

const OPERATION_RULES = Object.freeze({
  PROJECT_OPEN: Object.freeze({ target: 'REQUIRED_PROJECT', payload: 'NONE' }),
  OUTCOME_SUBMIT: Object.freeze({ target: 'REQUIRED', payload: 'REQUIRED' }),
  AGENT_START: Object.freeze({ target: 'REQUIRED', payload: 'OPTIONAL' }),
  AGENT_PAUSE: Object.freeze({ target: 'REQUIRED', payload: 'NONE' }),
  AGENT_RESUME: Object.freeze({ target: 'REQUIRED', payload: 'NONE' }),
  AGENT_STOP: Object.freeze({ target: 'REQUIRED', payload: 'NONE' }),
  STATUS_GET: Object.freeze({ target: 'REQUIRED', payload: 'NONE' }),
  PLAN_GET: Object.freeze({ target: 'REQUIRED', payload: 'NONE' }),
  EVIDENCE_GET: Object.freeze({ target: 'REQUIRED', payload: 'NONE' }),
  ASK_DECIDE: Object.freeze({ target: 'REQUIRED', payload: 'REQUIRED' }),
  RECIPE_TRIGGER: Object.freeze({ target: 'REQUIRED', payload: 'OPTIONAL' }),
  SKILL_TRIGGER: Object.freeze({ target: 'REQUIRED', payload: 'OPTIONAL' }),
  PROVIDER_CAPABILITIES_GET: Object.freeze({ target: 'OPTIONAL', payload: 'NONE' }),
  EVENTS_SUBSCRIBE: Object.freeze({ target: 'REQUIRED', payload: 'REQUIRED' }),
  ARTIFACT_GET: Object.freeze({ target: 'REQUIRED', payload: 'NONE' }),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotRecord(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(label + ' must be a plain or null-prototype object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain or null-prototype object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' fields must be enumerable own data properties');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function requireKeys(raw, keys, label) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(label + '.' + key + ' is required');
    }
  }
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must be a canonical identity');
  }
  return value;
}

function optionalId(value, label) {
  return value == null ? null : exactId(value, label);
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(label + ' must be a canonical ISO-8601 UTC timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO-8601 UTC timestamp');
  }
  return value;
}

function exactOperation(value) {
  if (typeof value !== 'string' || !OPERATIONS.has(value)) {
    throw new Error('operation is invalid');
  }
  return value;
}

function normalizePayloadArtifact(input, notAfterAt, chronologyLabel = 'requestedAt') {
  if (input == null) return null;
  const raw = snapshotRecord(input, ARTIFACT_KEYS, 'payloadArtifactRef');
  requireKeys(raw, ARTIFACT_KEYS, 'payloadArtifactRef');
  if (typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
    throw new Error('payloadArtifactRef.sha256 must be an exact lowercase sha256 digest');
  }
  const artifact = normalizeArtifactRefV1(raw);
  for (const key of ARTIFACT_KEYS) {
    if (!Object.is(raw[key], artifact[key])) {
      throw new Error('payloadArtifactRef contains a non-canonical representation');
    }
  }
  if (Date.parse(artifact.createdAt) > Date.parse(notAfterAt)) {
    throw new Error('payloadArtifactRef cannot be created after ' + chronologyLabel);
  }
  return artifact;
}

function assertOperationShape(request) {
  const rule = OPERATION_RULES[request.operation];
  if (rule.target === 'REQUIRED' && request.targetId == null) {
    throw new Error(request.operation + ' requires targetId');
  }
  if (rule.target === 'REQUIRED_PROJECT' && request.targetId !== request.projectId) {
    throw new Error('PROJECT_OPEN targetId must equal projectId');
  }
  if (rule.payload === 'REQUIRED' && request.payloadArtifactRef == null) {
    throw new Error(request.operation + ' requires payloadArtifactRef');
  }
  if (rule.payload === 'NONE' && request.payloadArtifactRef != null) {
    throw new Error(request.operation + ' does not accept payloadArtifactRef');
  }
}

export function normalizeAutopilotProgrammaticRequestV1(input) {
  const raw = snapshotRecord(input, REQUEST_KEYS, 'AutopilotProgrammaticRequestV1');
  requireKeys(raw, REQUEST_KEYS, 'AutopilotProgrammaticRequestV1');
  if (raw.schemaVersion !== AUTOPILOT_PROGRAMMATIC_CONTROL_VERSION) {
    throw new Error('AutopilotProgrammaticRequestV1 schemaVersion must be numeric 1');
  }
  const requestedAt = canonicalTimestamp(raw.requestedAt, 'requestedAt');
  const assessedAt = canonicalTimestamp(raw.assessedAt, 'assessedAt');
  if (Date.parse(requestedAt) > Date.parse(assessedAt)) {
    throw new Error('requestedAt cannot be after assessedAt');
  }
  const normalized = {
    schemaVersion: AUTOPILOT_PROGRAMMATIC_CONTROL_VERSION,
    requestId: exactId(raw.requestId, 'requestId'),
    principalId: exactId(raw.principalId, 'principalId'),
    projectId: exactId(raw.projectId, 'projectId'),
    operation: exactOperation(raw.operation),
    targetId: optionalId(raw.targetId, 'targetId'),
    payloadArtifactRef: normalizePayloadArtifact(raw.payloadArtifactRef, requestedAt),
    requestedAt,
    assessedAt,
  };
  assertOperationShape(normalized);
  return deepFreeze(normalized);
}

function normalizeScopeProof(input, request) {
  const raw = snapshotRecord(input, SCOPE_KEYS, 'AutopilotProgrammaticScopeProofV1');
  requireKeys(raw, SCOPE_KEYS, 'AutopilotProgrammaticScopeProofV1');
  if (raw.schemaVersion !== AUTOPILOT_PROGRAMMATIC_CONTROL_VERSION) {
    throw new Error('AutopilotProgrammaticScopeProofV1 schemaVersion must be numeric 1');
  }
  const expectedPayloadSha = request.payloadArtifactRef?.sha256 ?? null;
  if (exactId(raw.requestId, 'scope.requestId') !== request.requestId
      || exactId(raw.principalId, 'scope.principalId') !== request.principalId
      || exactId(raw.projectId, 'scope.projectId') !== request.projectId
      || exactOperation(raw.operation) !== request.operation
      || optionalId(raw.targetId, 'scope.targetId') !== request.targetId
      || raw.payloadSha256 !== expectedPayloadSha) {
    throw new Error('Programmatic scope proof does not match the exact request identity');
  }
  if (raw.payloadSha256 !== null
      && (typeof raw.payloadSha256 !== 'string' || !SHA256.test(raw.payloadSha256))) {
    throw new Error('scope.payloadSha256 is invalid');
  }
  if (typeof raw.allowed !== 'boolean') throw new Error('scope.allowed must be boolean');
  const verifiedAt = canonicalTimestamp(raw.verifiedAt, 'scope.verifiedAt');
  const validThrough = canonicalTimestamp(raw.validThrough, 'scope.validThrough');
  const requestedMs = Date.parse(request.requestedAt);
  const assessedMs = Date.parse(request.assessedAt);
  if (Date.parse(verifiedAt) < requestedMs || Date.parse(verifiedAt) > assessedMs) {
    throw new Error('scope.verifiedAt must be within the request assessment interval');
  }
  if (Date.parse(validThrough) < assessedMs) {
    throw new Error('Programmatic scope proof expired before assessedAt');
  }
  return deepFreeze({
    schemaVersion: AUTOPILOT_PROGRAMMATIC_CONTROL_VERSION,
    scopeRevisionId: exactId(raw.scopeRevisionId, 'scope.scopeRevisionId'),
    requestId: request.requestId,
    principalId: request.principalId,
    projectId: request.projectId,
    operation: request.operation,
    targetId: request.targetId,
    payloadSha256: expectedPayloadSha,
    allowed: raw.allowed,
    verifiedAt,
    validThrough,
  });
}

function normalizeReceipt(input, request) {
  const raw = snapshotRecord(input, RECEIPT_KEYS, 'AutopilotProgrammaticDispatchReceiptV1');
  requireKeys(raw, RECEIPT_KEYS, 'AutopilotProgrammaticDispatchReceiptV1');
  if (raw.schemaVersion !== AUTOPILOT_PROGRAMMATIC_CONTROL_VERSION) {
    throw new Error('AutopilotProgrammaticDispatchReceiptV1 schemaVersion must be numeric 1');
  }
  if (exactId(raw.requestId, 'receipt.requestId') !== request.requestId
      || exactId(raw.projectId, 'receipt.projectId') !== request.projectId
      || exactOperation(raw.operation) !== request.operation) {
    throw new Error('Programmatic dispatch receipt does not match the exact request identity');
  }
  if (typeof raw.status !== 'string' || !DISPATCH_STATUSES.has(raw.status)) {
    throw new Error('receipt.status is invalid');
  }
  const observedAt = canonicalTimestamp(raw.observedAt, 'receipt.observedAt');
  if (Date.parse(observedAt) < Date.parse(request.assessedAt)) {
    throw new Error('receipt.observedAt cannot predate assessedAt');
  }
  const resultArtifactRef = raw.resultArtifactRef == null
    ? null
    : normalizePayloadArtifact(raw.resultArtifactRef, observedAt, 'receipt.observedAt');
  return deepFreeze({
    schemaVersion: AUTOPILOT_PROGRAMMATIC_CONTROL_VERSION,
    requestId: request.requestId,
    projectId: request.projectId,
    operation: request.operation,
    dispatchId: exactId(raw.dispatchId, 'receipt.dispatchId'),
    status: raw.status,
    resultArtifactRef,
    observedAt,
  });
}

export function isAutopilotProgrammaticOperationReadOnly(operation) {
  const normalized = exactOperation(operation);
  return !MUTATING_OPERATIONS.has(normalized);
}

export async function executeAutopilotProgrammaticControlV1(input, dependencies = {}) {
  const request = normalizeAutopilotProgrammaticRequestV1(input);
  const dependencyRecord = snapshotRecord(
    dependencies,
    DEPENDENCY_KEYS,
    'AutopilotProgrammaticControlDependenciesV1',
  );
  requireKeys(
    dependencyRecord,
    DEPENDENCY_KEYS,
    'AutopilotProgrammaticControlDependenciesV1',
  );
  const resolveTrustedScope = dependencyRecord.resolveTrustedScope;
  const dispatchCanonicalControl = dependencyRecord.dispatchCanonicalControl;
  if (typeof resolveTrustedScope !== 'function') {
    throw new Error('Canonical programmatic scope resolver is required');
  }
  if (typeof dispatchCanonicalControl !== 'function') {
    throw new Error('Canonical control-plane dispatcher is required');
  }

  const rawScope = await resolveTrustedScope(request);
  const scopeProof = normalizeScopeProof(rawScope, request);
  if (!scopeProof.allowed) {
    throw new Error('Programmatic control scope denied');
  }

  const readOnly = isAutopilotProgrammaticOperationReadOnly(request.operation);
  const dispatchEnvelope = deepFreeze({
    schemaVersion: AUTOPILOT_PROGRAMMATIC_CONTROL_VERSION,
    request,
    scopeProof,
    readOnly,
    downstreamAuthorityRequired: !readOnly,
    adapterGrantsAuthority: false,
  });
  const rawReceipt = await dispatchCanonicalControl(dispatchEnvelope);
  const receipt = normalizeReceipt(rawReceipt, request);

  return deepFreeze({
    schemaVersion: AUTOPILOT_PROGRAMMATIC_CONTROL_VERSION,
    request,
    scopeProof,
    receipt,
    readOnly,
    downstreamAuthorityRequired: !readOnly,
    adapterGrantsAuthority: false,
    executionAuthorized: false,
    policyDecisionAuthorized: false,
    storeMutationAuthority: false,
    schedulerAuthority: false,
    exactEffectAuthority: false,
  });
}
