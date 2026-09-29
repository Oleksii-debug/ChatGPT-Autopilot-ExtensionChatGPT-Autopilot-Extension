import {
  VerificationStatus,
  normalizeArtifactRefV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';
import {
  ExactEffectPhase,
  normalizeExactEffectStateV1,
} from './universal-agent-exact-effect.js';

export const DeploymentLifecycleVersion = 1;

export const DeploymentPhase = Object.freeze({
  PREVIEW: 'PREVIEW',
  QUALIFIED: 'QUALIFIED',
  PUBLISHED_UNVERIFIED: 'PUBLISHED_UNVERIFIED',
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  ROLLBACK_PUBLISHED_UNVERIFIED: 'ROLLBACK_PUBLISHED_UNVERIFIED',
  ROLLED_BACK: 'ROLLED_BACK',
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',
});

export const DeploymentCheckKind = Object.freeze({
  TEST: 'TEST',
  ACCESSIBILITY: 'ACCESSIBILITY',
  PERFORMANCE: 'PERFORMANCE',
  SYNTHETIC: 'SYNTHETIC',
  LIVE: 'LIVE',
  ROLLBACK_LIVE: 'ROLLBACK_LIVE',
});

export const DeploymentEffectKind = Object.freeze({
  PUBLISH: 'PUBLISH',
  ROLLBACK: 'ROLLBACK',
});

export const DeploymentEventType = Object.freeze({
  RECORD_QUALIFICATION_VERIFICATION: 'RECORD_QUALIFICATION_VERIFICATION',
  RECORD_PUBLISH_EFFECT: 'RECORD_PUBLISH_EFFECT',
  RECORD_HEALTH_VERIFICATION: 'RECORD_HEALTH_VERIFICATION',
  RECORD_ROLLBACK_EFFECT: 'RECORD_ROLLBACK_EFFECT',
  RECORD_ROLLBACK_VERIFICATION: 'RECORD_ROLLBACK_VERIFICATION',
});

const PHASES = new Set(Object.values(DeploymentPhase));
const CHECK_KINDS = new Set(Object.values(DeploymentCheckKind));
const QUALIFICATION_KINDS = new Set([
  DeploymentCheckKind.TEST,
  DeploymentCheckKind.ACCESSIBILITY,
  DeploymentCheckKind.PERFORMANCE,
]);
const HEALTH_KINDS = new Set([
  DeploymentCheckKind.SYNTHETIC,
  DeploymentCheckKind.LIVE,
]);
const EFFECT_KINDS = new Set(Object.values(DeploymentEffectKind));
const EVENT_TYPES = new Set(Object.values(DeploymentEventType));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE_IDS = 128;

const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);
const VERIFICATION_KEYS = new Set([
  'schemaVersion', 'verificationId', 'invocationId', 'observationId',
  'status', 'reasonCode', 'summary', 'evidenceArtifactIds', 'verifiedAt',
  'verifierId', 'verificationAuthorityId', 'effectId', 'executionId', 'attempt',
]);
const VERIFICATION_BINDING_KEYS = new Set([
  'schemaVersion', 'verificationId', 'projectId', 'targetId',
  'artifactId', 'artifactSha256', 'checkKind', 'verification',
]);
const EFFECT_BINDING_KEYS = new Set([
  'schemaVersion', 'effectId', 'projectId', 'targetId', 'artifactId',
  'artifactSha256', 'kind', 'state',
]);
const QUALIFICATION_RECORD_KEYS = new Set([
  'checkKind', 'verificationId', 'verifierId', 'verifiedAt',
]);
const HEALTH_RECORD_KEYS = new Set([
  'checkKind', 'verificationId', 'verifierId', 'status', 'verifiedAt',
]);
const CREATE_KEYS = new Set([
  'deploymentId', 'projectId', 'targetId', 'publisherId',
  'candidateArtifactRef', 'rollbackArtifactRef',
  'publishEffectId', 'rollbackEffectId', 'createdAt',
]);
const STATE_KEYS = new Set([
  'schemaVersion', 'deploymentId', 'projectId', 'targetId', 'publisherId',
  'candidateArtifactRef', 'rollbackArtifactRef',
  'publishEffectId', 'rollbackEffectId', 'phase',
  'qualificationEvidence', 'healthEvidence', 'rollbackHealth',
  'qualifiedAt', 'publishedAt', 'lastHealthyAt', 'degradedAt',
  'rollbackPublishedAt', 'rolledBackAt',
  'publishCommitId', 'rollbackCommitId', 'regressionCount',
  'revision', 'lastEventId', 'lastEventType', 'lastEventEvidenceId', 'lastEventAt',
  'createdAt', 'updatedAt',
  'rollbackRecommended', 'rollbackAuthorized', 'publishAuthorized',
  'executionAuthorized', 'advisoryOnly',
]);
const EVENT_KEYS = new Set([
  'schemaVersion', 'eventId', 'deploymentId', 'previousRevision',
  'type', 'evidenceId', 'at',
]);

