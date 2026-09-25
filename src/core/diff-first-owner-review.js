import {
  VerificationStatus,
  normalizeArtifactRefV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';

export const DIFF_FIRST_OWNER_REVIEW_VERSION = 1;
export const MAX_DIFF_REVIEW_ITEMS = 128;

export const DiffReviewChangeKind = Object.freeze({
  FILE: 'FILE',
  ARTIFACT: 'ARTIFACT',
  EFFECT: 'EFFECT',
  CONFIG: 'CONFIG',
  DATA: 'DATA',
  OTHER: 'OTHER',
});

export const DiffReviewRiskSeverity = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

export const DiffReviewRollbackKind = Object.freeze({
  ROLLBACK: 'ROLLBACK',
  COMPENSATE: 'COMPENSATE',
  NONE: 'NONE',
});

const CHANGE_KINDS = new Set(Object.values(DiffReviewChangeKind));
const RISK_SEVERITIES = new Set(Object.values(DiffReviewRiskSeverity));
const ROLLBACK_KINDS = new Set(Object.values(DiffReviewRollbackKind));
const VERIFICATION_STATUSES = new Set(Object.values(VerificationStatus));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TEXT = 8_000;
const MAX_TARGET = 4_096;
const MAX_OPTION = 2_000;
const MAX_PLAIN_TEXT = 512_000;

const REVIEW_KEYS = new Set([
  'schemaVersion',
  'reviewId',
  'projectId',
  'subjectId',
  'subjectRevisionId',
  'generatedAt',
  'summary',
  'changes',
  'artifactRefs',
  'verificationRefs',
  'effectIds',
  'risks',
  'decisions',
  'rollbackOptions',
]);

const CHANGE_KEYS = new Set([
  'changeId',
  'kind',
  'target',
  'summary',
  'rationale',
  'artifactIds',
  'effectIds',
]);

const RISK_KEYS = new Set([
  'riskId',
  'severity',
  'summary',
  'evidenceArtifactIds',
]);

const DECISION_KEYS = new Set([
  'decisionId',
  'question',
  'options',
  'evidenceArtifactIds',
]);

const ROLLBACK_KEYS = new Set([
  'rollbackId',
  'kind',
  'summary',
  'referenceId',
  'evidenceArtifactIds',
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

const TRUSTED_OPTIONS_KEYS = new Set(['resolveSubjectEvidence']);
const TRUSTED_SUBJECT_EVIDENCE_KEYS = new Set([
  'schemaVersion',
  'projectId',
  'subjectId',
  'subjectRevisionId',
  'artifactRefs',
  'verificationRefs',
  'effectIds',
]);

function snapshotRecord(value, allowed, label, { requireAll = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain or null-prototype object`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }

  if (requireAll) {
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) {
        throw new Error(`${label} is missing field: ${key}`);
      }
    }
  }
  return out;
}

function denseArray(value, label, { max = MAX_DIFF_REVIEW_ITEMS, min = 0 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < min
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must contain between ${min} and ${max} items`);
  }
  const length = lengthDescriptor.value;

  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-canonical array fields`);
    }
  }

  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function canonicalId(value, label, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must be a canonical string identity`);
  }
  return value;
}

function canonicalText(value, label, {
  max = MAX_TEXT,
  allowEmpty = false,
} = {}) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || (!allowEmpty && !value)
      || value.length > max) {
    throw new Error(`${label} must be canonical bounded text`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function compareCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueIds(input, label, { min = 0 } = {}) {
  const values = denseArray(input, label, { min }).map((value, index) =>
    canonicalId(value, `${label}[${index}]`));
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} contains duplicate identity: ${value}`);
    seen.add(value);
  }
  return values.sort(compareCodeUnit);
}

function uniqueTexts(input, label, { min = 0, maxText = MAX_OPTION } = {}) {
  const values = denseArray(input, label, { min }).map((value, index) =>
    canonicalText(value, `${label}[${index}]`, { max: maxText }));
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} contains duplicate text option`);
    seen.add(value);
  }
  return values;
}

