import {
  VerificationStatus,
  normalizeArtifactRefV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';
import { normalizeOutcomeContractV1 } from './outcome-contract.js';

export const OUTCOME_VERIFICATION_BRIDGE_VERSION = 1;

export const OutcomeVerificationVerdict = Object.freeze({
  VERIFIED: 'VERIFIED',
  REOPEN: 'REOPEN',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_ITEMS = 128;
const REQUEST_KEYS = new Set([
  'contract',
  'criterionVerifications',
  'evidenceArtifacts',
  'evaluatedAt',
]);
const ROW_KEYS = new Set([
  'criterionId',
  'verification',
  'evidenceKinds',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' fields must be enumerable own data properties');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
  }
}

function denseArray(value, label, { min = 0, max = MAX_ITEMS } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < min
    || lengthDescriptor.value > max) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const length = lengthDescriptor.value;
  const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expectedKeys.has(key)) {
      throw new Error(label + ' contains non-index array property');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' must be a dense data array');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must be an exact id');
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  return value;
}

function compareCodeUnit(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueIdList(value, label, { min = 0, max = MAX_ITEMS } = {}) {
  const items = denseArray(value, label, { min, max });
  const out = items.map((item, index) => exactId(item, label + '[' + index + ']'));
  if (new Set(out).size !== out.length) {
    throw new Error(label + ' contains duplicate ids');
  }
  return Object.freeze(out.sort(compareCodeUnit));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactSet(actual, expected, label) {
  const left = [...actual].sort(compareCodeUnit);
  const right = [...expected].sort(compareCodeUnit);
  if (left.length !== right.length
    || left.some((item, index) => item !== right[index])) {
    throw new Error(label + ' must exactly cover the outcome criteria');
  }
}

function normalizeEvidenceArtifacts(value) {
  const items = denseArray(value, 'Outcome verification evidenceArtifacts', { min: 0 });
  const byId = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const artifact = normalizeArtifactRefV1(items[index]);
    if (!artifact.sha256) {
      throw new Error('Outcome verification evidence artifact must have sha256: ' + artifact.artifactId);
    }
    if (!artifact.producerInvocationId) {
      throw new Error('Outcome verification evidence artifact must have producerInvocationId: ' + artifact.artifactId);
    }
    if (byId.has(artifact.artifactId)) {
      throw new Error('Outcome verification evidenceArtifacts contains duplicate artifactId: ' + artifact.artifactId);
    }
    byId.set(artifact.artifactId, artifact);
  }
  return byId;
}

function normalizeRow(input, index) {
  const label = 'OutcomeCriterionVerificationV1[' + index + ']';
  const raw = record(input, label);
  exactKeys(raw, ROW_KEYS, label);
  return Object.freeze({
    criterionId: exactId(raw.criterionId, label + ' criterionId'),
    verification: normalizeVerificationV1(raw.verification),
    evidenceKinds: uniqueIdList(raw.evidenceKinds, label + ' evidenceKinds', { min: 0, max: 32 }),
  });
}

function criterionResult({
  row,
  criterion,
  contract,
  artifactsById,
  evaluatedAt,
  referencedArtifactIds,
}) {
  const verification = row.verification;
  if (!verification.verifierId
    || verification.verifierId !== contract.verifierPlan.verifierId) {
    throw new Error('Criterion ' + row.criterionId + ' verification is not from the declared independent verifier');
  }
  if (verification.verifierId === contract.verifierPlan.actorId) {
    throw new Error('Criterion ' + row.criterionId + ' verification cannot be attributed to the actor');
  }
  if (!verification.verificationAuthorityId) {
    throw new Error('Criterion ' + row.criterionId + ' verification lacks external verificationAuthorityId');
  }
  if (verification.verifiedAt < contract.createdAt) {
    throw new Error('Criterion ' + row.criterionId + ' verification predates the exact outcome contract');
  }
  if (verification.verifiedAt > evaluatedAt) {
    throw new Error('Criterion ' + row.criterionId + ' verification is future-dated');
  }

  for (const artifactId of verification.evidenceArtifactIds) {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) {
      throw new Error('Criterion ' + row.criterionId + ' references unknown evidence artifact: ' + artifactId);
    }
    if (artifact.producerInvocationId !== verification.invocationId) {
      throw new Error('Criterion ' + row.criterionId + ' evidence producer does not match verification invocation: ' + artifactId);
    }
    if (artifact.createdAt < contract.createdAt) {
      throw new Error('Criterion ' + row.criterionId + ' evidence predates the exact outcome contract: ' + artifactId);
    }
    if (artifact.createdAt > verification.verifiedAt || artifact.createdAt > evaluatedAt) {
      throw new Error('Criterion ' + row.criterionId + ' evidence is future-dated relative to verification: ' + artifactId);
    }
    referencedArtifactIds.add(artifactId);
  }

  const suppliedKinds = new Set(row.evidenceKinds);
  const missingKinds = criterion.requiredEvidenceKinds
    .filter(kind => !suppliedKinds.has(kind))
    .sort(compareCodeUnit);
  const missingArtifactCount = Math.max(
    0,
    contract.verifierPlan.requiredEvidenceArtifactCount - verification.evidenceArtifactIds.length,
  );

  let accepted = verification.status === VerificationStatus.VERIFIED;
  let reasonCode = verification.reasonCode;
  if (accepted && missingArtifactCount > 0) {
    accepted = false;
    reasonCode = 'EVIDENCE_ARTIFACT_COUNT_INSUFFICIENT';
  }
  if (accepted && missingKinds.length > 0) {
    accepted = false;
    reasonCode = 'EVIDENCE_KIND_INCOMPLETE';
  }
  if (!accepted && verification.status !== VerificationStatus.VERIFIED) {
    reasonCode = verification.reasonCode || 'VERIFICATION_NOT_VERIFIED';
  }

  return deepFreeze({
    criterionId: row.criterionId,
    verificationId: verification.verificationId,
    verificationStatus: verification.status,
    verificationAuthorityId: verification.verificationAuthorityId,
    accepted,
    reasonCode,
    evidenceArtifactIds: [...verification.evidenceArtifactIds].sort(compareCodeUnit),
    evidenceKinds: [...row.evidenceKinds],
    missingEvidenceKinds: missingKinds,
    missingEvidenceArtifactCount: missingArtifactCount,
    verifiedAt: verification.verifiedAt,
  });
}

