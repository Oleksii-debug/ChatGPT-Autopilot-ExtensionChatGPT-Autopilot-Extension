import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DataLogicalType,
  assessDataDatasetFreshnessV1,
  assertDataTransformLineageMatchesSnapshotsV1,
  dataDatasetBindingFromSnapshotV1,
  deriveDataDatasetDeltaV1,
  normalizeDataDatasetSnapshotV1,
  normalizeDataTransformLineageV1,
} from '../src/core/data-analytics-lineage.js';

const T1 = '2026-09-24T20:00:00.000Z';
const T2 = '2026-09-24T21:00:00.000Z';
const sha = char => char.repeat(64);

function artifact({ id = 'artifact-dataset-a', digest = sha('a'), at = T1 } = {}) {
  return {
    schemaVersion: 1,
    artifactId: id,
    kind: 'data.snapshot',
    uri: `artifact://${id}`,
    mediaType: 'application/json',
    sha256: digest,
    sizeBytes: 123,
    createdAt: at,
    producerInvocationId: 'invoke-data-1',
    sensitive: false,
  };
}

function source({
  id = 'source-a',
  projectId = 'project-a',
  revisionId = 'source-r1',
  digest = sha('b'),
  uri = 'file:///owner/data.csv',
  authority = 'CANONICAL',
  at = T1,
} = {}) {
  return {
    schemaVersion: 1,
    sourceId: id,
    projectId,
    kind: 'file',
    uri,
    revisionId,
    contentSha256: digest,
    observedAt: at,
    authority,
    metadata: {},
  };
}

function columns() {
  return [
    { name: 'amount', logicalType: 'DECIMAL', sourceType: 'decimal(18,2)', nullable: false, ordinal: 1 },
    { name: 'id', logicalType: 'INTEGER', sourceType: 'int64', nullable: false, ordinal: 0 },
  ];
}

function dataset({
  datasetId = 'dataset-a',
  projectId = 'project-a',
  revisionId = 'dataset-r1',
  digest = sha('a'),
  sourceRefs = [source({ projectId })],
  artifactId = 'artifact-dataset-a',
  schemaColumns = columns(),
  rowCount = 10,
  observedAt = T1,
} = {}) {
  return {
    schemaVersion: 1,
    datasetId,
    projectId,
    revisionId,
    contentSha256: digest,
    sourceRefs,
    artifactRef: artifact({ id: artifactId, digest, at: observedAt }),
    columns: schemaColumns,
    rowCount,
    observedAt,
  };
}

function lineage({ inputs, output, evidenceDigest = sha('e') } = {}) {
  return {
    schemaVersion: 1,
    lineageId: 'lineage-1',
    projectId: 'project-a',
    transformId: 'transform-sales',
    transformRevisionId: 'transform-r1',
    engineId: 'sql-engine',
    engineVersion: '1.2.3',
    definitionSha256: sha('d'),
    inputDatasets: (inputs || []).map(dataDatasetBindingFromSnapshotV1),
    outputDataset: dataDatasetBindingFromSnapshotV1(output),
    evidenceArtifactRefs: [artifact({ id: 'artifact-transform-log', digest: evidenceDigest, at: T2 })],
    executedAt: T2,
  };
}

test('dataset snapshots bind materialized sources/artifact and normalize deterministic schema order', () => {
  const raw = dataset({
    sourceRefs: [
      source({ id: 'source-b', revisionId: 'b-r1', digest: sha('c'), uri: 'file:///owner/b.csv' }),
      source(),
    ],
  });
  const normalized = normalizeDataDatasetSnapshotV1(raw);
  assert.deepEqual(normalized.columns.map(column => column.name), ['id', 'amount']);
  assert.deepEqual(normalized.sourceRefs.map(ref => ref.sourceId), ['source-a', 'source-b']);
  assert.equal(normalized.columns[0].logicalType, DataLogicalType.INTEGER);
  assert.equal(normalized.artifactRef.sha256, normalized.contentSha256);
  assert(Object.isFrozen(normalized));
  assert.throws(() => normalizeDataDatasetSnapshotV1({ ...raw, contentSha256: sha('f') }), /must match/);
  const noSourceHash = structuredClone(raw);
  noSourceHash.sourceRefs[0].contentSha256 = '';
  assert.throws(() => normalizeDataDatasetSnapshotV1(noSourceHash), /materialized/);
});

