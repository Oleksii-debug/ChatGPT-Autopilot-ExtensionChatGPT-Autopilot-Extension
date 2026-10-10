import { normalizeSpecialistProviderConfigV1 } from './specialist-provider-config.js';

export const SPECIALIST_PROVIDER_EXECUTION_VERSION = 1;

export const SpecialistProviderExecutionStatus = Object.freeze({
  PREPARED: 'PREPARED',
  RETRYABLE_FAILURE: 'RETRYABLE_FAILURE',
  BLOCKED_FAILURE: 'BLOCKED_FAILURE',
  PROVIDER_SUCCEEDED: 'PROVIDER_SUCCEEDED',
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  RECONCILE: 'RECONCILE',
});

const STATUSES = new Set(Object.values(SpecialistProviderExecutionStatus));
const RECORD_KEYS = new Set([
  'schemaVersion', 'planId', 'nodeId', 'agentId', 'handoffId', 'providerId',
  'leaseId', 'leaseUntil', 'conversationId', 'providerConfig',
  'status', 'providerStatus', 'providerSucceeded', 'manualReviewRequired',
  'reconciliationRequired', 'safeToRetry', 'effectEvidence', 'errorCode',
  'providerUpdatedAt', 'providerObservedAt', 'preparedAt', 'updatedAt',
]);
const OPTIONAL_RECORD_KEYS = new Set(['providerUpdatedAt', 'providerObservedAt']);
const OUTCOME_KEYS = new Set([
  'providerStatus', 'providerSucceeded', 'manualReviewRequired',
  'reconciliationRequired', 'safeToRetry', 'effectEvidence', 'errorCode',
  'providerUpdatedAt', 'providerObservedAt', 'at',
]);
const OPTIONAL_OUTCOME_KEYS = new Set(['providerUpdatedAt', 'providerObservedAt']);
const PREPARE_KEYS = new Set([
  'planId', 'nodeId', 'agentId', 'handoffId', 'providerId',
  'leaseId', 'leaseUntil', 'conversationId', 'providerConfig', 'at',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TERMINAL = new Set(['finished', 'error', 'stuck']);
const MANUAL = new Set(['paused', 'waiting_for_confirmation']);

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    // The execution snapshot is provider/caller-adjacent data. Proxy traps
    // may throw secret-bearing text; never surface that exception or its cause.
    throw new Error(label + ' cannot be inspected safely');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      // An unknown key is attacker-controlled and may contain a credential.
      throw new Error(label + ' contains unknown field');
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !UUID.test(value)) {
    throw new Error(label + ' must be a canonical lowercase UUID');
  }
  return value;
}

function ts(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must use canonical UTC');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(label + ' must use canonical UTC');
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function optionalId(value, label) {
  return value === '' ? '' : id(value, label);
}

function text(value, label, max = 2000) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > max) {
    throw new Error(label + ' must be exact bounded text');
  }
  return value;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function deriveStatus({
  providerStatus,
  providerSucceeded,
  manualReviewRequired,
  reconciliationRequired,
  safeToRetry,
  effectEvidence,
  errorCode,
}) {
  if (reconciliationRequired) {
    if (safeToRetry || !errorCode) {
      throw new Error('Reconciliation outcome requires non-retryable canonical errorCode');
    }
    return SpecialistProviderExecutionStatus.RECONCILE;
  }
  if (providerStatus && TERMINAL.has(providerStatus)) {
    if (safeToRetry || errorCode || !effectEvidence) {
      throw new Error('Terminal provider outcome is inconsistent');
    }
    if (providerSucceeded !== (providerStatus === 'finished')) {
      throw new Error('providerSucceeded does not match terminal providerStatus');
    }
    if (providerSucceeded === manualReviewRequired) {
      throw new Error('terminal provider manual-review flag is inconsistent');
    }
    return providerSucceeded
      ? SpecialistProviderExecutionStatus.PROVIDER_SUCCEEDED
      : SpecialistProviderExecutionStatus.PROVIDER_FAILED;
  }
  if (manualReviewRequired) {
    if (!MANUAL.has(providerStatus) || providerSucceeded || safeToRetry || errorCode) {
      throw new Error('Manual-review provider outcome is inconsistent');
    }
    return SpecialistProviderExecutionStatus.MANUAL_REVIEW;
  }
  if (providerStatus) {
    throw new Error('Provider outcome contains unsupported nonterminal status');
  }
  if (safeToRetry) {
    if (providerSucceeded || effectEvidence || !errorCode) {
      throw new Error('Retryable provider failure is inconsistent');
    }
    return SpecialistProviderExecutionStatus.RETRYABLE_FAILURE;
  }
  if (errorCode) {
    if (providerSucceeded || effectEvidence) {
      throw new Error('Blocked provider failure is inconsistent');
    }
    return SpecialistProviderExecutionStatus.BLOCKED_FAILURE;
  }
  throw new Error('Provider execution outcome is not classifiable');
}

