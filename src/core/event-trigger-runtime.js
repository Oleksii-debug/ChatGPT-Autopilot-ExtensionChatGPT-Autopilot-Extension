import {
  EventTriggerAdmissionStatus,
  createEventTriggerAdmissionV1,
} from './event-trigger-contract.js';

export const EVENT_TRIGGER_RUNTIME_VERSION = 1;

export const EventTriggerSchedulerReceiptStatus = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  DUPLICATE: 'DUPLICATE',
  BLOCKED: 'BLOCKED',
});

export const EventTriggerRuntimeStatus = Object.freeze({
  DISABLED: 'DISABLED',
  ACCEPTED: 'ACCEPTED',
  DUPLICATE: 'DUPLICATE',
  BLOCKED: 'BLOCKED',
});

const RECEIPT_STATUSES = new Set(Object.values(EventTriggerSchedulerReceiptStatus));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_REASON = 500;

const DEPENDENCY_KEYS = new Set([
  'resolveTriggerDefinition',
  'admitCanonicalOccurrence',
]);

const RECEIPT_KEYS = new Set([
  'schemaVersion',
  'status',
  'occurrenceId',
  'materialFingerprint',
  'canonicalTaskId',
  'schedulerRevision',
  'reason',
]);

function strictRecord(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(value); }
  catch { throw new Error(`${label} must be a plain object`); }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactId(value, label, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactFingerprint(value, label) {
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) {
    throw new Error(`${label} must be a canonical SHA-256 fingerprint`);
  }
  return value;
}