function canonicalArtifactRef(input) {
  const raw = snapshotRecord(input, ARTIFACT_KEYS, 'ArtifactRefV1');

  if (raw.schemaVersion !== 1) throw new Error('ArtifactRefV1.schemaVersion must be numeric 1');
  canonicalId(raw.artifactId, 'artifactId');
  canonicalId(raw.kind, 'artifact kind');
  canonicalText(raw.uri, 'artifact uri', { max: MAX_TARGET });
  canonicalText(raw.mediaType, 'artifact mediaType', { max: 300, allowEmpty: true });
  if (typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
    throw new Error('artifact sha256 must be an exact lowercase SHA-256');
  }
  if (!Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 0) {
    throw new Error('artifact sizeBytes must be a non-negative safe integer');
  }
  canonicalTimestamp(raw.createdAt, 'artifact createdAt');
  canonicalId(raw.producerInvocationId, 'producerInvocationId', { optional: true });
  if (typeof raw.sensitive !== 'boolean') throw new Error('artifact sensitive must be boolean');

  return normalizeArtifactRefV1(raw);
}

function canonicalVerificationRef(input) {
  const raw = snapshotRecord(input, VERIFICATION_KEYS, 'VerificationV1');

  if (raw.schemaVersion !== 1) throw new Error('VerificationV1.schemaVersion must be numeric 1');
  canonicalId(raw.verificationId, 'verificationId');
  canonicalId(raw.invocationId, 'verification invocationId');

  if (raw.observationId !== null) canonicalId(raw.observationId, 'verification observationId');
  if (typeof raw.status !== 'string' || !VERIFICATION_STATUSES.has(raw.status)) {
    throw new Error('verification status must be canonical');
  }
  if (raw.status !== VerificationStatus.NOT_APPLICABLE && raw.observationId === null) {
    throw new Error('verification observationId is required for applicable status');
  }

  canonicalId(raw.reasonCode, 'verification reasonCode');
  canonicalText(raw.summary, 'verification summary', { max: MAX_TEXT, allowEmpty: true });

  const evidenceArtifactIds = uniqueIds(
    raw.evidenceArtifactIds,
    'verification evidenceArtifactIds',
    { min: raw.status === VerificationStatus.NOT_APPLICABLE ? 0 : 1 },
  );

  canonicalTimestamp(raw.verifiedAt, 'verification verifiedAt');
  canonicalId(raw.verifierId, 'verification verifierId', { optional: true });
  canonicalId(raw.verificationAuthorityId, 'verificationAuthorityId', { optional: true });
  if (raw.verifierId === null && raw.verificationAuthorityId === null) {
    throw new Error('verification must identify verifierId or verificationAuthorityId');
  }
  canonicalId(raw.effectId, 'verification effectId', { optional: true });
  canonicalId(raw.executionId, 'verification executionId', { optional: true });
  if (!Number.isSafeInteger(raw.attempt) || raw.attempt < 0 || raw.attempt > 64) {
    throw new Error('verification attempt must be an integer from 0 to 64');
  }

  const normalized = normalizeVerificationV1({ ...raw, evidenceArtifactIds });
  return normalized;
}

function normalizeChange(input) {
  const raw = snapshotRecord(input, CHANGE_KEYS, 'DiffReviewChangeV1');
  const kind = raw.kind;
  if (typeof kind !== 'string' || !CHANGE_KINDS.has(kind)) {
    throw new Error('change kind must be canonical');
  }
  return Object.freeze({
    changeId: canonicalId(raw.changeId, 'changeId'),
    kind,
    target: canonicalText(raw.target, 'change target', { max: MAX_TARGET }),
    summary: canonicalText(raw.summary, 'change summary', { max: 2_000 }),
    rationale: canonicalText(raw.rationale, 'change rationale', { max: 4_000 }),
    artifactIds: Object.freeze(uniqueIds(raw.artifactIds, 'change artifactIds')),
    effectIds: Object.freeze(uniqueIds(raw.effectIds, 'change effectIds')),
  });
}

function normalizeRisk(input) {
  const raw = snapshotRecord(input, RISK_KEYS, 'DiffReviewRiskV1');
  if (typeof raw.severity !== 'string' || !RISK_SEVERITIES.has(raw.severity)) {
    throw new Error('risk severity must be canonical');
  }
  return Object.freeze({
    riskId: canonicalId(raw.riskId, 'riskId'),
    severity: raw.severity,
    summary: canonicalText(raw.summary, 'risk summary', { max: 4_000 }),
    evidenceArtifactIds: Object.freeze(uniqueIds(raw.evidenceArtifactIds, 'risk evidenceArtifactIds')),
  });
}

