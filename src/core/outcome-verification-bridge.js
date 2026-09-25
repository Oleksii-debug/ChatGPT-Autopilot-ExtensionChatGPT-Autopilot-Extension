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
const MAX_TEXT = 16_000;
const REQUEST_KEYS = new Set([
  'contract',
  'criterionVerifications',
  'evaluatedAt',
]);
const ROW_KEYS = new Set([
  'criterionId',
  'verificationId',
]);
const TRUSTED_RECORD_KEYS = new Set([
  'schemaVersion',
  'recordId',
  'contractId',
  'contractRevision',
  'verifierPlanId',
  'criterion',
  'verifierId',
  'verificationAuthorityId',
  'verification',
  'evidenceArtifacts',
  'recordedAt',
  'validThrough',
]);
const TRUSTED_CRITERION_KEYS = new Set([
  'criterionId',
  'description',
  'observable',
  'requiredEvidenceKinds',
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

function exactText(value, label, max = MAX_TEXT) {
  if (typeof value !== 'string'
    || value !== value.trim()
    || !value
    || value.length > max) {
    throw new Error(label + ' must be bounded exact text');
  }
  return value;
}

function exactInteger(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < min
    || value > max) {
    throw new Error(label + ' must be an exact integer');
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

function compareTimestamp(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return leftMs < rightMs ? -1 : leftMs > rightMs ? 1 : 0;
}

function compareCodeUnit(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactIdList(value, label, { min = 0, max = MAX_ITEMS } = {}) {
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
    throw new Error(label + ' must exactly match trusted identity');
  }
}

function sameNormalizedValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!sameNormalizedValue(left[index], right[index])) return false;
    }
    return true;
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
    const key = leftKeys[index];
    if (!sameNormalizedValue(left[key], right[key])) return false;
  }
  return true;
}

function assertCanonicalOutcomeContractMatches(trustedContract, requestedContract) {
  if (!sameNormalizedValue(trustedContract, requestedContract)) {
    throw new Error(
      'Trusted canonical Outcome Contract does not match the requested exact contract revision semantics',
    );
  }
}

function normalizeTrustedCriterion(input) {
  const raw = record(input, 'TrustedOutcomeCriterionV1');
  exactKeys(raw, TRUSTED_CRITERION_KEYS, 'TrustedOutcomeCriterionV1');
  return deepFreeze({
    criterionId: exactId(raw.criterionId, 'trusted criterionId'),
    description: exactText(raw.description, 'trusted criterion description', 8_000),
    observable: exactText(raw.observable, 'trusted criterion observable', 8_000),
    requiredEvidenceKinds: exactIdList(
      raw.requiredEvidenceKinds,
      'trusted criterion requiredEvidenceKinds',
      { min: 1, max: 32 },
    ),
  });
}

function assertTrustedCriterionMatches(actual, expected) {
  if (actual.criterionId !== expected.criterionId
    || actual.description !== expected.description
    || actual.observable !== expected.observable) {
    throw new Error('Trusted verification record criterion does not match the exact outcome criterion');
  }
  exactSet(
    actual.requiredEvidenceKinds,
    expected.requiredEvidenceKinds,
    'Trusted verification criterion requiredEvidenceKinds',
  );
}

function normalizeTrustedEvidenceArtifacts(value, verification) {
  const items = denseArray(value, 'TrustedVerificationRecordV1 evidenceArtifacts', {
    min: 0,
    max: MAX_ITEMS,
  });
  const byId = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const artifact = normalizeArtifactRefV1(items[index]);
    if (!artifact.sha256) {
      throw new Error(
        'Trusted verification evidence artifact must have sha256: ' + artifact.artifactId,
      );
    }
    if (byId.has(artifact.artifactId)) {
      throw new Error(
        'Trusted verification record contains duplicate artifactId: ' + artifact.artifactId,
      );
    }
    byId.set(artifact.artifactId, artifact);
  }
  exactSet(
    byId.keys(),
    verification.evidenceArtifactIds,
    'Trusted verification evidenceArtifactIds',
  );
  return byId;
}

