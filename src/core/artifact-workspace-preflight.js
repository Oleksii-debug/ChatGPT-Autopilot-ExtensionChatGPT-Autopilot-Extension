import {
  VerificationStatus,
} from './universal-agent-contracts.js';
import {
  compareArtifactVersionsV1,
  getArtifactVersionV1,
  getCurrentArtifactVersionV1,
  normalizeArtifactRegistryV1,
} from './artifact-registry.js';
import { buildDiffFirstOwnerReviewV1 } from './diff-first-owner-review.js';
import { buildJobArtifactBundleV1 } from './job-artifact-bundle.js';

export const ARTIFACT_WORKSPACE_PREFLIGHT_VERSION = 1;
export const MAX_ARTIFACT_WORKSPACE_VALIDATIONS = 64;

export const ArtifactWorkspacePreflightStatus = Object.freeze({
  EVIDENCE_READY_FOR_OWNER_REVIEW: 'EVIDENCE_READY_FOR_OWNER_REVIEW',
  OWNER_ATTENTION_REQUIRED: 'OWNER_ATTENTION_REQUIRED',
  VALIDATION_INCOMPLETE: 'VALIDATION_INCOMPLETE',
  VALIDATION_AMBIGUOUS: 'VALIDATION_AMBIGUOUS',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const PREFLIGHT_KEYS = new Set([
  'schemaVersion',
  'preflightId',
  'projectId',
  'artifactId',
  'versionId',
  'generatedAt',
  'registry',
  'ownerReview',
  'validationVerificationIds',
  'finalBundle',
]);

function snapshotRecord(value, allowed, label) {
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
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      throw new Error(`${label} is missing field: ${key}`);
    }
  }
  return out;
}

