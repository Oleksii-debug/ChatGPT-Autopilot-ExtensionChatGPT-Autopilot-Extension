import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const ProjectContextContractVersion = 1;

export const SourceAuthorityKind = Object.freeze({
  CANONICAL: 'CANONICAL',
  DERIVED: 'DERIVED',
  ADVISORY: 'ADVISORY',
});

const AUTHORITY = new Set(Object.values(SourceAuthorityKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_LIST = 128;
const MAX_TEXT = 16_000;
const MAX_METADATA_JSON = 64_000;

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function version(value, label) {
  if (Number(value) !== ProjectContextContractVersion) throw new Error(`Unsupported ${label} schemaVersion`);
  return ProjectContextContractVersion;
}

function id(value, label) {
  const out = String(value ?? '').trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!out || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

function digest(value, label, { optional = true } = {}) {
  if ((value == null || value === '') && optional) return '';
  const out = String(value ?? '').trim().toLowerCase();
  if (!SHA256.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function jsonData(value, label) {
  if (value == null) return {};
  plain(value, label);
  const cloned = structuredClone(value);
  if (JSON.stringify(cloned).length > MAX_METADATA_JSON) throw new Error(`${label} is too large`);
  return cloned;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function boundedArray(value, label, normalizeItem, { max = MAX_LIST } = {}) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`);
  return value.map((item, index) => {
    try { return normalizeItem(item); }
    catch (error) { throw new Error(`${label}[${index}]: ${error.message}`); }
  });
}

function uniqueBy(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${key}: ${value}`);
    seen.add(value);
  }
  return items;
}

const SOURCE_KEYS = new Set([
  'schemaVersion', 'sourceId', 'projectId', 'kind', 'uri', 'revisionId',
  'contentSha256', 'observedAt', 'authority', 'metadata',
]);

export function normalizeProjectSourceRefV1(input) {
  const raw = plain(input, 'ProjectSourceRefV1');
  exactKeys(raw, SOURCE_KEYS, 'ProjectSourceRefV1');
  const authority = String(raw.authority || '').trim().toUpperCase();
  if (!AUTHORITY.has(authority)) throw new Error('authority is invalid');
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'ProjectSourceRefV1'),
    sourceId: id(raw.sourceId, 'sourceId'),
    projectId: id(raw.projectId, 'projectId'),
    kind: id(raw.kind, 'kind'),
    uri: text(raw.uri, 'uri', { max: 4096 }),
    revisionId: id(raw.revisionId, 'revisionId'),
    contentSha256: digest(raw.contentSha256, 'contentSha256'),
    observedAt: timestamp(raw.observedAt, 'observedAt'),
    authority,
    metadata: jsonData(raw.metadata, 'metadata'),
  });
}

const BINDING_KEYS = new Set(['sourceId', 'revisionId', 'contentSha256']);

export function normalizeSourceRevisionBindingV1(input) {
  const raw = plain(input, 'SourceRevisionBindingV1');
  exactKeys(raw, BINDING_KEYS, 'SourceRevisionBindingV1');
  return frozen({
    sourceId: id(raw.sourceId, 'sourceId'),
    revisionId: id(raw.revisionId, 'revisionId'),
    contentSha256: digest(raw.contentSha256, 'contentSha256'),
  });
}

const SNAPSHOT_KEYS = new Set([
  'schemaVersion', 'projectId', 'revisionId', 'title', 'sourceRefs',
  'artifactRefs', 'createdAt',
]);

export function normalizeProjectSnapshotV1(input) {
  const raw = plain(input, 'ProjectSnapshotV1');
  exactKeys(raw, SNAPSHOT_KEYS, 'ProjectSnapshotV1');
  const projectId = id(raw.projectId, 'projectId');
  const sourceRefs = uniqueBy(
    boundedArray(raw.sourceRefs, 'sourceRefs', normalizeProjectSourceRefV1),
    'sourceId',
    'sourceRefs',
  );
  for (const source of sourceRefs) {
    if (source.projectId !== projectId) throw new Error(`sourceRefs projectId mismatch: ${source.sourceId}`);
  }
  const artifactRefs = uniqueBy(
    boundedArray(raw.artifactRefs || [], 'artifactRefs', normalizeArtifactRefV1),
    'artifactId',
    'artifactRefs',
  );
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'ProjectSnapshotV1'),
    projectId,
    revisionId: id(raw.revisionId, 'revisionId'),
    title: text(raw.title, 'title', { max: 1000 }),
    sourceRefs,
    artifactRefs,
    createdAt: timestamp(raw.createdAt, 'createdAt'),
  });
}