function normalizeDecision(input) {
  const raw = snapshotRecord(input, DECISION_KEYS, 'DiffReviewDecisionV1');
  return Object.freeze({
    decisionId: canonicalId(raw.decisionId, 'decisionId'),
    question: canonicalText(raw.question, 'decision question', { max: 4_000 }),
    options: Object.freeze(uniqueTexts(raw.options, 'decision options', { min: 2 })),
    evidenceArtifactIds: Object.freeze(uniqueIds(raw.evidenceArtifactIds, 'decision evidenceArtifactIds')),
  });
}

function normalizeRollback(input) {
  const raw = snapshotRecord(input, ROLLBACK_KEYS, 'DiffReviewRollbackOptionV1');
  if (typeof raw.kind !== 'string' || !ROLLBACK_KINDS.has(raw.kind)) {
    throw new Error('rollback kind must be canonical');
  }
  const referenceId = canonicalId(raw.referenceId, 'rollback referenceId', { optional: true });
  if (raw.kind === DiffReviewRollbackKind.NONE && referenceId !== null) {
    throw new Error('NONE rollback option must not carry a referenceId');
  }
  if (raw.kind !== DiffReviewRollbackKind.NONE && referenceId === null) {
    throw new Error('rollback/compensation option requires an opaque referenceId');
  }
  return Object.freeze({
    rollbackId: canonicalId(raw.rollbackId, 'rollbackId'),
    kind: raw.kind,
    summary: canonicalText(raw.summary, 'rollback summary', { max: 4_000 }),
    referenceId,
    evidenceArtifactIds: Object.freeze(uniqueIds(raw.evidenceArtifactIds, 'rollback evidenceArtifactIds')),
  });
}

function normalizeUniqueRecords(input, label, normalize, identityKey) {
  const values = denseArray(input, label).map(normalize);
  const seen = new Set();
  for (const value of values) {
    const identity = value[identityKey];
    if (seen.has(identity)) throw new Error(`${label} contains duplicate identity: ${identity}`);
    seen.add(identity);
  }
  return values.sort((a, b) => compareCodeUnit(a[identityKey], b[identityKey]));
}

function normalizeTrustedSubjectEvidenceV1(input) {
  const raw = snapshotRecord(
    input,
    TRUSTED_SUBJECT_EVIDENCE_KEYS,
    'TrustedDiffReviewSubjectEvidenceV1',
  );
  if (raw.schemaVersion !== 1) {
    throw new Error('TrustedDiffReviewSubjectEvidenceV1.schemaVersion must be numeric 1');
  }
  return Object.freeze({
    schemaVersion: 1,
    projectId: canonicalId(raw.projectId, 'trusted projectId'),
    subjectId: canonicalId(raw.subjectId, 'trusted subjectId'),
    subjectRevisionId: canonicalId(raw.subjectRevisionId, 'trusted subjectRevisionId'),
    artifactRefs: Object.freeze(normalizeUniqueRecords(
      raw.artifactRefs,
      'trusted artifactRefs',
      canonicalArtifactRef,
      'artifactId',
    )),
    verificationRefs: Object.freeze(normalizeUniqueRecords(
      raw.verificationRefs,
      'trusted verificationRefs',
      canonicalVerificationRef,
      'verificationId',
    )),
    effectIds: Object.freeze(uniqueIds(raw.effectIds, 'trusted effectIds')),
  });
}

function canonicalRecordFingerprint(value) {
  return JSON.stringify(value);
}

