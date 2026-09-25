import {
  normalizeObservationV1,
  normalizeVerificationV1,
  VerificationStatus,
} from './universal-agent-contracts.js';

export const HUMAN_TAKEOVER_VERSION = 1;

export const HumanTakeoverPhase = Object.freeze({
  REQUESTED: 'REQUESTED',
  OWNER_IN_CONTROL: 'OWNER_IN_CONTROL',
  HANDBACK_PENDING: 'HANDBACK_PENDING',
  REOBSERVED: 'REOBSERVED',
  EVIDENCE_READY: 'EVIDENCE_READY',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

const PHASES = new Set(Object.values(HumanTakeoverPhase));
const OBSERVATION_STATUSES = new Set(['OK', 'PARTIAL', 'ERROR', 'UNAVAILABLE']);
const VERIFICATION_STATUSES = new Set(Object.values(VerificationStatus));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_REASON = 4_000;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 8_192;
const MAX_ARRAY_ITEMS = 512;
const MAX_RECORD_FIELDS = 256;

const CREATE_KEYS = new Set([
  'takeoverId',
  'jobId',
  'planId',
  'nodeId',
  'resourceId',
  'effectId',
  'executionId',
  'attempt',
  'agentId',
  'humanPrincipalId',
  'verificationAuthorityId',
  'reason',
  'preTakeoverObservation',
  'at',
]);

const START_KEYS = new Set(['quiescenceEvidenceId', 'at']);
const HANDBACK_KEYS = new Set(['reobservationInvocationId', 'at']);
const OBSERVATION_REQUEST_KEYS = new Set(['observation']);
const VERIFICATION_REQUEST_KEYS = new Set(['verification']);

const TAKEOVER_KEYS = new Set([
  'schemaVersion',
  'takeoverId',
  'jobId',
  'planId',
  'nodeId',
  'resourceId',
  'effectId',
  'executionId',
  'attempt',
  'agentId',
  'humanPrincipalId',
  'verificationAuthorityId',
  'reason',
  'phase',
  'quiescenceEvidenceId',
  'reobservationInvocationId',
  'preTakeoverObservation',
  'postTakeoverObservation',
  'handbackVerification',
  'requestedAt',
  'controlStartedAt',
  'handbackRequestedAt',
  'reobservedAt',
  'reconciledAt',
  'revision',
  'advisoryOnly',
  'resumeAuthorized',
  'requiresCanonicalResumeGate',
  'verificationProvenance',
  'reconciliationAuthorized',
]);

function strictRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function strictRecordKeys(value, allowed, label) {
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_RECORD_FIELDS) throw new Error(`${label} has too many fields`);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable data property`);
    }
  }
}

function ownValue(value, key, label, { optional = false } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (optional) return undefined;
    throw new Error(`${label} must provide ${key} as an own field`);
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label} field ${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

function exactId(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must be an exact id`);
  }
  return value;
}

function exactText(value, label, max = MAX_REASON) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!out || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}

function exactTimestamp(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  const canonical = new Date(ms).toISOString();
  if (canonical !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function exactInteger(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}`);
  }
  return value;
}

function exactAttempt(value, label) {
  return exactInteger(value, label, 0, 64);
}

function assertAtOrAfter(later, earlier, label) {
  if (Date.parse(later) < Date.parse(earlier)) {
    throw new Error(`${label} violates causal timestamp ordering`);
  }
}

function snapshotDenseDataArray(value, label, max = MAX_ARRAY_ITEMS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-index array property`);
    }
  }
  const snapshot = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) {
      throw new Error(`${label} must be a dense data array`);
    }
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
    snapshot[index] = descriptor.value;
  }
  return snapshot;
}

function cloneDataOnly(value, label, budget = { nodes: 0 }, depth = 0) {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) throw new Error(`${label} exceeds data node bound`);
  if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds data depth bound`);

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} number must be finite`);
    return value;
  }

  if (Array.isArray(value)) {
    const snapshot = snapshotDenseDataArray(value, label);
    return snapshot.map((item, index) => cloneDataOnly(item, `${label}[${index}]`, budget, depth + 1));
  }

  const raw = strictRecord(value, label);
  const keys = Reflect.ownKeys(raw);
  if (keys.length > MAX_RECORD_FIELDS) throw new Error(`${label} has too many fields`);
  const out = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error(`${label} contains a symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable data property`);
    }
    out[key] = cloneDataOnly(descriptor.value, `${label}.${key}`, budget, depth + 1);
  }
  return out;
}