const CAPSULE_KEYS = new Set([
  'schemaVersion', 'capsuleId', 'projectId', 'projectRevisionId',
  'summary', 'sourceBindings', 'artifactRefs', 'createdAt',
]);

export function normalizeContextCapsuleV1(input) {
  const raw = plain(input, 'ContextCapsuleV1');
  exactKeys(raw, CAPSULE_KEYS, 'ContextCapsuleV1');
  const sourceBindings = uniqueBy(
    boundedArray(raw.sourceBindings, 'sourceBindings', normalizeSourceRevisionBindingV1),
    'sourceId',
    'sourceBindings',
  );
  const artifactRefs = uniqueBy(
    boundedArray(raw.artifactRefs || [], 'artifactRefs', normalizeArtifactRefV1),
    'artifactId',
    'artifactRefs',
  );
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'ContextCapsuleV1'),
    capsuleId: id(raw.capsuleId, 'capsuleId'),
    projectId: id(raw.projectId, 'projectId'),
    projectRevisionId: id(raw.projectRevisionId, 'projectRevisionId'),
    summary: text(raw.summary, 'summary', { max: 50_000 }),
    sourceBindings,
    artifactRefs,
    createdAt: timestamp(raw.createdAt, 'createdAt'),
  });
}

const PROVENANCE_KEYS = new Set([
  'schemaVersion', 'projectId', 'artifactRef', 'sourceBindings',
  'inputArtifactIds', 'createdAt',
]);

export function normalizeArtifactProvenanceV1(input) {
  const raw = plain(input, 'ArtifactProvenanceV1');
  exactKeys(raw, PROVENANCE_KEYS, 'ArtifactProvenanceV1');
  const sourceBindings = uniqueBy(
    boundedArray(raw.sourceBindings || [], 'sourceBindings', normalizeSourceRevisionBindingV1),
    'sourceId',
    'sourceBindings',
  );
  const ids = boundedArray(raw.inputArtifactIds || [], 'inputArtifactIds', value => id(value, 'artifactId'));
  if (new Set(ids).size !== ids.length) throw new Error('inputArtifactIds contains duplicates');
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'ArtifactProvenanceV1'),
    projectId: id(raw.projectId, 'projectId'),
    artifactRef: normalizeArtifactRefV1(raw.artifactRef),
    sourceBindings,
    inputArtifactIds: ids,
    createdAt: timestamp(raw.createdAt, 'createdAt'),
  });
}

export function sourceBindingFromRefV1(sourceRef) {
  const source = normalizeProjectSourceRefV1(sourceRef);
  return normalizeSourceRevisionBindingV1({
    sourceId: source.sourceId,
    revisionId: source.revisionId,
    contentSha256: source.contentSha256,
  });
}

export function assertContextCapsuleFreshV1(capsule, currentSourceRefs = []) {
  const normalized = normalizeContextCapsuleV1(capsule);
  const current = uniqueBy(
    boundedArray(currentSourceRefs, 'currentSourceRefs', normalizeProjectSourceRefV1),
    'sourceId',
    'currentSourceRefs',
  );
  const byId = new Map(current.map(source => [source.sourceId, source]));
  const stale = [];
  for (const binding of normalized.sourceBindings) {
    const source = byId.get(binding.sourceId);
    if (!source || source.projectId !== normalized.projectId || source.revisionId !== binding.revisionId) {
      stale.push(binding.sourceId);
      continue;
    }
    if (binding.contentSha256 && source.contentSha256 !== binding.contentSha256) stale.push(binding.sourceId);
  }
  if (stale.length) throw new Error(`ContextCapsuleV1 is stale for sources: ${stale.join(', ')}`);
  return normalized;
}
