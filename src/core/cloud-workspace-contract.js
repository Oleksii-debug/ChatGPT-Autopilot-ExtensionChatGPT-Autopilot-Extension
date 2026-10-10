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

export const CloudWorkspaceObservationTrust = Object.freeze({
  UNVERIFIED_INPUT: 'UNVERIFIED_INPUT',
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
  let proto;
  let descriptors;
  try {
    // Even a data-only read can invoke hostile Proxy reflection traps.
    // Never forward an untrusted trap's exception into canonical diagnostics.
    proto = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`${label} has invalid own-data descriptors`);
  }
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be own data properties`);
    }
    if (!descriptor.enumerable) throw new Error(`${label} contains non-enumerable field`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field`);
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
  'baselineObservedAt', 'boundAt', 'observationTrust',
  'executionAuthorized', 'resumeAuthorized',
]);

export function normalizeCloudWorkspaceBindingV1(input) {
  const raw = dataRecord(input, BINDING_KEYS, 'CloudWorkspaceBindingV1');
  if (raw.schemaVersion !== CLOUD_WORKSPACE_VERSION) {
    throw new Error('Unsupported CloudWorkspaceBindingV1 schemaVersion');
  }
  if (raw.observationTrust !== CloudWorkspaceObservationTrust.UNVERIFIED_INPUT) {
    throw new Error('Cloud workspace binding cannot self-assert trusted provider observation');
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
    observationTrust: CloudWorkspaceObservationTrust.UNVERIFIED_INPUT,
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
    observationTrust: CloudWorkspaceObservationTrust.UNVERIFIED_INPUT,
    providerObservationVerified: false,
    executionAuthorized: false,
    resumeAuthorized: false,
    requiresCanonicalProviderObservation: true,
    requiresCanonicalRuntime: true,
    requiresFreshPolicy: true,
    requiresCanonicalReconciliation:
      status === CloudWorkspaceContinuityStatus.RECONCILE_REQUIRED,
    assessedAt: at,
  });
}


// Provider-neutral isolation and scrub verification hooks. These are invoked
// ONLY by a trusted canonical runtime adapter. A provider's unverified JSON
// observation must never self-grant executable authority.
const ISOLATION_OPTIONS = new Set(['at', 'verifyIsolation', 'loadCanonicalOwnership']);
const SCRUB_OPTIONS = new Set(['at', 'teardown', 'verifyScrub', 'loadCanonicalBinding', 'loadCanonicalOwnership']);
const ISOLATION_PROOF_KEYS = new Set([
  'workspaceRevision', 'environmentSha256', 'checkpointArtifactId', 'checkpointSha256',
  'workspaceId', 'providerId', 'executionLeaseId', 'executionOwnershipRevision', 'verifiedAt',
  'filesystemIsolated', 'browserIsolated', 'processIsolated',
]);
const SCRUB_PROOF_KEYS = new Set([
  'workspaceRevision', 'environmentSha256', 'checkpointArtifactId', 'checkpointSha256',
  'workspaceId', 'providerId', 'executionLeaseId', 'executionOwnershipRevision', 'verifiedAt',
  'filesystemScrubbed', 'browserScrubbed', 'processesTerminated', 'secretsPurged',
]);
const TEARDOWN_RECEIPT_KEYS = new Set([
  'schemaVersion', 'workspaceId', 'providerId', 'workspaceRevision',
  'environmentSha256', 'checkpointArtifactId', 'checkpointSha256',
  'executionLeaseId', 'executionOwnershipRevision', 'completedAt',
]);

function trustedLifecycleOptions(input, keys, required, label) {
  const raw = dataRecord(input, keys, label);
  for (const key of required) {
    if (typeof raw[key] !== 'function') throw new Error(`${label} requires trusted ${key} callback`);
  }
  return Object.freeze({
    at: exactTimestamp(raw.at, `${label}.at`),
    ...Object.fromEntries(required.map(key => [key, raw[key]])),
  });
}

// Provider callbacks can throw errors containing credentials, paths or browser
// content. Do not let those untrusted diagnostics escape into the canonical
// job timeline. An ambiguous side effect must be reconciled, not retried.
async function invokeCloudProviderEvidence(callback, target, phase) {
  try {
    return await callback(target);
  } catch {
    throw new Error(`cloud workspace provider ${phase} failed; canonical reconciliation required`);
  }
}

