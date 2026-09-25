import {
  SourceAuthorityKind,
  normalizeProjectSnapshotV1,
  normalizeProjectSourceRefV1,
} from './project-context-artifact.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';
import {
  ProjectWorkspaceRepository,
  addProjectSnapshot,
} from './project-workspace.js';

export const PROJECT_BOOTSTRAP_SCHEMA_VERSION = 1;
export const MAX_PROJECT_BOOTSTRAP_SOURCES = 128;
export const MAX_PROJECT_BOOTSTRAP_ARTIFACTS = 128;

export const ProjectBootstrapStatus = Object.freeze({
  READY: 'READY',
  BLOCKED: 'BLOCKED',
});

export const ProjectBootstrapBlockerCode = Object.freeze({
  REQUIRED_SOURCE_DIGEST_MISSING: 'REQUIRED_SOURCE_DIGEST_MISSING',
  REQUIRED_ARTIFACT_DIGEST_MISSING: 'REQUIRED_ARTIFACT_DIGEST_MISSING',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_AUTHORITIES = new Set(Object.values(SourceAuthorityKind));
const INPUT_KEYS = new Set([
  'schemaVersion',
  'bootstrapId',
  'projectId',
  'revisionId',
  'title',
  'sourceRefs',
  'artifactRefs',
  'requiredSourceIds',
  'requiredArtifactIds',
  'createdAt',
]);
const SOURCE_KEYS = new Set([
  'schemaVersion',
  'sourceId',
  'projectId',
  'kind',
  'uri',
  'revisionId',
  'contentSha256',
  'observedAt',
  'authority',
  'metadata',
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

function strictRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain or null-prototype object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} must not contain symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function ownValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function strictArray(value, label, max, { min = 0 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    throw new Error(`${label} must contain between ${min} and ${max} items`);
  }
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-canonical array fields`);
    }
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function strictId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must be a canonical string identity`);
  }
  return value;
}

function strictText(value, label, max) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} must be canonical bounded text`);
  }
  return value;
}

function strictTimestamp(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function strictOptionalSha256(value, label) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be canonical lowercase SHA-256`);
  }
  return value;
}