function bindTrustedSubjectEvidence({
  projectId,
  subjectId,
  subjectRevisionId,
  artifactRefs,
  verificationRefs,
  effectIds,
}, options) {
  if (options == null) {
    throw new Error('trusted subject evidence resolver is required');
  }
  const trustedOptions = snapshotRecord(
    options,
    TRUSTED_OPTIONS_KEYS,
    'DiffReviewTrustedOptions',
  );
  const resolver = trustedOptions.resolveSubjectEvidence;
  if (typeof resolver !== 'function') {
    throw new Error('resolveSubjectEvidence must be a trusted function');
  }

  const query = Object.freeze({ projectId, subjectId, subjectRevisionId });
  const resolved = resolver(query);
  if (resolved && typeof resolved.then === 'function') {
    throw new Error('resolveSubjectEvidence must resolve synchronously');
  }
  const trusted = normalizeTrustedSubjectEvidenceV1(resolved);

  if (trusted.projectId !== projectId
      || trusted.subjectId !== subjectId
      || trusted.subjectRevisionId !== subjectRevisionId) {
    throw new Error('trusted subject evidence does not match exact project/subject/revision');
  }

  const trustedArtifacts = new Map(
    trusted.artifactRefs.map((item) => [item.artifactId, canonicalRecordFingerprint(item)]),
  );
  for (const artifact of artifactRefs) {
    if (trustedArtifacts.get(artifact.artifactId) !== canonicalRecordFingerprint(artifact)) {
      throw new Error(
        `artifact ${artifact.artifactId} is not bound to the exact trusted subject revision`,
      );
    }
  }

  const trustedVerifications = new Map(
    trusted.verificationRefs.map(
      (item) => [item.verificationId, canonicalRecordFingerprint(item)],
    ),
  );
  for (const verification of verificationRefs) {
    if (trustedVerifications.get(verification.verificationId)
        !== canonicalRecordFingerprint(verification)) {
      throw new Error(
        `verification ${verification.verificationId} is not bound to the exact trusted subject revision`,
      );
    }
  }

  const trustedEffects = new Set(trusted.effectIds);
  for (const effectId of effectIds) {
    if (!trustedEffects.has(effectId)) {
      throw new Error(`effect ${effectId} is not bound to the exact trusted subject revision`);
    }
  }
}

function requireKnownIds(values, known, label) {
  for (const value of values) {
    if (!known.has(value)) throw new Error(`${label} references unknown identity: ${value}`);
  }
}

function riskRank(severity) {
  return {
    [DiffReviewRiskSeverity.CRITICAL]: 0,
    [DiffReviewRiskSeverity.HIGH]: 1,
    [DiffReviewRiskSeverity.MEDIUM]: 2,
    [DiffReviewRiskSeverity.LOW]: 3,
  }[severity];
}