function verifyExactLifecycleProof(input, keys, binding, at, properties, label, minAt = binding.boundAt) {
  const raw = dataRecord(input, keys, label);
  if (raw.workspaceId !== binding.workspaceId
    || raw.providerId !== binding.providerId
    || raw.executionLeaseId !== binding.executionLeaseId
    || raw.executionOwnershipRevision !== binding.executionOwnershipRevision) {
    throw new Error(`${label} does not match exact cloud workspace/lease identity`);
  }
  // Reject stale lifecycle evidence for the same lease after a workspace
  // revision, environment or checkpoint change.
  if (raw.workspaceRevision !== binding.workspaceRevision
      || raw.environmentSha256 !== binding.environmentSha256
      || raw.checkpointArtifactId !== binding.checkpointArtifactId
      || raw.checkpointSha256 !== binding.checkpointSha256) {
    throw new Error(`${label} does not match exact workspace state/checkpoint`);
  }
  const verifiedAt = exactTimestamp(raw.verifiedAt, `${label}.verifiedAt`);
  if (Date.parse(verifiedAt) < Date.parse(minAt)
      || Date.parse(verifiedAt) > Date.parse(at)) {
    throw new Error(`${label} has stale or future verification chronology`);
  }
  for (const property of properties) {
    if (raw[property] !== true) throw new Error(`${label} did not verify ${property}`);
  }
  return verifiedAt;
}

/**
 * Validates an isolation attestation obtained by the canonical runtime from
 * its trusted provider adapter. Does not grant execution, resume or policy.
 */
export async function verifyCloudWorkspaceIsolationV1(
  observationInput, executionOwnershipInput, options,
) {
  const trusted = trustedLifecycleOptions(
    options, ISOLATION_OPTIONS, ['verifyIsolation', 'loadCanonicalOwnership'], 'Cloud workspace isolation options',
  );
  // Resolve the current ownership from the canonical store before *any*
  // provider work. Caller-provided ownership is never itself authoritative.
  const callerOwnership = normalizeExactExecutionOwnershipV1(executionOwnershipInput);
  const identity = Object.freeze({
    taskId: callerOwnership.taskId,
    planId: callerOwnership.planId,
    nodeId: callerOwnership.nodeId,
    effectId: callerOwnership.effectId,
  });
  const persistedOwner = normalizeExactExecutionOwnershipV1(
    await trusted.loadCanonicalOwnership(identity),
  );
  if (JSON.stringify(persistedOwner) !== JSON.stringify(callerOwnership)) {
    throw new Error('cloud workspace ownership drifted from canonical store');
  }
  const binding = createCloudWorkspaceBindingV1(
    observationInput, persistedOwner, { at: trusted.at },
  );
  const proof = await invokeCloudProviderEvidence(trusted.verifyIsolation, Object.freeze({
    workspaceId: binding.workspaceId,
    providerId: binding.providerId,
    workspaceRevision: binding.workspaceRevision,
    environmentSha256: binding.environmentSha256,
    checkpointArtifactId: binding.checkpointArtifactId,
    checkpointSha256: binding.checkpointSha256,
    executionLeaseId: binding.executionLeaseId,
    executionOwnershipRevision: binding.executionOwnershipRevision,
  }), 'isolation attestation');
  // Fail closed if the lease changed while asynchronous provider attestation
  // was in flight. This remains non-authorizing evidence, not a new lease.
  const ownerAfter = normalizeExactExecutionOwnershipV1(
    await trusted.loadCanonicalOwnership(identity),
  );
  if (JSON.stringify(ownerAfter) !== JSON.stringify(persistedOwner)) {
    throw new Error('cloud workspace ownership changed during isolation attestation');
  }
  const verifiedAt = verifyExactLifecycleProof(
    proof, ISOLATION_PROOF_KEYS, binding, trusted.at,
    ['filesystemIsolated', 'browserIsolated', 'processIsolated'],
    'Cloud workspace isolation proof', binding.baselineObservedAt,
  );
  return frozen({
    schemaVersion: CLOUD_WORKSPACE_VERSION,
    binding,
    isolationVerified: true,
    verifiedAt,
    executionAuthorized: false,
    resumeAuthorized: false,
    requiresCanonicalRuntime: true,
    requiresFreshPolicy: true,
  });
}