export function normalizeSpecialistProviderExecutionV1(input) {
  const raw = record(input, RECORD_KEYS, 'SpecialistProviderExecutionV1');
  for (const key of RECORD_KEYS) {
    if (!OPTIONAL_RECORD_KEYS.has(key) && !Object.hasOwn(raw, key)) {
      throw new Error('SpecialistProviderExecutionV1 requires ' + key);
    }
  }
  if (raw.schemaVersion !== SPECIALIST_PROVIDER_EXECUTION_VERSION) {
    throw new Error('Unsupported SpecialistProviderExecutionV1 schemaVersion');
  }
  if (!STATUSES.has(raw.status)) throw new Error('Specialist provider execution status is invalid');
  const providerConfig = normalizeSpecialistProviderConfigV1(raw.providerConfig);
  const providerId = id(raw.providerId, 'providerId');
  if (providerConfig.providerId !== providerId) {
    throw new Error('Specialist provider execution config provider identity drifted');
  }
  const preparedAt = ts(raw.preparedAt, 'preparedAt');
  const updatedAt = ts(raw.updatedAt, 'updatedAt');
  const leaseUntil = ts(raw.leaseUntil, 'leaseUntil');
  if (Date.parse(updatedAt) < Date.parse(preparedAt)) {
    throw new Error('Specialist provider execution updatedAt predates preparation');
  }
  if (Date.parse(leaseUntil) <= Date.parse(preparedAt)) {
    throw new Error('Specialist provider execution lease must outlive preparation');
  }
  const providerStatus = text(raw.providerStatus, 'providerStatus', 80);
  const providerSucceeded = bool(raw.providerSucceeded, 'providerSucceeded');
  const manualReviewRequired = bool(raw.manualReviewRequired, 'manualReviewRequired');
  const reconciliationRequired = bool(raw.reconciliationRequired, 'reconciliationRequired');
  const safeToRetry = bool(raw.safeToRetry, 'safeToRetry');
  const effectEvidence = text(raw.effectEvidence, 'effectEvidence', 1000);
  const errorCode = optionalId(raw.errorCode, 'errorCode');
  const providerUpdatedAt = raw.providerUpdatedAt == null || raw.providerUpdatedAt === ''
    ? ''
    : ts(raw.providerUpdatedAt, 'providerUpdatedAt');
  const providerObservedAt = raw.providerObservedAt == null || raw.providerObservedAt === ''
    ? ''
    : ts(raw.providerObservedAt, 'providerObservedAt');
  if (Boolean(providerUpdatedAt) !== Boolean(providerObservedAt)) {
    throw new Error('Specialist provider chronology requires both providerUpdatedAt and providerObservedAt');
  }
  if (providerUpdatedAt && Date.parse(providerUpdatedAt) > Date.parse(providerObservedAt)) {
    // A provider cannot be updated after the exact snapshot was observed.
    // Fail closed on inconsistent provider chronology rather than accepting
    // a future-dated status as proven execution evidence.
    throw new Error('Specialist provider update cannot postdate its observation');
  }
  if (providerObservedAt && Date.parse(providerObservedAt) > Date.parse(updatedAt)) {
    throw new Error('Specialist provider observation cannot postdate durable outcome');
  }
  if ((providerUpdatedAt || providerObservedAt) && !providerStatus) {
    throw new Error('Specialist provider chronology requires providerStatus evidence');
  }

  if (raw.status === SpecialistProviderExecutionStatus.PREPARED) {
    if (providerStatus || providerSucceeded || manualReviewRequired
        || reconciliationRequired || safeToRetry || effectEvidence || errorCode) {
      throw new Error('Prepared Specialist provider execution cannot contain outcome evidence');
    }
  } else {
    const derived = deriveStatus({
      providerStatus,
      providerSucceeded,
      manualReviewRequired,
      reconciliationRequired,
      safeToRetry,
      effectEvidence,
      errorCode,
    });
    if (raw.status !== derived) throw new Error('Specialist provider execution status disagrees with outcome');
  }

  return freeze({
    schemaVersion: SPECIALIST_PROVIDER_EXECUTION_VERSION,
    planId: id(raw.planId, 'planId'),
    nodeId: id(raw.nodeId, 'nodeId'),
    agentId: id(raw.agentId, 'agentId'),
    handoffId: id(raw.handoffId, 'handoffId'),
    providerId,
    leaseId: id(raw.leaseId, 'leaseId'),
    leaseUntil,
    conversationId: uuid(raw.conversationId, 'conversationId'),
    providerConfig,
    status: raw.status,
    providerStatus,
    providerSucceeded,
    manualReviewRequired,
    reconciliationRequired,
    safeToRetry,
    effectEvidence,
    errorCode,
    providerUpdatedAt,
    providerObservedAt,
    preparedAt,
    updatedAt,
  });
}