function normalizeTrustedVerificationRecord(input) {
  const raw = record(input, 'TrustedVerificationRecordV1');
  exactKeys(raw, TRUSTED_RECORD_KEYS, 'TrustedVerificationRecordV1');
  if (raw.schemaVersion !== OUTCOME_VERIFICATION_BRIDGE_VERSION) {
    throw new Error('Unsupported TrustedVerificationRecordV1 schemaVersion');
  }

  const verification = normalizeVerificationV1(raw.verification);
  const verifierId = exactId(raw.verifierId, 'trusted verifierId');
  const verificationAuthorityId = exactId(
    raw.verificationAuthorityId,
    'trusted verificationAuthorityId',
  );
  if (verification.verifierId !== verifierId) {
    throw new Error('Trusted verification record verifierId binding is mismatched');
  }
  if (verification.verificationAuthorityId !== verificationAuthorityId) {
    throw new Error('Trusted verification record verificationAuthorityId binding is mismatched');
  }

  const recordedAt = canonicalTimestamp(raw.recordedAt, 'trusted record recordedAt');
  const validThrough = canonicalTimestamp(raw.validThrough, 'trusted record validThrough');
  if (compareTimestamp(recordedAt, verification.verifiedAt) < 0) {
    throw new Error('Trusted verification record predates its verification');
  }
  if (compareTimestamp(validThrough, recordedAt) < 0) {
    throw new Error('Trusted verification record validity interval is invalid');
  }

  const evidenceArtifacts = normalizeTrustedEvidenceArtifacts(
    raw.evidenceArtifacts,
    verification,
  );

  return deepFreeze({
    schemaVersion: OUTCOME_VERIFICATION_BRIDGE_VERSION,
    recordId: exactId(raw.recordId, 'trusted recordId'),
    contractId: exactId(raw.contractId, 'trusted contractId'),
    contractRevision: exactInteger(raw.contractRevision, 'trusted contractRevision'),
    verifierPlanId: exactId(raw.verifierPlanId, 'trusted verifierPlanId'),
    criterion: normalizeTrustedCriterion(raw.criterion),
    verifierId,
    verificationAuthorityId,
    verification,
    evidenceArtifacts: [...evidenceArtifacts.values()],
    recordedAt,
    validThrough,
  });
}

function normalizeRow(input, index) {
  const label = 'OutcomeCriterionVerificationRefV1[' + index + ']';
  const raw = record(input, label);
  exactKeys(raw, ROW_KEYS, label);
  return Object.freeze({
    criterionId: exactId(raw.criterionId, label + ' criterionId'),
    verificationId: exactId(raw.verificationId, label + ' verificationId'),
  });
}

function criterionResult({
  trustedRecord,
  criterion,
  contract,
  evaluatedAt,
}) {
  if (trustedRecord.contractId !== contract.contractId
    || trustedRecord.contractRevision !== contract.revision) {
    throw new Error(
      'Trusted verification record is not bound to the exact outcome contract revision',
    );
  }
  if (trustedRecord.verifierPlanId !== contract.verifierPlan.planId) {
    throw new Error('Trusted verification record verifierPlanId is mismatched');
  }
  assertTrustedCriterionMatches(trustedRecord.criterion, criterion);

  const verification = trustedRecord.verification;
  if (verification.verifierId !== contract.verifierPlan.verifierId) {
    throw new Error(
      'Trusted verification is not from the declared independent verifier',
    );
  }
  if (verification.verifierId === contract.verifierPlan.actorId) {
    throw new Error('Trusted verification cannot be attributed to the actor');
  }
  if (!verification.verificationAuthorityId
    || verification.verificationAuthorityId !== trustedRecord.verificationAuthorityId) {
    throw new Error('Trusted verification authority binding is missing or mismatched');
  }
  if (compareTimestamp(verification.verifiedAt, contract.createdAt) < 0) {
    throw new Error('Trusted verification predates the exact outcome contract');
  }
  if (compareTimestamp(verification.verifiedAt, evaluatedAt) > 0) {
    throw new Error('Trusted verification is future-dated');
  }
  if (compareTimestamp(trustedRecord.recordedAt, contract.createdAt) < 0
    || compareTimestamp(trustedRecord.recordedAt, evaluatedAt) > 0) {
    throw new Error('Trusted verification record chronology is invalid');
  }
  if (compareTimestamp(evaluatedAt, trustedRecord.validThrough) > 0) {
    throw new Error('Trusted verification record is stale');
  }

  const artifactsById = new Map(
    trustedRecord.evidenceArtifacts.map(artifact => [artifact.artifactId, artifact]),
  );
  const evidenceKinds = new Set();
  for (const artifactId of verification.evidenceArtifactIds) {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) {
      throw new Error(
        'Trusted verification references missing evidence artifact: ' + artifactId,
      );
    }
    if (compareTimestamp(artifact.createdAt, contract.createdAt) < 0) {
      throw new Error(
        'Trusted verification evidence predates the exact outcome contract: ' + artifactId,
      );
    }
    if (compareTimestamp(artifact.createdAt, verification.verifiedAt) > 0
      || compareTimestamp(artifact.createdAt, evaluatedAt) > 0) {
      throw new Error(
        'Trusted verification evidence is future-dated relative to verification: ' + artifactId,
      );
    }
    evidenceKinds.add(artifact.kind);
  }

  const missingKinds = criterion.requiredEvidenceKinds
    .filter(kind => !evidenceKinds.has(kind))
    .sort(compareCodeUnit);
  const missingArtifactCount = Math.max(
    0,
    contract.verifierPlan.requiredEvidenceArtifactCount
      - verification.evidenceArtifactIds.length,
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

  return deepFreeze({
    criterionId: criterion.criterionId,
    trustedRecordId: trustedRecord.recordId,
    verificationId: verification.verificationId,
    verificationStatus: verification.status,
    verifierId: trustedRecord.verifierId,
    verificationAuthorityId: trustedRecord.verificationAuthorityId,
    accepted,
    reasonCode,
    evidenceArtifactIds: [...verification.evidenceArtifactIds].sort(compareCodeUnit),
    evidenceKinds: [...evidenceKinds].sort(compareCodeUnit),
    missingEvidenceKinds: missingKinds,
    missingEvidenceArtifactCount: missingArtifactCount,
    verifiedAt: verification.verifiedAt,
    trustedRecordedAt: trustedRecord.recordedAt,
    trustedValidThrough: trustedRecord.validThrough,
  });
}