const CANONICAL_BINDING_COMMIT_OPTIONS = new Set([
  'at', 'loadCanonicalOwnership', 'verifyIsolation',
  'atomicCommitCanonicalBinding', 'loadCanonicalBinding',
]);
const CANONICAL_BINDING_RECOVERY_OPTIONS = new Set(['at', 'loadCanonicalBinding', 'loadCanonicalOwnership']);

function cloudBindingLookupKey(binding) {
  return Object.freeze({
    workspaceId: binding.workspaceId,
    providerId: binding.providerId,
    executionLeaseId: binding.executionLeaseId,
  });
}

function cloudBindingReadback(binding, persisted) {
  if (persisted == null) return null;
  const canonical = normalizeCloudWorkspaceBindingV1(persisted);
  if (JSON.stringify(canonical) !== JSON.stringify(binding)) {
    throw new Error('canonical cloud workspace binding readback mismatch');
  }
  return canonical;
}

/**
 * Only the existing canonical job runtime may supply these trusted callbacks.
 * Its atomicCommitCanonicalBinding must compare the exact owner revision/lease
 * AND persist the binding in the same transaction. This module is not a second
 * job store, scheduler, provider authority, or permission grant.
 *
 * On an ambiguous commit failure, NEVER call this function again blindly:
 * use reconcileCloudWorkspaceBindingCommitV1 with the original binding.
 */
export async function commitVerifiedCloudWorkspaceBindingV1(
  observationInput, executionOwnershipInput, options,
) {
  const trusted = dataRecord(
    options, CANONICAL_BINDING_COMMIT_OPTIONS, 'Canonical cloud binding commit options',
  );
  for (const name of [
    'loadCanonicalOwnership', 'verifyIsolation',
    'atomicCommitCanonicalBinding', 'loadCanonicalBinding',
  ]) {
    if (typeof trusted[name] !== 'function') {
      throw new Error('canonical cloud binding commit requires trusted ' + name);
    }
  }
  const at = exactTimestamp(trusted.at, 'Canonical cloud binding commit at');
  const originalOwner = normalizeExactExecutionOwnershipV1(executionOwnershipInput);
  const isolation = await verifyCloudWorkspaceIsolationV1(observationInput, originalOwner, {
    at, verifyIsolation: trusted.verifyIsolation,
    loadCanonicalOwnership: trusted.loadCanonicalOwnership,
  });
  const binding = isolation.binding;
  const transaction = Object.freeze({
    binding,
    taskId: binding.taskId,
    planId: binding.planId,
    nodeId: binding.nodeId,
    effectId: binding.effectId,
    policyEnvelopeId: binding.policyEnvelopeId,
    executionOwnerId: binding.executionOwnerId,
    executionLeaseId: binding.executionLeaseId,
    expectedOwnershipRevision: binding.executionOwnershipRevision,
    requireAtomicOwnerLeaseCompareAndSet: true,
    requireExactCheckpoint: true,
  });
  // A provider response cannot commit or authenticate its own binding.
  await trusted.atomicCommitCanonicalBinding(transaction);
  const persisted = cloudBindingReadback(
    binding, await trusted.loadCanonicalBinding(cloudBindingLookupKey(binding)),
  );
  if (!persisted) throw new Error('canonical cloud workspace binding was not durably persisted');
  const ownerAfter = normalizeExactExecutionOwnershipV1(
    await trusted.loadCanonicalOwnership(Object.freeze({
      taskId: binding.taskId, planId: binding.planId,
      nodeId: binding.nodeId, effectId: binding.effectId,
    })),
  );
  if (JSON.stringify(ownerAfter) !== JSON.stringify(originalOwner)) {
    throw new Error('canonical cloud workspace ownership changed during binding commit');
  }
  // The final ownership callback itself crosses an async boundary. Re-read
  // the canonical binding after it, rather than accepting a binding which
  // may have been removed/replaced while the owner lookup was in flight.
  const finalPersisted = cloudBindingReadback(
    binding, await trusted.loadCanonicalBinding(cloudBindingLookupKey(binding)),
  );
  if (!finalPersisted) {
    throw new Error('canonical cloud workspace binding disappeared after owner readback');
  }
  return frozen({
    schemaVersion: CLOUD_WORKSPACE_VERSION,
    status: 'CANONICAL_BINDING_DURABLE_READBACK',
    binding: finalPersisted,
    isolationVerified: true,
    durableBindingVerified: true,
    executionAuthorized: false,
    resumeAuthorized: false,
    requiresFreshPolicy: true,
    requiresCanonicalRuntime: true,
  });
}