test('analytics authority boundary rejects getters, hidden fields, symbols, exotic objects and sparse arrays without executing accessors', () => {
  let reads = 0;
  const accessor = dataset();
  Object.defineProperty(accessor, 'rowCount', {
    enumerable: true,
    get() { reads += 1; return 10; },
  });
  assert.throws(() => normalizeDataDatasetSnapshotV1(accessor), /enumerable data property/);
  assert.equal(reads, 0);

  const hidden = dataset();
  Object.defineProperty(hidden, 'revisionId', { value: 'dataset-r1', enumerable: false });
  assert.throws(() => normalizeDataDatasetSnapshotV1(hidden), /enumerable data property/);

  const symbol = dataset();
  symbol[Symbol('permission')] = 'ALLOW';
  assert.throws(() => normalizeDataDatasetSnapshotV1(symbol), /symbol fields/);

  const exotic = Object.create({ policyDecision: 'ALLOW' });
  Object.assign(exotic, dataset());
  assert.throws(() => normalizeDataDatasetSnapshotV1(exotic), /plain data object/);

  const sparse = dataset();
  sparse.columns = new Array(2);
  sparse.columns[0] = { name: 'id', logicalType: 'INTEGER', sourceType: 'int64', nullable: false, ordinal: 0 };
  assert.throws(() => normalizeDataDatasetSnapshotV1(sparse), /enumerable data item/);

  const sideField = dataset();
  sideField.columns.extra = 'ALLOW';
  assert.throws(() => normalizeDataDatasetSnapshotV1(sideField), /non-index fields/);

  const nestedAccessor = dataset();
  Object.defineProperty(nestedAccessor.sourceRefs[0].metadata, 'secret', {
    enumerable: true,
    get() { reads += 1; return 'never'; },
  });
  assert.throws(() => normalizeDataDatasetSnapshotV1(nestedAccessor), /enumerable data property/);
  assert.equal(reads, 0);

  assert.throws(() => normalizeDataDatasetSnapshotV1({ ...dataset(), policyDecision: 'ALLOW' }), /unknown field/);
});

test('freshness is exact revision/hash/source identity evidence and never grants permission', () => {
  const snap = dataset();
  const fresh = assessDataDatasetFreshnessV1(snap, [source()]);
  assert.equal(fresh.status, 'FRESH');
  assert.equal(fresh.advisoryOnly, true);
  assert.equal(fresh.staleSourceCount, 0);

  const changed = assessDataDatasetFreshnessV1(snap, [
    source({ revisionId: 'source-r2', digest: sha('c') }),
  ]);
  assert.equal(changed.status, 'STALE');
  assert.deepEqual(changed.sources[0].reasons, ['REVISION_CHANGED', 'CONTENT_CHANGED']);

  const missing = assessDataDatasetFreshnessV1(snap, []);
  assert.equal(missing.status, 'STALE');
  assert.deepEqual(missing.sources[0].reasons, ['CURRENT_SOURCE_MISSING']);

  const derived = assessDataDatasetFreshnessV1(dataset({ sourceRefs: [] }), []);
  assert.equal(derived.status, 'UNVERIFIED');
  assert.equal(derived.advisoryOnly, true);

  assert.throws(() => assessDataDatasetFreshnessV1(snap, [source({ projectId: 'project-other' })]), /projectId mismatch/);
});

