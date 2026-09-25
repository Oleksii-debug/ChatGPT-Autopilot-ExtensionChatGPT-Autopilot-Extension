import { createSha256FingerprintV1 } from './fingerprint.js';
import { normalizeToolInvocationV1 } from './universal-agent-contracts.js';

export const SHADOW_EXECUTION_VERSION = 1;

export const ShadowExecutionMode = Object.freeze({
  SHADOW: 'SHADOW',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_TEXT = 8_000;
const MAX_ITEMS = 128;
const SHADOW_KEYS = new Set([
  'schemaVersion', 'shadowRunId', 'projectId', 'subjectRevisionId',
  'invocation', 'predictedEffect', 'verificationPlan', 'recordedAt',
]);
const INVOCATION_KEYS = new Set([
  'schemaVersion', 'invocationId', 'toolId', 'providerId', 'requestedCapabilityIds',
  'policyDecisionId', 'arguments', 'createdAt', 'parentInvocationId',
]);
const EFFECT_KEYS = new Set([
  'effectClass', 'summary', 'targetResourceIds', 'expectedChangeSummary',
  'reversible', 'compensatingActionRequired',
]);
const VERIFICATION_KEYS = new Set([
  'verifierId', 'successCondition', 'requiredEvidenceKinds', 'independent',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains a symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
  }
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must be an exact id`);
  }
  return value;
}

function text(value, label, { max = MAX_TEXT } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`);
  return normalized;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  const canonical = new Date(ms).toISOString();
  if (canonical !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function denseArray(value, label, { min = 0, max = MAX_ITEMS } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < min
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must contain ${min}..${max} items`);
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
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} entries must be enumerable own data properties`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function idList(value, label, { min = 0, max = MAX_ITEMS } = {}) {
  const raw = denseArray(value, label, { min, max });
  const normalized = raw.map((item, index) => id(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return normalized.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeProposedInvocation(input) {
  const raw = record(input, 'Shadow proposed invocation');
  exactKeys(raw, INVOCATION_KEYS, 'Shadow proposed invocation');
  const normalized = normalizeToolInvocationV1(raw);

  if (raw.schemaVersion !== normalized.schemaVersion
      || raw.invocationId !== normalized.invocationId
      || raw.toolId !== normalized.toolId
      || raw.providerId !== normalized.providerId
      || raw.policyDecisionId !== normalized.policyDecisionId
      || raw.createdAt !== normalized.createdAt) {
    throw new Error('Shadow proposed invocation must use exact canonical identity and timestamp representation');
  }
  const rawParent = raw.parentInvocationId == null ? null : raw.parentInvocationId;
  if (rawParent !== normalized.parentInvocationId) {
    throw new Error('Shadow proposed invocation parentInvocationId must use exact canonical representation');
  }
  const requestedCapabilityIds = idList(
    raw.requestedCapabilityIds,
    'Shadow proposed invocation requestedCapabilityIds',
    { max: MAX_ITEMS },
  );
  if (JSON.stringify(requestedCapabilityIds)
      !== JSON.stringify([...normalized.requestedCapabilityIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))) {
    throw new Error('Shadow proposed invocation capability IDs must use exact canonical representation');
  }
  return normalized;
}

function normalizePredictedEffect(input) {
  const raw = record(input, 'ShadowPredictedEffectV1');
  exactKeys(raw, EFFECT_KEYS, 'ShadowPredictedEffectV1');
  return deepFreeze({
    effectClass: id(raw.effectClass, 'effectClass'),
    summary: text(raw.summary, 'effect summary'),
    targetResourceIds: idList(raw.targetResourceIds, 'targetResourceIds', { min: 1 }),
    expectedChangeSummary: text(raw.expectedChangeSummary, 'expectedChangeSummary'),
    reversible: bool(raw.reversible, 'reversible'),
    compensatingActionRequired: bool(raw.compensatingActionRequired, 'compensatingActionRequired'),
  });
}

function normalizeVerificationPlan(input) {
  const raw = record(input, 'ShadowVerificationPlanV1');
  exactKeys(raw, VERIFICATION_KEYS, 'ShadowVerificationPlanV1');
  if (raw.independent !== true) {
    throw new Error('Shadow verification plan must require an independent verifier');
  }
  return deepFreeze({
    verifierId: id(raw.verifierId, 'verifierId'),
    successCondition: text(raw.successCondition, 'successCondition'),
    requiredEvidenceKinds: idList(raw.requiredEvidenceKinds, 'requiredEvidenceKinds', { min: 1 }),
    independent: true,
  });
}

function publicInvocationIdentity(invocation) {
  return deepFreeze({
    invocationId: invocation.invocationId,
    toolId: invocation.toolId,
    providerId: invocation.providerId,
    requestedCapabilityIds: [...invocation.requestedCapabilityIds],
    policyDecisionId: invocation.policyDecisionId,
    createdAt: invocation.createdAt,
    parentInvocationId: invocation.parentInvocationId,
  });
}

export async function createShadowExecutionV1(input, { cryptoApi = globalThis.crypto } = {}) {
  const raw = record(input, 'ShadowExecutionV1');
  exactKeys(raw, SHADOW_KEYS, 'ShadowExecutionV1');
  if (raw.schemaVersion !== SHADOW_EXECUTION_VERSION) {
    throw new Error('Unsupported ShadowExecutionV1 schemaVersion');
  }

  const invocation = normalizeProposedInvocation(raw.invocation);
  const recordedAt = timestamp(raw.recordedAt, 'recordedAt');
  if (Date.parse(recordedAt) < Date.parse(invocation.createdAt)) {
    throw new Error('recordedAt cannot predate proposed invocation createdAt');
  }

  const invocationFingerprint = await createSha256FingerprintV1(
    JSON.stringify(['shadow-tool-invocation-v1', invocation]),
    { cryptoApi },
  );

  return deepFreeze({
    schemaVersion: SHADOW_EXECUTION_VERSION,
    mode: ShadowExecutionMode.SHADOW,
    shadowRunId: id(raw.shadowRunId, 'shadowRunId'),
    projectId: id(raw.projectId, 'projectId'),
    subjectRevisionId: id(raw.subjectRevisionId, 'subjectRevisionId'),
    proposedInvocation: publicInvocationIdentity(invocation),
    invocationFingerprint,
    predictedEffect: normalizePredictedEffect(raw.predictedEffect),
    verificationPlan: normalizeVerificationPlan(raw.verificationPlan),
    recordedAt,
    policyDecisionAuthority: 'UNVERIFIED_INPUT',
    policyDecisionVerified: false,
    executionAuthorized: false,
    providerCallAuthorized: false,
    externalEffectAuthorized: false,
    replayAuthorized: false,
    authorityUpgradeAuthorized: false,
    requiresFreshWorldState: true,
    requiresCanonicalPolicyAtExecution: true,
    requiresIndependentVerificationAtExecution: true,
  });
}