/** READ-ONLY post-crash reconciliation; never resubmit an ambiguous commit. */
export async function reconcileCloudWorkspaceBindingCommitV1(bindingInput, options) {
  const binding = normalizeCloudWorkspaceBindingV1(bindingInput);
  const trusted = dataRecord(
    options, CANONICAL_BINDING_RECOVERY_OPTIONS, 'Canonical cloud binding recovery options',
  );
  for (const name of ['loadCanonicalBinding', 'loadCanonicalOwnership']) {
    if (typeof trusted[name] !== 'function') {
      throw new Error('canonical cloud binding recovery requires trusted ' + name);
    }
  }
  const at = exactTimestamp(trusted.at, 'Canonical cloud binding recovery at');
  const bindingKey = cloudBindingLookupKey(binding);
  const ownershipKey = Object.freeze({
    taskId: binding.taskId, planId: binding.planId,
    nodeId: binding.nodeId, effectId: binding.effectId,
  });
  // A stored binding alone is not a valid post-crash recovery result: its
  // owner may have lost the lease or changed while the first read was in flight.
  // This is read-only and must never issue another atomic commit or provider call.
  const persisted = cloudBindingReadback(
    binding, await trusted.loadCanonicalBinding(bindingKey),
  );
  let current = Boolean(persisted);
  if (current) {
    const ownerBefore = normalizeExactExecutionOwnershipV1(
      await trusted.loadCanonicalOwnership(ownershipKey),
    );
    current = ownerBefore.state === ExecutionOwnershipState.OWNED
      && ownerBefore.ownerPlane === 'CLOUD'
      && sameExecutionIdentity(binding, ownerBefore)
      && Date.parse(at) >= Date.parse(binding.boundAt)
      && Date.parse(at) >= Date.parse(ownerBefore.updatedAt)
      && Boolean(ownerBefore.leaseUntil)
      && Date.parse(at) < Date.parse(ownerBefore.leaseUntil);
    if (current) {
      const afterBinding = cloudBindingReadback(
        binding, await trusted.loadCanonicalBinding(bindingKey),
      );
      const ownerAfter = normalizeExactExecutionOwnershipV1(
        await trusted.loadCanonicalOwnership(ownershipKey),
      );
      current = Boolean(afterBinding)
        && JSON.stringify(ownerAfter) === JSON.stringify(ownerBefore);
      if (current) {
        // The last owner read may observe a stable owner while a concurrent
        // writer removes its binding. Fence that final asynchronous gap.
        const bindingAfterOwner = cloudBindingReadback(
          binding, await trusted.loadCanonicalBinding(bindingKey),
        );
        current = Boolean(bindingAfterOwner);
      }
    }
  }
  return frozen({
    schemaVersion: CLOUD_WORKSPACE_VERSION,
    status: current
      ? 'CANONICAL_BINDING_DURABLE_READBACK'
      : 'UNKNOWN_REQUIRES_CANONICAL_RECONCILIATION',
    binding: current ? persisted : null,
    durableBindingVerified: current,
    safeRetryAuthorized: false,
    executionAuthorized: false,
    resumeAuthorized: false,
    requiresCanonicalRuntime: true,
  });
}

/**
 * Executes provider teardown and verifies four independent scrub dimensions.
 * A failed/ambiguous provider result never generates a clean receipt. The
 * result remains diagnostic; a canonical owner must fence lease reuse.
 */
