import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DataLogicalType,
  assessDataDatasetFreshnessV1,
  assertDataDatasetSourcesMatchProjectSnapshotV1,
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
  assert.throws(() => normalizeDataDatasetSnapshotV1(noSourceHash), /contentSha256/);
});

test('dataset snapshots reject future source or artifact materialization evidence', () => {
  const futureSource = dataset({
    observedAt: T1,
    sourceRefs: [source({ at: T2 })],
  });
  assert.throws(
    () => normalizeDataDatasetSnapshotV1(futureSource),
    /source observed after dataset snapshot/,
  );

  const futureArtifact = dataset({ observedAt: T1 });
  futureArtifact.artifactRef.createdAt = T2;
  assert.throws(
    () => normalizeDataDatasetSnapshotV1(futureArtifact),
    /artifactRef created after dataset snapshot/,
  );

  const laterDataset = dataset({
    observedAt: T2,
    sourceRefs: [source({ at: T1 })],
  });
  laterDataset.artifactRef.createdAt = T1;
  assert.doesNotThrow(() => normalizeDataDatasetSnapshotV1(laterDataset));
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

test('public analytics requests and arrays consume descriptor snapshots without ordinary caller reads', () => {
  const input = dataset();
  const output = dataset({
    datasetId: 'dataset-out',
    revisionId: 'dataset-out-r1',
    digest: sha('f'),
    sourceRefs: [],
    artifactId: 'artifact-dataset-out',
    observedAt: T2,
  });
  const transform = lineage({ inputs: [input], output });
  const projectSnapshot = {
    schemaVersion: 1,
    projectId: 'project-a',
    revisionId: 'project-r1',
    title: 'Project A',
    sourceRefs: [source()],
    artifactRefs: [],
    createdAt: T1,
  };
  const after = dataset({
    revisionId: 'dataset-r2',
    digest: sha('c'),
    artifactId: 'artifact-dataset-a-r2',
    observedAt: T2,
  });

  function requestProxy(fields) {
    const target = Object.assign(Object.create(null), fields);
    let reads = 0;
    return {
      value: new Proxy(target, {
        get() {
          reads += 1;
          return undefined;
        },
      }),
      reads: () => reads,
    };
  }

  const transformRequest = requestProxy({
    lineage: transform,
    inputSnapshots: [input],
    outputSnapshot: output,
  });
  assert.doesNotThrow(() => assertDataTransformLineageMatchesSnapshotsV1(transformRequest.value));
  assert.equal(transformRequest.reads(), 0);

  const projectRequest = requestProxy({ dataset: input, projectSnapshot });
  assert.doesNotThrow(() => assertDataDatasetSourcesMatchProjectSnapshotV1(projectRequest.value));
  assert.equal(projectRequest.reads(), 0);

  const deltaRequest = requestProxy({ baseline: input, current: after });
  assert.equal(deriveDataDatasetDeltaV1(deltaRequest.value).status, 'CHANGED');
  assert.equal(deltaRequest.reads(), 0);

  const nullPrototype = Object.assign(Object.create(null), { baseline: input, current: structuredClone(input) });
  assert.equal(deriveDataDatasetDeltaV1(nullPrototype).status, 'UNCHANGED');

  const hidden = Object.assign(Object.create(null), { dataset: input, projectSnapshot });
  Object.defineProperty(hidden, 'dataset', { value: input, enumerable: false });
  assert.throws(() => assertDataDatasetSourcesMatchProjectSnapshotV1(hidden), /enumerable data property/);

  const symbol = Object.assign(Object.create(null), { baseline: input, current: after });
  symbol[Symbol('authority')] = 'ALLOW';
  assert.throws(() => deriveDataDatasetDeltaV1(symbol), /symbol fields/);

  const unknown = Object.assign(Object.create(null), { baseline: input, current: after, policyDecision: 'ALLOW' });
  assert.throws(() => deriveDataDatasetDeltaV1(unknown), /unknown field/);

  const exotic = Object.assign(Object.create({ inheritedAuthority: 'ALLOW' }), {
    lineage: transform,
    inputSnapshots: [input],
    outputSnapshot: output,
  });
  assert.throws(() => assertDataTransformLineageMatchesSnapshotsV1(exotic), /plain data object/);

  let arrayReads = 0;
  const sourceRefs = new Proxy([source()], {
    get(target, property, receiver) {
      arrayReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const normalized = normalizeDataDatasetSnapshotV1(dataset({ sourceRefs }));
  assert.equal(normalized.sourceRefs[0].sourceId, 'source-a');
  assert.equal(arrayReads, 0);
});

test('materialized provenance never aliases missing or noncanonical evidence to safe defaults', () => {
  const stringVersion = dataset();
  stringVersion.artifactRef.schemaVersion = '1';
  assert.throws(() => normalizeDataDatasetSnapshotV1(stringVersion), /schemaVersion/);

  const numericArtifactId = dataset();
  numericArtifactId.artifactRef.artifactId = 7;
  assert.throws(() => normalizeDataDatasetSnapshotV1(numericArtifactId), /artifactId is invalid/);

  const paddedKind = dataset();
  paddedKind.artifactRef.kind = ' data.snapshot ';
  assert.throws(() => normalizeDataDatasetSnapshotV1(paddedKind), /kind is invalid/);

  const missingSensitive = dataset();
  delete missingSensitive.artifactRef.sensitive;
  assert.throws(() => normalizeDataDatasetSnapshotV1(missingSensitive), /sensitive is required/);

  const missingSize = dataset();
  delete missingSize.artifactRef.sizeBytes;
  assert.throws(() => normalizeDataDatasetSnapshotV1(missingSize), /sizeBytes is required/);

  const upperArtifactDigest = dataset();
  upperArtifactDigest.artifactRef.sha256 = sha('A');
  upperArtifactDigest.contentSha256 = sha('A');
  assert.throws(() => normalizeDataDatasetSnapshotV1(upperArtifactDigest), /sha256 is invalid|contentSha256 is invalid/);

  const upperSourceDigest = dataset();
  upperSourceDigest.sourceRefs[0].contentSha256 = sha('B');
  assert.throws(() => normalizeDataDatasetSnapshotV1(upperSourceDigest), /contentSha256 is invalid/);

  const noncanonicalSourceTime = dataset();
  noncanonicalSourceTime.sourceRefs[0].observedAt = '2026-09-24T20:00:00Z';
  assert.throws(() => normalizeDataDatasetSnapshotV1(noncanonicalSourceTime), /canonical timestamp/);

  const missingSourceDigest = dataset();
  delete missingSourceDigest.sourceRefs[0].contentSha256;
  assert.throws(() => normalizeDataDatasetSnapshotV1(missingSourceDigest), /contentSha256 is required/);
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

  const regressed = assessDataDatasetFreshnessV1(snap, [
    source({ at: '2026-09-24T19:00:00.000Z' }),
  ]);
  assert.equal(regressed.status, 'STALE');
  assert.deepEqual(regressed.sources[0].reasons, ['OBSERVATION_REGRESSED']);

  const missing = assessDataDatasetFreshnessV1(snap, []);
  assert.equal(missing.status, 'STALE');
  assert.deepEqual(missing.sources[0].reasons, ['CURRENT_SOURCE_MISSING']);

  const derived = assessDataDatasetFreshnessV1(dataset({ sourceRefs: [] }), []);
  assert.equal(derived.status, 'UNVERIFIED');
  assert.equal(derived.advisoryOnly, true);

  assert.throws(() => assessDataDatasetFreshnessV1(snap, [source({ projectId: 'project-other' })]), /projectId mismatch/);
});

test('dataset source admission composes with canonical ProjectSnapshotV1 instead of becoming source authority', () => {
  const snap = dataset();
  const projectSnapshot = {
    schemaVersion: 1,
    projectId: 'project-a',
    revisionId: 'project-r1',
    title: 'Project A',
    sourceRefs: [source()],
    artifactRefs: [],
    createdAt: T1,
  };
  const admitted = assertDataDatasetSourcesMatchProjectSnapshotV1({ dataset: snap, projectSnapshot });
  assert.equal(admitted.projectRevisionId, 'project-r1');
  assert.equal(admitted.advisoryOnly, true);

  const staleProject = structuredClone(projectSnapshot);
  staleProject.sourceRefs[0].revisionId = 'source-r0';
  assert.throws(() => assertDataDatasetSourcesMatchProjectSnapshotV1({
    dataset: snap,
    projectSnapshot: staleProject,
  }), /not admitted/);

  const olderObservation = structuredClone(projectSnapshot);
  olderObservation.sourceRefs[0].observedAt = '2026-09-24T19:00:00.000Z';
  assert.throws(() => assertDataDatasetSourcesMatchProjectSnapshotV1({
    dataset: snap,
    projectSnapshot: olderObservation,
  }), /not admitted/);

  const wrongProject = { ...projectSnapshot, projectId: 'project-other', sourceRefs: [source({ projectId: 'project-other' })] };
  assert.throws(() => assertDataDatasetSourcesMatchProjectSnapshotV1({
    dataset: snap,
    projectSnapshot: wrongProject,
  }), /projectId does not match/);

  let reads = 0;
  const accessorProject = structuredClone(projectSnapshot);
  Object.defineProperty(accessorProject.sourceRefs, '0', {
    enumerable: true,
    get() { reads += 1; return source(); },
  });
  assert.throws(() => assertDataDatasetSourcesMatchProjectSnapshotV1({
    dataset: snap,
    projectSnapshot: accessorProject,
  }), /enumerable data item/);
  assert.equal(reads, 0);
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

  const futureInput = dataset({
    observedAt: T2,
    revisionId: 'dataset-future-r1',
    digest: sha('7'),
    artifactId: 'artifact-dataset-future',
  });
  const earlyExecution = { ...raw, executedAt: T1, inputDatasets: [raw.inputDatasets[0], dataDatasetBindingFromSnapshotV1(futureInput)] };
  assert.throws(() => assertDataTransformLineageMatchesSnapshotsV1({
    lineage: earlyExecution,
    inputSnapshots: [futureInput, inputB],
    outputSnapshot: output,
  }), /input dataset observed after execution/);

  const earlyOutput = dataset({
    datasetId: 'dataset-out',
    revisionId: 'dataset-out-r1',
    digest: sha('f'),
    sourceRefs: [],
    artifactId: 'artifact-dataset-out',
    observedAt: T1,
  });
  assert.throws(() => assertDataTransformLineageMatchesSnapshotsV1({
    lineage: raw,
    inputSnapshots: [inputA, inputB],
    outputSnapshot: earlyOutput,
  }), /output dataset predates execution/);

  const duplicate = { ...raw, inputDatasets: [raw.inputDatasets[0], raw.inputDatasets[0]] };
  assert.throws(() => normalizeDataTransformLineageV1(duplicate), /duplicate datasetId/);
});

test('transform lineage rejects an output artifact materialized before execution', () => {
  const input = dataset();
  const output = dataset({
    datasetId: 'dataset-out-preexisting-artifact',
    revisionId: 'dataset-out-preexisting-r1',
    digest: sha('4'),
    sourceRefs: [],
    artifactId: 'artifact-dataset-out-preexisting',
    observedAt: '2026-09-24T22:00:00.000Z',
  });
  output.artifactRef.createdAt = T1;
  const raw = lineage({ inputs: [input], output });

  assert.throws(
    () => assertDataTransformLineageMatchesSnapshotsV1({
      lineage: raw,
      inputSnapshots: [input],
      outputSnapshot: output,
    }),
    /transform output artifact predates execution/,
  );
});

test('extended-year analytics chronology uses epoch order for transform causality and freshness', () => {
  const beforeBoundary = '9999-12-31T23:59:59.999Z';
  const executionAt = '+010000-01-01T00:00:00.000Z';
  const afterBoundary = '+010000-01-01T00:00:00.001Z';

  const input = dataset({
    observedAt: beforeBoundary,
    sourceRefs: [source({ at: beforeBoundary })],
  });
  const output = dataset({
    datasetId: 'dataset-extended-out',
    revisionId: 'dataset-extended-out-r1',
    digest: sha('7'),
    sourceRefs: [source({
      id: 'source-extended-out',
      revisionId: 'source-extended-out-r1',
      digest: sha('8'),
      uri: 'file:///owner/extended.csv',
      at: beforeBoundary,
    })],
    artifactId: 'artifact-dataset-extended-out',
    observedAt: afterBoundary,
  });
  const raw = lineage({ inputs: [input], output });
  raw.executedAt = executionAt;

  assert.doesNotThrow(() => assertDataTransformLineageMatchesSnapshotsV1({
    lineage: raw,
    inputSnapshots: [input],
    outputSnapshot: output,
  }));

  const fresh = assessDataDatasetFreshnessV1(input, [
    source({ at: afterBoundary }),
  ]);
  assert.equal(fresh.status, 'FRESH');
  assert.deepEqual(fresh.sources[0].reasons, []);

  const currentInput = dataset({
    observedAt: executionAt,
    sourceRefs: [source({ at: executionAt })],
  });
  const preExecutionOutput = dataset({
    datasetId: 'dataset-pre-execution-out',
    revisionId: 'dataset-pre-execution-out-r1',
    digest: sha('9'),
    sourceRefs: [],
    artifactId: 'artifact-pre-execution-out',
    observedAt: beforeBoundary,
  });
  const invalid = lineage({ inputs: [currentInput], output: preExecutionOutput });
  invalid.executedAt = afterBoundary;

  assert.throws(
    () => assertDataTransformLineageMatchesSnapshotsV1({
      lineage: invalid,
      inputSnapshots: [currentInput],
      outputSnapshot: preExecutionOutput,
    }),
    /transform output dataset predates execution/,
  );
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

  const observationAliasConflict = structuredClone(before);
  observationAliasConflict.sourceRefs[0].observedAt = T2;
  observationAliasConflict.observedAt = T2;
  assert.throws(
    () => deriveDataDatasetDeltaV1({ baseline: before, current: observationAliasConflict }),
    /revision identity conflict/,
  );


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


test('transform lineage rejects output source provenance first observed after execution', () => {
  const input = dataset();
  const futureAt = '2026-09-24T22:00:00.000Z';
  const output = dataset({
    datasetId: 'dataset-out-future-source',
    revisionId: 'dataset-out-future-r1',
    digest: sha('6'),
    sourceRefs: [source({
      id: 'source-output-future',
      revisionId: 'source-output-future-r1',
      digest: sha('5'),
      uri: 'file:///owner/future.csv',
      at: futureAt,
    })],
    artifactId: 'artifact-dataset-out-future',
    observedAt: futureAt,
  });
  const raw = lineage({ inputs: [input], output });

  assert.throws(
    () => assertDataTransformLineageMatchesSnapshotsV1({
      lineage: raw,
      inputSnapshots: [input],
      outputSnapshot: output,
    }),
    /transform output source observed after execution/,
  );
});