function exactSchemaVersion(raw, label) {
  if (ownValue(raw, 'schemaVersion', label) !== 1) {
    throw new Error(`${label} schemaVersion must be exact numeric 1`);
  }
}

function exactStringField(raw, key, label, { optional = false } = {}) {
  const value = ownValue(raw, key, label, { optional });
  if (value == null && optional) return;
  if (typeof value !== 'string') throw new Error(`${label}.${key} must be text`);
}

function exactBooleanField(raw, key, label, { optional = false } = {}) {
  const value = ownValue(raw, key, label, { optional });
  if (value == null && optional) return;
  if (typeof value !== 'boolean') throw new Error(`${label}.${key} must be boolean`);
}

function exactIntegerField(raw, key, label, { optional = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = ownValue(raw, key, label, { optional });
  if (value == null && optional) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}.${key} must be an exact integer`);
  }
}

function exactStatus(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${label} must be a canonical status`);
  }
}

function exactStringArray(value, label, max = MAX_ARRAY_ITEMS) {
  const snapshot = snapshotDenseDataArray(value, label, max);
  for (let index = 0; index < snapshot.length; index += 1) {
    exactId(snapshot[index], `${label}[${index}]`);
  }
}

function assertExactArtifactRefTypes(raw, label) {
  strictRecord(raw, label);
  exactSchemaVersion(raw, label);
  exactId(ownValue(raw, 'artifactId', label), `${label}.artifactId`);
  exactId(ownValue(raw, 'kind', label), `${label}.kind`);
  exactStringField(raw, 'uri', label);
  exactTimestamp(ownValue(raw, 'createdAt', label), `${label}.createdAt`);
  exactStringField(raw, 'mediaType', label, { optional: true });
  const digest = ownValue(raw, 'sha256', label, { optional: true });
  if (digest != null && digest !== '' && (typeof digest !== 'string' || !SHA256.test(digest))) {
    throw new Error(`${label}.sha256 must be canonical lowercase SHA-256`);
  }
  const producer = ownValue(raw, 'producerInvocationId', label, { optional: true });
  if (producer != null && producer !== '') exactId(producer, `${label}.producerInvocationId`);
  exactIntegerField(raw, 'sizeBytes', label, { optional: true, min: 0 });
  exactBooleanField(raw, 'sensitive', label, { optional: true });
}

function assertExactObservationTypes(raw, label) {
  strictRecord(raw, label);
  exactSchemaVersion(raw, label);
  exactId(ownValue(raw, 'observationId', label), `${label}.observationId`);
  exactId(ownValue(raw, 'invocationId', label), `${label}.invocationId`);
  exactStatus(ownValue(raw, 'status', label), OBSERVATION_STATUSES, `${label}.status`);
  exactTimestamp(ownValue(raw, 'observedAt', label), `${label}.observedAt`);
  exactStringField(raw, 'summary', label, { optional: true });
  const artifactRefs = ownValue(raw, 'artifactRefs', label, { optional: true });
  if (artifactRefs != null) {
    const snapshot = snapshotDenseDataArray(artifactRefs, `${label}.artifactRefs`);
    for (let index = 0; index < snapshot.length; index += 1) {
      assertExactArtifactRefTypes(snapshot[index], `${label}.artifactRefs[${index}]`);
    }
  }
}

function assertExactVerificationTypes(raw, label) {
  strictRecord(raw, label);
  exactSchemaVersion(raw, label);
  exactId(ownValue(raw, 'verificationId', label), `${label}.verificationId`);
  exactId(ownValue(raw, 'invocationId', label), `${label}.invocationId`);
  exactStatus(ownValue(raw, 'status', label), VERIFICATION_STATUSES, `${label}.status`);
  exactId(ownValue(raw, 'reasonCode', label), `${label}.reasonCode`);
  exactTimestamp(ownValue(raw, 'verifiedAt', label), `${label}.verifiedAt`);
  exactStringField(raw, 'summary', label, { optional: true });
  for (const key of [
    'observationId', 'verifierId', 'verificationAuthorityId', 'effectId', 'executionId',
  ]) {
    const value = ownValue(raw, key, label, { optional: true });
    if (value != null && value !== '') exactId(value, `${label}.${key}`);
  }
  const evidenceArtifactIds = ownValue(raw, 'evidenceArtifactIds', label, { optional: true });
  if (evidenceArtifactIds != null) exactStringArray(evidenceArtifactIds, `${label}.evidenceArtifactIds`, 128);
  exactIntegerField(raw, 'attempt', label, { optional: true, min: 0, max: 64 });
}