export function adjudicateOutcomeVerificationV1(input = {}) {
  const request = record(input, 'OutcomeVerificationBridgeRequestV1');
  exactKeys(request, REQUEST_KEYS, 'OutcomeVerificationBridgeRequestV1');

  const contract = normalizeOutcomeContractV1(request.contract);
  const evaluatedAt = canonicalTimestamp(request.evaluatedAt, 'evaluatedAt');
  if (evaluatedAt < contract.createdAt) {
    throw new Error('evaluatedAt predates the exact outcome contract');
  }

  const artifactsById = normalizeEvidenceArtifacts(request.evidenceArtifacts);
  const rows = denseArray(
    request.criterionVerifications,
    'Outcome verification criterionVerifications',
    { min: 1 },
  ).map(normalizeRow);

  const rowIds = rows.map(row => row.criterionId);
  if (new Set(rowIds).size !== rowIds.length) {
    throw new Error('Outcome verification criterionVerifications contains duplicate criterionId');
  }
  exactSet(
    rowIds,
    contract.completionCriteria.map(criterion => criterion.criterionId),
    'Outcome verification criterionVerifications',
  );

  const criteriaById = new Map(
    contract.completionCriteria.map(criterion => [criterion.criterionId, criterion]),
  );
  const referencedArtifactIds = new Set();
  const results = rows
    .sort((left, right) => compareCodeUnit(left.criterionId, right.criterionId))
    .map(row => criterionResult({
      row,
      criterion: criteriaById.get(row.criterionId),
      contract,
      artifactsById,
      evaluatedAt,
      referencedArtifactIds,
    }));

  const suppliedArtifactIds = [...artifactsById.keys()].sort(compareCodeUnit);
  const referenced = [...referencedArtifactIds].sort(compareCodeUnit);
  exactSet(referenced, suppliedArtifactIds, 'Outcome verification evidenceArtifacts');

  const reopenCriterionIds = results
    .filter(result => !result.accepted)
    .map(result => result.criterionId);
  const verifiedCriteria = results.length - reopenCriterionIds.length;
  const evidenceReady = reopenCriterionIds.length === 0;

  return deepFreeze({
    schemaVersion: OUTCOME_VERIFICATION_BRIDGE_VERSION,
    contractId: contract.contractId,
    contractRevision: contract.revision,
    verifierPlanId: contract.verifierPlan.planId,
    actorId: contract.verifierPlan.actorId,
    verifierId: contract.verifierPlan.verifierId,
    evaluatedAt,
    verdict: evidenceReady
      ? OutcomeVerificationVerdict.VERIFIED
      : OutcomeVerificationVerdict.REOPEN,
    verifiedCriteria,
    totalCriteria: results.length,
    reopenCriterionIds,
    criteria: results,
    verificationProvenance: 'CANONICAL_VERIFICATION_V1_WITH_HASHED_ARTIFACT_REFS',
    completionEvidenceReady: evidenceReady,
    completionAuthorized: false,
    executionAuthorized: false,
    verificationAuthorityMinted: false,
    requiresCanonicalCompletionCommit: true,
  });
}