export async function adjudicateOutcomeVerificationV1(
  input = {},
  {
    resolveTrustedOutcomeContract,
    resolveTrustedVerificationRecord,
  } = {},
) {
  if (typeof resolveTrustedOutcomeContract !== 'function') {
    throw new Error('Canonical trusted outcome contract resolver is required');
  }
  if (typeof resolveTrustedVerificationRecord !== 'function') {
    throw new Error('Canonical trusted verification record resolver is required');
  }

  const request = record(input, 'OutcomeVerificationBridgeRequestV1');
  exactKeys(request, REQUEST_KEYS, 'OutcomeVerificationBridgeRequestV1');

  const requestedContract = normalizeOutcomeContractV1(request.contract);
  const trustedContractLookup = deepFreeze({
    contractId: requestedContract.contractId,
    contractRevision: requestedContract.revision,
  });
  const rawTrustedContract = await resolveTrustedOutcomeContract(trustedContractLookup);
  if (rawTrustedContract == null) {
    throw new Error(
      'Trusted canonical Outcome Contract was not found for contractId/revision: '
        + requestedContract.contractId
        + '/'
        + requestedContract.revision,
    );
  }
  const contract = normalizeOutcomeContractV1(rawTrustedContract);
  assertCanonicalOutcomeContractMatches(contract, requestedContract);

  const evaluatedAt = canonicalTimestamp(request.evaluatedAt, 'evaluatedAt');
  if (compareTimestamp(evaluatedAt, contract.createdAt) < 0) {
    throw new Error('evaluatedAt predates the exact outcome contract');
  }

  const rows = denseArray(
    request.criterionVerifications,
    'Outcome verification criterionVerifications',
    { min: 1 },
  ).map(normalizeRow);
  const rowIds = rows.map(row => row.criterionId);
  if (new Set(rowIds).size !== rowIds.length) {
    throw new Error(
      'Outcome verification criterionVerifications contains duplicate criterionId',
    );
  }
  exactSet(
    rowIds,
    contract.completionCriteria.map(criterion => criterion.criterionId),
    'Outcome verification criterionVerifications',
  );

  const criteriaById = new Map(
    contract.completionCriteria.map(criterion => [criterion.criterionId, criterion]),
  );
  const trustedRecordIds = new Set();
  const results = [];

  for (const row of [...rows].sort(
    (left, right) => compareCodeUnit(left.criterionId, right.criterionId),
  )) {
    const lookup = deepFreeze({
      contractId: contract.contractId,
      contractRevision: contract.revision,
      verifierPlanId: contract.verifierPlan.planId,
      criterionId: row.criterionId,
      verificationId: row.verificationId,
    });
    const rawTrustedRecord = await resolveTrustedVerificationRecord(lookup);
    if (rawTrustedRecord == null) {
      throw new Error(
        'Trusted verification record was not found for verificationId: '
          + row.verificationId,
      );
    }
    const trustedRecord = normalizeTrustedVerificationRecord(rawTrustedRecord);
    if (trustedRecord.verification.verificationId !== row.verificationId) {
      throw new Error('Trusted verification record verificationId is mismatched');
    }
    if (trustedRecord.criterion.criterionId !== row.criterionId) {
      throw new Error('Trusted verification record criterionId is mismatched');
    }
    if (trustedRecordIds.has(trustedRecord.recordId)) {
      throw new Error('Trusted verification recordId cannot be reused across criteria');
    }
    trustedRecordIds.add(trustedRecord.recordId);
    results.push(criterionResult({
      trustedRecord,
      criterion: criteriaById.get(row.criterionId),
      contract,
      evaluatedAt,
    }));
  }

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
    verificationProvenance:
      'TRUSTED_CANONICAL_VERIFICATION_RECORD_WITH_HASHED_ARTIFACT_REFS',
    trustedVerificationResolverRequired: true,
    completionEvidenceReady: evidenceReady,
    completionAuthorized: false,
    executionAuthorized: false,
    verificationAuthorityMinted: false,
    requiresCanonicalCompletionCommit: true,
  });
}