function canonicalObservation(value, label) {
  const cloned = cloneDataOnly(value, label);
  assertExactObservationTypes(cloned, label);
  return normalizeObservationV1(cloned);
}

function canonicalVerification(value, label) {
  const cloned = cloneDataOnly(value, label);
  assertExactVerificationTypes(cloned, label);
  return normalizeVerificationV1(cloned);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeOptionalObservation(raw, key, label) {
  const value = ownValue(raw, key, 'HumanTakeoverV1', { optional: true });
  if (value == null) return null;
  return canonicalObservation(value, label);
}

function normalizeOptionalVerification(raw, key, label) {
  const value = ownValue(raw, key, 'HumanTakeoverV1', { optional: true });
  if (value == null) return null;
  return canonicalVerification(value, label);
}

function requirePhaseFields(state) {
  const hasControl = Boolean(state.controlStartedAt && state.quiescenceEvidenceId);
  const hasHandback = Boolean(state.handbackRequestedAt && state.reobservationInvocationId);
  const hasObservation = Boolean(state.postTakeoverObservation && state.reobservedAt);
  const hasVerification = Boolean(state.handbackVerification && state.reconciledAt);

  if (state.preTakeoverObservation && Date.parse(state.preTakeoverObservation.observedAt) > Date.parse(state.requestedAt)) {
    throw new Error('pre-takeover observation cannot postdate takeover request');
  }

  if (hasControl) assertAtOrAfter(state.controlStartedAt, state.requestedAt, 'controlStartedAt');
  if (hasHandback) {
    if (!hasControl) throw new Error('handback request requires recorded owner control');
    assertAtOrAfter(state.handbackRequestedAt, state.controlStartedAt, 'handbackRequestedAt');
  }
  if (hasObservation) {
    if (!hasHandback) throw new Error('post-takeover observation requires handback request');
    if (state.postTakeoverObservation.invocationId !== state.reobservationInvocationId) {
      throw new Error('post-takeover observation invocation does not match handback reobservation invocation');
    }
    if (state.reobservedAt !== state.postTakeoverObservation.observedAt) {
      throw new Error('reobservedAt must equal the canonical observation timestamp');
    }
    assertAtOrAfter(state.reobservedAt, state.handbackRequestedAt, 'reobservedAt');
  }
  if (hasVerification) {
    if (!hasObservation) throw new Error('handback verification requires fresh post-takeover observation');
    const verification = state.handbackVerification;
    if (verification.invocationId !== state.postTakeoverObservation.invocationId) {
      throw new Error('handback verification invocation does not match post-takeover observation');
    }
    if (verification.observationId !== state.postTakeoverObservation.observationId) {
      throw new Error('handback verification observation does not match post-takeover observation');
    }
    if (!verification.verifierId || verification.verifierId === state.agentId || verification.verifierId === state.humanPrincipalId) {
      throw new Error('handback verifier must be an independent identified verifier');
    }
    if (verification.verificationAuthorityId !== state.verificationAuthorityId) {
      throw new Error('handback verification authority mismatch');
    }
    if (state.effectId && verification.effectId && verification.effectId !== state.effectId) {
      throw new Error('handback verification effectId mismatch');
    }
    if (state.reconciledAt !== verification.verifiedAt) {
      throw new Error('reconciledAt must equal the canonical verification timestamp');
    }
    assertAtOrAfter(state.reconciledAt, state.reobservedAt, 'reconciledAt');
  }

  const expected = {
    [HumanTakeoverPhase.REQUESTED]: !hasControl && !hasHandback && !hasObservation && !hasVerification,
    [HumanTakeoverPhase.OWNER_IN_CONTROL]: hasControl && !hasHandback && !hasObservation && !hasVerification,
    [HumanTakeoverPhase.HANDBACK_PENDING]: hasControl && hasHandback && !hasObservation && !hasVerification,
    [HumanTakeoverPhase.REOBSERVED]: hasControl && hasHandback && hasObservation && !hasVerification,
    [HumanTakeoverPhase.EVIDENCE_READY]: hasControl && hasHandback && hasObservation && hasVerification
      && state.handbackVerification.status === VerificationStatus.VERIFIED
      && state.handbackVerification.evidenceArtifactIds.length > 0,
    [HumanTakeoverPhase.MANUAL_REVIEW]: hasControl && hasHandback && hasObservation && hasVerification
      && (state.handbackVerification.status !== VerificationStatus.VERIFIED
        || state.handbackVerification.evidenceArtifactIds.length === 0),
  };

  if (!expected[state.phase]) {
    throw new Error(`HumanTakeoverV1 fields are inconsistent with phase ${state.phase}`);
  }
}

export function normalizeHumanTakeoverV1(input) {
  const raw = strictRecord(input, 'HumanTakeoverV1');
  strictRecordKeys(raw, TAKEOVER_KEYS, 'HumanTakeoverV1');

  if (ownValue(raw, 'schemaVersion', 'HumanTakeoverV1') !== HUMAN_TAKEOVER_VERSION) {
    throw new Error('Unsupported HumanTakeoverV1 schemaVersion');
  }

  const phaseRaw = ownValue(raw, 'phase', 'HumanTakeoverV1');
  if (typeof phaseRaw !== 'string' || !PHASES.has(phaseRaw)) {
    throw new Error('HumanTakeoverV1 phase is invalid');
  }

  const state = {
    schemaVersion: HUMAN_TAKEOVER_VERSION,
    takeoverId: exactId(ownValue(raw, 'takeoverId', 'HumanTakeoverV1'), 'takeoverId'),
    jobId: exactId(ownValue(raw, 'jobId', 'HumanTakeoverV1'), 'jobId'),
    planId: exactId(ownValue(raw, 'planId', 'HumanTakeoverV1'), 'planId'),
    nodeId: exactId(ownValue(raw, 'nodeId', 'HumanTakeoverV1'), 'nodeId'),
    resourceId: exactId(ownValue(raw, 'resourceId', 'HumanTakeoverV1'), 'resourceId'),
    effectId: exactId(ownValue(raw, 'effectId', 'HumanTakeoverV1', { optional: true }), 'effectId', { optional: true }),
    executionId: exactId(
      ownValue(raw, 'executionId', 'HumanTakeoverV1', { optional: true }),
      'executionId',
      { optional: true },
    ),
    attempt: exactAttempt(ownValue(raw, 'attempt', 'HumanTakeoverV1')),
    agentId: exactId(ownValue(raw, 'agentId', 'HumanTakeoverV1'), 'agentId'),
    humanPrincipalId: exactId(ownValue(raw, 'humanPrincipalId', 'HumanTakeoverV1'), 'humanPrincipalId'),
    verificationAuthorityId: exactId(ownValue(raw, 'verificationAuthorityId', 'HumanTakeoverV1'), 'verificationAuthorityId'),
    reason: exactText(ownValue(raw, 'reason', 'HumanTakeoverV1'), 'reason'),
    phase: phaseRaw,
    quiescenceEvidenceId: exactId(
      ownValue(raw, 'quiescenceEvidenceId', 'HumanTakeoverV1', { optional: true }),
      'quiescenceEvidenceId',
      { optional: true },
    ),
    reobservationInvocationId: exactId(
      ownValue(raw, 'reobservationInvocationId', 'HumanTakeoverV1', { optional: true }),
      'reobservationInvocationId',
      { optional: true },
    ),
    preTakeoverObservation: normalizeOptionalObservation(raw, 'preTakeoverObservation', 'preTakeoverObservation'),
    postTakeoverObservation: normalizeOptionalObservation(raw, 'postTakeoverObservation', 'postTakeoverObservation'),
    handbackVerification: normalizeOptionalVerification(raw, 'handbackVerification', 'handbackVerification'),
    requestedAt: exactTimestamp(ownValue(raw, 'requestedAt', 'HumanTakeoverV1'), 'requestedAt'),
    controlStartedAt: exactTimestamp(
      ownValue(raw, 'controlStartedAt', 'HumanTakeoverV1', { optional: true }),
      'controlStartedAt',
      { optional: true },
    ),
    handbackRequestedAt: exactTimestamp(
      ownValue(raw, 'handbackRequestedAt', 'HumanTakeoverV1', { optional: true }),
      'handbackRequestedAt',
      { optional: true },
    ),
    reobservedAt: exactTimestamp(
      ownValue(raw, 'reobservedAt', 'HumanTakeoverV1', { optional: true }),
      'reobservedAt',
      { optional: true },
    ),
    reconciledAt: exactTimestamp(
      ownValue(raw, 'reconciledAt', 'HumanTakeoverV1', { optional: true }),
      'reconciledAt',
      { optional: true },
    ),
    revision: exactInteger(ownValue(raw, 'revision', 'HumanTakeoverV1'), 'revision'),
    advisoryOnly: true,
    resumeAuthorized: false,
    requiresCanonicalResumeGate: true,
    verificationProvenance: 'UNVERIFIED_INPUT',
    reconciliationAuthorized: false,
  };

  if (Boolean(state.effectId) !== Boolean(state.executionId)) {
    throw new Error('HumanTakeoverV1 effectId and executionId must be present together');
  }
  if (state.effectId && state.attempt < 1) {
    throw new Error('HumanTakeoverV1 active effect requires attempt >= 1');
  }
  if (!state.effectId && state.attempt !== 0) {
    throw new Error('HumanTakeoverV1 without active effect requires attempt = 0');
  }

  if (Object.hasOwn(raw, 'advisoryOnly') && ownValue(raw, 'advisoryOnly', 'HumanTakeoverV1') !== true) {
    throw new Error('HumanTakeoverV1 advisoryOnly must remain true');
  }
  if (Object.hasOwn(raw, 'resumeAuthorized') && ownValue(raw, 'resumeAuthorized', 'HumanTakeoverV1') !== false) {
    throw new Error('HumanTakeoverV1 cannot authorize resume');
  }
  if (Object.hasOwn(raw, 'requiresCanonicalResumeGate')
      && ownValue(raw, 'requiresCanonicalResumeGate', 'HumanTakeoverV1') !== true) {
    throw new Error('HumanTakeoverV1 must require the canonical resume gate');
  }
  if (Object.hasOwn(raw, 'verificationProvenance')
      && ownValue(raw, 'verificationProvenance', 'HumanTakeoverV1') !== 'UNVERIFIED_INPUT') {
    throw new Error('HumanTakeoverV1 verification provenance must remain unverified');
  }
  if (Object.hasOwn(raw, 'reconciliationAuthorized')
      && ownValue(raw, 'reconciliationAuthorized', 'HumanTakeoverV1') !== false) {
    throw new Error('HumanTakeoverV1 cannot authorize reconciliation');
  }

  requirePhaseFields(state);
  return freezeDeep(state);
}

export function createHumanTakeoverV1(input = {}) {
  const raw = strictRecord(input, 'HumanTakeoverCreateRequestV1');
  strictRecordKeys(raw, CREATE_KEYS, 'HumanTakeoverCreateRequestV1');
  return normalizeHumanTakeoverV1({
    schemaVersion: HUMAN_TAKEOVER_VERSION,
    takeoverId: ownValue(raw, 'takeoverId', 'HumanTakeoverCreateRequestV1'),
    jobId: ownValue(raw, 'jobId', 'HumanTakeoverCreateRequestV1'),
    planId: ownValue(raw, 'planId', 'HumanTakeoverCreateRequestV1'),
    nodeId: ownValue(raw, 'nodeId', 'HumanTakeoverCreateRequestV1'),
    resourceId: ownValue(raw, 'resourceId', 'HumanTakeoverCreateRequestV1'),
    effectId: ownValue(raw, 'effectId', 'HumanTakeoverCreateRequestV1', { optional: true }) ?? '',
    executionId: ownValue(raw, 'executionId', 'HumanTakeoverCreateRequestV1', { optional: true }) ?? '',
    attempt: ownValue(raw, 'attempt', 'HumanTakeoverCreateRequestV1', { optional: true }) ?? 0,
    agentId: ownValue(raw, 'agentId', 'HumanTakeoverCreateRequestV1'),
    humanPrincipalId: ownValue(raw, 'humanPrincipalId', 'HumanTakeoverCreateRequestV1'),
    verificationAuthorityId: ownValue(raw, 'verificationAuthorityId', 'HumanTakeoverCreateRequestV1'),
    reason: ownValue(raw, 'reason', 'HumanTakeoverCreateRequestV1'),
    phase: HumanTakeoverPhase.REQUESTED,
    quiescenceEvidenceId: '',
    reobservationInvocationId: '',
    preTakeoverObservation: ownValue(
      raw,
      'preTakeoverObservation',
      'HumanTakeoverCreateRequestV1',
      { optional: true },
    ) ?? null,
    postTakeoverObservation: null,
    handbackVerification: null,
    requestedAt: ownValue(raw, 'at', 'HumanTakeoverCreateRequestV1'),
    controlStartedAt: '',
    handbackRequestedAt: '',
    reobservedAt: '',
    reconciledAt: '',
    revision: 1,
    advisoryOnly: true,
    resumeAuthorized: false,
    requiresCanonicalResumeGate: true,
    verificationProvenance: 'UNVERIFIED_INPUT',
    reconciliationAuthorized: false,
  });
}

function advance(raw, expectedPhase, patch) {
  const current = normalizeHumanTakeoverV1(raw);
  if (current.phase !== expectedPhase) {
    throw new Error(`HumanTakeoverV1 must be ${expectedPhase} for this transition`);
  }
  return normalizeHumanTakeoverV1({
    ...current,
    ...patch,
    revision: current.revision + 1,
  });
}

export function recordHumanTakeoverStartedV1(raw, input = {}) {
  const request = strictRecord(input, 'HumanTakeoverStartRequestV1');
  strictRecordKeys(request, START_KEYS, 'HumanTakeoverStartRequestV1');
  const current = normalizeHumanTakeoverV1(raw);
  const startedAt = exactTimestamp(ownValue(request, 'at', 'HumanTakeoverStartRequestV1'), 'at');
  assertAtOrAfter(startedAt, current.requestedAt, 'takeover start');
  return advance(current, HumanTakeoverPhase.REQUESTED, {
    phase: HumanTakeoverPhase.OWNER_IN_CONTROL,
    quiescenceEvidenceId: exactId(
      ownValue(request, 'quiescenceEvidenceId', 'HumanTakeoverStartRequestV1'),
      'quiescenceEvidenceId',
    ),
    controlStartedAt: startedAt,
  });
}

export function requestHumanHandbackV1(raw, input = {}) {
  const request = strictRecord(input, 'HumanHandbackRequestV1');
  strictRecordKeys(request, HANDBACK_KEYS, 'HumanHandbackRequestV1');
  const current = normalizeHumanTakeoverV1(raw);
  const requestedAt = exactTimestamp(ownValue(request, 'at', 'HumanHandbackRequestV1'), 'at');
  assertAtOrAfter(requestedAt, current.controlStartedAt, 'handback request');
  return advance(current, HumanTakeoverPhase.OWNER_IN_CONTROL, {
    phase: HumanTakeoverPhase.HANDBACK_PENDING,
    reobservationInvocationId: exactId(
      ownValue(request, 'reobservationInvocationId', 'HumanHandbackRequestV1'),
      'reobservationInvocationId',
    ),
    handbackRequestedAt: requestedAt,
  });
}

export function recordHumanHandbackObservationV1(raw, input = {}) {
  const request = strictRecord(input, 'HumanHandbackObservationRequestV1');
  strictRecordKeys(request, OBSERVATION_REQUEST_KEYS, 'HumanHandbackObservationRequestV1');
  const current = normalizeHumanTakeoverV1(raw);
  if (current.phase !== HumanTakeoverPhase.HANDBACK_PENDING) {
    throw new Error('HumanTakeoverV1 must be HANDBACK_PENDING for reobservation');
  }
  const observed = canonicalObservation(
    ownValue(request, 'observation', 'HumanHandbackObservationRequestV1'),
    'postTakeoverObservation',
  );
  if (observed.invocationId !== current.reobservationInvocationId) {
    throw new Error('post-takeover observation invocation does not match handback reobservation invocation');
  }
  assertAtOrAfter(observed.observedAt, current.handbackRequestedAt, 'post-takeover observation');
  if (current.preTakeoverObservation
      && observed.observationId === current.preTakeoverObservation.observationId) {
    throw new Error('post-takeover observation must be a fresh observation identity');
  }
  return advance(current, HumanTakeoverPhase.HANDBACK_PENDING, {
    phase: HumanTakeoverPhase.REOBSERVED,
    postTakeoverObservation: observed,
    reobservedAt: observed.observedAt,
  });
}

export function recordHumanHandbackVerificationV1(raw, input = {}) {
  const request = strictRecord(input, 'HumanHandbackVerificationRequestV1');
  strictRecordKeys(request, VERIFICATION_REQUEST_KEYS, 'HumanHandbackVerificationRequestV1');
  const current = normalizeHumanTakeoverV1(raw);
  if (current.phase !== HumanTakeoverPhase.REOBSERVED) {
    throw new Error('HumanTakeoverV1 must be REOBSERVED for verification');
  }
  const verified = canonicalVerification(
    ownValue(request, 'verification', 'HumanHandbackVerificationRequestV1'),
    'handbackVerification',
  );
  if (verified.invocationId !== current.postTakeoverObservation.invocationId) {
    throw new Error('handback verification invocation does not match post-takeover observation');
  }
  if (verified.observationId !== current.postTakeoverObservation.observationId) {
    throw new Error('handback verification observation does not match post-takeover observation');
  }
  if (!verified.verifierId
      || verified.verifierId === current.agentId
      || verified.verifierId === current.humanPrincipalId) {
    throw new Error('handback verifier must be independent from agent and human takeover principal');
  }
  if (verified.verificationAuthorityId !== current.verificationAuthorityId) {
    throw new Error('handback verification authority mismatch');
  }
  if (current.effectId) {
    if (verified.effectId !== current.effectId) {
      throw new Error('handback verification effectId mismatch');
    }
    if (verified.executionId !== current.executionId) {
      throw new Error('handback verification executionId mismatch');
    }
    if (verified.attempt !== current.attempt) {
      throw new Error('handback verification attempt mismatch');
    }
  } else if (verified.effectId || verified.executionId || verified.attempt !== 0) {
    throw new Error('handback verification cannot introduce unrelated exact-effect identity');
  }
  assertAtOrAfter(verified.verifiedAt, current.postTakeoverObservation.observedAt, 'handback verification');

  const resumeCandidate = verified.status === VerificationStatus.VERIFIED
    && verified.evidenceArtifactIds.length > 0;

  return advance(current, HumanTakeoverPhase.REOBSERVED, {
    phase: resumeCandidate ? HumanTakeoverPhase.EVIDENCE_READY : HumanTakeoverPhase.MANUAL_REVIEW,
    handbackVerification: verified,
    reconciledAt: verified.verifiedAt,
  });
}

export function buildHumanHandbackResumePacketV1(raw) {
  const current = normalizeHumanTakeoverV1(raw);
  if (current.phase !== HumanTakeoverPhase.EVIDENCE_READY) {
    throw new Error('Human handback is not a resume candidate');
  }

  return freezeDeep({
    schemaVersion: HUMAN_TAKEOVER_VERSION,
    takeoverId: current.takeoverId,
    jobId: current.jobId,
    planId: current.planId,
    nodeId: current.nodeId,
    resourceId: current.resourceId,
    effectId: current.effectId,
    executionId: current.executionId,
    attempt: current.attempt,
    agentId: current.agentId,
    humanPrincipalId: current.humanPrincipalId,
    verificationAuthorityId: current.verificationAuthorityId,
    quiescenceEvidenceId: current.quiescenceEvidenceId,
    reobservationInvocationId: current.reobservationInvocationId,
    postTakeoverObservation: current.postTakeoverObservation,
    handbackVerification: current.handbackVerification,
    advisoryOnly: true,
    resumeCandidate: true,
    resumeAuthorized: false,
    requiresCanonicalResumeGate: true,
    verificationProvenance: 'UNVERIFIED_INPUT',
    reconciliationAuthorized: false,
  });
}

export function humanTakeoverResumeCandidateV1(raw) {
  return normalizeHumanTakeoverV1(raw).phase === HumanTakeoverPhase.EVIDENCE_READY;
}