test('transform lineage is reproducible and exact-bound to every input/output revision', () => {
  const inputA = dataset();
  const inputB = dataset({
    datasetId: 'dataset-b',
    revisionId: 'dataset-b-r1',
    digest: sha('c'),
    sourceRefs: [source({ id: 'source-b', revisionId: 'source-b-r1', digest: sha('d'), uri: 'file:///owner/b.csv' })],
    artifactId: 'artifact-dataset-b',
  });
  const output = dataset({
    datasetId: 'dataset-out',
    revisionId: 'dataset-out-r1',
    digest: sha('f'),
    sourceRefs: [],
    artifactId: 'artifact-dataset-out',
    observedAt: T2,
  });
  const raw = lineage({ inputs: [inputB, inputA], output });
  const normalized = normalizeDataTransformLineageV1(raw);
  assert.deepEqual(normalized.inputDatasets.map(binding => binding.datasetId), ['dataset-a', 'dataset-b']);
  assert.doesNotThrow(() => assertDataTransformLineageMatchesSnapshotsV1({
    lineage: raw,
    inputSnapshots: [inputA, inputB],
    outputSnapshot: output,
  }));

  const staleA = dataset({ revisionId: 'dataset-r2', digest: sha('9'), artifactId: 'artifact-dataset-a-r2' });
  assert.throws(() => assertDataTransformLineageMatchesSnapshotsV1({
    lineage: raw,
    inputSnapshots: [staleA, inputB],
    outputSnapshot: output,
  }), /input dataset revision mismatch/);

  const wrongOutput = dataset({
    datasetId: 'dataset-out',
    revisionId: 'dataset-out-r2',
    digest: sha('8'),
    sourceRefs: [],
    artifactId: 'artifact-dataset-out-r2',
    observedAt: T2,
  });
  assert.throws(() => assertDataTransformLineageMatchesSnapshotsV1({
    lineage: raw,
    inputSnapshots: [inputA, inputB],
    outputSnapshot: wrongOutput,
  }), /output dataset revision mismatch/);

  const duplicate = { ...raw, inputDatasets: [raw.inputDatasets[0], raw.inputDatasets[0]] };
  assert.throws(() => normalizeDataTransformLineageV1(duplicate), /duplicate datasetId/);
});

test('dataset delta is deterministic advisory structural change evidence and detects revision identity conflicts', () => {
  const before = dataset();
  const after = dataset({
    revisionId: 'dataset-r2',
    digest: sha('c'),
    sourceRefs: [source({ revisionId: 'source-r2', digest: sha('d') })],
    artifactId: 'artifact-dataset-a-r2',
    rowCount: 12,
    observedAt: T2,
    schemaColumns: [
      { name: 'id', logicalType: 'INTEGER', sourceType: 'int64', nullable: false, ordinal: 0 },
      { name: 'amount', logicalType: 'DECIMAL', sourceType: 'decimal(20,4)', nullable: false, ordinal: 1 },
      { name: 'currency', logicalType: 'TEXT', sourceType: 'varchar(3)', nullable: false, ordinal: 2 },
    ],
  });
  const delta = deriveDataDatasetDeltaV1({ baseline: before, current: after });
  assert.equal(delta.status, 'CHANGED');
  assert.equal(delta.advisoryOnly, true);
  assert.equal(delta.rowCountDelta, 2);
  assert.deepEqual(delta.signals, [
    'REVISION_CHANGED',
    'CONTENT_CHANGED',
    'SCHEMA_CHANGED',
    'SOURCE_BINDINGS_CHANGED',
    'ARTIFACT_CHANGED',
    'ROW_COUNT_INCREASED',
  ]);
  assert.deepEqual(delta.schemaChanges.map(change => [change.name, change.change]), [
    ['amount', 'CHANGED'],
    ['currency', 'ADDED'],
  ]);
  assert.deepEqual(delta.sourceChanges.map(change => change.sourceId), ['source-a']);

  const conflict = dataset({ digest: sha('f'), artifactId: 'artifact-conflict' });
  assert.throws(() => deriveDataDatasetDeltaV1({ baseline: before, current: conflict }), /revision identity conflict/);

  const unchanged = deriveDataDatasetDeltaV1({ baseline: before, current: structuredClone(before) });
  assert.equal(unchanged.status, 'UNCHANGED');
  assert.deepEqual(unchanged.signals, []);
});

test('canonical timestamps, exact numeric types and dense schema ordinals fail closed', () => {
  assert.throws(() => normalizeDataDatasetSnapshotV1({ ...dataset(), rowCount: '10' }), /safe integer/);
  assert.throws(() => normalizeDataDatasetSnapshotV1({ ...dataset(), observedAt: '2026-09-24T20:00:00Z' }), /canonical timestamp/);
  const badColumns = columns();
  badColumns[0].ordinal = 2;
  assert.throws(() => normalizeDataDatasetSnapshotV1(dataset({ schemaColumns: badColumns })), /contiguous/);
});