function positiveInteger(value, label, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function boundedReason(value, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error('scheduler receipt reason is required');
    return '';
  }
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > MAX_REASON
      || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw new Error('scheduler receipt reason is invalid');
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeDependencies(value) {
  const raw = strictRecord(
    value,
    'Event trigger runtime dependencies',
    DEPENDENCY_KEYS,
  );
  if (typeof raw.resolveTriggerDefinition !== 'function') {
    throw new Error('Event trigger runtime requires resolveTriggerDefinition');
  }
  if (typeof raw.admitCanonicalOccurrence !== 'function') {
    throw new Error('Event trigger runtime requires admitCanonicalOccurrence');
  }
  return raw;
}

function canonicalSchedulerRequest(admission) {
  return deepFreeze({
    schemaVersion: EVENT_TRIGGER_RUNTIME_VERSION,
    triggerId: exactId(admission.triggerId, 'triggerId'),
    triggerRevision: positiveInteger(admission.triggerRevision, 'triggerRevision'),
    triggerDefinitionFingerprint: exactFingerprint(
      admission.triggerDefinitionFingerprint,
      'triggerDefinitionFingerprint',
    ),
    agentId: exactId(admission.agentId, 'agentId'),
    jobId: exactId(admission.jobId, 'jobId'),
    kind: exactId(admission.kind, 'kind'),
    providerId: exactId(admission.providerId, 'providerId'),
    sourceBindingId: exactId(admission.sourceBindingId, 'sourceBindingId'),
    observationId: exactId(admission.observationId, 'observationId'),
    sourceEventId: exactId(admission.sourceEventId, 'sourceEventId'),
    occurrenceId: exactId(admission.occurrenceId, 'occurrenceId'),
    sourceIdentityFingerprint: exactFingerprint(
      admission.sourceIdentityFingerprint,
      'sourceIdentityFingerprint',
    ),
    materialFingerprint: exactFingerprint(
      admission.materialFingerprint,
      'materialFingerprint',
    ),
    requiredCapabilityIds: admission.requiredCapabilityIds,
    payloadArtifactId: exactId(admission.payloadArtifactId, 'payloadArtifactId'),
    payloadSha256: (() => {
      if (typeof admission.payloadSha256 !== 'string' || !SHA256.test(admission.payloadSha256)) {
        throw new Error('payloadSha256 must be canonical lowercase SHA-256');
      }
      return admission.payloadSha256;
    })(),
    observedAt: admission.observedAt,
    admittedAt: admission.admittedAt,
    policyDecisionGranted: false,
    executionAuthorized: false,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalExactEffect: true,
    requiresCanonicalVerification: true,
  });
}

function normalizeSchedulerReceipt(value, request) {
  const raw = strictRecord(
    value,
    'Event trigger scheduler receipt',
    RECEIPT_KEYS,
  );
  if (raw.schemaVersion !== EVENT_TRIGGER_RUNTIME_VERSION) {
    throw new Error('Unsupported event trigger scheduler receipt schemaVersion');
  }
  if (typeof raw.status !== 'string' || !RECEIPT_STATUSES.has(raw.status)) {
    throw new Error('Event trigger scheduler receipt status is invalid');
  }
  if (raw.occurrenceId !== request.occurrenceId) {
    throw new Error('Event trigger scheduler receipt occurrenceId mismatch');
  }
  if (raw.materialFingerprint !== request.materialFingerprint) {
    throw new Error('Event trigger scheduler receipt materialFingerprint mismatch');
  }

  if (raw.status === EventTriggerSchedulerReceiptStatus.BLOCKED) {
    if (raw.canonicalTaskId != null && raw.canonicalTaskId !== '') {
      throw new Error('Blocked event trigger scheduler receipt must not claim canonicalTaskId');
    }
    if (raw.schedulerRevision != null) {
      throw new Error('Blocked event trigger scheduler receipt must not claim schedulerRevision');
    }
    return deepFreeze({
      schemaVersion: EVENT_TRIGGER_RUNTIME_VERSION,
      status: raw.status,
      occurrenceId: request.occurrenceId,
      materialFingerprint: request.materialFingerprint,
      canonicalTaskId: null,
      schedulerRevision: null,
      reason: boundedReason(raw.reason, { required: true }),
    });
  }

  return deepFreeze({
    schemaVersion: EVENT_TRIGGER_RUNTIME_VERSION,
    status: raw.status,
    occurrenceId: request.occurrenceId,
    materialFingerprint: request.materialFingerprint,
    canonicalTaskId: exactId(raw.canonicalTaskId, 'scheduler receipt canonicalTaskId'),
    schedulerRevision: positiveInteger(raw.schedulerRevision, 'scheduler receipt schedulerRevision'),
    reason: boundedReason(raw.reason),
  });
}

/**
 * Thin event-provider -> canonical scheduler runtime bridge.
 *
 * This module intentionally owns no scheduler, queue, dedup ledger, policy,
 * exact-effect state, provider transport, or recovery authority. The stable
 * occurrence/material identities are produced by EventTriggerAdmissionV1 and
 * handed to the injected canonical scheduler admission boundary.
 */
export async function admitEventTriggerObservationV1(value, dependencies) {
  const deps = normalizeDependencies(dependencies);
  const admission = await createEventTriggerAdmissionV1(value, {
    resolveTriggerDefinition: deps.resolveTriggerDefinition,
  });

  if (admission.status === EventTriggerAdmissionStatus.DISABLED) {
    return deepFreeze({
      schemaVersion: EVENT_TRIGGER_RUNTIME_VERSION,
      status: EventTriggerRuntimeStatus.DISABLED,
      triggerId: admission.triggerId,
      triggerRevision: admission.triggerRevision,
      agentId: admission.agentId,
      jobId: admission.jobId,
      observationId: admission.observationId,
      sourceEventId: admission.sourceEventId,
      triggerDefinitionFingerprint: admission.triggerDefinitionFingerprint,
      canonicalTaskId: null,
      schedulerRevision: null,
      schedulerCalled: false,
      canonicalWorkPresent: false,
      policyDecisionGranted: false,
      executionAuthorized: false,
      requiresCanonicalPolicyDecision: true,
      requiresCanonicalExactEffect: true,
      requiresCanonicalVerification: true,
      admittedAt: admission.admittedAt,
    });
  }

  if (admission.status !== EventTriggerAdmissionStatus.READY_FOR_SCHEDULER) {
    throw new Error('Event trigger admission status is not supported by runtime');
  }

  const schedulerRequest = canonicalSchedulerRequest(admission);
  const receipt = normalizeSchedulerReceipt(
    await deps.admitCanonicalOccurrence(schedulerRequest),
    schedulerRequest,
  );

  return deepFreeze({
    schemaVersion: EVENT_TRIGGER_RUNTIME_VERSION,
    status: receipt.status,
    triggerId: schedulerRequest.triggerId,
    triggerRevision: schedulerRequest.triggerRevision,
    agentId: schedulerRequest.agentId,
    jobId: schedulerRequest.jobId,
    observationId: schedulerRequest.observationId,
    sourceEventId: schedulerRequest.sourceEventId,
    occurrenceId: schedulerRequest.occurrenceId,
    triggerDefinitionFingerprint: schedulerRequest.triggerDefinitionFingerprint,
    sourceIdentityFingerprint: schedulerRequest.sourceIdentityFingerprint,
    materialFingerprint: schedulerRequest.materialFingerprint,
    payloadArtifactId: schedulerRequest.payloadArtifactId,
    payloadSha256: schedulerRequest.payloadSha256,
    canonicalTaskId: receipt.canonicalTaskId,
    schedulerRevision: receipt.schedulerRevision,
    reason: receipt.reason,
    schedulerCalled: true,
    canonicalWorkPresent: receipt.status === EventTriggerSchedulerReceiptStatus.ACCEPTED
      || receipt.status === EventTriggerSchedulerReceiptStatus.DUPLICATE,
    policyDecisionGranted: false,
    executionAuthorized: false,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalExactEffect: true,
    requiresCanonicalVerification: true,
    admittedAt: schedulerRequest.admittedAt,
  });
}