function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  const seen = new Set();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    out[key] = descriptor.value;
    seen.add(key);
  }
  for (const key of allowed) {
    if (!seen.has(key)) throw new Error(`${label} is missing field: ${key}`);
  }
  return out;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) {
      throw new Error(`${label} contains non-index fields`);
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

function exactVersion(value, label) {
  if (typeof value !== 'number'
      || !Number.isInteger(value)
      || value !== DeploymentLifecycleVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return value;
}

function exactId(value, label, { nullable = false, empty = false } = {}) {
  if (nullable && value === null) return null;
  if (empty && value === '') return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function exactText(value, label, { empty = false, max = 16_000 } = {}) {
  if (empty && value === '') return '';
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > max) {
    throw new Error(`${label} must use exact canonical text representation`);
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function exactTimestamp(value, label, { empty = false } = {}) {
  if (empty && value === '') return '';
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function compareTimestampEpoch(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return leftMs < rightMs ? -1 : leftMs > rightMs ? 1 : 0;
}

function exactInteger(value, label, min, max) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(`${label} must be an exact integer in range`);
  }
  return value;
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactArtifactRef(input, label) {
  const raw = snapshotRecord(input, ARTIFACT_KEYS, label);
  if (raw.schemaVersion !== 1) throw new Error(`${label}.schemaVersion is unsupported`);
  const canonical = {
    schemaVersion: raw.schemaVersion,
    artifactId: exactId(raw.artifactId, `${label}.artifactId`),
    kind: exactId(raw.kind, `${label}.kind`),
    uri: exactText(raw.uri, `${label}.uri`, { max: 4096 }),
    mediaType: exactText(raw.mediaType, `${label}.mediaType`, { empty: true, max: 300 }),
    sha256: exactSha256(raw.sha256, `${label}.sha256`),
    sizeBytes: exactInteger(raw.sizeBytes, `${label}.sizeBytes`, 0, Number.MAX_SAFE_INTEGER),
    createdAt: exactTimestamp(raw.createdAt, `${label}.createdAt`),
    producerInvocationId: exactId(raw.producerInvocationId, `${label}.producerInvocationId`, { nullable: true }),
    sensitive: exactBoolean(raw.sensitive, `${label}.sensitive`),
  };
  const normalized = normalizeArtifactRefV1(canonical);
  if (normalized.artifactId !== canonical.artifactId
      || normalized.kind !== canonical.kind
      || normalized.uri !== canonical.uri
      || normalized.mediaType !== canonical.mediaType
      || normalized.sha256 !== canonical.sha256
      || normalized.sizeBytes !== canonical.sizeBytes
      || normalized.createdAt !== canonical.createdAt
      || normalized.producerInvocationId !== canonical.producerInvocationId
      || normalized.sensitive !== canonical.sensitive) {
    throw new Error(`${label} is not already canonical`);
  }
  return normalized;
}

function exactIdArray(value, label) {
  const out = denseArray(value, label, MAX_EVIDENCE_IDS)
    .map((item, index) => exactId(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function exactVerification(input) {
  const raw = snapshotRecord(input, VERIFICATION_KEYS, 'VerificationV1');
  if (raw.schemaVersion !== 1) throw new Error('VerificationV1 schemaVersion is unsupported');
  const status = raw.status;
  if (typeof status !== 'string' || !Object.values(VerificationStatus).includes(status)) {
    throw new Error('VerificationV1 status must be exact canonical enum');
  }
  const canonical = {
    schemaVersion: 1,
    verificationId: exactId(raw.verificationId, 'verification.verificationId'),
    invocationId: exactId(raw.invocationId, 'verification.invocationId'),
    observationId: exactId(raw.observationId, 'verification.observationId', {
      nullable: status === VerificationStatus.NOT_APPLICABLE,
    }),
    status,
    reasonCode: exactId(raw.reasonCode, 'verification.reasonCode'),
    summary: exactText(raw.summary, 'verification.summary', { empty: true, max: 8000 }),
    evidenceArtifactIds: exactIdArray(raw.evidenceArtifactIds, 'verification.evidenceArtifactIds'),
    verifiedAt: exactTimestamp(raw.verifiedAt, 'verification.verifiedAt'),
    verifierId: exactId(raw.verifierId, 'verification.verifierId', { nullable: true }),
    verificationAuthorityId: exactId(
      raw.verificationAuthorityId,
      'verification.verificationAuthorityId',
      { nullable: true },
    ),
    effectId: exactId(raw.effectId, 'verification.effectId', { nullable: true }),
    executionId: exactId(raw.executionId, 'verification.executionId', { nullable: true }),
    attempt: exactInteger(raw.attempt, 'verification.attempt', 0, 64),
  };
  const normalized = normalizeVerificationV1(canonical);
  if (JSON.stringify(normalized) !== JSON.stringify(canonical)) {
    throw new Error('VerificationV1 is not already canonical');
  }
  return normalized;
}

function normalizeVerificationBinding(input) {
  const raw = snapshotRecord(input, VERIFICATION_BINDING_KEYS, 'DeploymentVerificationBindingV1');
  if (raw.schemaVersion !== 1) throw new Error('DeploymentVerificationBindingV1 schemaVersion is unsupported');
  if (typeof raw.checkKind !== 'string' || !CHECK_KINDS.has(raw.checkKind)) {
    throw new Error('Deployment verification checkKind is invalid');
  }
  const verification = exactVerification(raw.verification);
  const binding = {
    schemaVersion: 1,
    verificationId: exactId(raw.verificationId, 'binding.verificationId'),
    projectId: exactId(raw.projectId, 'binding.projectId'),
    targetId: exactId(raw.targetId, 'binding.targetId'),
    artifactId: exactId(raw.artifactId, 'binding.artifactId'),
    artifactSha256: exactSha256(raw.artifactSha256, 'binding.artifactSha256'),
    checkKind: raw.checkKind,
    verification,
  };
  if (binding.verificationId !== verification.verificationId) {
    throw new Error('Trusted verification binding verificationId mismatch');
  }
  return deepFreeze(binding);
}

function normalizeEffectBinding(input) {
  const raw = snapshotRecord(input, EFFECT_BINDING_KEYS, 'DeploymentEffectBindingV1');
  if (raw.schemaVersion !== 1) throw new Error('DeploymentEffectBindingV1 schemaVersion is unsupported');
  if (typeof raw.kind !== 'string' || !EFFECT_KINDS.has(raw.kind)) {
    throw new Error('Deployment effect kind is invalid');
  }
  const effectId = exactId(raw.effectId, 'effect binding effectId');
  const state = normalizeExactEffectStateV1(raw.state);
  if (state.effectId !== effectId) throw new Error('Trusted effect binding effectId mismatch');
  if (state.phase !== ExactEffectPhase.COMMITTED || !state.commitId) {
    throw new Error('Deployment effect must be canonically COMMITTED');
  }
  if (!state.observation?.observedAt) {
    throw new Error('Deployment effect requires canonical exact-effect observation evidence');
  }
  if (!state.verification || state.verification.status !== VerificationStatus.VERIFIED) {
    throw new Error('Deployment effect requires VERIFIED canonical exact-effect evidence');
  }
  if (!state.verification.verifierId || !state.verification.verificationAuthorityId) {
    throw new Error('Deployment effect requires verifier and verification-authority identity');
  }
  if (state.verification.observationId !== state.observation.observationId) {
    throw new Error('Deployment exact-effect verification observation binding mismatch');
  }
  if (compareTimestampEpoch(state.observation.observedAt, state.verification.verifiedAt) > 0) {
    throw new Error('Deployment exact-effect verification cannot predate observation');
  }
  if (compareTimestampEpoch(state.verification.verifiedAt, state.updatedAt) > 0) {
    throw new Error('Deployment exact-effect verification cannot postdate durable effect state');
  }
  if (compareTimestampEpoch(state.observation.observedAt, state.updatedAt) > 0) {
    throw new Error('Deployment exact-effect observation cannot postdate durable effect state');
  }
  return deepFreeze({
    schemaVersion: 1,
    effectId,
    projectId: exactId(raw.projectId, 'effect binding projectId'),
    targetId: exactId(raw.targetId, 'effect binding targetId'),
    artifactId: exactId(raw.artifactId, 'effect binding artifactId'),
    artifactSha256: exactSha256(raw.artifactSha256, 'effect binding artifactSha256'),
    kind: raw.kind,
    state,
  });
}

function normalizeQualificationRecord(input) {
  const raw = snapshotRecord(input, QUALIFICATION_RECORD_KEYS, 'DeploymentQualificationEvidenceV1');
  if (!QUALIFICATION_KINDS.has(raw.checkKind)) throw new Error('Qualification checkKind is invalid');
  return deepFreeze({
    checkKind: raw.checkKind,
    verificationId: exactId(raw.verificationId, 'qualification verificationId'),
    verifierId: exactId(raw.verifierId, 'qualification verifierId'),
    verifiedAt: exactTimestamp(raw.verifiedAt, 'qualification verifiedAt'),
  });
}

function normalizeHealthRecord(input, label = 'DeploymentHealthEvidenceV1') {
  const raw = snapshotRecord(input, HEALTH_RECORD_KEYS, label);
  if (!HEALTH_KINDS.has(raw.checkKind) && raw.checkKind !== DeploymentCheckKind.ROLLBACK_LIVE) {
    throw new Error('Health checkKind is invalid');
  }
  if (![VerificationStatus.VERIFIED, VerificationStatus.FAILED, VerificationStatus.AMBIGUOUS].includes(raw.status)) {
    throw new Error('Health status is invalid');
  }
  return deepFreeze({
    checkKind: raw.checkKind,
    verificationId: exactId(raw.verificationId, 'health verificationId'),
    verifierId: exactId(raw.verifierId, 'health verifierId'),
    status: raw.status,
    verifiedAt: exactTimestamp(raw.verifiedAt, 'health verifiedAt'),
  });
}

function maxTimestamp(values) {
  return values.reduce(
    (max, value) => (!max || compareTimestampEpoch(value, max) > 0 ? value : max),
    '',
  );
}

function derivePhaseFlags(phase) {
  return {
    rollbackRecommended: [DeploymentPhase.DEGRADED, DeploymentPhase.ROLLBACK_FAILED].includes(phase),
    rollbackAuthorized: false,
    publishAuthorized: false,
    executionAuthorized: false,
    advisoryOnly: true,
  };
}

function normalizeStateInternal(input) {
  const raw = snapshotRecord(input, STATE_KEYS, 'DeploymentLifecycleV1');
  const phase = raw.phase;
  if (typeof phase !== 'string' || !PHASES.has(phase)) throw new Error('Deployment lifecycle phase is invalid');

  const candidateArtifactRef = exactArtifactRef(raw.candidateArtifactRef, 'candidateArtifactRef');
  const rollbackArtifactRef = exactArtifactRef(raw.rollbackArtifactRef, 'rollbackArtifactRef');
  if (candidateArtifactRef.sha256 === rollbackArtifactRef.sha256) {
    throw new Error('Candidate and rollback artifacts must have different materialized SHA-256 identities');
  }

  const qualificationEvidence = denseArray(raw.qualificationEvidence, 'qualificationEvidence', 3)
    .map(normalizeQualificationRecord)
    .sort((a, b) => compareCodeUnits(a.checkKind, b.checkKind));
  if (new Set(qualificationEvidence.map(item => item.checkKind)).size !== qualificationEvidence.length) {
    throw new Error('qualificationEvidence contains duplicate checkKind');
  }

  const healthEvidence = denseArray(raw.healthEvidence, 'healthEvidence', 2)
    .map(item => normalizeHealthRecord(item))
    .sort((a, b) => compareCodeUnits(a.checkKind, b.checkKind));
  if (healthEvidence.some(item => !HEALTH_KINDS.has(item.checkKind))) {
    throw new Error('healthEvidence may contain only SYNTHETIC/LIVE checks');
  }
  if (new Set(healthEvidence.map(item => item.checkKind)).size !== healthEvidence.length) {
    throw new Error('healthEvidence contains duplicate checkKind');
  }
  const rollbackHealth = raw.rollbackHealth === null
    ? null
    : normalizeHealthRecord(raw.rollbackHealth, 'DeploymentRollbackHealthV1');
  if (rollbackHealth && rollbackHealth.checkKind !== DeploymentCheckKind.ROLLBACK_LIVE) {
    throw new Error('rollbackHealth must be ROLLBACK_LIVE evidence');
  }

  const state = {
    schemaVersion: exactVersion(raw.schemaVersion, 'DeploymentLifecycleV1'),
    deploymentId: exactId(raw.deploymentId, 'deploymentId'),
    projectId: exactId(raw.projectId, 'projectId'),
    targetId: exactId(raw.targetId, 'targetId'),
    publisherId: exactId(raw.publisherId, 'publisherId'),
    candidateArtifactRef,
    rollbackArtifactRef,
    publishEffectId: exactId(raw.publishEffectId, 'publishEffectId'),
    rollbackEffectId: exactId(raw.rollbackEffectId, 'rollbackEffectId'),
    phase,
    qualificationEvidence,
    healthEvidence,
    rollbackHealth,
    qualifiedAt: exactTimestamp(raw.qualifiedAt, 'qualifiedAt', { empty: true }),
    publishedAt: exactTimestamp(raw.publishedAt, 'publishedAt', { empty: true }),
    lastHealthyAt: exactTimestamp(raw.lastHealthyAt, 'lastHealthyAt', { empty: true }),
    degradedAt: exactTimestamp(raw.degradedAt, 'degradedAt', { empty: true }),
    rollbackPublishedAt: exactTimestamp(raw.rollbackPublishedAt, 'rollbackPublishedAt', { empty: true }),
    rolledBackAt: exactTimestamp(raw.rolledBackAt, 'rolledBackAt', { empty: true }),
    publishCommitId: exactId(raw.publishCommitId, 'publishCommitId', { empty: true }),
    rollbackCommitId: exactId(raw.rollbackCommitId, 'rollbackCommitId', { empty: true }),
    regressionCount: exactInteger(raw.regressionCount, 'regressionCount', 0, Number.MAX_SAFE_INTEGER),
    revision: exactInteger(raw.revision, 'revision', 0, Number.MAX_SAFE_INTEGER),
    lastEventId: exactId(raw.lastEventId, 'lastEventId', { empty: true }),
    lastEventType: exactId(raw.lastEventType, 'lastEventType', { empty: true }),
    lastEventEvidenceId: exactId(raw.lastEventEvidenceId, 'lastEventEvidenceId', { empty: true }),
    lastEventAt: exactTimestamp(raw.lastEventAt, 'lastEventAt', { empty: true }),
    createdAt: exactTimestamp(raw.createdAt, 'createdAt'),
    updatedAt: exactTimestamp(raw.updatedAt, 'updatedAt'),
    rollbackRecommended: exactBoolean(raw.rollbackRecommended, 'rollbackRecommended'),
    rollbackAuthorized: exactBoolean(raw.rollbackAuthorized, 'rollbackAuthorized'),
    publishAuthorized: exactBoolean(raw.publishAuthorized, 'publishAuthorized'),
    executionAuthorized: exactBoolean(raw.executionAuthorized, 'executionAuthorized'),
    advisoryOnly: exactBoolean(raw.advisoryOnly, 'advisoryOnly'),
  };

  const expectedFlags = derivePhaseFlags(phase);
  for (const [key, expected] of Object.entries(expectedFlags)) {
    if (state[key] !== expected) throw new Error(`${key} is inconsistent with deployment phase`);
  }
  if (compareTimestampEpoch(state.updatedAt, state.createdAt) < 0) throw new Error('Deployment updatedAt cannot predate createdAt');
  const lastEventFields = [
    state.lastEventId,
    state.lastEventType,
    state.lastEventEvidenceId,
    state.lastEventAt,
  ];
  if (state.revision === 0) {
    if (lastEventFields.some(Boolean)) {
      throw new Error('Deployment revision and last-event identity are inconsistent');
    }
  } else {
    if (lastEventFields.some(value => !value)) {
      throw new Error('Deployment revision and last-event identity are inconsistent');
    }
    if (!EVENT_TYPES.has(state.lastEventType) || state.lastEventAt !== state.updatedAt) {
      throw new Error('Deployment last-event identity is inconsistent with durable state');
    }
  }

  for (const evidence of [...qualificationEvidence, ...healthEvidence, ...(rollbackHealth ? [rollbackHealth] : [])]) {
    if (evidence.verifierId === state.publisherId) {
      throw new Error('Deployment verifier must be independent from publisher');
    }
    if (compareTimestampEpoch(evidence.verifiedAt, candidateArtifactRef.createdAt) < 0
        && evidence.checkKind !== DeploymentCheckKind.ROLLBACK_LIVE) {
      throw new Error('Deployment verification predates candidate materialization');
    }
    if (evidence.checkKind === DeploymentCheckKind.ROLLBACK_LIVE
        && compareTimestampEpoch(evidence.verifiedAt, rollbackArtifactRef.createdAt) < 0) {
      throw new Error('Rollback verification predates rollback artifact materialization');
    }
    if (compareTimestampEpoch(evidence.verifiedAt, state.updatedAt) > 0) throw new Error('Deployment evidence cannot be from the future');
  }

  const qualificationKinds = new Set(qualificationEvidence.map(item => item.checkKind));
  const fullyQualified = [...QUALIFICATION_KINDS].every(kind => qualificationKinds.has(kind));
  const requiresQualified = phase !== DeploymentPhase.PREVIEW;
  if (requiresQualified && !fullyQualified) throw new Error('Non-preview deployment requires all qualification gates');
  if (fullyQualified) {
    const expectedQualifiedAt = maxTimestamp(qualificationEvidence.map(item => item.verifiedAt));
    if (state.qualifiedAt !== expectedQualifiedAt) throw new Error('qualifiedAt must equal latest qualification evidence');
  } else if (state.qualifiedAt !== '') {
    throw new Error('qualifiedAt requires all qualification gates');
  }

  const publishPhases = new Set([
    DeploymentPhase.PUBLISHED_UNVERIFIED,
    DeploymentPhase.HEALTHY,
    DeploymentPhase.DEGRADED,
    DeploymentPhase.ROLLBACK_PUBLISHED_UNVERIFIED,
    DeploymentPhase.ROLLED_BACK,
    DeploymentPhase.ROLLBACK_FAILED,
  ]);
  if (publishPhases.has(phase)) {
    if (!state.publishedAt || !state.publishCommitId) throw new Error('Published deployment requires committed publish evidence');
    if (compareTimestampEpoch(state.publishedAt, state.qualifiedAt) < 0) throw new Error('Publish cannot predate qualification');
  } else if (state.publishedAt || state.publishCommitId) {
    throw new Error('Unpublished deployment cannot carry publish commit evidence');
  }

  const currentHealth = new Map(healthEvidence.map(item => [item.checkKind, item]));
  const bothHealth = HEALTH_KINDS.size === currentHealth.size;
  const healthFailure = [...currentHealth.values()].some(item => item.status !== VerificationStatus.VERIFIED);
  const healthAllVerified = bothHealth
    && [...HEALTH_KINDS].every(kind => currentHealth.get(kind)?.status === VerificationStatus.VERIFIED);
  if (phase === DeploymentPhase.HEALTHY && !healthAllVerified) {
    throw new Error('HEALTHY deployment requires current SYNTHETIC and LIVE VERIFIED evidence');
  }
  if (phase === DeploymentPhase.DEGRADED && !healthFailure) {
    throw new Error('DEGRADED deployment requires failed or ambiguous current health evidence');
  }
  if (healthEvidence.length && !state.publishedAt) throw new Error('Health evidence requires a published deployment');
  for (const evidence of healthEvidence) {
    if (compareTimestampEpoch(evidence.verifiedAt, state.publishedAt) < 0) throw new Error('Health verification cannot predate publish');
  }

  if (state.lastHealthyAt) {
    if (!state.publishedAt || compareTimestampEpoch(state.lastHealthyAt, state.publishedAt) < 0 || compareTimestampEpoch(state.lastHealthyAt, state.updatedAt) > 0) {
      throw new Error('lastHealthyAt is causally invalid');
    }
  }
  if (state.degradedAt) {
    if (!state.publishedAt || compareTimestampEpoch(state.degradedAt, state.publishedAt) < 0 || compareTimestampEpoch(state.degradedAt, state.updatedAt) > 0) {
      throw new Error('degradedAt is causally invalid');
    }
  }

  const rollbackPhases = new Set([
    DeploymentPhase.ROLLBACK_PUBLISHED_UNVERIFIED,
    DeploymentPhase.ROLLED_BACK,
    DeploymentPhase.ROLLBACK_FAILED,
  ]);
  if (rollbackPhases.has(phase)) {
    if (!state.rollbackPublishedAt || !state.rollbackCommitId) {
      throw new Error('Rollback phase requires committed rollback effect evidence');
    }
    if (compareTimestampEpoch(state.rollbackPublishedAt, state.publishedAt) < 0) throw new Error('Rollback cannot predate publish');
  } else if (state.rollbackPublishedAt || state.rollbackCommitId || rollbackHealth || state.rolledBackAt) {
    throw new Error('Non-rollback phase cannot carry rollback evidence');
  }
  if (rollbackHealth) {
    if (compareTimestampEpoch(rollbackHealth.verifiedAt, state.rollbackPublishedAt) < 0) {
      throw new Error('Rollback verification cannot predate rollback publish');
    }
    if (phase === DeploymentPhase.ROLLED_BACK && rollbackHealth.status !== VerificationStatus.VERIFIED) {
      throw new Error('ROLLED_BACK requires VERIFIED rollback health evidence');
    }
    if (phase === DeploymentPhase.ROLLBACK_FAILED
        && ![VerificationStatus.FAILED, VerificationStatus.AMBIGUOUS].includes(rollbackHealth.status)) {
      throw new Error('ROLLBACK_FAILED requires failed or ambiguous rollback health evidence');
    }
  } else if ([DeploymentPhase.ROLLED_BACK, DeploymentPhase.ROLLBACK_FAILED].includes(phase)) {
    throw new Error('Terminal rollback phase requires rollback health evidence');
  }
  if (phase === DeploymentPhase.ROLLED_BACK) {
    if (!state.rolledBackAt || state.rolledBackAt !== rollbackHealth.verifiedAt) {
      throw new Error('rolledBackAt must bind exact VERIFIED rollback health time');
    }
  } else if (state.rolledBackAt) {
    throw new Error('rolledBackAt is valid only for ROLLED_BACK');
  }

  return deepFreeze(state);
}

export function normalizeDeploymentLifecycleV1(input) {
  return normalizeStateInternal(input);
}

export function createDeploymentLifecycleV1(input) {
  const raw = snapshotRecord(input, CREATE_KEYS, 'DeploymentLifecycleCreateV1');
  const candidateArtifactRef = exactArtifactRef(raw.candidateArtifactRef, 'candidateArtifactRef');
  const rollbackArtifactRef = exactArtifactRef(raw.rollbackArtifactRef, 'rollbackArtifactRef');
  const createdAt = exactTimestamp(raw.createdAt, 'createdAt');
  if (compareTimestampEpoch(candidateArtifactRef.createdAt, createdAt) > 0 || compareTimestampEpoch(rollbackArtifactRef.createdAt, createdAt) > 0) {
    throw new Error('Deployment cannot predate release artifacts');
  }
  if (candidateArtifactRef.sha256 === rollbackArtifactRef.sha256) {
    throw new Error('Candidate and rollback artifacts must have different materialized SHA-256 identities');
  }
  return normalizeStateInternal({
    schemaVersion: DeploymentLifecycleVersion,
    deploymentId: exactId(raw.deploymentId, 'deploymentId'),
    projectId: exactId(raw.projectId, 'projectId'),
    targetId: exactId(raw.targetId, 'targetId'),
    publisherId: exactId(raw.publisherId, 'publisherId'),
    candidateArtifactRef,
    rollbackArtifactRef,
    publishEffectId: exactId(raw.publishEffectId, 'publishEffectId'),
    rollbackEffectId: exactId(raw.rollbackEffectId, 'rollbackEffectId'),
    phase: DeploymentPhase.PREVIEW,
    qualificationEvidence: [],
    healthEvidence: [],
    rollbackHealth: null,
    qualifiedAt: '',
    publishedAt: '',
    lastHealthyAt: '',
    degradedAt: '',
    rollbackPublishedAt: '',
    rolledBackAt: '',
    publishCommitId: '',
    rollbackCommitId: '',
    regressionCount: 0,
    revision: 0,
    lastEventId: '',
    lastEventType: '',
    lastEventEvidenceId: '',
    lastEventAt: '',
    createdAt,
    updatedAt: createdAt,
    ...derivePhaseFlags(DeploymentPhase.PREVIEW),
  });
}

function normalizeEvent(input) {
  const raw = snapshotRecord(input, EVENT_KEYS, 'DeploymentLifecycleEventV1');
  if (raw.schemaVersion !== DeploymentLifecycleVersion) {
    throw new Error('Unsupported DeploymentLifecycleEventV1 schemaVersion');
  }
  if (typeof raw.type !== 'string' || !EVENT_TYPES.has(raw.type)) {
    throw new Error('Deployment lifecycle event type is invalid');
  }
  return deepFreeze({
    schemaVersion: DeploymentLifecycleVersion,
    eventId: exactId(raw.eventId, 'eventId'),
    deploymentId: exactId(raw.deploymentId, 'event.deploymentId'),
    previousRevision: exactInteger(raw.previousRevision, 'previousRevision', 0, Number.MAX_SAFE_INTEGER),
    type: raw.type,
    evidenceId: exactId(raw.evidenceId, 'evidenceId'),
    at: exactTimestamp(raw.at, 'event.at'),
  });
}

function resolveVerification(resolver, event, state, expectedKinds, artifact) {
  if (typeof resolver !== 'function') throw new Error('Trusted verification resolver is required');
  const binding = normalizeVerificationBinding(resolver(event.evidenceId));
  if (binding.verificationId !== event.evidenceId) throw new Error('Resolved verification identity mismatch');
  if (binding.projectId !== state.projectId || binding.targetId !== state.targetId) {
    throw new Error('Resolved verification subject project/target mismatch');
  }
  if (binding.artifactId !== artifact.artifactId || binding.artifactSha256 !== artifact.sha256) {
    throw new Error('Resolved verification subject artifact mismatch');
  }
  if (!expectedKinds.has(binding.checkKind)) throw new Error('Resolved verification checkKind is not valid for event');
  if (!binding.verification.verifierId || !binding.verification.verificationAuthorityId) {
    throw new Error('Deployment verification requires independent verifier authority identity');
  }
  if (binding.verification.verifierId === state.publisherId) {
    throw new Error('Deployment verifier must be independent from publisher');
  }
  if (compareTimestampEpoch(binding.verification.verifiedAt, event.at) > 0) throw new Error('Verification evidence cannot postdate lifecycle event');
  return binding;
}

function resolveEffect(resolver, event, state, expectedKind, artifact, expectedEffectId) {
  if (typeof resolver !== 'function') throw new Error('Trusted exact-effect resolver is required');
  const binding = normalizeEffectBinding(resolver(event.evidenceId));
  if (binding.effectId !== event.evidenceId || binding.effectId !== expectedEffectId) {
    throw new Error('Resolved exact-effect identity mismatch');
  }
  if (binding.kind !== expectedKind) throw new Error('Resolved exact-effect kind mismatch');
  if (binding.state.verification.verifierId === state.publisherId) {
    throw new Error('Deployment exact-effect verifier must be independent from publisher');
  }
  if (binding.projectId !== state.projectId || binding.targetId !== state.targetId) {
    throw new Error('Resolved exact-effect subject project/target mismatch');
  }
  if (binding.artifactId !== artifact.artifactId || binding.artifactSha256 !== artifact.sha256) {
    throw new Error('Resolved exact-effect artifact mismatch');
  }
  if (compareTimestampEpoch(binding.state.updatedAt, event.at) > 0) throw new Error('Exact-effect evidence cannot postdate lifecycle event');
  return binding;
}

function accepted(current, event, mutate) {
  const draft = structuredClone(current);
  mutate(draft);
  draft.revision = current.revision + 1;
  draft.lastEventId = event.eventId;
  draft.lastEventType = event.type;
  draft.lastEventEvidenceId = event.evidenceId;
  draft.lastEventAt = event.at;
  draft.updatedAt = event.at;
  Object.assign(draft, derivePhaseFlags(draft.phase));
  return deepFreeze({
    state: normalizeStateInternal(draft),
    accepted: true,
    deduplicated: false,
    reason: 'EVENT_ACCEPTED',
  });
}

function rejected(current, reason) {
  return deepFreeze({
    state: current,
    accepted: false,
    deduplicated: false,
    reason,
  });
}

export function reduceDeploymentLifecycleV1(stateInput, eventInput, {
  resolveVerificationBinding = null,
  resolveEffectBinding = null,
} = {}) {
  const current = normalizeStateInternal(stateInput);
  const event = normalizeEvent(eventInput);
  if (event.deploymentId !== current.deploymentId) throw new Error('Deployment event deploymentId mismatch');

  if (event.eventId === current.lastEventId) {
    const exactReplay = event.previousRevision === current.revision - 1
      && event.type === current.lastEventType
      && event.evidenceId === current.lastEventEvidenceId
      && event.at === current.lastEventAt;
    if (!exactReplay) {
      throw new Error('Deployment event idempotency conflict for lastEventId');
    }
    return deepFreeze({
      state: current,
      accepted: true,
      deduplicated: true,
      reason: 'DUPLICATE_LAST_EVENT',
    });
  }
  if (event.previousRevision !== current.revision) {
    throw new Error('Deployment event previousRevision mismatch');
  }
  if (compareTimestampEpoch(event.at, current.updatedAt) < 0) throw new Error('Deployment lifecycle event cannot predate durable state');

  if (event.type === DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION) {
    if (current.phase !== DeploymentPhase.PREVIEW) {
      return rejected(current, 'QUALIFICATION_PHASE_CLOSED');
    }
    const binding = resolveVerification(
      resolveVerificationBinding,
      event,
      current,
      QUALIFICATION_KINDS,
      current.candidateArtifactRef,
    );
    if (binding.verification.status !== VerificationStatus.VERIFIED) {
      return rejected(current, 'QUALIFICATION_REQUIRES_VERIFIED_EVIDENCE');
    }
    if (compareTimestampEpoch(binding.verification.verifiedAt, current.candidateArtifactRef.createdAt) < 0) {
      throw new Error('Qualification verification predates candidate materialization');
    }
    if (current.qualificationEvidence.some(item => item.checkKind === binding.checkKind)) {
      return rejected(current, 'QUALIFICATION_KIND_ALREADY_RECORDED');
    }
    return accepted(current, event, draft => {
      draft.qualificationEvidence.push({
        checkKind: binding.checkKind,
        verificationId: binding.verification.verificationId,
        verifierId: binding.verification.verifierId,
        verifiedAt: binding.verification.verifiedAt,
      });
      draft.qualificationEvidence.sort((a, b) => compareCodeUnits(a.checkKind, b.checkKind));
      if (draft.qualificationEvidence.length === QUALIFICATION_KINDS.size) {
        draft.qualifiedAt = maxTimestamp(draft.qualificationEvidence.map(item => item.verifiedAt));
        draft.phase = DeploymentPhase.QUALIFIED;
      }
    });
  }

  if (event.type === DeploymentEventType.RECORD_PUBLISH_EFFECT) {
    if (current.phase !== DeploymentPhase.QUALIFIED) return rejected(current, 'PUBLISH_REQUIRES_QUALIFIED');
    const binding = resolveEffect(
      resolveEffectBinding,
      event,
      current,
      DeploymentEffectKind.PUBLISH,
      current.candidateArtifactRef,
      current.publishEffectId,
    );
    const effectObservedAt = binding.state.observation.observedAt;
    if (compareTimestampEpoch(effectObservedAt, current.qualifiedAt) < 0) {
      throw new Error('Publish exact-effect observation predates completed qualification');
    }
    return accepted(current, event, draft => {
      draft.phase = DeploymentPhase.PUBLISHED_UNVERIFIED;
      draft.publishedAt = effectObservedAt;
      draft.publishCommitId = binding.state.commitId;
    });
  }

  if (event.type === DeploymentEventType.RECORD_HEALTH_VERIFICATION) {
    if (![DeploymentPhase.PUBLISHED_UNVERIFIED, DeploymentPhase.HEALTHY, DeploymentPhase.DEGRADED].includes(current.phase)) {
      return rejected(current, 'HEALTH_CHECK_REQUIRES_PUBLISHED_DEPLOYMENT');
    }
    const binding = resolveVerification(
      resolveVerificationBinding,
      event,
      current,
      HEALTH_KINDS,
      current.candidateArtifactRef,
    );
    if (binding.verification.status === VerificationStatus.NOT_APPLICABLE) {
      return rejected(current, 'PRODUCTION_HEALTH_CANNOT_BE_NOT_APPLICABLE');
    }
    if (compareTimestampEpoch(binding.verification.verifiedAt, current.publishedAt) < 0) {
      throw new Error('Production health verification predates publish');
    }
    const prior = current.healthEvidence.find(item => item.checkKind === binding.checkKind);
    if (prior && compareTimestampEpoch(binding.verification.verifiedAt, prior.verifiedAt) <= 0) {
      return rejected(current, 'HEALTH_EVIDENCE_NOT_NEWER');
    }
    return accepted(current, event, draft => {
      const next = {
        checkKind: binding.checkKind,
        verificationId: binding.verification.verificationId,
        verifierId: binding.verification.verifierId,
        status: binding.verification.status,
        verifiedAt: binding.verification.verifiedAt,
      };
      const index = draft.healthEvidence.findIndex(item => item.checkKind === binding.checkKind);
      if (index >= 0) draft.healthEvidence[index] = next;
      else draft.healthEvidence.push(next);
      draft.healthEvidence.sort((a, b) => compareCodeUnits(a.checkKind, b.checkKind));

      const map = new Map(draft.healthEvidence.map(item => [item.checkKind, item]));
      const failure = [...map.values()].some(item => item.status !== VerificationStatus.VERIFIED);
      const allVerified = [...HEALTH_KINDS].every(
        kind => map.get(kind)?.status === VerificationStatus.VERIFIED,
      );
      if (failure) {
        draft.phase = DeploymentPhase.DEGRADED;
        draft.degradedAt = binding.verification.verifiedAt;
        draft.regressionCount += 1;
      } else if (allVerified) {
        draft.phase = DeploymentPhase.HEALTHY;
        draft.lastHealthyAt = maxTimestamp([...map.values()].map(item => item.verifiedAt));
        draft.degradedAt = '';
      } else {
        draft.phase = DeploymentPhase.PUBLISHED_UNVERIFIED;
      }
    });
  }

  if (event.type === DeploymentEventType.RECORD_ROLLBACK_EFFECT) {
    if (![DeploymentPhase.PUBLISHED_UNVERIFIED, DeploymentPhase.HEALTHY, DeploymentPhase.DEGRADED].includes(current.phase)) {
      return rejected(current, 'ROLLBACK_NOT_AVAILABLE_IN_PHASE');
    }
    const binding = resolveEffect(
      resolveEffectBinding,
      event,
      current,
      DeploymentEffectKind.ROLLBACK,
      current.rollbackArtifactRef,
      current.rollbackEffectId,
    );
    const effectObservedAt = binding.state.observation.observedAt;
    if (compareTimestampEpoch(effectObservedAt, current.publishedAt) < 0) {
      throw new Error('Rollback exact-effect observation predates current publish');
    }
    return accepted(current, event, draft => {
      draft.phase = DeploymentPhase.ROLLBACK_PUBLISHED_UNVERIFIED;
      draft.rollbackPublishedAt = effectObservedAt;
      draft.rollbackCommitId = binding.state.commitId;
      draft.rollbackHealth = null;
    });
  }

  if (event.type === DeploymentEventType.RECORD_ROLLBACK_VERIFICATION) {
    if (current.phase !== DeploymentPhase.ROLLBACK_PUBLISHED_UNVERIFIED) {
      return rejected(current, 'ROLLBACK_VERIFICATION_REQUIRES_ROLLBACK_PUBLISH');
    }
    const binding = resolveVerification(
      resolveVerificationBinding,
      event,
      current,
      new Set([DeploymentCheckKind.ROLLBACK_LIVE]),
      current.rollbackArtifactRef,
    );
    if (binding.verification.status === VerificationStatus.NOT_APPLICABLE) {
      return rejected(current, 'ROLLBACK_HEALTH_CANNOT_BE_NOT_APPLICABLE');
    }
    if (compareTimestampEpoch(binding.verification.verifiedAt, current.rollbackPublishedAt) < 0) {
      throw new Error('Rollback live verification predates rollback publish');
    }
    return accepted(current, event, draft => {
      draft.rollbackHealth = {
        checkKind: DeploymentCheckKind.ROLLBACK_LIVE,
        verificationId: binding.verification.verificationId,
        verifierId: binding.verification.verifierId,
        status: binding.verification.status,
        verifiedAt: binding.verification.verifiedAt,
      };
      if (binding.verification.status === VerificationStatus.VERIFIED) {
        draft.phase = DeploymentPhase.ROLLED_BACK;
        draft.rolledBackAt = binding.verification.verifiedAt;
      } else {
        draft.phase = DeploymentPhase.ROLLBACK_FAILED;
      }
    });
  }

  throw new Error('Unhandled deployment lifecycle event');
}