function buildPlainText(review) {
  const lines = [
    `Owner review: ${review.subjectId} @ ${review.subjectRevisionId}`,
    `Project: ${review.projectId}`,
    `Review: ${review.reviewId}`,
    `Generated: ${review.generatedAt}`,
    `Summary: ${review.summary}`,
    'Subject evidence binding: exact trusted project/subject/revision resolver',
    '',
    `What changed (${review.changes.length})`,
  ];

  if (review.changes.length === 0) {
    lines.push('- None declared.');
  } else {
    for (const change of review.changes) {
      lines.push(
        `- [${change.kind}] ${change.target} — ${change.summary}`,
        `  Why: ${change.rationale}`,
        `  Artifacts: ${change.artifactIds.length ? change.artifactIds.join(', ') : 'none'}`,
        `  Effects: ${change.effectIds.length ? change.effectIds.join(', ') : 'none'}`,
      );
    }
  }

  lines.push('', `Artifacts (${review.artifactRefs.length})`);
  if (review.artifactRefs.length === 0) {
    lines.push('- None.');
  } else {
    for (const artifact of review.artifactRefs) {
      lines.push(
        `- ${artifact.artifactId}: ${artifact.kind}; sha256=${artifact.sha256}; sensitive=${artifact.sensitive ? 'yes' : 'no'}`,
        `  URI: ${artifact.sensitive ? '[sensitive URI redacted from plain text]' : artifact.uri}`,
      );
    }
  }

  lines.push('', `Effects changed (${review.effectIds.length})`);
  lines.push(review.effectIds.length ? `- ${review.effectIds.join(', ')}` : '- None.');

  lines.push('', `Verification results (${review.verificationRefs.length})`);
  if (review.verificationRefs.length === 0) {
    lines.push('- None.');
  } else {
    for (const verification of review.verificationRefs) {
      const verifier = verification.verifierId
        || verification.verificationAuthorityId
        || 'unidentified';
      lines.push(
        `- [${verification.status}] ${verification.verificationId}; verifier=${verifier}; reason=${verification.reasonCode}`,
        `  Summary: ${verification.summary || 'none'}`,
        `  Evidence: ${verification.evidenceArtifactIds.length ? verification.evidenceArtifactIds.join(', ') : 'none'}`,
        `  Effect: ${verification.effectId || 'none'}`,
      );
    }
  }

  lines.push('', `Unresolved risks (${review.risks.length})`);
  if (review.risks.length === 0) {
    lines.push('- None.');
  } else {
    for (const risk of review.risks) {
      lines.push(
        `- [${risk.severity}] ${risk.riskId}: ${risk.summary}`,
        `  Evidence: ${risk.evidenceArtifactIds.length ? risk.evidenceArtifactIds.join(', ') : 'none'}`,
      );
    }
  }

  lines.push('', `Decisions needing attention (${review.decisions.length})`);
  if (review.decisions.length === 0) {
    lines.push('- None.');
  } else {
    for (const decision of review.decisions) {
      lines.push(
        `- ${decision.decisionId}: ${decision.question}`,
        `  Options: ${decision.options.join(' | ')}`,
        `  Evidence: ${decision.evidenceArtifactIds.length ? decision.evidenceArtifactIds.join(', ') : 'none'}`,
      );
    }
  }

  lines.push('', `Rollback or compensating options (${review.rollbackOptions.length})`);
  if (review.rollbackOptions.length === 0) {
    lines.push('- None declared.');
  } else {
    for (const option of review.rollbackOptions) {
      lines.push(
        `- [${option.kind}] ${option.rollbackId}: ${option.summary}`,
        `  Reference: ${option.referenceId || 'none'}`,
        `  Evidence: ${option.evidenceArtifactIds.length ? option.evidenceArtifactIds.join(', ') : 'none'}`,
      );
    }
  }

  lines.push(
    '',
    `Owner attention required: ${review.requiresOwnerAttention ? 'yes' : 'no'}`,
    `Attention reasons: ${review.attentionReasons.length ? review.attentionReasons.join(', ') : 'none'}`,
    'Authority: advisory/read-only review projection; no approval, execution, rollback, compensation, policy, store, scheduler, or recovery authority.',
  );

  const plainText = lines.join('\n');
  if (plainText.length > MAX_PLAIN_TEXT) {
    throw new Error('diff-first owner review plainText exceeds bounded size');
  }
  return plainText;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) freezeDeep(value[key]);
  return Object.freeze(value);
}

