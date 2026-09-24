import {
  SourceAuthorityKind,
  normalizeProjectSnapshotV1,
  normalizeProjectSourceRefV1,
} from './project-context-artifact.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

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

export function buildProjectBootstrapV1(input) {
  const normalized = normalizeInput(input);
  const snapshot = normalizeProjectSnapshotV1({
    schemaVersion: 1,
    projectId: normalized.projectId,
    revisionId: normalized.revisionId,
    title: normalized.title,
    sourceRefs: normalized.sourceRefs,
    artifactRefs: normalized.artifactRefs,
    createdAt: normalized.createdAt,
  });
  const blockers = deriveBlockers(normalized);
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
    snapshot,
  });
}