export function createSpecialistProviderExecutionV1(input = {}) {
  // Do not destructure a potentially hostile preparation object: property
  // reads could execute getters/Proxy get traps before canonical admission.
  const {
    planId, nodeId, agentId, handoffId, providerId, leaseId, leaseUntil,
    conversationId, providerConfig, at,
  } = record(input, PREPARE_KEYS, 'Specialist provider preparation request');
  return normalizeSpecialistProviderExecutionV1({
    schemaVersion: SPECIALIST_PROVIDER_EXECUTION_VERSION,
    planId,
    nodeId,
    agentId,
    handoffId,
    providerId,
    leaseId,
    leaseUntil,
    conversationId,
    providerConfig,
    status: SpecialistProviderExecutionStatus.PREPARED,
    providerStatus: '',
    providerSucceeded: false,
    manualReviewRequired: false,
    reconciliationRequired: false,
    safeToRetry: false,
    effectEvidence: '',
    errorCode: '',
    providerUpdatedAt: '',
    providerObservedAt: '',
    preparedAt: at,
    updatedAt: at,
  });
}

export function recordSpecialistProviderExecutionOutcomeV1(currentInput, outcomeInput) {
  const current = normalizeSpecialistProviderExecutionV1(currentInput);
  // A terminal provider outcome is immutable evidence for this exact lease and
  // conversation. Late or duplicate observations (including after JSON restart)
  // cannot turn a success/failure into a retryable or contradictory outcome.
  // Reconciliation or a genuinely new attempt belongs to the existing canonical
  // effect/lease authority, never an overwrite of this historical record.
  if (current.status === SpecialistProviderExecutionStatus.RECONCILE
      || current.status === SpecialistProviderExecutionStatus.PROVIDER_SUCCEEDED
      || current.status === SpecialistProviderExecutionStatus.PROVIDER_FAILED) {
    return current;
  }
  const raw = record(outcomeInput, OUTCOME_KEYS, 'Specialist provider execution outcome');
  for (const key of OUTCOME_KEYS) {
    if (!OPTIONAL_OUTCOME_KEYS.has(key) && !Object.hasOwn(raw, key)) {
      throw new Error('Specialist provider execution outcome requires ' + key);
    }
  }
  const at = ts(raw.at, 'outcome.at');
  if (Date.parse(at) < Date.parse(current.updatedAt)) {
    throw new Error('Specialist provider execution outcome predates current record');
  }
  const providerStatus = text(raw.providerStatus, 'providerStatus', 80);
  const providerSucceeded = bool(raw.providerSucceeded, 'providerSucceeded');
  const manualReviewRequired = bool(raw.manualReviewRequired, 'manualReviewRequired');
  const reconciliationRequired = bool(raw.reconciliationRequired, 'reconciliationRequired');
  const safeToRetry = bool(raw.safeToRetry, 'safeToRetry');
  const effectEvidence = text(raw.effectEvidence, 'effectEvidence', 1000);
  const errorCode = optionalId(raw.errorCode, 'errorCode');
  const providerUpdatedAt = raw.providerUpdatedAt == null ? '' : raw.providerUpdatedAt;
  const providerObservedAt = raw.providerObservedAt == null ? '' : raw.providerObservedAt;
  const status = deriveStatus({
    providerStatus,
    providerSucceeded,
    manualReviewRequired,
    reconciliationRequired,
    safeToRetry,
    effectEvidence,
    errorCode,
  });
  return normalizeSpecialistProviderExecutionV1({
    ...current,
    status,
    providerStatus,
    providerSucceeded,
    manualReviewRequired,
    reconciliationRequired,
    safeToRetry,
    effectEvidence,
    errorCode,
    providerUpdatedAt,
    providerObservedAt,
    updatedAt: at,
  });
}
