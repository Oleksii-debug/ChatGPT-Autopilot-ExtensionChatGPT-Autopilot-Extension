import {
  normalizeProjectSnapshotV1,
  normalizeProjectSourceRefV1,
} from './project-context-artifact.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const DATA_ANALYTICS_SCHEMA_VERSION = 1;
export const DataLogicalType = Object.freeze({
  BOOLEAN: 'BOOLEAN',
  INTEGER: 'INTEGER',
  DECIMAL: 'DECIMAL',
  TEXT: 'TEXT',
  TIMESTAMP: 'TIMESTAMP',
  DATE: 'DATE',
  JSON: 'JSON',
  BINARY: 'BINARY',
  UNKNOWN: 'UNKNOWN',
});

const LOGICAL_TYPES = new Set(Object.values(DataLogicalType));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_COLUMNS = 256;
const MAX_SOURCES = 128;
const MAX_DATASETS = 64;
const MAX_EVIDENCE = 64;
const MAX_TEXT = 16_000;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_ARRAY = 4096;

function strictRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function strictArray(value, label, max, { min = 0 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain dense array`);
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    throw new Error(`${label} has an invalid length descriptor`);
  }
  const length = lengthDescriptor.value;
  if (length < min || length > max) {
    throw new Error(`${label} length must be ${min}-${max}`);
  }
  const values = new Map();
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index fields`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= length) {
      throw new Error(`${label} contains invalid indices`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}[${index}] must be an enumerable data item`);
    }
    values.set(index, descriptor.value);
  }
  const snapshot = new Array(length);
  for (let index = 0; index < length; index += 1) {
    if (!values.has(index)) {
      throw new Error(`${label}[${index}] must be an enumerable data item`);
    }
    snapshot[index] = values.get(index);
  }
  return Object.freeze(snapshot);
}

function guardJsonData(value, label, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    const snapshot = strictArray(value, label, MAX_JSON_ARRAY);
    return Object.freeze(snapshot.map((item, index) => guardJsonData(item, `${label}[${index}]`, depth + 1)));
  }
  if (value && typeof value === 'object') {
    const snapshot = strictRecord(value, label);
    const normalized = Object.create(null);
    for (const key of Object.keys(snapshot)) {
      Object.defineProperty(normalized, key, {
        value: guardJsonData(snapshot[key], `${label}.${key}`, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(normalized);
  }
  throw new Error(`${label} must contain JSON data only`);
}

function exactKeys(raw, allowed, label) {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function version(value, label) {
  if (value !== DATA_ANALYTICS_SCHEMA_VERSION) throw new Error(`Unsupported ${label} schemaVersion`);
  return DATA_ANALYTICS_SCHEMA_VERSION;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if ((value === undefined || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a safe integer in range`);
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error(`${label} must be a canonical timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCanonicalTimestamp(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return leftMs < rightMs ? -1 : leftMs > rightMs ? 1 : 0;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
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

function requireOwn(raw, key, label) {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) throw new Error(`${label}.${key} is required`);
}

function strictProjectSourceRef(input, label = 'ProjectSourceRefV1') {
  const raw = strictRecord(input, label);
  for (const key of ['schemaVersion', 'sourceId', 'projectId', 'kind', 'uri', 'revisionId', 'contentSha256', 'observedAt', 'authority']) {
    requireOwn(raw, key, label);
  }
  id(raw.sourceId, `${label}.sourceId`);
  id(raw.projectId, `${label}.projectId`);
  id(raw.kind, `${label}.kind`);
  text(raw.uri, `${label}.uri`, { max: 4096 });
  id(raw.revisionId, `${label}.revisionId`);
  digest(raw.contentSha256, `${label}.contentSha256`);
  timestamp(raw.observedAt, `${label}.observedAt`);
  if (typeof raw.authority !== 'string' || raw.authority !== raw.authority.trim() || raw.authority !== raw.authority.toUpperCase()) {
    throw new Error(`${label}.authority must be canonical text`);
  }
  const normalizedInput = { ...raw };
  if (raw.metadata !== undefined) {
    normalizedInput.metadata = guardJsonData(raw.metadata, `${label}.metadata`);
  }
  return normalizeProjectSourceRefV1(normalizedInput);
}

function strictArtifactRef(input, label = 'ArtifactRefV1') {
  const raw = strictRecord(input, label);
  for (const key of ['schemaVersion', 'artifactId', 'kind', 'uri', 'sha256', 'sizeBytes', 'createdAt', 'sensitive']) {
    requireOwn(raw, key, label);
  }
  version(raw.schemaVersion, label);
  id(raw.artifactId, `${label}.artifactId`);
  id(raw.kind, `${label}.kind`);
  text(raw.uri, `${label}.uri`, { max: 4096 });
  if (raw.mediaType !== undefined) text(raw.mediaType, `${label}.mediaType`, { optional: true, max: 300 });
  if (raw.producerInvocationId !== undefined && raw.producerInvocationId !== null && raw.producerInvocationId !== '') {
    id(raw.producerInvocationId, `${label}.producerInvocationId`);
  }
  digest(raw.sha256, `${label}.sha256`);
  integer(raw.sizeBytes, `${label}.sizeBytes`);
  bool(raw.sensitive, `${label}.sensitive`);
  timestamp(raw.createdAt, `${label}.createdAt`);
  return normalizeArtifactRefV1(raw);
}

const COLUMN_KEYS = new Set(['name', 'logicalType', 'sourceType', 'nullable', 'ordinal']);

export function normalizeDataColumnV1(input) {
  const raw = strictRecord(input, 'DataColumnV1');
  exactKeys(raw, COLUMN_KEYS, 'DataColumnV1');
  const logicalType = text(raw.logicalType, 'logicalType', { max: 64 }).toUpperCase();
  if (!LOGICAL_TYPES.has(logicalType)) throw new Error('logicalType is invalid');
  return frozen({
    name: text(raw.name, 'name', { max: 500 }),
    logicalType,
    sourceType: text(raw.sourceType, 'sourceType', { optional: true, max: 500 }),
    nullable: bool(raw.nullable, 'nullable'),
    ordinal: integer(raw.ordinal, 'ordinal', 0, MAX_COLUMNS - 1),
  });
}

const DATASET_KEYS = new Set([
  'schemaVersion', 'datasetId', 'projectId', 'revisionId', 'contentSha256',
  'sourceRefs', 'artifactRef', 'columns', 'rowCount', 'observedAt',
]);

export function normalizeDataDatasetSnapshotV1(input) {
  const raw = strictRecord(input, 'DataDatasetSnapshotV1');
  exactKeys(raw, DATASET_KEYS, 'DataDatasetSnapshotV1');
  const projectId = id(raw.projectId, 'projectId');
  const sourceRefs = unique(
    strictArray(raw.sourceRefs, 'sourceRefs', MAX_SOURCES).map((source, index) => {
      const normalized = strictProjectSourceRef(source, `sourceRefs[${index}]`);
      if (normalized.projectId !== projectId) throw new Error(`sourceRefs[${index}] projectId mismatch`);
      return normalized;
    }),
    'sourceId',
    'sourceRefs',
  ).sort((a, b) => asciiCompare(a.sourceId, b.sourceId));
  const columns = unique(
    strictArray(raw.columns, 'columns', MAX_COLUMNS, { min: 1 }).map((column, index) => {
      try { return normalizeDataColumnV1(column); }
      catch (error) { throw new Error(`columns[${index}]: ${error.message}`); }
    }),
    'name',
    'columns',
  ).sort((a, b) => a.ordinal - b.ordinal || asciiCompare(a.name, b.name));
  for (let index = 0; index < columns.length; index += 1) {
    if (columns[index].ordinal !== index) throw new Error('columns ordinals must be contiguous from zero');
  }
  const artifactRef = strictArtifactRef(raw.artifactRef);
  const contentSha256 = digest(raw.contentSha256, 'contentSha256');
  if (artifactRef.sha256 !== contentSha256) throw new Error('artifactRef.sha256 must match contentSha256');
  const observedAt = timestamp(raw.observedAt, 'observedAt');
  const observedAtMs = Date.parse(observedAt);
  for (const source of sourceRefs) {
    if (Date.parse(source.observedAt) > observedAtMs) {
      throw new Error(`sourceRefs source observed after dataset snapshot: ${source.sourceId}`);
    }
  }
  if (Date.parse(artifactRef.createdAt) > observedAtMs) {
    throw new Error('artifactRef created after dataset snapshot');
  }
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'DataDatasetSnapshotV1'),
    datasetId: id(raw.datasetId, 'datasetId'),
    projectId,
    revisionId: id(raw.revisionId, 'revisionId'),
    contentSha256,
    sourceRefs,
    artifactRef,
    columns,
    rowCount: integer(raw.rowCount, 'rowCount'),
    observedAt,
  });
}

const DATASET_BINDING_KEYS = new Set(['datasetId', 'revisionId', 'contentSha256', 'artifactId']);

export function normalizeDataDatasetBindingV1(input) {
  const raw = strictRecord(input, 'DataDatasetBindingV1');
  exactKeys(raw, DATASET_BINDING_KEYS, 'DataDatasetBindingV1');
  return frozen({
    datasetId: id(raw.datasetId, 'datasetId'),
    revisionId: id(raw.revisionId, 'revisionId'),
    contentSha256: digest(raw.contentSha256, 'contentSha256'),
    artifactId: id(raw.artifactId, 'artifactId'),
  });
}

export function dataDatasetBindingFromSnapshotV1(snapshot) {
  const normalized = normalizeDataDatasetSnapshotV1(snapshot);
  return normalizeDataDatasetBindingV1({
    datasetId: normalized.datasetId,
    revisionId: normalized.revisionId,
    contentSha256: normalized.contentSha256,
    artifactId: normalized.artifactRef.artifactId,
  });
}

const LINEAGE_KEYS = new Set([
  'schemaVersion', 'lineageId', 'projectId', 'transformId', 'transformRevisionId',
  'engineId', 'engineVersion', 'definitionSha256', 'inputDatasets', 'outputDataset',
  'evidenceArtifactRefs', 'executedAt',
]);

export function normalizeDataTransformLineageV1(input) {
  const raw = strictRecord(input, 'DataTransformLineageV1');
  exactKeys(raw, LINEAGE_KEYS, 'DataTransformLineageV1');
  const inputs = unique(
    strictArray(raw.inputDatasets, 'inputDatasets', MAX_DATASETS, { min: 1 }).map((binding, index) => {
      try { return normalizeDataDatasetBindingV1(binding); }
      catch (error) { throw new Error(`inputDatasets[${index}]: ${error.message}`); }
    }),
    'datasetId',
    'inputDatasets',
  ).sort((a, b) => asciiCompare(a.datasetId, b.datasetId));
  const evidenceArtifactRefs = unique(
    strictArray(raw.evidenceArtifactRefs, 'evidenceArtifactRefs', MAX_EVIDENCE, { min: 1 }).map((ref, index) => {
      try { return strictArtifactRef(ref, `evidenceArtifactRefs[${index}]`); }
      catch (error) { throw new Error(`evidenceArtifactRefs[${index}]: ${error.message}`); }
    }),
    'artifactId',
    'evidenceArtifactRefs',
  ).sort((a, b) => asciiCompare(a.artifactId, b.artifactId));
  return frozen({
    schemaVersion: version(raw.schemaVersion, 'DataTransformLineageV1'),
    lineageId: id(raw.lineageId, 'lineageId'),
    projectId: id(raw.projectId, 'projectId'),
    transformId: id(raw.transformId, 'transformId'),
    transformRevisionId: id(raw.transformRevisionId, 'transformRevisionId'),
    engineId: id(raw.engineId, 'engineId'),
    engineVersion: text(raw.engineVersion, 'engineVersion', { max: 500 }),
    definitionSha256: digest(raw.definitionSha256, 'definitionSha256'),
    inputDatasets: inputs,
    outputDataset: normalizeDataDatasetBindingV1(raw.outputDataset),
    evidenceArtifactRefs,
    executedAt: timestamp(raw.executedAt, 'executedAt'),
  });
}

function bindingIdentity(binding) {
  return JSON.stringify([
    binding.datasetId,
    binding.revisionId,
    binding.contentSha256,
    binding.artifactId,
  ]);
}

const TRANSFORM_ASSERT_REQUEST_KEYS = new Set(['lineage', 'inputSnapshots', 'outputSnapshot']);

export function assertDataTransformLineageMatchesSnapshotsV1(request = {}) {
  const raw = strictRecord(request, 'assertDataTransformLineageMatchesSnapshotsV1 request');
  exactKeys(raw, TRANSFORM_ASSERT_REQUEST_KEYS, 'assertDataTransformLineageMatchesSnapshotsV1 request');
  for (const key of TRANSFORM_ASSERT_REQUEST_KEYS) requireOwn(raw, key, 'assertDataTransformLineageMatchesSnapshotsV1 request');
  const { lineage, inputSnapshots, outputSnapshot } = raw;
  const normalizedLineage = normalizeDataTransformLineageV1(lineage);
  const inputs = unique(
    strictArray(inputSnapshots, 'inputSnapshots', MAX_DATASETS, { min: 1 }).map((snapshot, index) => {
      try { return normalizeDataDatasetSnapshotV1(snapshot); }
      catch (error) { throw new Error(`inputSnapshots[${index}]: ${error.message}`); }
    }),
    'datasetId',
    'inputSnapshots',
  );
  const output = normalizeDataDatasetSnapshotV1(outputSnapshot);
  if (inputs.length !== normalizedLineage.inputDatasets.length) {
    throw new Error('transform lineage input dataset set mismatch');
  }
  const byId = new Map(inputs.map(snapshot => [snapshot.datasetId, snapshot]));
  for (const expected of normalizedLineage.inputDatasets) {
    const snapshot = byId.get(expected.datasetId);
    if (!snapshot || snapshot.projectId !== normalizedLineage.projectId) {
      throw new Error(`transform input dataset mismatch: ${expected.datasetId}`);
    }
    if (bindingIdentity(dataDatasetBindingFromSnapshotV1(snapshot)) !== bindingIdentity(expected)) {
      throw new Error(`transform input dataset revision mismatch: ${expected.datasetId}`);
    }
    if (compareCanonicalTimestamp(snapshot.observedAt, normalizedLineage.executedAt) > 0) {
      throw new Error(`transform input dataset observed after execution: ${expected.datasetId}`);
    }
  }
  if (output.projectId !== normalizedLineage.projectId) throw new Error('transform output projectId mismatch');
  if (bindingIdentity(dataDatasetBindingFromSnapshotV1(output)) !== bindingIdentity(normalizedLineage.outputDataset)) {
    throw new Error('transform output dataset revision mismatch');
  }
  if (compareCanonicalTimestamp(output.observedAt, normalizedLineage.executedAt) < 0) {
    throw new Error('transform output dataset predates execution');
  }
  if (compareCanonicalTimestamp(output.artifactRef.createdAt, normalizedLineage.executedAt) < 0) {
    throw new Error('transform output artifact predates execution');
  }
  for (const source of output.sourceRefs) {
    if (compareCanonicalTimestamp(source.observedAt, normalizedLineage.executedAt) > 0) {
      throw new Error(`transform output source observed after execution: ${source.sourceId}`);
    }
  }
  return frozen({ lineage: normalizedLineage, inputSnapshots: inputs, outputSnapshot: output });
}

function sourceIdentity(source) {
  return JSON.stringify([
    source.sourceId,
    source.projectId,
    source.kind,
    source.uri,
    source.revisionId,
    source.contentSha256,
    source.observedAt,
    source.authority,
  ]);
}

const DATASET_PROJECT_REQUEST_KEYS = new Set(['dataset', 'projectSnapshot']);

export function assertDataDatasetSourcesMatchProjectSnapshotV1(request = {}) {
  const raw = strictRecord(request, 'assertDataDatasetSourcesMatchProjectSnapshotV1 request');
  exactKeys(raw, DATASET_PROJECT_REQUEST_KEYS, 'assertDataDatasetSourcesMatchProjectSnapshotV1 request');
  for (const key of DATASET_PROJECT_REQUEST_KEYS) requireOwn(raw, key, 'assertDataDatasetSourcesMatchProjectSnapshotV1 request');
  const normalizedDataset = normalizeDataDatasetSnapshotV1(raw.dataset);
  const projectSnapshot = guardJsonData(raw.projectSnapshot, 'projectSnapshot');
  const normalizedProject = normalizeProjectSnapshotV1(projectSnapshot);
  if (normalizedProject.projectId !== normalizedDataset.projectId) {
    throw new Error('dataset projectId does not match ProjectSnapshotV1');
  }
  const admittedById = new Map(normalizedProject.sourceRefs.map(source => [source.sourceId, source]));
  for (const source of normalizedDataset.sourceRefs) {
    const admitted = admittedById.get(source.sourceId);
    if (!admitted || sourceIdentity(admitted) !== sourceIdentity(source)) {
      throw new Error(`dataset source is not admitted by ProjectSnapshotV1: ${source.sourceId}`);
    }
  }
  return frozen({
    dataset: normalizedDataset,
    projectId: normalizedProject.projectId,
    projectRevisionId: normalizedProject.revisionId,
    advisoryOnly: true,
  });
}

export function assessDataDatasetFreshnessV1(snapshot, currentSourceRefs = []) {
  const normalized = normalizeDataDatasetSnapshotV1(snapshot);
  const current = unique(
    strictArray(currentSourceRefs, 'currentSourceRefs', MAX_SOURCES).map((source, index) => {
      const ref = strictProjectSourceRef(source, `currentSourceRefs[${index}]`);
      if (ref.projectId !== normalized.projectId) throw new Error(`currentSourceRefs[${index}] projectId mismatch`);
      return ref;
    }),
    'sourceId',
    'currentSourceRefs',
  );
  if (!normalized.sourceRefs.length) {
    return frozen({
      schemaVersion: DATA_ANALYTICS_SCHEMA_VERSION,
      datasetId: normalized.datasetId,
      datasetRevisionId: normalized.revisionId,
      advisoryOnly: true,
      status: 'UNVERIFIED',
      checkedSourceCount: 0,
      staleSourceCount: 0,
      sources: [],
    });
  }
  const byId = new Map(current.map(source => [source.sourceId, source]));
  const sources = normalized.sourceRefs.map(expected => {
    const actual = byId.get(expected.sourceId) || null;
    const reasons = [];
    if (!actual) {
      reasons.push('CURRENT_SOURCE_MISSING');
    } else {
      if (actual.kind !== expected.kind) reasons.push('KIND_CHANGED');
      if (actual.uri !== expected.uri) reasons.push('URI_CHANGED');
      if (actual.authority !== expected.authority) reasons.push('AUTHORITY_CHANGED');
      if (compareCanonicalTimestamp(actual.observedAt, expected.observedAt) < 0) reasons.push('OBSERVATION_REGRESSED');
      if (actual.revisionId !== expected.revisionId) reasons.push('REVISION_CHANGED');
      if (actual.contentSha256 !== expected.contentSha256) reasons.push('CONTENT_CHANGED');
    }
    return frozen({
      sourceId: expected.sourceId,
      status: reasons.length ? 'STALE' : 'FRESH',
      reasons,
      expectedRevisionId: expected.revisionId,
      currentRevisionId: actual?.revisionId || null,
    });
  }).sort((a, b) => asciiCompare(a.sourceId, b.sourceId));
  const staleSourceCount = sources.filter(source => source.status === 'STALE').length;
  return frozen({
    schemaVersion: DATA_ANALYTICS_SCHEMA_VERSION,
    datasetId: normalized.datasetId,
    datasetRevisionId: normalized.revisionId,
    advisoryOnly: true,
    status: staleSourceCount ? 'STALE' : 'FRESH',
    checkedSourceCount: sources.length,
    staleSourceCount,
    sources,
  });
}

function columnIdentity(column) {
  return JSON.stringify([column.ordinal, column.logicalType, column.sourceType, column.nullable]);
}

function snapshotRevisionFingerprint(snapshot) {
  return JSON.stringify([
    snapshot.contentSha256,
    snapshot.rowCount,
    snapshot.artifactRef.artifactId,
    snapshot.artifactRef.sha256,
    snapshot.columns.map(column => [column.name, column.ordinal, column.logicalType, column.sourceType, column.nullable]),
    snapshot.sourceRefs.map(source => sourceIdentity(source)),
  ]);
}

function sourceDeltaView(source) {
  if (!source) return null;
  return frozen({
    kind: source.kind,
    uri: source.uri,
    authority: source.authority,
    revisionId: source.revisionId,
    contentSha256: source.contentSha256,
    observedAt: source.observedAt,
  });
}

function columnDeltaView(column) {
  if (!column) return null;
  return frozen({
    ordinal: column.ordinal,
    logicalType: column.logicalType,
    sourceType: column.sourceType,
    nullable: column.nullable,
  });
}

const DATASET_DELTA_REQUEST_KEYS = new Set(['baseline', 'current']);

export function deriveDataDatasetDeltaV1(request = {}) {
  const raw = strictRecord(request, 'deriveDataDatasetDeltaV1 request');
  exactKeys(raw, DATASET_DELTA_REQUEST_KEYS, 'deriveDataDatasetDeltaV1 request');
  for (const key of DATASET_DELTA_REQUEST_KEYS) requireOwn(raw, key, 'deriveDataDatasetDeltaV1 request');
  const before = normalizeDataDatasetSnapshotV1(raw.baseline);
  const after = normalizeDataDatasetSnapshotV1(raw.current);
  if (before.projectId !== after.projectId || before.datasetId !== after.datasetId) {
    throw new Error('dataset delta requires the same projectId and datasetId');
  }
  if (before.revisionId === after.revisionId && snapshotRevisionFingerprint(before) !== snapshotRevisionFingerprint(after)) {
    throw new Error('dataset revision identity conflict');
  }

  const beforeColumns = new Map(before.columns.map(column => [column.name, column]));
  const afterColumns = new Map(after.columns.map(column => [column.name, column]));
  const columnNames = [...new Set([...beforeColumns.keys(), ...afterColumns.keys()])].sort(asciiCompare);
  const schemaChanges = [];
  for (const name of columnNames) {
    const prior = beforeColumns.get(name) || null;
    const next = afterColumns.get(name) || null;
    let change = 'UNCHANGED';
    if (!prior) change = 'ADDED';
    else if (!next) change = 'REMOVED';
    else if (columnIdentity(prior) !== columnIdentity(next)) change = 'CHANGED';
    if (change !== 'UNCHANGED') {
      schemaChanges.push(frozen({ name, change, before: columnDeltaView(prior), after: columnDeltaView(next) }));
    }
  }

  const beforeSources = new Map(before.sourceRefs.map(source => [source.sourceId, source]));
  const afterSources = new Map(after.sourceRefs.map(source => [source.sourceId, source]));
  const sourceIds = [...new Set([...beforeSources.keys(), ...afterSources.keys()])].sort(asciiCompare);
  const sourceChanges = [];
  for (const sourceId of sourceIds) {
    const prior = beforeSources.get(sourceId) || null;
    const next = afterSources.get(sourceId) || null;
    let change = 'UNCHANGED';
    if (!prior) change = 'ADDED';
    else if (!next) change = 'REMOVED';
    else if (sourceIdentity(prior) !== sourceIdentity(next)) change = 'CHANGED';
    if (change !== 'UNCHANGED') {
      sourceChanges.push(frozen({ sourceId, change, before: sourceDeltaView(prior), after: sourceDeltaView(next) }));
    }
  }

  const signals = [];
  if (before.revisionId !== after.revisionId) signals.push('REVISION_CHANGED');
  if (before.contentSha256 !== after.contentSha256) signals.push('CONTENT_CHANGED');
  if (schemaChanges.length) signals.push('SCHEMA_CHANGED');
  if (sourceChanges.length) signals.push('SOURCE_BINDINGS_CHANGED');
  if (before.artifactRef.artifactId !== after.artifactRef.artifactId || before.artifactRef.sha256 !== after.artifactRef.sha256) {
    signals.push('ARTIFACT_CHANGED');
  }
  if (after.rowCount > before.rowCount) signals.push('ROW_COUNT_INCREASED');
  if (after.rowCount < before.rowCount) signals.push('ROW_COUNT_DECREASED');

  return frozen({
    schemaVersion: DATA_ANALYTICS_SCHEMA_VERSION,
    projectId: after.projectId,
    datasetId: after.datasetId,
    fromRevisionId: before.revisionId,
    toRevisionId: after.revisionId,
    advisoryOnly: true,
    status: signals.length ? 'CHANGED' : 'UNCHANGED',
    rowCountBefore: before.rowCount,
    rowCountAfter: after.rowCount,
    rowCountDelta: after.rowCount - before.rowCount,
    signals,
    schemaChanges,
    sourceChanges,
  });
}