export function buildDiffFirstOwnerReviewV1(input, trustedOptions = null) {
  const raw = snapshotRecord(input, REVIEW_KEYS, 'DiffFirstOwnerReviewV1');
  if (raw.schemaVersion !== DIFF_FIRST_OWNER_REVIEW_VERSION) {
    throw new Error('DiffFirstOwnerReviewV1.schemaVersion must be numeric 1');
  }

  const reviewId = canonicalId(raw.reviewId, 'reviewId');
  const projectId = canonicalId(raw.projectId, 'projectId');
  const subjectId = canonicalId(raw.subjectId, 'subjectId');
  const subjectRevisionId = canonicalId(raw.subjectRevisionId, 'subjectRevisionId');
  const generatedAt = canonicalTimestamp(raw.generatedAt, 'generatedAt');
  const summary = canonicalText(raw.summary, 'summary', { max: MAX_TEXT });

  const artifactRefs = normalizeUniqueRecords(
    raw.artifactRefs,
    'artifactRefs',
    canonicalArtifactRef,
    'artifactId',
  );
  const artifactIds = new Set(artifactRefs.map((artifact) => artifact.artifactId));
  const artifactById = new Map(artifactRefs.map((artifact) => [artifact.artifactId, artifact]));
  for (const artifact of artifactRefs) {
    if (Date.parse(artifact.createdAt) > Date.parse(generatedAt)) {
      throw new Error(`artifact ${artifact.artifactId} createdAt is after review generatedAt`);
    }
  }

  const effectIds = uniqueIds(raw.effectIds, 'effectIds');

  const verificationRefs = normalizeUniqueRecords(
    raw.verificationRefs,
    'verificationRefs',
    canonicalVerificationRef,
    'verificationId',
  );

  for (const verification of verificationRefs) {
    requireKnownIds(
      verification.evidenceArtifactIds,
      artifactIds,
      `verification ${verification.verificationId} evidenceArtifactIds`,
    );
    for (const artifactId of verification.evidenceArtifactIds) {
      const artifact = artifactById.get(artifactId);
      if (Date.parse(artifact.createdAt) > Date.parse(verification.verifiedAt)) {
        throw new Error(
          `verification ${verification.verificationId} references evidence created after verifiedAt: ${artifactId}`,
        );
      }
    }
    if (verification.effectId && !effectIds.includes(verification.effectId)) {
      throw new Error(
        `verification ${verification.verificationId} references unknown effectId: ${verification.effectId}`,
      );
    }
    if (Date.parse(verification.verifiedAt) > Date.parse(generatedAt)) {
      throw new Error(
        `verification ${verification.verificationId} verifiedAt is after review generatedAt`,
      );
    }
  }

  bindTrustedSubjectEvidence({
    projectId,
    subjectId,
    subjectRevisionId,
    artifactRefs,
    verificationRefs,
    effectIds,
  }, trustedOptions);

  const changes = normalizeUniqueRecords(raw.changes, 'changes', normalizeChange, 'changeId');
  const risks = normalizeUniqueRecords(raw.risks, 'risks', normalizeRisk, 'riskId')
    .sort((a, b) => riskRank(a.severity) - riskRank(b.severity)
      || compareCodeUnit(a.riskId, b.riskId));
  const decisions = normalizeUniqueRecords(
    raw.decisions,
    'decisions',
    normalizeDecision,
    'decisionId',
  );
  const rollbackOptions = normalizeUniqueRecords(
    raw.rollbackOptions,
    'rollbackOptions',
    normalizeRollback,
    'rollbackId',
  );

  for (const change of changes) {
    requireKnownIds(change.artifactIds, artifactIds, `change ${change.changeId} artifactIds`);
    requireKnownIds(change.effectIds, new Set(effectIds), `change ${change.changeId} effectIds`);
  }
  for (const risk of risks) {
    requireKnownIds(
      risk.evidenceArtifactIds,
      artifactIds,
      `risk ${risk.riskId} evidenceArtifactIds`,
    );
  }
  for (const decision of decisions) {
    requireKnownIds(
      decision.evidenceArtifactIds,
      artifactIds,
      `decision ${decision.decisionId} evidenceArtifactIds`,
    );
  }
  for (const option of rollbackOptions) {
    requireKnownIds(
      option.evidenceArtifactIds,
      artifactIds,
      `rollback ${option.rollbackId} evidenceArtifactIds`,
    );
  }

  const attentionReasons = [];
  if (decisions.length) attentionReasons.push('DECISIONS');
  if (risks.some((risk) =>
    risk.severity === DiffReviewRiskSeverity.HIGH
    || risk.severity === DiffReviewRiskSeverity.CRITICAL)) {
    attentionReasons.push('HIGH_RISK');
  }
  if (verificationRefs.some((verification) =>
    verification.status === VerificationStatus.FAILED
    || verification.status === VerificationStatus.AMBIGUOUS)) {
    attentionReasons.push('VERIFICATION_EXCEPTION');
  }

  const review = {
    schemaVersion: DIFF_FIRST_OWNER_REVIEW_VERSION,
    reviewId,
    projectId,
    subjectId,
    subjectRevisionId,
    generatedAt,
    summary,
    subjectEvidenceBound: true,
    advisoryOnly: true,
    approvalAuthorized: false,
    executionAuthorized: false,
    rollbackAuthorized: false,
    changes,
    artifactRefs,
    verificationRefs,
    effectIds,
    risks,
    decisions,
    rollbackOptions,
    requiresOwnerAttention: attentionReasons.length > 0,
    attentionReasons,
    counts: {
      changes: changes.length,
      artifacts: artifactRefs.length,
      effects: effectIds.length,
      verifications: verificationRefs.length,
      risks: risks.length,
      decisions: decisions.length,
      rollbackOptions: rollbackOptions.length,
    },
  };

  review.plainText = buildPlainText(review);
  return freezeDeep(review);
}
