import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const SKILL_PACK_SCHEMA_VERSION = 1;
export const SkillEntrypointKind = Object.freeze({
  RECIPE: 'RECIPE',
  TOOL: 'TOOL',
  PROMPT: 'PROMPT',
  SCRIPT: 'SCRIPT',
  WORKFLOW: 'WORKFLOW',
});

const ENTRYPOINT_KINDS = new Set(Object.values(SkillEntrypointKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const MAX_VERSION_LENGTH = 256;
const MAX_ARTIFACTS = 128;
const MAX_ENTRYPOINTS = 64;
const MAX_DEPENDENCIES = 64;
const MAX_REQUIREMENTS = 128;
const MAX_EVALUATIONS = 64;
const MAX_SIGNATURES = 32;
const MAX_TEXT = 16_000;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function array(value, label, max, { min = 0 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain dense array`);
  }
  if (value.length < min || value.length > max) {
    throw new Error(`${label} length must be ${min}-${max}`);
  }
  const output = [];
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index fields`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= value.length) {
      throw new Error(`${label} contains invalid indices`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}[${index}] must be an enumerable own data item`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function exact(raw, allowed, label) {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function own(raw, key, label) {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) throw new Error(`${label}.${key} is required`);
}

function identifier(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function version(value, label) {
  if (typeof value !== 'string'
      || value.length > MAX_VERSION_LENGTH
      || value !== value.trim()
      || !SEMVER.test(value)) {
    throw new Error(`${label} must be a canonical semantic version`);
  }
  return value;
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function integer(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function ascii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${key}: ${value}`);
    seen.add(value);
  }
  return items;
}

function idList(value, label, max = MAX_REQUIREMENTS, { min = 0 } = {}) {
  const items = array(value, label, max, { min }).map((item, index) => identifier(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates`);
  return items.sort(ascii);
}

const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);

function strictArtifact(input, label) {
  const raw = record(input, label);
  exact(raw, ARTIFACT_KEYS, label);
  for (const key of ['schemaVersion', 'artifactId', 'kind', 'uri', 'sha256', 'sizeBytes', 'createdAt', 'sensitive']) {
    own(raw, key, label);
  }
  if (raw.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
  identifier(raw.artifactId, `${label}.artifactId`);
  identifier(raw.kind, `${label}.kind`);
  text(raw.uri, `${label}.uri`, { max: 4096 });
  if (raw.mediaType !== undefined && raw.mediaType !== '') {
    text(raw.mediaType, `${label}.mediaType`, { max: 300 });
  }
  digest(raw.sha256, `${label}.sha256`);
  integer(raw.sizeBytes, `${label}.sizeBytes`);
  timestamp(raw.createdAt, `${label}.createdAt`);
  if (raw.producerInvocationId !== undefined && raw.producerInvocationId !== null && raw.producerInvocationId !== '') {
    identifier(raw.producerInvocationId, `${label}.producerInvocationId`);
  }
  bool(raw.sensitive, `${label}.sensitive`);
  return normalizeArtifactRefV1(raw);
}

const ENTRYPOINT_KEYS = new Set([
  'entrypointId', 'kind', 'artifactId', 'exportName', 'readOnly',
  'requiredCapabilityIds', 'requiredPermissionIds',
]);

function normalizeEntrypoint(input, label) {
  const raw = record(input, label);
  exact(raw, ENTRYPOINT_KEYS, label);
  for (const key of ['entrypointId', 'kind', 'artifactId', 'readOnly', 'requiredCapabilityIds', 'requiredPermissionIds']) {
    own(raw, key, label);
  }
  const kind = identifier(raw.kind, `${label}.kind`);
  if (!ENTRYPOINT_KINDS.has(kind)) throw new Error(`${label}.kind is invalid`);
  return freeze({
    entrypointId: identifier(raw.entrypointId, `${label}.entrypointId`),
    kind,
    artifactId: identifier(raw.artifactId, `${label}.artifactId`),
    exportName: text(raw.exportName, `${label}.exportName`, { optional: true, max: 300 }),
    readOnly: bool(raw.readOnly, `${label}.readOnly`),
    requiredCapabilityIds: idList(raw.requiredCapabilityIds, `${label}.requiredCapabilityIds`),
    requiredPermissionIds: idList(raw.requiredPermissionIds, `${label}.requiredPermissionIds`),
  });
}

const DEPENDENCY_KEYS = new Set(['skillPackId', 'version', 'sourceSha256']);

function normalizeDependency(input, label) {
  const raw = record(input, label);
  exact(raw, DEPENDENCY_KEYS, label);
  for (const key of DEPENDENCY_KEYS) own(raw, key, label);
  return freeze({
    skillPackId: identifier(raw.skillPackId, `${label}.skillPackId`),
    version: version(raw.version, `${label}.version`),
    sourceSha256: digest(raw.sourceSha256, `${label}.sourceSha256`),
  });
}

const EVALUATION_KEYS = new Set([
  'evaluationRequirementId', 'suiteId', 'suiteRevisionId', 'subjectSha256', 'requiredEvidenceKinds',
]);

function normalizeEvaluationRequirement(input, label) {
  const raw = record(input, label);
  exact(raw, EVALUATION_KEYS, label);
  for (const key of EVALUATION_KEYS) own(raw, key, label);
  return freeze({
    evaluationRequirementId: identifier(raw.evaluationRequirementId, `${label}.evaluationRequirementId`),
    suiteId: identifier(raw.suiteId, `${label}.suiteId`),
    suiteRevisionId: identifier(raw.suiteRevisionId, `${label}.suiteRevisionId`),
    subjectSha256: digest(raw.subjectSha256, `${label}.subjectSha256`),
    requiredEvidenceKinds: idList(raw.requiredEvidenceKinds, `${label}.requiredEvidenceKinds`, 32, { min: 1 }),
  });
}

const SIGNATURE_KEYS = new Set([
  'signatureId', 'scheme', 'keyId', 'signatureArtifactId', 'signedSha256', 'trustState',
]);

function normalizeSignatureRef(input, label) {
  const raw = record(input, label);
  exact(raw, SIGNATURE_KEYS, label);
  for (const key of SIGNATURE_KEYS) own(raw, key, label);
  if (raw.trustState !== 'UNVERIFIED_REFERENCE') {
    throw new Error(`${label}.trustState must remain UNVERIFIED_REFERENCE`);
  }
  return freeze({
    signatureId: identifier(raw.signatureId, `${label}.signatureId`),
    scheme: identifier(raw.scheme, `${label}.scheme`),
    keyId: identifier(raw.keyId, `${label}.keyId`),
    signatureArtifactId: identifier(raw.signatureArtifactId, `${label}.signatureArtifactId`),
    signedSha256: digest(raw.signedSha256, `${label}.signedSha256`),
    trustState: 'UNVERIFIED_REFERENCE',
  });
}

const PACK_KEYS = new Set([
  'schemaVersion', 'skillPackId', 'version', 'displayName', 'description',
  'artifactRefs', 'sourceArtifactId', 'entrypoints', 'dependencies',
  'requiredCapabilityIds', 'requiredPermissionIds', 'evaluationRequirements',
  'signatureRefs', 'publishedAt', 'admissionAuthorized', 'executionAuthorized',
  'trustAuthority',
]);

export function normalizeSkillPackManifestV1(input) {
  const raw = record(input, 'SkillPackManifestV1');
  exact(raw, PACK_KEYS, 'SkillPackManifestV1');
  for (const key of [
    'schemaVersion', 'skillPackId', 'version', 'displayName', 'artifactRefs', 'sourceArtifactId',
    'entrypoints', 'dependencies', 'requiredCapabilityIds', 'requiredPermissionIds',
    'evaluationRequirements', 'signatureRefs', 'publishedAt', 'admissionAuthorized',
    'executionAuthorized', 'trustAuthority',
  ]) own(raw, key, 'SkillPackManifestV1');

  if (raw.schemaVersion !== SKILL_PACK_SCHEMA_VERSION) throw new Error('Unsupported SkillPackManifestV1 schemaVersion');
  if (raw.admissionAuthorized !== false) throw new Error('SkillPackManifestV1 cannot authorize admission');
  if (raw.executionAuthorized !== false) throw new Error('SkillPackManifestV1 cannot authorize execution');
  if (raw.trustAuthority !== 'UNVERIFIED_REFERENCES') {
    throw new Error('SkillPackManifestV1 trustAuthority must remain UNVERIFIED_REFERENCES');
  }

  const skillPackId = identifier(raw.skillPackId, 'skillPackId');
  const artifacts = unique(
    array(raw.artifactRefs, 'artifactRefs', MAX_ARTIFACTS, { min: 1 }).map(
      (item, index) => strictArtifact(item, `artifactRefs[${index}]`),
    ),
    'artifactId',
    'artifactRefs',
  ).sort((a, b) => ascii(a.artifactId, b.artifactId));
  const artifactsById = new Map(artifacts.map(item => [item.artifactId, item]));
  const sourceArtifactId = identifier(raw.sourceArtifactId, 'sourceArtifactId');
  const sourceArtifact = artifactsById.get(sourceArtifactId);
  if (!sourceArtifact) throw new Error('sourceArtifactId must resolve to artifactRefs');
  if (!sourceArtifact.sha256) throw new Error('source artifact requires materialized sha256');

  const requiredCapabilityIds = idList(raw.requiredCapabilityIds, 'requiredCapabilityIds');
  const requiredPermissionIds = idList(raw.requiredPermissionIds, 'requiredPermissionIds');
  const capabilitySet = new Set(requiredCapabilityIds);
  const permissionSet = new Set(requiredPermissionIds);

  const entrypoints = unique(
    array(raw.entrypoints, 'entrypoints', MAX_ENTRYPOINTS, { min: 1 }).map(
      (item, index) => normalizeEntrypoint(item, `entrypoints[${index}]`),
    ),
    'entrypointId',
    'entrypoints',
  ).sort((a, b) => ascii(a.entrypointId, b.entrypointId));
  for (const entrypoint of entrypoints) {
    if (!artifactsById.has(entrypoint.artifactId)) {
      throw new Error(`entrypoint artifact is not in skill pack: ${entrypoint.artifactId}`);
    }
    for (const capabilityId of entrypoint.requiredCapabilityIds) {
      if (!capabilitySet.has(capabilityId)) {
        throw new Error(`entrypoint capability is not declared by skill pack: ${capabilityId}`);
      }
    }
    for (const permissionId of entrypoint.requiredPermissionIds) {
      if (!permissionSet.has(permissionId)) {
        throw new Error(`entrypoint permission is not declared by skill pack: ${permissionId}`);
      }
    }
  }

  const dependencies = unique(
    array(raw.dependencies, 'dependencies', MAX_DEPENDENCIES).map(
      (item, index) => normalizeDependency(item, `dependencies[${index}]`),
    ),
    'skillPackId',
    'dependencies',
  ).sort((a, b) => ascii(a.skillPackId, b.skillPackId));
  if (dependencies.some(item => item.skillPackId === skillPackId)) {
    throw new Error('skill pack cannot depend on itself');
  }

  const evaluationRequirements = unique(
    array(raw.evaluationRequirements, 'evaluationRequirements', MAX_EVALUATIONS).map(
      (item, index) => normalizeEvaluationRequirement(item, `evaluationRequirements[${index}]`),
    ),
    'evaluationRequirementId',
    'evaluationRequirements',
  ).sort((a, b) => ascii(a.evaluationRequirementId, b.evaluationRequirementId));
  for (const requirement of evaluationRequirements) {
    if (requirement.subjectSha256 !== sourceArtifact.sha256) {
      throw new Error('evaluation requirement subjectSha256 must bind source artifact');
    }
  }

  const signatureRefs = unique(
    array(raw.signatureRefs, 'signatureRefs', MAX_SIGNATURES).map(
      (item, index) => normalizeSignatureRef(item, `signatureRefs[${index}]`),
    ),
    'signatureId',
    'signatureRefs',
  ).sort((a, b) => ascii(a.signatureId, b.signatureId));
  for (const signature of signatureRefs) {
    if (signature.signedSha256 !== sourceArtifact.sha256) {
      throw new Error('signature signedSha256 must bind source artifact');
    }
    if (!artifactsById.has(signature.signatureArtifactId)) {
      throw new Error(`signature artifact is not in skill pack: ${signature.signatureArtifactId}`);
    }
    if (signature.signatureArtifactId === sourceArtifactId) {
      throw new Error('signature artifact must be distinct from source artifact');
    }
  }

  const publishedAt = timestamp(raw.publishedAt, 'publishedAt');
  const publishedMs = Date.parse(publishedAt);
  for (const artifact of artifacts) {
    if (Date.parse(artifact.createdAt) > publishedMs) {
      throw new Error(`skill pack cannot be published before artifact creation: ${artifact.artifactId}`);
    }
  }

  return freeze({
    schemaVersion: SKILL_PACK_SCHEMA_VERSION,
    skillPackId,
    version: version(raw.version, 'version'),
    displayName: text(raw.displayName, 'displayName', { max: 500 }),
    description: text(raw.description, 'description', { optional: true, max: 4000 }),
    artifactRefs: artifacts,
    sourceArtifactId,
    entrypoints,
    dependencies,
    requiredCapabilityIds,
    requiredPermissionIds,
    evaluationRequirements,
    signatureRefs,
    publishedAt,
    admissionAuthorized: false,
    executionAuthorized: false,
    trustAuthority: 'UNVERIFIED_REFERENCES',
  });
}

function stableProjection(manifest) {
  return JSON.stringify([
    manifest.skillPackId,
    manifest.version,
    manifest.displayName,
    manifest.description,
    manifest.publishedAt,
    manifest.sourceArtifactId,
    manifest.artifactRefs.map(item => [
      item.artifactId, item.kind, item.uri, item.mediaType || '', item.sha256,
      item.sizeBytes, item.createdAt, item.producerInvocationId || '', item.sensitive,
    ]),
    manifest.entrypoints.map(item => [
      item.entrypointId, item.kind, item.artifactId, item.exportName, item.readOnly,
      item.requiredCapabilityIds, item.requiredPermissionIds,
    ]),
    manifest.dependencies.map(item => [item.skillPackId, item.version, item.sourceSha256]),
    manifest.requiredCapabilityIds,
    manifest.requiredPermissionIds,
    manifest.evaluationRequirements.map(item => [
      item.evaluationRequirementId, item.suiteId, item.suiteRevisionId,
      item.subjectSha256, item.requiredEvidenceKinds,
    ]),
    manifest.signatureRefs.map(item => [
      item.signatureId, item.scheme, item.keyId, item.signatureArtifactId,
      item.signedSha256, item.trustState,
    ]),
  ]);
}

export function assessSkillPackDriftV1(baselineInput, currentInput) {
  const baseline = normalizeSkillPackManifestV1(baselineInput);
  const current = normalizeSkillPackManifestV1(currentInput);
  if (baseline.skillPackId !== current.skillPackId) {
    throw new Error('Skill pack identity mismatch');
  }

  const signals = [];
  if (baseline.version !== current.version) signals.push('VERSION_CHANGED');
  if (baseline.displayName !== current.displayName || baseline.description !== current.description) signals.push('METADATA_CHANGED');
  if (baseline.publishedAt !== current.publishedAt) signals.push('PUBLISHED_AT_CHANGED');
  if (JSON.stringify(baseline.artifactRefs) !== JSON.stringify(current.artifactRefs)) signals.push('ARTIFACTS_CHANGED');
  const baselineSource = baseline.artifactRefs.find(item => item.artifactId === baseline.sourceArtifactId);
  const currentSource = current.artifactRefs.find(item => item.artifactId === current.sourceArtifactId);
  if (baseline.sourceArtifactId !== current.sourceArtifactId || baselineSource.sha256 !== currentSource.sha256) {
    signals.push('SOURCE_CHANGED');
  }
  if (JSON.stringify(baseline.entrypoints) !== JSON.stringify(current.entrypoints)) signals.push('ENTRYPOINTS_CHANGED');
  if (JSON.stringify(baseline.dependencies) !== JSON.stringify(current.dependencies)) signals.push('DEPENDENCIES_CHANGED');
  if (JSON.stringify(baseline.requiredCapabilityIds) !== JSON.stringify(current.requiredCapabilityIds)) signals.push('CAPABILITIES_CHANGED');
  if (JSON.stringify(baseline.requiredPermissionIds) !== JSON.stringify(current.requiredPermissionIds)) signals.push('PERMISSIONS_CHANGED');
  if (JSON.stringify(baseline.evaluationRequirements) !== JSON.stringify(current.evaluationRequirements)) signals.push('EVALUATION_REQUIREMENTS_CHANGED');
  if (JSON.stringify(baseline.signatureRefs) !== JSON.stringify(current.signatureRefs)) signals.push('SIGNATURE_REFS_CHANGED');

  const sameVersionConflict = baseline.version === current.version
    && stableProjection(baseline) !== stableProjection(current);

  return freeze({
    schemaVersion: SKILL_PACK_SCHEMA_VERSION,
    skillPackId: baseline.skillPackId,
    fromVersion: baseline.version,
    toVersion: current.version,
    advisoryOnly: true,
    admissionAuthorized: false,
    executionAuthorized: false,
    status: sameVersionConflict ? 'VERSION_CONFLICT' : signals.length ? 'DRIFTED' : 'UNCHANGED',
    sameVersionConflict,
    signals,
  });
}
