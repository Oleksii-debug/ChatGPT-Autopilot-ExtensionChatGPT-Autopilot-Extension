import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';
import { normalizeArtifactProvenanceV1 } from './project-context-artifact.js';

export const ArtifactRegistrySchemaVersion = 1;
export const MAX_ARTIFACTS_PER_REGISTRY = 256;
export const MAX_VERSIONS_PER_ARTIFACT = 128;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);
const SOURCE_BINDING_KEYS = new Set(['sourceId', 'revisionId', 'contentSha256']);
const INPUT_ARTIFACT_BINDING_KEYS = new Set(['artifactId', 'versionId', 'sha256']);
const PROVENANCE_KEYS = new Set([
  'schemaVersion', 'projectId', 'artifactRef', 'sourceBindings',
  'inputArtifactIds', 'inputArtifactBindings', 'createdAt',
]);
const VERSION_KEYS = new Set([
  'schemaVersion', 'projectId', 'versionId', 'parentVersionId',
  'artifactRef', 'provenance', 'registeredAt',
]);
const ENTRY_KEYS = new Set(['artifactId', 'currentVersionId', 'versions']);
const REGISTRY_KEYS = new Set(['schemaVersion', 'projectId', 'revision', 'artifacts']);

function snapshotRecord(value, allowed, label, { optionalKeys = new Set() } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  const seen = new Set();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    out[key] = descriptor.value;
    seen.add(key);
  }
  for (const key of allowed) {
    if (!seen.has(key) && !optionalKeys.has(key)) {
      throw new Error(`${label} is missing field: ${key}`);
    }
  }
  return out;
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
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded array`);
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

function exactVersion(value, label) {
  if (typeof value !== 'number'
      || !Number.isInteger(value)
      || value !== ArtifactRegistrySchemaVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return value;
}

function exactId(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function exactText(value, label, { optional = false, max = 4096 } = {}) {
  if (optional && value === '') return '';
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > max) {
    throw new Error(`${label} must use exact canonical text representation`);
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function exactInteger(value, label, min, max) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(`${label} must be an integer in range`);
  }
  return value;
}

function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function deepFrozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFrozen(child);
  return Object.freeze(value);
}

function exactArtifactRef(input) {
  const raw = snapshotRecord(input, ARTIFACT_KEYS, 'ArtifactRefV1');
  const canonical = {
    schemaVersion: exactVersion(raw.schemaVersion, 'ArtifactRefV1'),
    artifactId: exactId(raw.artifactId, 'artifactId'),
    kind: exactId(raw.kind, 'kind'),
    uri: exactText(raw.uri, 'uri', { max: 4096 }),
    mediaType: exactText(raw.mediaType, 'mediaType', { optional: true, max: 300 }),
    sha256: exactSha256(raw.sha256, 'sha256'),
    sizeBytes: exactInteger(raw.sizeBytes, 'sizeBytes', 0, Number.MAX_SAFE_INTEGER),
    createdAt: exactTimestamp(raw.createdAt, 'artifactRef.createdAt'),
    producerInvocationId: exactId(raw.producerInvocationId, 'producerInvocationId', { nullable: true }),
    sensitive: raw.sensitive,
  };
  if (typeof canonical.sensitive !== 'boolean') throw new Error('sensitive must be boolean');
  const normalized = normalizeArtifactRefV1(canonical);
  if (normalized.sha256 !== canonical.sha256
      || normalized.createdAt !== canonical.createdAt
      || normalized.artifactId !== canonical.artifactId
      || normalized.kind !== canonical.kind
      || normalized.uri !== canonical.uri
      || normalized.mediaType !== canonical.mediaType
      || normalized.sizeBytes !== canonical.sizeBytes
      || normalized.producerInvocationId !== canonical.producerInvocationId
      || normalized.sensitive !== canonical.sensitive) {
    throw new Error('ArtifactRefV1 is not already canonical');
  }
  return normalized;
}

function exactSourceBinding(input, index) {
  const label = `sourceBindings[${index}]`;
  const raw = snapshotRecord(input, SOURCE_BINDING_KEYS, label);
  return deepFrozen({
    sourceId: exactId(raw.sourceId, `${label}.sourceId`),
    revisionId: exactId(raw.revisionId, `${label}.revisionId`),
    contentSha256: exactSha256(raw.contentSha256, `${label}.contentSha256`),
  });
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

function exactInputArtifactBinding(input, index) {
  const label = `inputArtifactBindings[${index}]`;
  const raw = snapshotRecord(input, INPUT_ARTIFACT_BINDING_KEYS, label);
  return deepFrozen({
    artifactId: exactId(raw.artifactId, `${label}.artifactId`),
    versionId: exactId(raw.versionId, `${label}.versionId`),
    sha256: exactSha256(raw.sha256, `${label}.sha256`),
  });
}

function exactProvenance(input) {
  const raw = snapshotRecord(
    input,
    PROVENANCE_KEYS,
    'ArtifactProvenanceV1',
    { optionalKeys: new Set(['inputArtifactBindings']) },
  );
  const projectId = exactId(raw.projectId, 'provenance.projectId');
  const artifactRef = exactArtifactRef(raw.artifactRef);
  const sourceBindings = dataArray(raw.sourceBindings, 'sourceBindings', 128)
    .map((item, index) => exactSourceBinding(item, index))
    .sort((left, right) => compareCodeUnits(left.sourceId, right.sourceId));
  const sourceIds = sourceBindings.map(item => item.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error('sourceBindings contains duplicate sourceId');
  }
  const inputArtifactIds = dataArray(raw.inputArtifactIds, 'inputArtifactIds', 128)
    .map((item, index) => exactId(item, `inputArtifactIds[${index}]`))
    .sort(compareCodeUnits);
  if (new Set(inputArtifactIds).size !== inputArtifactIds.length) {
    throw new Error('inputArtifactIds contains duplicates');
  }
  const inputArtifactBindings = Object.prototype.hasOwnProperty.call(raw, 'inputArtifactBindings')
    ? dataArray(raw.inputArtifactBindings, 'inputArtifactBindings', 128)
      .map((item, index) => exactInputArtifactBinding(item, index))
      .sort((left, right) =>
        compareCodeUnits(left.artifactId, right.artifactId)
        || compareCodeUnits(left.versionId, right.versionId))
    : [];
  const boundArtifactIds = inputArtifactBindings.map(binding => binding.artifactId);
  const boundVersionIds = inputArtifactBindings.map(binding => binding.versionId);
  if (new Set(boundArtifactIds).size !== boundArtifactIds.length) {
    throw new Error('inputArtifactBindings contains duplicate artifactId');
  }
  if (new Set(boundVersionIds).size !== boundVersionIds.length) {
    throw new Error('inputArtifactBindings contains duplicate versionId');
  }
  if (inputArtifactBindings.length) {
    if (boundArtifactIds.length !== inputArtifactIds.length
        || boundArtifactIds.some((artifactId, index) => artifactId !== inputArtifactIds[index])) {
      throw new Error('inputArtifactBindings must exactly bind inputArtifactIds');
    }
  }
  const createdAt = exactTimestamp(raw.createdAt, 'provenance.createdAt');
  const normalized = normalizeArtifactProvenanceV1({
    schemaVersion: exactVersion(raw.schemaVersion, 'ArtifactProvenanceV1'),
    projectId,
    artifactRef,
    sourceBindings,
    inputArtifactIds,
    inputArtifactBindings,
    createdAt,
  });
  return normalized;
}

function exactArtifactVersion(input) {
  const raw = snapshotRecord(input, VERSION_KEYS, 'ArtifactVersionV1');
  const projectId = exactId(raw.projectId, 'version.projectId');
  const artifactRef = exactArtifactRef(raw.artifactRef);
  const provenance = exactProvenance(raw.provenance);
  const registeredAt = exactTimestamp(raw.registeredAt, 'registeredAt');
  const version = {
    schemaVersion: exactVersion(raw.schemaVersion, 'ArtifactVersionV1'),
    projectId,
    versionId: exactId(raw.versionId, 'versionId'),
    parentVersionId: exactId(raw.parentVersionId, 'parentVersionId', { nullable: true }),
    artifactRef,
    provenance,
    registeredAt,
  };
  if (provenance.projectId !== projectId) throw new Error('Artifact version provenance projectId mismatch');
  if (!artifactRefEqual(provenance.artifactRef, artifactRef)) {
    throw new Error('Artifact version provenance does not bind the exact artifact ref');
  }
  if (Date.parse(provenance.createdAt) < Date.parse(artifactRef.createdAt)) {
    throw new Error('Artifact provenance cannot predate artifact materialization');
  }
  if (Date.parse(registeredAt) < Date.parse(provenance.createdAt)) {
    throw new Error('Artifact registration cannot predate provenance');
  }
  return deepFrozen(version);
}

function exactEntry(input, projectId) {
  const raw = snapshotRecord(input, ENTRY_KEYS, 'ArtifactRegistryEntryV1');
  const artifactId = exactId(raw.artifactId, 'entry.artifactId');
  const currentVersionId = exactId(raw.currentVersionId, 'entry.currentVersionId');
  const versions = dataArray(raw.versions, `artifacts[${artifactId}].versions`, MAX_VERSIONS_PER_ARTIFACT)
    .map(exactArtifactVersion);
  if (!versions.length) throw new Error('Artifact registry entry must contain at least one version');
  const versionIds = new Set();
  let previous = null;
  for (const version of versions) {
    if (version.projectId !== projectId) throw new Error('Artifact registry version projectId mismatch');
    if (version.artifactRef.artifactId !== artifactId) {
      throw new Error('Artifact registry version artifactId mismatch');
    }
    if (versionIds.has(version.versionId)) throw new Error(`Duplicate artifact versionId: ${version.versionId}`);
    versionIds.add(version.versionId);
    if (previous === null) {
      if (version.parentVersionId !== null) throw new Error('First artifact version must not have a parent');
    } else {
      if (version.parentVersionId !== previous.versionId) {
        throw new Error('Artifact version parent must be the immediately previous version');
      }
      if (Date.parse(version.registeredAt) < Date.parse(previous.registeredAt)) {
        throw new Error('Artifact version registration time cannot regress');
      }
    }
    previous = version;
  }
  if (currentVersionId !== versions[versions.length - 1].versionId) {
    throw new Error('currentVersionId must identify the last artifact version');
  }
  return deepFrozen({ artifactId, currentVersionId, versions });
}

function assertVersionInputDependencies(artifacts, version) {
  const { inputArtifactIds, inputArtifactBindings } = version.provenance;
  if (inputArtifactIds.length !== inputArtifactBindings.length) {
    throw new Error('Artifact provenance with inputs requires exact inputArtifactBindings');
  }
  for (const binding of inputArtifactBindings) {
    const entry = artifacts.find(item => item.artifactId === binding.artifactId);
    if (!entry) {
      throw new Error(`Artifact input dependency not found: ${binding.artifactId}`);
    }
    const dependency = entry.versions.find(item => item.versionId === binding.versionId);
    if (!dependency) {
      throw new Error(`Artifact input version not found: ${binding.artifactId}/${binding.versionId}`);
    }
    if (dependency.versionId === version.versionId) {
      throw new Error('Artifact version cannot depend on itself');
    }
    if (dependency.artifactRef.sha256 !== binding.sha256) {
      throw new Error(`Artifact input SHA-256 mismatch: ${binding.artifactId}/${binding.versionId}`);
    }
    const derivedAt = Date.parse(version.artifactRef.createdAt);
    if (Date.parse(dependency.artifactRef.createdAt) > derivedAt) {
      throw new Error(`Artifact input materialization is from the future: ${binding.artifactId}/${binding.versionId}`);
    }
    if (Date.parse(dependency.registeredAt) > derivedAt) {
      throw new Error(`Artifact input registration is from the future: ${binding.artifactId}/${binding.versionId}`);
    }
  }
}

export function normalizeArtifactRegistryV1(input) {
  const raw = snapshotRecord(input, REGISTRY_KEYS, 'ArtifactRegistryV1');
  const projectId = exactId(raw.projectId, 'registry.projectId');
  const artifacts = dataArray(raw.artifacts, 'artifacts', MAX_ARTIFACTS_PER_REGISTRY)
    .map(item => exactEntry(item, projectId))
    .sort((left, right) => compareCodeUnits(left.artifactId, right.artifactId));
  const artifactIds = artifacts.map(item => item.artifactId);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error('ArtifactRegistryV1 contains duplicate artifactId');
  }
  const versionIds = artifacts.flatMap(entry => entry.versions.map(item => item.versionId));
  if (new Set(versionIds).size !== versionIds.length) {
    throw new Error('ArtifactRegistryV1 contains duplicate versionId across artifacts');
  }
  const revision = exactInteger(raw.revision, 'registry.revision', 0, Number.MAX_SAFE_INTEGER);
  if (revision !== versionIds.length) {
    throw new Error('ArtifactRegistryV1 revision must equal immutable version count');
  }
  for (const entry of artifacts) {
    for (const version of entry.versions) assertVersionInputDependencies(artifacts, version);
  }
  return deepFrozen({
    schemaVersion: exactVersion(raw.schemaVersion, 'ArtifactRegistryV1'),
    projectId,
    revision,
    artifacts,
  });
}

export function createArtifactRegistryV1(projectId) {
  return deepFrozen({
    schemaVersion: ArtifactRegistrySchemaVersion,
    projectId: exactId(projectId, 'projectId'),
    revision: 0,
    artifacts: [],
  });
}

function versionSignature(version) {
  return JSON.stringify(version);
}

export function putArtifactVersionV1(registryInput, versionInput) {
  const registry = normalizeArtifactRegistryV1(registryInput);
  const version = exactArtifactVersion(versionInput);
  if (version.projectId !== registry.projectId) throw new Error('Artifact version projectId mismatch');
  assertVersionInputDependencies(registry.artifacts, version);

  const existingEntry = registry.artifacts.find(item => item.artifactId === version.artifactRef.artifactId);
  const versionOwner = registry.artifacts.find(entry => entry.versions.some(item => item.versionId === version.versionId));
  if (versionOwner && versionOwner.artifactId !== version.artifactRef.artifactId) {
    throw new Error(`Artifact versionId already belongs to another artifact: ${version.versionId}`);
  }
  if (existingEntry) {
    const existingVersion = existingEntry.versions.find(item => item.versionId === version.versionId);
    if (existingVersion) {
      if (versionSignature(existingVersion) !== versionSignature(version)) {
        throw new Error(`Divergent artifact version collision: ${version.versionId}`);
      }
      return registry;
    }
    if (existingEntry.versions.length >= MAX_VERSIONS_PER_ARTIFACT) {
      throw new Error('Artifact version limit exceeded');
    }
    if (version.parentVersionId !== existingEntry.currentVersionId) {
      throw new Error('Artifact version parent must match currentVersionId');
    }
    const parent = existingEntry.versions[existingEntry.versions.length - 1];
    if (Date.parse(version.registeredAt) < Date.parse(parent.registeredAt)) {
      throw new Error('Artifact version registration time cannot regress');
    }
  } else {
    if (registry.artifacts.length >= MAX_ARTIFACTS_PER_REGISTRY) {
      throw new Error('Artifact registry artifact limit exceeded');
    }
    if (version.parentVersionId !== null) {
      throw new Error('First artifact version must not have a parent');
    }
  }

  const artifacts = registry.artifacts.map(entry => {
    if (!existingEntry || entry.artifactId !== existingEntry.artifactId) return entry;
    return deepFrozen({
      artifactId: entry.artifactId,
      currentVersionId: version.versionId,
      versions: [...entry.versions, version],
    });
  });
  if (!existingEntry) {
    artifacts.push(deepFrozen({
      artifactId: version.artifactRef.artifactId,
      currentVersionId: version.versionId,
      versions: [version],
    }));
  }
  artifacts.sort((left, right) => compareCodeUnits(left.artifactId, right.artifactId));
  return deepFrozen({
    schemaVersion: ArtifactRegistrySchemaVersion,
    projectId: registry.projectId,
    revision: registry.revision + 1,
    artifacts,
  });
}

export function getArtifactVersionV1(registryInput, artifactIdInput, versionIdInput) {
  const registry = normalizeArtifactRegistryV1(registryInput);
  const artifactId = exactId(artifactIdInput, 'artifactId');
  const versionId = exactId(versionIdInput, 'versionId');
  const entry = registry.artifacts.find(item => item.artifactId === artifactId);
  if (!entry) throw new Error('Artifact not found');
  const version = entry.versions.find(item => item.versionId === versionId);
  if (!version) throw new Error('Artifact version not found');
  return version;
}

export function getCurrentArtifactVersionV1(registryInput, artifactIdInput) {
  const registry = normalizeArtifactRegistryV1(registryInput);
  const artifactId = exactId(artifactIdInput, 'artifactId');
  const entry = registry.artifacts.find(item => item.artifactId === artifactId);
  if (!entry) throw new Error('Artifact not found');
  return entry.versions[entry.versions.length - 1];
}

export function listArtifactVersionsV1(registryInput, artifactIdInput) {
  const registry = normalizeArtifactRegistryV1(registryInput);
  const artifactId = exactId(artifactIdInput, 'artifactId');
  const entry = registry.artifacts.find(item => item.artifactId === artifactId);
  if (!entry) throw new Error('Artifact not found');
  return Object.freeze([...entry.versions]);
}

function listChangedArtifactFields(left, right) {
  const fields = [
    'kind', 'uri', 'mediaType', 'sha256', 'sizeBytes',
    'createdAt', 'producerInvocationId', 'sensitive',
  ];
  return fields.filter(field => left[field] !== right[field]);
}

export function compareArtifactVersionsV1(leftInput, rightInput) {
  const left = exactArtifactVersion(leftInput);
  const right = exactArtifactVersion(rightInput);
  if (left.projectId !== right.projectId) throw new Error('Artifact versions belong to different projects');
  if (left.artifactRef.artifactId !== right.artifactRef.artifactId) {
    throw new Error('Artifact versions belong to different artifacts');
  }
  const changedFields = listChangedArtifactFields(left.artifactRef, right.artifactRef);
  const leftSources = JSON.stringify(left.provenance.sourceBindings);
  const rightSources = JSON.stringify(right.provenance.sourceBindings);
  const leftInputs = JSON.stringify({
    ids: left.provenance.inputArtifactIds,
    bindings: left.provenance.inputArtifactBindings,
  });
  const rightInputs = JSON.stringify({
    ids: right.provenance.inputArtifactIds,
    bindings: right.provenance.inputArtifactBindings,
  });
  const provenanceChanged = versionSignature(left.provenance) !== versionSignature(right.provenance);
  return deepFrozen({
    schemaVersion: ArtifactRegistrySchemaVersion,
    projectId: left.projectId,
    artifactId: left.artifactRef.artifactId,
    fromVersionId: left.versionId,
    toVersionId: right.versionId,
    contentChanged: left.artifactRef.sha256 !== right.artifactRef.sha256,
    metadataChanged: changedFields.some(field => field !== 'sha256' && field !== 'sizeBytes'),
    changedFields,
    sizeDeltaBytes: right.artifactRef.sizeBytes - left.artifactRef.sizeBytes,
    provenanceChanged,
    sourceBindingsChanged: leftSources !== rightSources,
    inputArtifactsChanged: leftInputs !== rightInputs,
    advisoryOnly: true,
    executionAuthorized: false,
  });
}