function denseArray(value, label, { min = 0, max = MAX_ARTIFACT_WORKSPACE_VALIDATIONS } = {}) {
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
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function canonicalId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
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

function canonicalValidationIds(value) {
  const ids = denseArray(value, 'validationVerificationIds', { min: 1 })
    .map((item, index) => canonicalId(item, `validationVerificationIds[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new Error('validationVerificationIds contains duplicate identity');
  }
  return Object.freeze([...ids].sort());
}

function artifactRefEqual(left, right) {
  return left.schemaVersion === right.schemaVersion
    && left.artifactId === right.artifactId
    && left.kind === right.kind
    && left.uri === right.uri
    && left.mediaType === right.mediaType
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && left.createdAt === right.createdAt
    && left.producerInvocationId === right.producerInvocationId
    && left.sensitive === right.sensitive;
}

function deriveValidationStatus(verifications) {
  if (verifications.some(item => item.status === VerificationStatus.FAILED)) {
    return ArtifactWorkspacePreflightStatus.VALIDATION_FAILED;
  }
  if (verifications.some(item => item.status === VerificationStatus.AMBIGUOUS)) {
    return ArtifactWorkspacePreflightStatus.VALIDATION_AMBIGUOUS;
  }
  if (!verifications.length
      || verifications.some(item => item.status !== VerificationStatus.VERIFIED)) {
    return ArtifactWorkspacePreflightStatus.VALIDATION_INCOMPLETE;
  }
  return null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export function buildArtifactWorkspaceDeliveryPreflightV1(input, trustedReviewOptions = null) {
  const raw = snapshotRecord(input, PREFLIGHT_KEYS, 'ArtifactWorkspaceDeliveryPreflightV1');
  if (raw.schemaVersion !== ARTIFACT_WORKSPACE_PREFLIGHT_VERSION) {
    throw new Error('ArtifactWorkspaceDeliveryPreflightV1.schemaVersion must be numeric 1');
  }

  const preflightId = canonicalId(raw.preflightId, 'preflightId');
  const projectId = canonicalId(raw.projectId, 'projectId');
  const artifactId = canonicalId(raw.artifactId, 'artifactId');
  const versionId = canonicalId(raw.versionId, 'versionId');
  const generatedAt = canonicalTimestamp(raw.generatedAt, 'generatedAt');
  const validationVerificationIds = canonicalValidationIds(raw.validationVerificationIds);

  const registry = normalizeArtifactRegistryV1(raw.registry);
  if (registry.projectId !== projectId) {
    throw new Error('artifact registry projectId does not match preflight projectId');
  }

  const version = getArtifactVersionV1(registry, artifactId, versionId);
  const currentVersion = getCurrentArtifactVersionV1(registry, artifactId);
  if (currentVersion.versionId !== versionId) {
    throw new Error('artifact delivery preflight requires the current artifact version');
  }
  if (Date.parse(generatedAt) < Date.parse(version.registeredAt)) {
    throw new Error('preflight generatedAt cannot predate current artifact registration');
  }

  const parentDiff = version.parentVersionId === null
    ? null
    : compareArtifactVersionsV1(
      getArtifactVersionV1(registry, artifactId, version.parentVersionId),
      version,
    );

  const review = buildDiffFirstOwnerReviewV1(raw.ownerReview, trustedReviewOptions);
  if (review.projectId !== projectId
      || review.subjectId !== artifactId
      || review.subjectRevisionId !== versionId) {
    throw new Error('owner review does not bind exact preflight project/artifact/version');
  }
  if (Date.parse(review.generatedAt) < Date.parse(version.registeredAt)) {
    throw new Error('owner review cannot predate current artifact registration');
  }
  if (Date.parse(review.generatedAt) > Date.parse(generatedAt)) {
    throw new Error('owner review cannot postdate preflight generation');
  }
  const reviewedCurrentArtifact = review.artifactRefs.find(item => item.artifactId === artifactId);
  if (!reviewedCurrentArtifact || !artifactRefEqual(reviewedCurrentArtifact, version.artifactRef)) {
    throw new Error('owner review does not include the exact current ArtifactRefV1');
  }

  const verificationById = new Map(
    review.verificationRefs.map(item => [item.verificationId, item]),
  );
  const selectedVerifications = validationVerificationIds.map((verificationId) => {
    const verification = verificationById.get(verificationId);
    if (!verification) {
      throw new Error(`validation verification is not bound to owner review: ${verificationId}`);
    }
    if (Date.parse(verification.verifiedAt) < Date.parse(version.registeredAt)) {
      throw new Error(`validation verification predates artifact registration: ${verificationId}`);
    }
    return verification;
  });

  const finalBundle = buildJobArtifactBundleV1(raw.finalBundle);
  if (finalBundle.projectId !== projectId) {
    throw new Error('final bundle projectId does not match preflight projectId');
  }
  if (Date.parse(finalBundle.createdAt) < Date.parse(version.registeredAt)) {
    throw new Error('final bundle cannot predate current artifact registration');
  }
  if (Date.parse(finalBundle.createdAt) > Date.parse(generatedAt)) {
    throw new Error('final bundle cannot postdate preflight generation');
  }
  const bundledArtifact = finalBundle.entries.find(
    item => item.artifactRef.artifactId === artifactId,
  );
  if (!bundledArtifact || !artifactRefEqual(bundledArtifact.artifactRef, version.artifactRef)) {
    throw new Error('final bundle does not contain the exact current ArtifactRefV1');
  }

  const validationBlockingStatus = deriveValidationStatus(selectedVerifications);
  const status = validationBlockingStatus
    || (review.requiresOwnerAttention
      ? ArtifactWorkspacePreflightStatus.OWNER_ATTENTION_REQUIRED
      : ArtifactWorkspacePreflightStatus.EVIDENCE_READY_FOR_OWNER_REVIEW);

  return deepFreeze({
    schemaVersion: ARTIFACT_WORKSPACE_PREFLIGHT_VERSION,
    preflightId,
    projectId,
    artifactId,
    versionId,
    generatedAt,
    status,
    advisoryOnly: true,
    approvalAuthorized: false,
    distributionAuthorized: false,
    executionAuthorized: false,
    requiresCanonicalOwnerApproval: true,
    requiresCanonicalDistributionAuthorization: true,
    currentArtifactRef: version.artifactRef,
    version: {
      versionId: version.versionId,
      parentVersionId: version.parentVersionId,
      registeredAt: version.registeredAt,
      provenance: version.provenance,
      parentDiff,
    },
    validation: {
      verificationIds: validationVerificationIds,
      verifications: Object.freeze([...selectedVerifications]),
      evidenceReady: validationBlockingStatus === null,
    },
    ownerReview: {
      reviewId: review.reviewId,
      generatedAt: review.generatedAt,
      requiresOwnerAttention: review.requiresOwnerAttention,
      attentionReasons: review.attentionReasons,
      subjectEvidenceBound: review.subjectEvidenceBound,
      advisoryOnly: review.advisoryOnly,
      approvalAuthorized: review.approvalAuthorized,
    },
    finalBundle: {
      bundleId: finalBundle.bundleId,
      jobId: finalBundle.jobId,
      planId: finalBundle.planId,
      createdAt: finalBundle.createdAt,
      path: bundledArtifact.path,
      sensitive: version.artifactRef.sensitive,
      requiresCanonicalDisclosureAuthorization:
        finalBundle.requiresCanonicalDisclosureAuthorization,
      disclosureAuthorized: finalBundle.disclosureAuthorized,
      distributionAuthorized: finalBundle.distributionAuthorized,
    },
  });
}