function strictJsonValue(value, label, depth = 0) {
  if (depth > 24) throw new Error(`${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return strictArray(value, label, 1024).map((item, index) =>
      strictJsonValue(item, `${label}[${index}]`, depth + 1));
  }
  const record = strictRecord(value, label);
  const out = {};
  for (const key of Object.getOwnPropertyNames(record).sort(compareIds)) {
    out[key] = strictJsonValue(ownValue(record, key), `${label}.${key}`, depth + 1);
  }
  return out;
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueIds(values, label, max, { min = 0 } = {}) {
  const items = strictArray(values, label, max, { min }).map((value, index) =>
    strictId(value, `${label}[${index}]`));
  const seen = new Set();
  for (const value of items) {
    if (seen.has(value)) throw new Error(`${label} contains duplicate identity: ${value}`);
    seen.add(value);
  }
  return items.sort(compareIds);
}

function guardedSourceRef(input, expectedProjectId) {
  const raw = strictRecord(input, 'ProjectSourceRefV1');
  exactKeys(raw, SOURCE_KEYS, 'ProjectSourceRefV1');
  if (ownValue(raw, 'schemaVersion') !== 1) throw new Error('ProjectSourceRefV1 schemaVersion must be numeric 1');
  const sourceId = strictId(ownValue(raw, 'sourceId'), 'sourceId');
  const projectId = strictId(ownValue(raw, 'projectId'), 'source projectId');
  if (projectId !== expectedProjectId) throw new Error(`source projectId mismatch: ${sourceId}`);
  strictId(ownValue(raw, 'kind'), 'source kind');
  strictText(ownValue(raw, 'uri'), 'source uri', 4096);
  strictId(ownValue(raw, 'revisionId'), 'source revisionId');
  strictOptionalSha256(ownValue(raw, 'contentSha256'), 'source contentSha256');
  strictTimestamp(ownValue(raw, 'observedAt'), 'source observedAt');
  const authority = ownValue(raw, 'authority');
  if (typeof authority !== 'string' || !SOURCE_AUTHORITIES.has(authority)) {
    throw new Error('source authority must be canonical');
  }
  if (Object.hasOwn(raw, 'metadata')) strictJsonValue(ownValue(raw, 'metadata'), 'source metadata');
  return normalizeProjectSourceRefV1(raw);
}

function guardedArtifactRef(input) {
  const raw = strictRecord(input, 'ArtifactRefV1');
  exactKeys(raw, ARTIFACT_KEYS, 'ArtifactRefV1');
  if (ownValue(raw, 'schemaVersion') !== 1) throw new Error('ArtifactRefV1 schemaVersion must be numeric 1');
  strictId(ownValue(raw, 'artifactId'), 'artifactId');
  strictId(ownValue(raw, 'kind'), 'artifact kind');
  strictText(ownValue(raw, 'uri'), 'artifact uri', 4096);
  if (Object.hasOwn(raw, 'mediaType') && ownValue(raw, 'mediaType') !== '') {
    strictText(ownValue(raw, 'mediaType'), 'artifact mediaType', 300);
  }
  strictOptionalSha256(ownValue(raw, 'sha256'), 'artifact sha256');
  if (Object.hasOwn(raw, 'sizeBytes')) {
    const sizeBytes = ownValue(raw, 'sizeBytes');
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error('artifact sizeBytes must be a non-negative safe integer');
  }
  strictTimestamp(ownValue(raw, 'createdAt'), 'artifact createdAt');
  if (Object.hasOwn(raw, 'producerInvocationId')) {
    const producer = ownValue(raw, 'producerInvocationId');
    if (producer != null && producer !== '') strictId(producer, 'artifact producerInvocationId');
  }
  if (Object.hasOwn(raw, 'sensitive') && typeof ownValue(raw, 'sensitive') !== 'boolean') {
    throw new Error('artifact sensitive must be boolean');
  }
  return normalizeArtifactRefV1(raw);
}

function normalizeInput(input) {
  const raw = strictRecord(input, 'ProjectBootstrapV1');
  exactKeys(raw, INPUT_KEYS, 'ProjectBootstrapV1');
  if (ownValue(raw, 'schemaVersion') !== PROJECT_BOOTSTRAP_SCHEMA_VERSION) {
    throw new Error('ProjectBootstrapV1 schemaVersion must be numeric 1');
  }
  const bootstrapId = strictId(ownValue(raw, 'bootstrapId'), 'bootstrapId');
  const projectId = strictId(ownValue(raw, 'projectId'), 'projectId');
  const revisionId = strictId(ownValue(raw, 'revisionId'), 'revisionId');
  const title = strictText(ownValue(raw, 'title'), 'title', 1000);
  const createdAt = strictTimestamp(ownValue(raw, 'createdAt'), 'createdAt');

  const sourceInputs = strictArray(
    ownValue(raw, 'sourceRefs'),
    'sourceRefs',
    MAX_PROJECT_BOOTSTRAP_SOURCES,
    { min: 1 },
  );
  const sourceRefs = sourceInputs.map((item) => guardedSourceRef(item, projectId));
  sourceRefs.sort((a, b) => compareIds(a.sourceId, b.sourceId));
  if (new Set(sourceRefs.map((item) => item.sourceId)).size !== sourceRefs.length) {
    throw new Error('sourceRefs contains duplicate sourceId');
  }

  const artifactInputs = strictArray(
    ownValue(raw, 'artifactRefs'),
    'artifactRefs',
    MAX_PROJECT_BOOTSTRAP_ARTIFACTS,
  );
  const artifactRefs = artifactInputs.map(guardedArtifactRef);
  artifactRefs.sort((a, b) => compareIds(a.artifactId, b.artifactId));
  if (new Set(artifactRefs.map((item) => item.artifactId)).size !== artifactRefs.length) {
    throw new Error('artifactRefs contains duplicate artifactId');
  }

  const bootstrapTime = Date.parse(createdAt);
  for (const source of sourceRefs) {
    if (Date.parse(source.observedAt) > bootstrapTime) {
      throw new Error(`source observedAt is after bootstrap createdAt: ${source.sourceId}`);
    }
  }
  for (const artifact of artifactRefs) {
    if (Date.parse(artifact.createdAt) > bootstrapTime) {
      throw new Error(`artifact createdAt is after bootstrap createdAt: ${artifact.artifactId}`);
    }
  }

  const requiredSourceIds = uniqueIds(
    ownValue(raw, 'requiredSourceIds'),
    'requiredSourceIds',
    MAX_PROJECT_BOOTSTRAP_SOURCES,
    { min: 1 },
  );
  const requiredArtifactIds = uniqueIds(
    ownValue(raw, 'requiredArtifactIds'),
    'requiredArtifactIds',
    MAX_PROJECT_BOOTSTRAP_ARTIFACTS,
  );

  const sourceIds = new Set(sourceRefs.map((item) => item.sourceId));
  for (const sourceId of requiredSourceIds) {
    if (!sourceIds.has(sourceId)) throw new Error(`requiredSourceIds references unknown sourceId: ${sourceId}`);
  }
  const artifactIds = new Set(artifactRefs.map((item) => item.artifactId));
  for (const artifactId of requiredArtifactIds) {
    if (!artifactIds.has(artifactId)) throw new Error(`requiredArtifactIds references unknown artifactId: ${artifactId}`);
  }

  return Object.freeze({
    bootstrapId,
    projectId,
    revisionId,
    title,
    createdAt,
    sourceRefs: Object.freeze(sourceRefs),
    artifactRefs: Object.freeze(artifactRefs),
    requiredSourceIds: Object.freeze(requiredSourceIds),
    requiredArtifactIds: Object.freeze(requiredArtifactIds),
  });
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function deriveBlockers(normalized) {
  const blockers = [];
  const sources = new Map(normalized.sourceRefs.map((source) => [source.sourceId, source]));
  const artifacts = new Map(normalized.artifactRefs.map((artifact) => [artifact.artifactId, artifact]));

  for (const sourceId of normalized.requiredSourceIds) {
    if (!sources.get(sourceId).contentSha256) {
      blockers.push({
        code: ProjectBootstrapBlockerCode.REQUIRED_SOURCE_DIGEST_MISSING,
        resourceType: 'SOURCE',
        resourceId: sourceId,
      });
    }
  }
  for (const artifactId of normalized.requiredArtifactIds) {
    if (!artifacts.get(artifactId).sha256) {
      blockers.push({
        code: ProjectBootstrapBlockerCode.REQUIRED_ARTIFACT_DIGEST_MISSING,
        resourceType: 'ARTIFACT',
        resourceId: artifactId,
      });
    }
  }

  blockers.sort((a, b) =>
    compareIds(a.resourceType, b.resourceType)
    || compareIds(a.resourceId, b.resourceId)
    || compareIds(a.code, b.code));
  return blockers;
}

function sourceCandidate(source) {
  return {
    sourceId: source.sourceId,
    kind: source.kind,
    uri: source.uri,
    revisionId: source.revisionId,
    contentSha256: source.contentSha256,
    observedAt: source.observedAt,
    metadata: source.metadata,
  };
}

function artifactCandidate(artifact) {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    uri: artifact.uri,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt,
    producerInvocationId: artifact.producerInvocationId,
    sensitive: artifact.sensitive,
  };
}

export function buildProjectBootstrapV1(input) {
  const normalized = normalizeInput(input);
  const blockers = deriveBlockers(normalized);
  const candidate = {
    projectId: normalized.projectId,
    revisionId: normalized.revisionId,
    title: normalized.title,
    createdAt: normalized.createdAt,
    sourceCandidates: normalized.sourceRefs.map(sourceCandidate),
    artifactCandidates: normalized.artifactRefs.map(artifactCandidate),
  };
  return freezeDeep({
    schemaVersion: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
    bootstrapId: normalized.bootstrapId,
    projectId: normalized.projectId,
    projectRevisionId: normalized.revisionId,
    createdAt: normalized.createdAt,
    status: blockers.length ? ProjectBootstrapStatus.BLOCKED : ProjectBootstrapStatus.READY,
    advisoryOnly: true,
    admissionAuthorized: false,
    requiresTrustedSourceAdmission: true,
    requiredSourceIds: [...normalized.requiredSourceIds],
    requiredArtifactIds: [...normalized.requiredArtifactIds],
    blockers,
    candidate,
  });
}



const TRUSTED_RESOLVER_KEYS = new Set(['resolveSourceRef', 'resolveArtifactRef']);

function trustedResolverFunctions(input, { artifactsRequired }) {
  const raw = strictRecord(input, 'ProjectBootstrapTrustedResolversV1');
  exactKeys(raw, TRUSTED_RESOLVER_KEYS, 'ProjectBootstrapTrustedResolversV1');
  const resolveSourceRef = ownValue(raw, 'resolveSourceRef');
  const resolveArtifactRef = ownValue(raw, 'resolveArtifactRef');
  if (typeof resolveSourceRef !== 'function') {
    throw new Error('resolveSourceRef must be a trusted resolver function');
  }
  if (artifactsRequired && typeof resolveArtifactRef !== 'function') {
    throw new Error('resolveArtifactRef must be a trusted resolver function when artifacts are present');
  }
  if (!artifactsRequired && resolveArtifactRef !== undefined && typeof resolveArtifactRef !== 'function') {
    throw new Error('resolveArtifactRef must be a trusted resolver function when provided');
  }
  return { resolveSourceRef, resolveArtifactRef };
}

function sameCanonicalJson(left, right) {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameCanonicalJson(left[index], right[index])) return false;
    }
    return true;
  }
  if (typeof left !== 'object') return Object.is(left, right);
  const leftKeys = Object.keys(left).sort(compareIds);
  const rightKeys = Object.keys(right).sort(compareIds);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
    if (!sameCanonicalJson(left[leftKeys[index]], right[rightKeys[index]])) return false;
  }
  return true;
}

function trustedSourceMatchesRequested(requested, trusted) {
  return trusted.schemaVersion === requested.schemaVersion
    && trusted.sourceId === requested.sourceId
    && trusted.projectId === requested.projectId
    && trusted.kind === requested.kind
    && trusted.uri === requested.uri
    && trusted.revisionId === requested.revisionId
    && trusted.contentSha256 === requested.contentSha256
    && trusted.observedAt === requested.observedAt
    && sameCanonicalJson(trusted.metadata, requested.metadata);
}

function trustedArtifactMatchesRequested(requested, trusted) {
  return trusted.schemaVersion === requested.schemaVersion
    && trusted.artifactId === requested.artifactId
    && trusted.kind === requested.kind
    && trusted.uri === requested.uri
    && trusted.mediaType === requested.mediaType
    && trusted.sha256 === requested.sha256
    && trusted.sizeBytes === requested.sizeBytes
    && trusted.createdAt === requested.createdAt
    && trusted.producerInvocationId === requested.producerInvocationId
    && trusted.sensitive === requested.sensitive;
}

export async function resolveTrustedProjectBootstrapSnapshotV1(input, resolversInput) {
  const normalized = normalizeInput(input);
  const blockers = deriveBlockers(normalized);
  if (blockers.length) {
    throw new Error('Project bootstrap is blocked and cannot be resolved into a trusted snapshot');
  }
  for (const sourceRef of normalized.sourceRefs) {
    if (!sourceRef.contentSha256) {
      throw new Error(`Trusted Project bootstrap requires source SHA-256: ${sourceRef.sourceId}`);
    }
  }
  for (const artifactRef of normalized.artifactRefs) {
    if (!artifactRef.sha256) {
      throw new Error(`Trusted Project bootstrap requires artifact SHA-256: ${artifactRef.artifactId}`);
    }
  }

  const { resolveSourceRef, resolveArtifactRef } = trustedResolverFunctions(
    resolversInput,
    { artifactsRequired: normalized.artifactRefs.length > 0 },
  );

  const trustedSourceRefs = [];
  for (const requested of normalized.sourceRefs) {
    const query = Object.freeze({
      projectId: normalized.projectId,
      sourceId: requested.sourceId,
      kind: requested.kind,
      uri: requested.uri,
      revisionId: requested.revisionId,
      contentSha256: requested.contentSha256,
    });
    const resolved = await resolveSourceRef(query);
    const trusted = guardedSourceRef(resolved, normalized.projectId);
    if (trusted.authority !== SourceAuthorityKind.CANONICAL) {
      throw new Error(`Trusted source is not canonically admitted: ${requested.sourceId}`);
    }
    if (!trustedSourceMatchesRequested(requested, trusted)) {
      throw new Error(`Trusted source does not exactly match bootstrap source: ${requested.sourceId}`);
    }
    trustedSourceRefs.push(trusted);
  }

  const trustedArtifactRefs = [];
  for (const requested of normalized.artifactRefs) {
    const query = Object.freeze({
      artifactId: requested.artifactId,
      kind: requested.kind,
      uri: requested.uri,
      sha256: requested.sha256,
      sizeBytes: requested.sizeBytes,
    });
    const resolved = await resolveArtifactRef(query);
    const trusted = guardedArtifactRef(resolved);
    if (!trustedArtifactMatchesRequested(requested, trusted)) {
      throw new Error(`Trusted artifact does not exactly match bootstrap artifact: ${requested.artifactId}`);
    }
    trustedArtifactRefs.push(trusted);
  }

  const snapshot = normalizeProjectSnapshotV1({
    schemaVersion: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
    projectId: normalized.projectId,
    revisionId: normalized.revisionId,
    title: normalized.title,
    sourceRefs: trustedSourceRefs,
    artifactRefs: trustedArtifactRefs,
    createdAt: normalized.createdAt,
  });

  return freezeDeep({
    schemaVersion: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
    bootstrapId: normalized.bootstrapId,
    projectId: normalized.projectId,
    projectRevisionId: normalized.revisionId,
    trustedSourceResolution: true,
    trustedArtifactResolution: true,
    workspaceAdmissionAuthorized: false,
    requiresCanonicalProjectWorkspaceCommit: true,
    snapshot,
  });
}

function canonicalWorkspaceRepository(repository) {
  if (!(repository instanceof ProjectWorkspaceRepository)) {
    throw new Error('Project bootstrap workspace commit requires the canonical ProjectWorkspaceRepository');
  }
  return repository;
}

function workspaceCommitTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Project bootstrap workspace commit nowMs must be a non-negative safe integer');
  }
  return value;
}

export async function commitTrustedProjectBootstrapToWorkspaceV1(
  input,
  resolversInput,
  repositoryInput,
  { nowMs = Date.now() } = {},
) {
  const repository = canonicalWorkspaceRepository(repositoryInput);
  const commitAt = workspaceCommitTime(nowMs);

  // Trusted resolution and durable admission stay in one operation. Callers
  // cannot manufacture a resolved snapshot and then ask the workspace to trust
  // it separately.
  const resolved = await resolveTrustedProjectBootstrapSnapshotV1(input, resolversInput);

  // ProjectWorkspace timestamps are wall-clock epoch milliseconds. A durable
  // admission must therefore be causally at or after the exact trusted
  // snapshot and every source/artifact observation materialized by it.
  const causalFloorMs = Math.max(
    Date.parse(resolved.snapshot.createdAt),
    ...resolved.snapshot.sourceRefs.map(source => Date.parse(source.observedAt)),
    ...resolved.snapshot.artifactRefs.map(artifact => Date.parse(artifact.createdAt)),
  );
  if (commitAt < causalFloorMs) {
    throw new Error('Project bootstrap workspace commit must not predate trusted snapshot or evidence');
  }

  const workspace = await repository.update(draft => {
    addProjectSnapshot(draft, resolved.snapshot, { nowMs: commitAt });
    return draft;
  }, { nowMs: commitAt });

  return freezeDeep({
    schemaVersion: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
    bootstrapId: resolved.bootstrapId,
    projectId: resolved.projectId,
    projectRevisionId: resolved.projectRevisionId,
    workspaceRevision: workspace.revision,
    workspaceCommitApplied: true,
    requiresCanonicalProjectWorkspaceCommit: false,
    additionalMutationAuthorized: false,
  });
}

