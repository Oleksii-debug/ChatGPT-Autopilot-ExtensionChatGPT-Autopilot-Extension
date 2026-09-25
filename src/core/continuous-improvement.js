import {
  VerificationStatus,
  normalizeArtifactRefV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';
import {
  BenchmarkEvaluationStatus,
  evaluateBenchmarkRunV1,
} from './benchmark-evaluation.js';

export const CONTINUOUS_IMPROVEMENT_VERSION = 1;

export const ContinuousImprovementKind = Object.freeze({
  PROCEDURE: 'PROCEDURE',
  ROUTING: 'ROUTING',
  VERIFIER: 'VERIFIER',
  CONTEXT: 'CONTEXT',
  SKILL: 'SKILL',
});

export const ContinuousImprovementTriggerKind = Object.freeze({
  ACCEPTED_WORK: 'ACCEPTED_WORK',
  FAILURE_SIGNATURE: 'FAILURE_SIGNATURE',
  NEGATIVE_EVALUATION: 'NEGATIVE_EVALUATION',
  DRIFT: 'DRIFT',
});

export const ContinuousImprovementGateStatus = Object.freeze({
  READY_FOR_OWNER_REVIEW: 'READY_FOR_OWNER_REVIEW',
  BENCHMARK_REJECTED: 'BENCHMARK_REJECTED',
});

const KINDS = new Set(Object.values(ContinuousImprovementKind));
const TRIGGERS = new Set(Object.values(ContinuousImprovementTriggerKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TEXT = 16_000;
const MAX_ARTIFACTS = 128;

const CANDIDATE_KEYS = new Set([
  'schemaVersion',
  'improvementId',
  'projectId',
  'kind',
  'triggerKind',
  'title',
  'rationale',
  'actorId',
  'independentVerifierId',
  'baselineSubjectId',
  'baselineRevisionId',
  'baselineSha256',
  'proposalSubjectId',
  'proposalRevisionId',
  'proposalArtifact',
  'evidenceArtifacts',
  'sourceVerification',
  'benchmarkSuiteId',
  'benchmarkSuiteRevisionId',
  'createdAt',
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

const VERIFICATION_KEYS = new Set([
  'schemaVersion',
  'verificationId',
  'invocationId',
  'observationId',
  'status',
  'reasonCode',
  'summary',
  'evidenceArtifactIds',
  'verifiedAt',
  'verifierId',
  'verificationAuthorityId',
  'effectId',
  'executionId',
  'attempt',
]);

const ASSESSMENT_KEYS = new Set([
  'candidate',
  'suite',
  'run',
  'trustedExecution',
  'trustedEvidenceArtifacts',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' contains symbol field');
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    Object.defineProperty(out, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
  }
}

function denseArray(value, label, { min = 0, max = MAX_ARTIFACTS } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < min
      || lengthDescriptor.value > max) {
    throw new Error(label + ' must contain ' + min + '-' + max + ' items');
  }
  const length = lengthDescriptor.value;
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) {
      throw new Error(label + ' contains non-index array data');
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
      throw new Error(label + ' entries must be enumerable own data properties');
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' must be a dense data-only array');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function exactText(value, label, max = MAX_TEXT) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(label + ' must use bounded exact text');
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(label + ' must be an exact lowercase SHA-256 digest');
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function exactEnum(value, allowed, label) {
  if (typeof value !== 'string' || value !== value.trim() || !allowed.has(value)) {
    throw new Error(label + ' must use exact canonical enum representation');
  }
  return value;
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeExactArtifactRef(input, label) {
  const raw = record(input, label);
  exactKeys(raw, ARTIFACT_KEYS, label);
  const artifact = normalizeArtifactRefV1(raw);
  const exactFields = ['artifactId', 'kind', 'uri', 'createdAt'];
  for (const field of exactFields) {
    if (raw[field] !== artifact[field]) {
      throw new Error(label + '.' + field + ' must use exact canonical representation');
    }
  }
  if (raw.sha256 !== artifact.sha256 || !artifact.sha256) {
    throw new Error(label + '.sha256 must be an exact lowercase SHA-256 digest');
  }
  if (raw.mediaType != null && raw.mediaType !== artifact.mediaType) {
    throw new Error(label + '.mediaType must use exact canonical representation');
  }
  if (raw.producerInvocationId != null && raw.producerInvocationId !== artifact.producerInvocationId) {
    throw new Error(label + '.producerInvocationId must use exact canonical representation');
  }
  if (Object.is(raw.sizeBytes, -0)) throw new Error(label + '.sizeBytes cannot be -0');
  return artifact;
}

function normalizeEvidenceArtifacts(value) {
  const raw = denseArray(value, 'evidenceArtifacts', { min: 1, max: MAX_ARTIFACTS });
  const artifacts = raw
    .map((item, index) => normalizeExactArtifactRef(item, 'evidenceArtifacts[' + index + ']'))
    .sort((a, b) => asciiCompare(a.artifactId, b.artifactId));
  const ids = new Set();
  for (const artifact of artifacts) {
    if (ids.has(artifact.artifactId)) {
      throw new Error('evidenceArtifacts contains duplicate artifactId: ' + artifact.artifactId);
    }
    ids.add(artifact.artifactId);
  }
  return artifacts;
}

function normalizeExactVerification(input) {
  const raw = record(input, 'sourceVerification');
  exactKeys(raw, VERIFICATION_KEYS, 'sourceVerification');
  const verification = normalizeVerificationV1(raw);
  const exactFields = [
    'verificationId',
    'invocationId',
    'observationId',
    'status',
    'reasonCode',
    'verifiedAt',
    'verifierId',
    'verificationAuthorityId',
  ];
  for (const field of exactFields) {
    if (raw[field] !== verification[field]) {
      throw new Error('sourceVerification.' + field + ' must use exact canonical representation');
    }
  }
  if (verification.status !== VerificationStatus.VERIFIED) {
    throw new Error('sourceVerification must be VERIFIED');
  }
  if (!verification.verifierId || !verification.verificationAuthorityId) {
    throw new Error('sourceVerification requires verifierId and verificationAuthorityId');
  }
  return verification;
}

export function normalizeContinuousImprovementCandidateV1(input) {
  const raw = record(input, 'ContinuousImprovementCandidateV1');
  exactKeys(raw, CANDIDATE_KEYS, 'ContinuousImprovementCandidateV1');
  if (raw.schemaVersion !== CONTINUOUS_IMPROVEMENT_VERSION) {
    throw new Error('Unsupported ContinuousImprovementCandidateV1 schemaVersion');
  }

  const improvementId = id(raw.improvementId, 'improvementId');
  const projectId = id(raw.projectId, 'projectId');
  const kind = exactEnum(raw.kind, KINDS, 'kind');
  const triggerKind = exactEnum(raw.triggerKind, TRIGGERS, 'triggerKind');
  const actorId = id(raw.actorId, 'actorId');
  const independentVerifierId = id(raw.independentVerifierId, 'independentVerifierId');
  if (actorId === independentVerifierId) {
    throw new Error('independentVerifierId must differ from actorId');
  }

  const baselineSubjectId = id(raw.baselineSubjectId, 'baselineSubjectId');
  const proposalSubjectId = id(raw.proposalSubjectId, 'proposalSubjectId');
  if (baselineSubjectId !== proposalSubjectId) {
    throw new Error('proposalSubjectId must match baselineSubjectId');
  }
  const baselineRevisionId = id(raw.baselineRevisionId, 'baselineRevisionId');
  const proposalRevisionId = id(raw.proposalRevisionId, 'proposalRevisionId');
  if (baselineRevisionId === proposalRevisionId) {
    throw new Error('proposalRevisionId must differ from baselineRevisionId');
  }
  const baselineSha256 = digest(raw.baselineSha256, 'baselineSha256');

  const proposalArtifact = normalizeExactArtifactRef(raw.proposalArtifact, 'proposalArtifact');
  if (proposalArtifact.sha256 === baselineSha256) {
    throw new Error('proposalArtifact must materially differ from baselineSha256');
  }

  const createdAt = timestamp(raw.createdAt, 'createdAt');
  if (Date.parse(proposalArtifact.createdAt) > Date.parse(createdAt)) {
    throw new Error('proposalArtifact cannot be created after improvement candidate');
  }

  const evidenceArtifacts = normalizeEvidenceArtifacts(raw.evidenceArtifacts);
  const sourceVerification = normalizeExactVerification(raw.sourceVerification);
  if (sourceVerification.verifierId !== independentVerifierId) {
    throw new Error('sourceVerification verifierId does not match independentVerifierId');
  }
  if (Date.parse(sourceVerification.verifiedAt) > Date.parse(createdAt)) {
    throw new Error('sourceVerification cannot postdate improvement candidate');
  }

  const evidenceIds = evidenceArtifacts.map((artifact) => artifact.artifactId);
  const verificationIds = [...sourceVerification.evidenceArtifactIds].sort(asciiCompare);
  if (verificationIds.length !== evidenceIds.length
      || verificationIds.some((value, index) => value !== evidenceIds[index])) {
    throw new Error('sourceVerification evidenceArtifactIds must exactly cover evidenceArtifacts');
  }
  for (const artifact of evidenceArtifacts) {
    if (Date.parse(artifact.createdAt) > Date.parse(sourceVerification.verifiedAt)) {
      throw new Error('evidence artifact cannot postdate sourceVerification');
    }
  }

  const benchmarkSuiteId = id(raw.benchmarkSuiteId, 'benchmarkSuiteId');
  const benchmarkSuiteRevisionId = id(
    raw.benchmarkSuiteRevisionId,
    'benchmarkSuiteRevisionId',
  );

  return deepFreeze({
    schemaVersion: CONTINUOUS_IMPROVEMENT_VERSION,
    improvementId,
    projectId,
    kind,
    triggerKind,
    title: exactText(raw.title, 'title', 1000),
    rationale: exactText(raw.rationale, 'rationale'),
    actorId,
    independentVerifierId,
    baselineSubjectId,
    baselineRevisionId,
    baselineSha256,
    proposalSubjectId,
    proposalRevisionId,
    proposalArtifact,
    evidenceArtifacts,
    sourceVerification,
    benchmarkSuiteId,
    benchmarkSuiteRevisionId,
    benchmarkSubjectId: proposalArtifact.artifactId,
    benchmarkSubjectRevisionId: 'sha256:' + proposalArtifact.sha256,
    createdAt,
    sourceVerificationTrust: 'UNVERIFIED_REFERENCE',
    requiresTrustedBenchmark: true,
    requiresOwnerReview: true,
    promotionAuthorized: false,
    executionAuthorized: false,
    policyMutationAuthorized: false,
    recipePromotionAuthorized: false,
    skillPromotionAuthorized: false,
  });
}

export function assessContinuousImprovementCandidateV1(input) {
  const raw = record(input, 'ContinuousImprovementAssessmentRequestV1');
  exactKeys(raw, ASSESSMENT_KEYS, 'ContinuousImprovementAssessmentRequestV1');
  const candidate = normalizeContinuousImprovementCandidateV1(raw.candidate);

  const report = evaluateBenchmarkRunV1({
    suite: raw.suite,
    run: raw.run,
    expectedSubject: {
      subjectId: candidate.benchmarkSubjectId,
      subjectRevisionId: candidate.benchmarkSubjectRevisionId,
    },
    trustedExecution: raw.trustedExecution,
    trustedEvidenceArtifacts: raw.trustedEvidenceArtifacts,
  });

  if (report.suiteId !== candidate.benchmarkSuiteId
      || report.suiteRevisionId !== candidate.benchmarkSuiteRevisionId) {
    throw new Error('benchmark suite identity/revision does not match improvement candidate');
  }
  if (Date.parse(report.startedAt) < Date.parse(candidate.proposalArtifact.createdAt)) {
    throw new Error('benchmark cannot start before proposalArtifact exists');
  }

  const benchmarkPassed = report.status === BenchmarkEvaluationStatus.PASS;
  return deepFreeze({
    schemaVersion: CONTINUOUS_IMPROVEMENT_VERSION,
    improvementId: candidate.improvementId,
    projectId: candidate.projectId,
    kind: candidate.kind,
    baselineSubjectId: candidate.baselineSubjectId,
    baselineRevisionId: candidate.baselineRevisionId,
    baselineSha256: candidate.baselineSha256,
    proposalSubjectId: candidate.proposalSubjectId,
    proposalRevisionId: candidate.proposalRevisionId,
    proposalSha256: candidate.proposalArtifact.sha256,
    benchmarkRunId: report.runId,
    benchmarkSuiteId: report.suiteId,
    benchmarkSuiteRevisionId: report.suiteRevisionId,
    benchmarkSubjectId: report.subjectId,
    benchmarkSubjectRevisionId: report.subjectRevisionId,
    benchmarkStatus: report.status,
    benchmarkCaseCount: report.caseCount,
    benchmarkPassedCaseCount: report.passedCaseCount,
    benchmarkFailedCaseCount: report.failedCaseCount,
    gateStatus: benchmarkPassed
      ? ContinuousImprovementGateStatus.READY_FOR_OWNER_REVIEW
      : ContinuousImprovementGateStatus.BENCHMARK_REJECTED,
    requiresOwnerReview: true,
    requiresCanonicalPromotionAuthority: true,
    promotionAuthorized: false,
    executionAuthorized: false,
    policyMutationAuthorized: false,
    recipePromotionAuthorized: false,
    skillPromotionAuthorized: false,
  });
}
