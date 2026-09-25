import { normalizeSkillPackManifestV1 } from './skill-pack-contract.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';
import { createSha256FingerprintV1 } from './fingerprint.js';

export const SKILL_PACK_ADMISSION_SCHEMA_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_KEYS = new Set(['manifest', 'entrypointId', 'admittedAt']);
const DEPENDENCY_KEYS = new Set([
  'resolveManifest',
  'resolveArtifact',
  'resolveEvaluation',
  'resolveSignature',
  'resolveDependencyAdmission',
]);
const EVALUATION_PROOF_KEYS = new Set([
  'evaluationRequirementId', 'evaluationId', 'suiteId', 'suiteRevisionId',
  'subjectSha256', 'status', 'completedAt', 'evidenceKinds', 'verificationAuthorityId',
]);
const SIGNATURE_PROOF_KEYS = new Set([
  'signatureId', 'scheme', 'keyId', 'signatureArtifactId', 'signedSha256', 'status',
  'verifiedAt', 'verificationAuthorityId',
]);
const DEPENDENCY_PROOF_KEYS = new Set([
  'skillPackId', 'version', 'sourceSha256', 'status', 'admissionId', 'admittedAt',
]);
const MAX_EVIDENCE_KINDS = 64;

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
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const output = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains a non-index field`);
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index) || index < 0 || index >= length
        || String(index) !== key || !descriptor?.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} contains invalid array data`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    output[index] = descriptor.value;
  }
  return output;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function evidenceKinds(value, label) {
  const items = denseArray(value, label, MAX_EVIDENCE_KINDS).map((item, index) =>
    id(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates`);
  return items.sort();
}

function requireResolvers(options) {
  const raw = strictRecord(options, 'Skill pack admission dependencies', DEPENDENCY_KEYS);
  for (const key of DEPENDENCY_KEYS) {
    if (typeof raw[key] !== 'function') {
      throw new Error(`Skill pack admission requires trusted ${key}`);
    }
  }
  return raw;
}

function sourceArtifact(manifest) {
  const artifact = manifest.artifactRefs.find(item => item.artifactId === manifest.sourceArtifactId);
  if (!artifact) throw new Error('Skill pack source artifact is missing');
  return artifact;
}

function exactArtifactMatch(expected, observedInput, label) {
  const observed = normalizeArtifactRefV1(observedInput);
  if (!same(expected, observed)) {
    throw new Error(`${label} does not match the trusted materialized ArtifactRef`);
  }
  return observed;
}

async function bindTrustedManifest(manifest, resolveManifest) {
  const trusted = normalizeSkillPackManifestV1(await resolveManifest({
    skillPackId: manifest.skillPackId,
    version: manifest.version,
  }));
  if (!same(manifest, trusted)) {
    throw new Error('Skill pack manifest does not match the trusted manifest revision');
  }
  return trusted;
}

async function bindEvaluation(requirement, source, admittedAt, resolveEvaluation) {
  const raw = strictRecord(
    await resolveEvaluation({
      evaluationRequirementId: requirement.evaluationRequirementId,
      suiteId: requirement.suiteId,
      suiteRevisionId: requirement.suiteRevisionId,
      subjectSha256: requirement.subjectSha256,
    }),
    'TrustedSkillEvaluationV1',
    EVALUATION_PROOF_KEYS,
  );
  const proof = {
    evaluationRequirementId: id(raw.evaluationRequirementId, 'evaluationRequirementId'),
    evaluationId: id(raw.evaluationId, 'evaluationId'),
    suiteId: id(raw.suiteId, 'suiteId'),
    suiteRevisionId: id(raw.suiteRevisionId, 'suiteRevisionId'),
    subjectSha256: digest(raw.subjectSha256, 'subjectSha256'),
    status: raw.status,
    completedAt: timestamp(raw.completedAt, 'completedAt'),
    evidenceKinds: evidenceKinds(raw.evidenceKinds, 'evidenceKinds'),
    verificationAuthorityId: id(raw.verificationAuthorityId, 'verificationAuthorityId'),
  };
  if (proof.status !== 'PASS') throw new Error('Skill pack evaluation requirement did not PASS');
  if (proof.evaluationRequirementId !== requirement.evaluationRequirementId
      || proof.suiteId !== requirement.suiteId
      || proof.suiteRevisionId !== requirement.suiteRevisionId
      || proof.subjectSha256 !== requirement.subjectSha256
      || proof.subjectSha256 !== source.sha256) {
    throw new Error('Skill pack evaluation proof identity does not match requirement/source');
  }
  if (Date.parse(proof.completedAt) < Date.parse(source.createdAt)
      || Date.parse(proof.completedAt) > Date.parse(admittedAt)) {
    throw new Error('Skill pack evaluation proof is outside the source/admission time boundary');
  }
  const present = new Set(proof.evidenceKinds);
  for (const kind of requirement.requiredEvidenceKinds) {
    if (!present.has(kind)) throw new Error(`Skill pack evaluation is missing required evidence kind: ${kind}`);
  }
  return frozen(proof);
}

async function bindSignature(reference, source, signatureArtifact, admittedAt, resolveSignature) {
  const raw = strictRecord(
    await resolveSignature({
      signatureId: reference.signatureId,
      scheme: reference.scheme,
      keyId: reference.keyId,
      signedSha256: reference.signedSha256,
      signatureArtifactId: reference.signatureArtifactId,
    }),
    'TrustedSkillSignatureV1',
    SIGNATURE_PROOF_KEYS,
  );
  const proof = {
    signatureId: id(raw.signatureId, 'signatureId'),
    scheme: id(raw.scheme, 'scheme'),
    keyId: id(raw.keyId, 'keyId'),
    signatureArtifactId: id(raw.signatureArtifactId, 'signatureArtifactId'),
    signedSha256: digest(raw.signedSha256, 'signedSha256'),
    status: raw.status,
    verifiedAt: timestamp(raw.verifiedAt, 'verifiedAt'),
    verificationAuthorityId: id(raw.verificationAuthorityId, 'verificationAuthorityId'),
  };
  if (proof.status !== 'VERIFIED') throw new Error('Skill pack signature is not VERIFIED');
  if (proof.signatureId !== reference.signatureId
      || proof.scheme !== reference.scheme
      || proof.keyId !== reference.keyId
      || proof.signatureArtifactId !== reference.signatureArtifactId
      || proof.signedSha256 !== reference.signedSha256
      || proof.signedSha256 !== source.sha256) {
    throw new Error('Skill pack signature proof does not match signature/source identity');
  }
  const earliestVerificationAt = Math.max(
    Date.parse(source.createdAt),
    Date.parse(signatureArtifact.createdAt),
  );
  if (Date.parse(proof.verifiedAt) < earliestVerificationAt
      || Date.parse(proof.verifiedAt) > Date.parse(admittedAt)) {
    throw new Error('Skill pack signature proof is outside the artifact/admission time boundary');
  }
  return frozen(proof);
}

async function bindDependency(dependency, admittedAt, resolveDependencyAdmission) {
  const raw = strictRecord(
    await resolveDependencyAdmission({
      skillPackId: dependency.skillPackId,
      version: dependency.version,
      sourceSha256: dependency.sourceSha256,
    }),
    'TrustedSkillDependencyAdmissionV1',
    DEPENDENCY_PROOF_KEYS,
  );
  const proof = {
    skillPackId: id(raw.skillPackId, 'dependency skillPackId'),
    version: raw.version,
    sourceSha256: digest(raw.sourceSha256, 'dependency sourceSha256'),
    status: raw.status,
    admissionId: id(raw.admissionId, 'dependency admissionId'),
    admittedAt: timestamp(raw.admittedAt, 'dependency admittedAt'),
  };
  if (proof.status !== 'READY_FOR_POLICY') {
    throw new Error('Skill pack dependency is not READY_FOR_POLICY');
  }
  if (proof.skillPackId !== dependency.skillPackId
      || proof.version !== dependency.version
      || proof.sourceSha256 !== dependency.sourceSha256) {
    throw new Error('Skill pack dependency admission does not match exact dependency identity');
  }
  if (Date.parse(proof.admittedAt) > Date.parse(admittedAt)) {
    throw new Error('Skill pack dependency admission is from the future');
  }
  return frozen(proof);
}

export async function createSkillPackAdmissionV1(input = {}, options = {}) {
  const request = strictRecord(input, 'SkillPackAdmissionV1 request', REQUEST_KEYS);
  const dependencies = requireResolvers(options);
  const manifest = normalizeSkillPackManifestV1(request.manifest);
  const entrypointId = id(request.entrypointId, 'entrypointId');
  const admittedAt = timestamp(request.admittedAt, 'admittedAt');
  if (Date.parse(admittedAt) < Date.parse(manifest.publishedAt)) {
    throw new Error('Skill pack admission cannot predate publication');
  }

  const trustedManifest = await bindTrustedManifest(manifest, dependencies.resolveManifest);
  const entrypoint = trustedManifest.entrypoints.find(item => item.entrypointId === entrypointId);
  if (!entrypoint) throw new Error('Skill pack entrypoint not found');

  const source = sourceArtifact(trustedManifest);
  if (!trustedManifest.evaluationRequirements.length) {
    throw new Error('Skill pack runtime admission requires at least one trusted evaluation');
  }
  if (!trustedManifest.signatureRefs.length) {
    throw new Error('Skill pack runtime admission requires at least one trusted signature');
  }

  const artifactIds = [...new Set([trustedManifest.sourceArtifactId, entrypoint.artifactId])];
  const loadArtifactRefs = [];
  for (const artifactId of artifactIds) {
    const expected = trustedManifest.artifactRefs.find(item => item.artifactId === artifactId);
    const observed = await dependencies.resolveArtifact({
      skillPackId: trustedManifest.skillPackId,
      version: trustedManifest.version,
      artifactId,
      sha256: expected.sha256,
    });
    loadArtifactRefs.push(exactArtifactMatch(expected, observed, `Artifact ${artifactId}`));
  }

  const evaluationProofs = [];
  for (const requirement of trustedManifest.evaluationRequirements) {
    evaluationProofs.push(await bindEvaluation(
      requirement,
      source,
      admittedAt,
      dependencies.resolveEvaluation,
    ));
  }

  const signatureProofs = [];
  for (const reference of trustedManifest.signatureRefs) {
    const signatureArtifact = trustedManifest.artifactRefs.find(
      item => item.artifactId === reference.signatureArtifactId,
    );
    signatureProofs.push(await bindSignature(
      reference,
      source,
      signatureArtifact,
      admittedAt,
      dependencies.resolveSignature,
    ));
  }

  const dependencyProofs = [];
  for (const dependency of trustedManifest.dependencies) {
    dependencyProofs.push(await bindDependency(
      dependency,
      admittedAt,
      dependencies.resolveDependencyAdmission,
    ));
  }

  const requiredCapabilityIds = [...new Set([
    ...trustedManifest.requiredCapabilityIds,
    ...entrypoint.requiredCapabilityIds,
  ])].sort();
  const requiredPermissionIds = [...new Set([
    ...trustedManifest.requiredPermissionIds,
    ...entrypoint.requiredPermissionIds,
  ])].sort();
  const admissionFingerprint = await createSha256FingerprintV1(JSON.stringify([
    'chatgpt-autopilot-skill-pack-admission-v1',
    trustedManifest.skillPackId,
    trustedManifest.version,
    source.sha256,
    entrypoint.entrypointId,
    dependencyProofs.map(item => item.admissionId),
    evaluationProofs.map(item => item.evaluationId),
    signatureProofs.map(item => item.signatureId),
  ]));

  return frozen({
    schemaVersion: SKILL_PACK_ADMISSION_SCHEMA_VERSION,
    admissionId: `skill-admission:${admissionFingerprint.slice('sha256:'.length)}`,
    status: 'READY_FOR_POLICY',
    skillPackId: trustedManifest.skillPackId,
    version: trustedManifest.version,
    sourceSha256: source.sha256,
    entrypoint,
    loadArtifactRefs,
    dependencyAdmissionIds: dependencyProofs.map(item => item.admissionId),
    evaluationIds: evaluationProofs.map(item => item.evaluationId),
    signatureIds: signatureProofs.map(item => item.signatureId),
    requiredCapabilityIds,
    requiredPermissionIds,
    admittedAt,
    manifestTrusted: true,
    materializationTrusted: true,
    evaluationsTrusted: true,
    signaturesTrusted: true,
    dependenciesTrusted: true,
    minimalLoadPlan: true,
    policyDecisionGranted: false,
    artifactReadAuthorized: false,
    executionAuthorized: false,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalExecutionPlane: true,
  });
}