export async function teardownAndVerifyCloudWorkspaceV1(bindingInput, options) {
  const trusted = trustedLifecycleOptions(
    options, SCRUB_OPTIONS, ['teardown', 'verifyScrub', 'loadCanonicalBinding', 'loadCanonicalOwnership'], 'Cloud workspace scrub options',
  );
  const binding = normalizeCloudWorkspaceBindingV1(bindingInput);
  const persistedBinding = normalizeCloudWorkspaceBindingV1(
    await trusted.loadCanonicalBinding(Object.freeze({
      workspaceId: binding.workspaceId,
      providerId: binding.providerId,
      executionLeaseId: binding.executionLeaseId,
    })),
  );
  if (JSON.stringify(persistedBinding) !== JSON.stringify(binding)) {
    throw new Error('cloud workspace scrub target does not match canonical binding');
  }
  // The canonical binding may remain byte-for-byte identical while a different
  // execution owner acquires the same logical job. Read the canonical ownership
  // ledger independently before interacting with any provider resources.
  const ownerKey = Object.freeze({
    taskId: binding.taskId,
    planId: binding.planId,
    nodeId: binding.nodeId,
    effectId: binding.effectId,
  });
  const ownerBefore = normalizeExactExecutionOwnershipV1(
    await trusted.loadCanonicalOwnership(ownerKey),
  );
  if (ownerBefore.state !== ExecutionOwnershipState.OWNED
      || ownerBefore.ownerPlane !== 'CLOUD'
      || ownerBefore.ownerId !== binding.executionOwnerId
      || ownerBefore.leaseId !== binding.executionLeaseId
      || ownerBefore.revision !== binding.executionOwnershipRevision
      || ownerBefore.policyEnvelopeId !== binding.policyEnvelopeId) {
    throw new Error('cloud workspace teardown canonical ownership mismatch');
  }
  // Never send provider teardown against an expired owner lease or a
  // rolled-back assessment clock. Cleanup after expiry must be reconciled by
  // the canonical job runtime; a stale worker cannot destroy reused resources.
  if (!ownerBefore.leaseUntil
      || Date.parse(trusted.at) < Date.parse(binding.boundAt)
      || Date.parse(trusted.at) < Date.parse(ownerBefore.updatedAt)
      || Date.parse(trusted.at) >= Date.parse(ownerBefore.leaseUntil)) {
    throw new Error('cloud workspace teardown requires a live canonical owner lease');
  }
  // The owner lookup above is asynchronous. Re-read the exact canonical
  // workspace binding before invoking destructive provider teardown: a
  // reassignment or checkpoint replacement during that await must not allow
  // a stale worker to delete a potentially reused cloud workspace.
  const bindingBeforeTeardown = normalizeCloudWorkspaceBindingV1(
    await trusted.loadCanonicalBinding(Object.freeze({
      workspaceId: binding.workspaceId,
      providerId: binding.providerId,
      executionLeaseId: binding.executionLeaseId,
    })),
  );
  if (JSON.stringify(bindingBeforeTeardown) !== JSON.stringify(binding)) {
    throw new Error('cloud workspace canonical binding changed before provider teardown');
  }
  const target = Object.freeze({
    workspaceId: binding.workspaceId,
    providerId: binding.providerId,
    workspaceRevision: binding.workspaceRevision,
    environmentSha256: binding.environmentSha256,
    checkpointArtifactId: binding.checkpointArtifactId,
    checkpointSha256: binding.checkpointSha256,
    executionLeaseId: binding.executionLeaseId,
    executionOwnershipRevision: binding.executionOwnershipRevision,
  });
  // A boolean/undefined teardown response is not evidence that cleanup
  // finished. An attested completion timestamp must precede fresh scrub proof,
  // so a previously captured "clean" receipt cannot be replayed post-teardown.
  const completed = dataRecord(
    await invokeCloudProviderEvidence(trusted.teardown, target, 'teardown'), TEARDOWN_RECEIPT_KEYS,
    'Cloud workspace teardown completion',
  );
  if (completed.schemaVersion !== CLOUD_WORKSPACE_VERSION
      || completed.workspaceId !== binding.workspaceId
      || completed.providerId !== binding.providerId
      || completed.executionLeaseId !== binding.executionLeaseId
      || completed.executionOwnershipRevision !== binding.executionOwnershipRevision) {
    throw new Error('Cloud workspace teardown completion identity mismatch');
  }
  // A lease can be retained across workspace revision/checkpoint changes.
  // A teardown receipt for an older incarnation is not proof of cleanup of
  // the currently bound environment, even when the lease matches exactly.
  if (completed.workspaceRevision !== binding.workspaceRevision
      || completed.environmentSha256 !== binding.environmentSha256
      || completed.checkpointArtifactId !== binding.checkpointArtifactId
      || completed.checkpointSha256 !== binding.checkpointSha256) {
    throw new Error('Cloud workspace teardown completion workspace state mismatch');
  }
  const completedAt = exactTimestamp(completed.completedAt, 'Cloud workspace teardown completedAt');
  if (Date.parse(completedAt) < Date.parse(binding.boundAt)
      || Date.parse(completedAt) > Date.parse(trusted.at)) {
    throw new Error('Cloud workspace teardown completion chronology is invalid');
  }
  const proof = await invokeCloudProviderEvidence(trusted.verifyScrub, target, 'scrub verification');
  const verifiedAt = verifyExactLifecycleProof(
    proof, SCRUB_PROOF_KEYS, binding, trusted.at,
    ['filesystemScrubbed', 'browserScrubbed', 'processesTerminated', 'secretsPurged'],
    'Cloud workspace scrub proof', completedAt,
  );
  // Equal timestamps do not prove causal ordering. An attestation captured
  // before teardown could be replayed with the teardown completion timestamp.
  // Require strictly later, independently attested scrub evidence. This is
  // non-authorizing and never releases or reuses the canonical execution lease.
  if (Date.parse(verifiedAt) <= Date.parse(completedAt)) {
    throw new Error('Cloud workspace scrub proof must follow teardown completion');
  }
  // Teardown and attestation cross asynchronous boundaries. A proof about an
  // earlier lease/workspace must never be accepted after the canonical binding
  // has changed (including same lease with a different checkpoint revision).
  // Read back from the canonical store AFTER the provider's scrub verification.
  const finalPersistedBinding = normalizeCloudWorkspaceBindingV1(
    await trusted.loadCanonicalBinding(Object.freeze({
      workspaceId: binding.workspaceId,
      providerId: binding.providerId,
      executionLeaseId: binding.executionLeaseId,
    })),
  );
  if (JSON.stringify(finalPersistedBinding) !== JSON.stringify(binding)) {
    throw new Error('cloud workspace canonical binding changed during teardown/scrub');
  }
  const ownerAfter = normalizeExactExecutionOwnershipV1(
    await trusted.loadCanonicalOwnership(ownerKey),
  );
  if (JSON.stringify(ownerAfter) !== JSON.stringify(ownerBefore)) {
    throw new Error('cloud workspace canonical ownership changed during teardown/scrub');
  }
  // The final canonical ownership read crosses another asynchronous boundary.
  // A concurrent writer may revoke or replace the workspace binding while
  // that owner read resolves, even when the owner itself remains unchanged.
  // Never publish scrubVerified for a binding that no longer exists exactly.
  const bindingAfterOwner = normalizeCloudWorkspaceBindingV1(
    await trusted.loadCanonicalBinding(Object.freeze({
      workspaceId: binding.workspaceId,
      providerId: binding.providerId,
      executionLeaseId: binding.executionLeaseId,
    })),
  );
  if (JSON.stringify(bindingAfterOwner) !== JSON.stringify(binding)) {
    throw new Error('cloud workspace canonical binding changed after final owner readback');
  }
  return frozen({
    schemaVersion: CLOUD_WORKSPACE_VERSION,
    workspaceId: binding.workspaceId,
    providerId: binding.providerId,
    executionLeaseId: binding.executionLeaseId,
    scrubVerified: true,
    verifiedAt,
    // External contracts cannot transfer or release execution ownership.
    leaseReleaseAuthorized: false,
    reuseAuthorized: false,
    requiresCanonicalRuntime: true,
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
  if (Date.parse(assessedAt) >= Date.parse(ownership.leaseUntil)) {
    throw new Error('cloud workspace binding requires a live execution lease');
  }
  if (!sameExecutionIdentity(observation, ownership)) {
    throw new Error('cloud workspace observation does not match canonical execution ownership');
  }
  if (Date.parse(observation.observedAt) < Date.parse(ownership.updatedAt)) {
    throw new Error('cloud workspace observation predates canonical ownership revision');
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
    observationTrust: CloudWorkspaceObservationTrust.UNVERIFIED_INPUT,
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

  if (Date.parse(binding.boundAt) > Date.parse(assessedAt)) {
    return assessment(CloudWorkspaceContinuityStatus.BLOCKED, 'BINDING_FROM_FUTURE', binding, ownership, assessedAt);
  }
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
  if (Date.parse(assessedAt) >= Date.parse(ownership.leaseUntil)) {
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
      || Date.parse(observation.observedAt) < Date.parse(ownership.updatedAt)
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
