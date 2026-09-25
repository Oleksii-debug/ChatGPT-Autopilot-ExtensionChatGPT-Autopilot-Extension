import {
  ExecutionOwnershipState,
  normalizeExecutionOwnershipV1,
} from './execution-plane-ownership.js';

export const CLOUD_WORKSPACE_VERSION = 1;

export const CloudWorkspaceHealth = Object.freeze({
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const CloudWorkspaceContinuityStatus = Object.freeze({
  READY: 'READY',
  RECONCILE_REQUIRED: 'RECONCILE_REQUIRED',
  BLOCKED: 'BLOCKED',
});

const HEALTH = new Set(Object.values(CloudWorkspaceHealth));
const OWNERSHIP_STATES = new Set(Object.values(ExecutionOwnershipState));
const OWNERSHIP_PLANES = new Set(['LOCAL', 'CLOUD', 'REMOTE']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function dataRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be own data properties`);
    }
    if (!descriptor.enumerable) throw new Error(`${label} contains non-enumerable field: ${key}`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    Object.defineProperty(out, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function optionalExactId(value, label) {
  return value == null || value === '' ? '' : exactId(value, label);
}

function exactEnum(value, allowed, label, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !allowed.has(value)) {
    throw new Error(`${label} must use exact canonical enum representation`);
  }
  return value;
}

function exactTimestamp(value, label, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function strictInteger(value, label, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactText(value, label, { optional = false, max = 1000 } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} must use exact text representation`);
  }
  return value;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function optionAt(input, label) {
  const raw = dataRecord(input == null ? {} : input, new Set(['at']), label);
  return exactTimestamp(raw.at === undefined ? new Date().toISOString() : raw.at, 'at');
}

const OWNERSHIP_KEYS = new Set([
  'schemaVersion', 'taskId', 'planId', 'nodeId', 'effectId', 'policyEnvelopeId',
  'state', 'ownerPlane', 'ownerId', 'leaseId', 'leaseUntil',
  'handoffToPlane', 'handoffId', 'ambiguityReason', 'updatedAt', 'revision',
]);

function normalizeExactExecutionOwnershipV1(input) {
  const raw = dataRecord(input, OWNERSHIP_KEYS, 'ExecutionOwnershipV1');
  if (raw.schemaVersion !== 1) throw new Error('ExecutionOwnershipV1 schemaVersion is invalid');
  exactId(raw.taskId, 'ExecutionOwnershipV1.taskId');
  exactId(raw.planId, 'ExecutionOwnershipV1.planId');
  exactId(raw.nodeId, 'ExecutionOwnershipV1.nodeId');
  exactId(raw.effectId, 'ExecutionOwnershipV1.effectId');
  exactId(raw.policyEnvelopeId, 'ExecutionOwnershipV1.policyEnvelopeId');
  exactEnum(raw.state, OWNERSHIP_STATES, 'ExecutionOwnershipV1.state');
  exactEnum(raw.ownerPlane, OWNERSHIP_PLANES, 'ExecutionOwnershipV1.ownerPlane', { optional: true });
  optionalExactId(raw.ownerId, 'ExecutionOwnershipV1.ownerId');
  optionalExactId(raw.leaseId, 'ExecutionOwnershipV1.leaseId');
  exactTimestamp(raw.leaseUntil, 'ExecutionOwnershipV1.leaseUntil', { optional: true });
  exactEnum(raw.handoffToPlane, OWNERSHIP_PLANES, 'ExecutionOwnershipV1.handoffToPlane', { optional: true });
  optionalExactId(raw.handoffId, 'ExecutionOwnershipV1.handoffId');
  exactText(raw.ambiguityReason, 'ExecutionOwnershipV1.ambiguityReason', { optional: true });
  exactTimestamp(raw.updatedAt, 'ExecutionOwnershipV1.updatedAt');
  strictInteger(raw.revision, 'ExecutionOwnershipV1.revision', { min: 1 });
  return normalizeExecutionOwnershipV1(raw);
}

const OBSERVATION_KEYS = new Set([
  'schemaVersion', 'workspaceId', 'providerId', 'workspaceRevision',
  'environmentSha256', 'checkpointArtifactId', 'checkpointSha256',
  'taskId', 'planId', 'nodeId', 'effectId', 'policyEnvelopeId',
  'executionOwnerId', 'executionLeaseId', 'executionOwnershipRevision',
  'health', 'observerId', 'observedAt', 'expiresAt',
]);

export function normalizeCloudWorkspaceObservationV1(input) {
  const raw = dataRecord(input, OBSERVATION_KEYS, 'CloudWorkspaceObservationV1');
  if (raw.schemaVersion !== CLOUD_WORKSPACE_VERSION) {
    throw new Error('Unsupported CloudWorkspaceObservationV1 schemaVersion');
  }
  const observedAt = exactTimestamp(raw.observedAt, 'CloudWorkspaceObservationV1.observedAt');
  const expiresAt = exactTimestamp(raw.expiresAt, 'CloudWorkspaceObservationV1.expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new Error('CloudWorkspaceObservationV1 expiresAt must follow observedAt');
  }
  return frozen({
    schemaVersion: CLOUD_WORKSPACE_VERSION,
    workspaceId: exactId(raw.workspaceId, 'CloudWorkspaceObservationV1.workspaceId'),
    providerId: exactId(raw.providerId, 'CloudWorkspaceObservationV1.providerId'),
    workspaceRevision: exactId(raw.workspaceRevision, 'CloudWorkspaceObservationV1.workspaceRevision'),
    environmentSha256: exactSha256(raw.environmentSha256, 'CloudWorkspaceObservationV1.environmentSha256'),
    checkpointArtifactId: exactId(raw.checkpointArtifactId, 'CloudWorkspaceObservationV1.checkpointArtifactId'),
    checkpointSha256: exactSha256(raw.checkpointSha256, 'CloudWorkspaceObservationV1.checkpointSha256'),
    taskId: exactId(raw.taskId, 'CloudWorkspaceObservationV1.taskId'),
    planId: exactId(raw.planId, 'CloudWorkspaceObservationV1.planId'),
    nodeId: exactId(raw.nodeId, 'CloudWorkspaceObservationV1.nodeId'),
    effectId: exactId(raw.effectId, 'CloudWorkspaceObservationV1.effectId'),
    policyEnvelopeId: exactId(raw.policyEnvelopeId, 'CloudWorkspaceObservationV1.policyEnvelopeId'),
    executionOwnerId: exactId(raw.executionOwnerId, 'CloudWorkspaceObservationV1.executionOwnerId'),
    executionLeaseId: exactId(raw.executionLeaseId, 'CloudWorkspaceObservationV1.executionLeaseId'),
    executionOwnershipRevision: strictInteger(
      raw.executionOwnershipRevision,
      'CloudWorkspaceObservationV1.executionOwnershipRevision',
      { min: 1 },
    ),
    health: exactEnum(raw.health, HEALTH, 'CloudWorkspaceObservationV1.health'),
    observerId: exactId(raw.observerId, 'CloudWorkspaceObservationV1.observerId'),
    observedAt,
    expiresAt,
  });
}

const BINDING_KEYS = new Set([
  'schemaVersion', 'workspaceId', 'providerId', 'workspaceRevision',
  'environmentSha256', 'checkpointArtifactId', 'checkpointSha256',
  'taskId', 'planId', 'nodeId', 'effectId', 'policyEnvelopeId',
  'executionOwnerId', 'executionLeaseId', 'executionOwnershipRevision',
  'baselineObservedAt', 'boundAt', 'executionAuthorized', 'resumeAuthorized',
]);

export function normalizeCloudWorkspaceBindingV1(input) {
  const raw = dataRecord(input, BINDING_KEYS, 'CloudWorkspaceBindingV1');
  if (raw.schemaVersion !== CLOUD_WORKSPACE_VERSION) {
    throw new Error('Unsupported CloudWorkspaceBindingV1 schemaVersion');
  }
  if (raw.executionAuthorized !== false || raw.resumeAuthorized !== false) {
    throw new Error('Cloud workspace binding cannot grant execution or resume authority');
  }
  const baselineObservedAt = exactTimestamp(
    raw.baselineObservedAt,
    'CloudWorkspaceBindingV1.baselineObservedAt',
  );
  const boundAt = exactTimestamp(raw.boundAt, 'CloudWorkspaceBindingV1.boundAt');
  if (Date.parse(boundAt) < Date.parse(baselineObservedAt)) {
    throw new Error('CloudWorkspaceBindingV1 boundAt cannot predate baseline observation');
  }
  return frozen({
    schemaVersion: CLOUD_WORKSPACE_VERSION,
    workspaceId: exactId(raw.workspaceId, 'CloudWorkspaceBindingV1.workspaceId'),
    providerId: exactId(raw.providerId, 'CloudWorkspaceBindingV1.providerId'),
    workspaceRevision: exactId(raw.workspaceRevision, 'CloudWorkspaceBindingV1.workspaceRevision'),
    environmentSha256: exactSha256(raw.environmentSha256, 'CloudWorkspaceBindingV1.environmentSha256'),
    checkpointArtifactId: exactId(raw.checkpointArtifactId, 'CloudWorkspaceBindingV1.checkpointArtifactId'),
    checkpointSha256: exactSha256(raw.checkpointSha256, 'CloudWorkspaceBindingV1.checkpointSha256'),
    taskId: exactId(raw.taskId, 'CloudWorkspaceBindingV1.taskId'),
    planId: exactId(raw.planId, 'CloudWorkspaceBindingV1.planId'),
    nodeId: exactId(raw.nodeId, 'CloudWorkspaceBindingV1.nodeId'),
    effectId: exactId(raw.effectId, 'CloudWorkspaceBindingV1.effectId'),
    policyEnvelopeId: exactId(raw.policyEnvelopeId, 'CloudWorkspaceBindingV1.policyEnvelopeId'),
    executionOwnerId: exactId(raw.executionOwnerId, 'CloudWorkspaceBindingV1.executionOwnerId'),
    executionLeaseId: exactId(raw.executionLeaseId, 'CloudWorkspaceBindingV1.executionLeaseId'),
    executionOwnershipRevision: strictInteger(
      raw.executionOwnershipRevision,
      'CloudWorkspaceBindingV1.executionOwnershipRevision',
      { min: 1 },
    ),
    baselineObservedAt,
    boundAt,
    executionAuthorized: false,
    resumeAuthorized: false,
  });
}

function sameExecutionIdentity(observation, ownership) {
  return observation.taskId === ownership.taskId
    && observation.planId === ownership.planId
    && observation.nodeId === ownership.nodeId
    && observation.effectId === ownership.effectId
    && observation.policyEnvelopeId === ownership.policyEnvelopeId
    && observation.executionOwnerId === ownership.ownerId
    && observation.executionLeaseId === ownership.leaseId
    && observation.executionOwnershipRevision === ownership.revision;
}

function sameBindingIdentity(binding, observation) {
  return binding.workspaceId === observation.workspaceId
    && binding.providerId === observation.providerId
    && binding.taskId === observation.taskId
    && binding.planId === observation.planId
    && binding.nodeId === observation.nodeId
    && binding.effectId === observation.effectId
    && binding.policyEnvelopeId === observation.policyEnvelopeId
    && binding.executionOwnerId === observation.executionOwnerId
    && binding.executionLeaseId === observation.executionLeaseId
    && binding.executionOwnershipRevision === observation.executionOwnershipRevision;
}

function sameWorkspaceState(binding, observation) {
  return binding.workspaceRevision === observation.workspaceRevision
    && binding.environmentSha256 === observation.environmentSha256
    && binding.checkpointArtifactId === observation.checkpointArtifactId
    && binding.checkpointSha256 === observation.checkpointSha256;
}

function assessment(status, reasonCode, binding, ownership, at) {
  const ready = status === CloudWorkspaceContinuityStatus.READY;
  return frozen({
    schemaVersion: CLOUD_WORKSPACE_VERSION,
    status,
    reasonCode,
    workspaceId: binding.workspaceId,
    providerId: binding.providerId,
    executionOwnershipRevision: ownership.revision,
    workspaceReady: ready,
    executionAuthorized: false,
    resumeAuthorized: false,
    requiresCanonicalRuntime: true,
    requiresFreshPolicy: true,
    requiresCanonicalReconciliation:
      status === CloudWorkspaceContinuityStatus.RECONCILE_REQUIRED,
    assessedAt: at,
  });
}

export function createCloudWorkspaceBindingV1(
  observationInput,
  executionOwnershipInput,
  options = {},
) {
  const observation = normalizeCloudWorkspaceObservationV1(observationInput);
  const ownership = normalizeExactExecutionOwnershipV1(executionOwnershipInput);
  const assessedAt = optionAt(options, 'Cloud workspace binding options');

  if (ownership.state !== ExecutionOwnershipState.OWNED || ownership.ownerPlane !== 'CLOUD') {
    throw new Error('cloud workspace binding requires a currently OWNED CLOUD execution lease');
  }
  if (Date.parse(assessedAt) > Date.parse(ownership.leaseUntil)) {
    throw new Error('cloud workspace binding requires a live execution lease');
  }
  if (!sameExecutionIdentity(observation, ownership)) {
    throw new Error('cloud workspace observation does not match canonical execution ownership');
  }
  if (observation.health !== CloudWorkspaceHealth.READY) {
    throw new Error('cloud workspace binding requires READY workspace health');
  }
  if (Date.parse(observation.observedAt) > Date.parse(assessedAt)
      || Date.parse(assessedAt) >= Date.parse(observation.expiresAt)) {
    throw new Error('cloud workspace binding requires a fresh observation');
  }

  return normalizeCloudWorkspaceBindingV1({
    schemaVersion: CLOUD_WORKSPACE_VERSION,
    workspaceId: observation.workspaceId,
    providerId: observation.providerId,
    workspaceRevision: observation.workspaceRevision,
    environmentSha256: observation.environmentSha256,
    checkpointArtifactId: observation.checkpointArtifactId,
    checkpointSha256: observation.checkpointSha256,
    taskId: observation.taskId,
    planId: observation.planId,
    nodeId: observation.nodeId,
    effectId: observation.effectId,
    policyEnvelopeId: observation.policyEnvelopeId,
    executionOwnerId: observation.executionOwnerId,
    executionLeaseId: observation.executionLeaseId,
    executionOwnershipRevision: observation.executionOwnershipRevision,
    baselineObservedAt: observation.observedAt,
    boundAt: assessedAt,
    executionAuthorized: false,
    resumeAuthorized: false,
  });
}

export function assessCloudWorkspaceContinuityV1(
  bindingInput,
  currentObservationInput,
  executionOwnershipInput,
  options = {},
) {
  const binding = normalizeCloudWorkspaceBindingV1(bindingInput);
  const observation = normalizeCloudWorkspaceObservationV1(currentObservationInput);
  const ownership = normalizeExactExecutionOwnershipV1(executionOwnershipInput);
  const assessedAt = optionAt(options, 'Cloud workspace continuity options');

  if (ownership.state === ExecutionOwnershipState.RECONCILE
      || ownership.state === ExecutionOwnershipState.MANUAL_REVIEW) {
    return assessment(
      CloudWorkspaceContinuityStatus.RECONCILE_REQUIRED,
      'EXECUTION_RECONCILIATION_REQUIRED',
      binding,
      ownership,
      assessedAt,
    );
  }
  if (ownership.state !== ExecutionOwnershipState.OWNED) {
    return assessment(
      CloudWorkspaceContinuityStatus.BLOCKED,
      'EXECUTION_NOT_OWNED',
      binding,
      ownership,
      assessedAt,
    );
  }
  if (ownership.ownerPlane !== 'CLOUD') {
    return assessment(
      CloudWorkspaceContinuityStatus.BLOCKED,
      'EXECUTION_NOT_CLOUD',
      binding,
      ownership,
      assessedAt,
    );
  }
  if (Date.parse(assessedAt) > Date.parse(ownership.leaseUntil)) {
    return assessment(
      CloudWorkspaceContinuityStatus.RECONCILE_REQUIRED,
      'EXECUTION_LEASE_EXPIRED',
      binding,
      ownership,
      assessedAt,
    );
  }
  if (!sameExecutionIdentity(observation, ownership)
      || binding.executionOwnerId !== ownership.ownerId
      || binding.executionLeaseId !== ownership.leaseId
      || binding.executionOwnershipRevision !== ownership.revision) {
    return assessment(
      CloudWorkspaceContinuityStatus.BLOCKED,
      'EXECUTION_BINDING_MISMATCH',
      binding,
      ownership,
      assessedAt,
    );
  }
  if (!sameBindingIdentity(binding, observation)) {
    return assessment(
      CloudWorkspaceContinuityStatus.BLOCKED,
      'WORKSPACE_BINDING_MISMATCH',
      binding,
      ownership,
      assessedAt,
    );
  }
  if (Date.parse(observation.observedAt) < Date.parse(binding.baselineObservedAt)
      || Date.parse(observation.observedAt) > Date.parse(assessedAt)) {
    return assessment(
      CloudWorkspaceContinuityStatus.BLOCKED,
      'OBSERVATION_TIME_INVALID',
      binding,
      ownership,
      assessedAt,
    );
  }
  if (Date.parse(assessedAt) >= Date.parse(observation.expiresAt)) {
    return assessment(
      CloudWorkspaceContinuityStatus.BLOCKED,
      'OBSERVATION_EXPIRED',
      binding,
      ownership,
      assessedAt,
    );
  }
  if (observation.health === CloudWorkspaceHealth.UNAVAILABLE) {
    return assessment(
      CloudWorkspaceContinuityStatus.BLOCKED,
      'WORKSPACE_UNAVAILABLE',
      binding,
      ownership,
      assessedAt,
    );
  }
  if (observation.health === CloudWorkspaceHealth.DEGRADED) {
    return assessment(
      CloudWorkspaceContinuityStatus.BLOCKED,
      'WORKSPACE_DEGRADED',
      binding,
      ownership,
      assessedAt,
    );
  }
  if (!sameWorkspaceState(binding, observation)) {
    return assessment(
      CloudWorkspaceContinuityStatus.RECONCILE_REQUIRED,
      'WORKSPACE_STATE_DRIFT',
      binding,
      ownership,
      assessedAt,
    );
  }
  return assessment(
    CloudWorkspaceContinuityStatus.READY,
    'READY',
    binding,
    ownership,
    assessedAt,
  );
}
