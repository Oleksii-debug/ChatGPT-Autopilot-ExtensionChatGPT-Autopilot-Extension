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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function version(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value !== ProjectContextContractVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return ProjectContextContractVersion;
}

function id(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  if (value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!out || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  const canonical = new Date(ms).toISOString();
  if (value !== canonical) throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  return value;
}

function digest(value, label, { optional = true } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  if (!SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function dataArray(value, label, max) {
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
      throw new Error(`${label} contains a non-index field`);
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

function cloneJsonData(value, label, stack = new WeakSet(), depth = 0) {
  if (depth > 32) throw new Error(`${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} must contain JSON-compatible data only`);
  }
  if (stack.has(value)) throw new Error(`${label} must not contain cycles`);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return dataArray(value, label, MAX_METADATA_JSON)
        .map((item, index) => cloneJsonData(item, `${label}[${index}]`, stack, depth + 1));
    }
    const raw = plain(value, label);
    const out = {};
    for (const key of Object.keys(raw)) {
      Object.defineProperty(out, key, {
        value: cloneJsonData(raw[key], `${label}.${key}`, stack, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

function jsonData(value, label) {
  if (value == null) return {};
  const cloned = cloneJsonData(value, label);
  if (JSON.stringify(cloned).length > MAX_METADATA_JSON) throw new Error(`${label} is too large`);
  return cloned;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function boundedArray(value, label, normalizeItem, { max = MAX_LIST, optional = false } = {}) {
  if (value == null && optional) return [];
  const items = dataArray(value, label, max);
  return items.map((item, index) => {
    try { return normalizeItem(item); }
    catch (error) { throw new Error(`${label}[${index}]: ${error.message}`); }
  });
}

const NESTED_ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);

function exactText(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalId(value, label) {
  if (value == null || value === '') return '';
  return id(value, label);
}

function exactNonNegativeInteger(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalizeNestedArtifactRefV1(input) {
  const raw = plain(input, 'ArtifactRefV1');
  exactKeys(raw, NESTED_ARTIFACT_KEYS, 'ArtifactRefV1');

  version(raw.schemaVersion, 'ArtifactRefV1');
  id(raw.artifactId, 'artifactId');
  id(raw.kind, 'kind');
  exactText(raw.uri, 'uri', { max: 4096 });
  exactText(raw.mediaType, 'mediaType', { optional: true, max: 300 });
  digest(raw.sha256, 'sha256', { optional: true });
  if (raw.sizeBytes != null) exactNonNegativeInteger(raw.sizeBytes, 'sizeBytes');
  timestamp(raw.createdAt, 'createdAt');
  optionalId(raw.producerInvocationId, 'producerInvocationId');
  if (raw.sensitive != null && typeof raw.sensitive !== 'boolean') {
    throw new Error('sensitive must be boolean');
  }

  return normalizeArtifactRefV1(raw);
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
  if (typeof raw.authority !== 'string') throw new Error('authority must be text');
  const authority = raw.authority;
  if (!AUTHORITY.has(authority)) throw new Error('authority is invalid');
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'ProjectSourceRefV1'),
    sourceId: id(raw.sourceId, 'sourceId'),
    projectId: id(raw.projectId, 'projectId'),
    kind: id(raw.kind, 'kind'),
    uri: exactText(raw.uri, 'uri', { max: 4096 }),
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
    boundedArray(raw.artifactRefs, 'artifactRefs', normalizeNestedArtifactRefV1, { optional: true }),
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
    boundedArray(raw.artifactRefs, 'artifactRefs', normalizeNestedArtifactRefV1, { optional: true }),
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

const INPUT_ARTIFACT_BINDING_KEYS = new Set(['artifactId', 'versionId', 'sha256']);

function normalizeArtifactInputBindingV1(input) {
  const raw = plain(input, 'ArtifactInputBindingV1');
  exactKeys(raw, INPUT_ARTIFACT_BINDING_KEYS, 'ArtifactInputBindingV1');
  return frozen({
    artifactId: id(raw.artifactId, 'inputArtifactBinding.artifactId'),
    versionId: id(raw.versionId, 'inputArtifactBinding.versionId'),
    sha256: digest(raw.sha256, 'inputArtifactBinding.sha256', { optional: false }),
  });
}

const PROVENANCE_KEYS = new Set([
  'schemaVersion', 'projectId', 'artifactRef', 'sourceBindings',
  'inputArtifactIds', 'inputArtifactBindings', 'createdAt',
]);

export function normalizeArtifactProvenanceV1(input) {
  const raw = plain(input, 'ArtifactProvenanceV1');
  exactKeys(raw, PROVENANCE_KEYS, 'ArtifactProvenanceV1');
  const sourceBindings = uniqueBy(
    boundedArray(raw.sourceBindings, 'sourceBindings', normalizeSourceRevisionBindingV1, { optional: true }),
    'sourceId',
    'sourceBindings',
  );
  const ids = boundedArray(raw.inputArtifactIds, 'inputArtifactIds', value => id(value, 'artifactId'), { optional: true });
  if (new Set(ids).size !== ids.length) throw new Error('inputArtifactIds contains duplicates');
  const inputArtifactBindings = uniqueBy(
    boundedArray(
      raw.inputArtifactBindings,
      'inputArtifactBindings',
      normalizeArtifactInputBindingV1,
      { optional: true },
    ),
    'artifactId',
    'inputArtifactBindings',
  );
  if (new Set(inputArtifactBindings.map(binding => binding.versionId)).size !== inputArtifactBindings.length) {
    throw new Error('inputArtifactBindings contains duplicate versionId');
  }
  if (inputArtifactBindings.length) {
    const boundIds = [...inputArtifactBindings.map(binding => binding.artifactId)].sort();
    const declaredIds = [...ids].sort();
    if (boundIds.length !== declaredIds.length
        || boundIds.some((artifactId, index) => artifactId !== declaredIds[index])) {
      throw new Error('inputArtifactBindings must exactly bind inputArtifactIds');
    }
  }
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'ArtifactProvenanceV1'),
    projectId: id(raw.projectId, 'projectId'),
    artifactRef: normalizeNestedArtifactRefV1(raw.artifactRef),
    sourceBindings,
    inputArtifactIds: ids,
    inputArtifactBindings,
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
