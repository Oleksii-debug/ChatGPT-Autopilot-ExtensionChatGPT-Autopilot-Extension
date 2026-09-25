import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDataMonitoringReportV1,
  DataMonitoringStatus,
} from '../src/core/data-monitoring-report.js';

const T1 = '2026-09-25T08:00:00.000Z';
const T2 = '2026-09-25T09:00:00.000Z';
const T3 = '2026-09-25T10:00:00.000Z';
const T4 = '2026-09-25T11:00:00.000Z';
const sha = char => char.repeat(64);

function source({
  id = 'source-a',
  revisionId = 'source-r1',
  digest = sha('b'),
  at = T1,
} = {}) {
  return {
    schemaVersion: 1,
    sourceId: id,
    projectId: 'project-a',
    kind: 'file',
    uri: 'file:///owner/data.csv',
    revisionId,
    contentSha256: digest,
    observedAt: at,
    authority: 'CANONICAL',
    metadata: {},
  };
}

function artifact({
  id = 'artifact-a',
  digest = sha('a'),
  at = T1,
} = {}) {
  return {
    schemaVersion: 1,
    artifactId: id,
    kind: 'data.snapshot',
    uri: 'artifact://' + id,
    mediaType: 'application/json',
    sha256: digest,
    sizeBytes: 123,
    createdAt: at,
    producerInvocationId: 'invoke-data-1',
    sensitive: false,
  };
}

function columns({ changed = false } = {}) {
  return [
    {
      name: 'id',
      logicalType: 'INTEGER',
      sourceType: 'int64',
      nullable: false,
      ordinal: 0,
    },
    {
      name: 'amount',
      logicalType: changed ? 'TEXT' : 'DECIMAL',
      sourceType: changed ? 'varchar' : 'decimal(18,2)',
      nullable: false,
      ordinal: 1,
    },
  ];
}

function snapshot({
  revisionId = 'dataset-r1',
  digest = sha('a'),
  rowCount = 100,
  at = T1,
  artifactId = 'artifact-a',
  sourceRef = source(),
  changedColumns = false,
  sourceRefs,
} = {}) {
  const refs = sourceRefs === undefined ? [sourceRef] : sourceRefs;
  return {
    schemaVersion: 1,
    datasetId: 'dataset-a',
    projectId: 'project-a',
    revisionId,
    contentSha256: digest,
    sourceRefs: refs,
    artifactRef: artifact({ id: artifactId, digest, at }),
    columns: columns({ changed: changedColumns }),
    rowCount,
    observedAt: at,
  };
}

function thresholds(overrides = {}) {
  return {
    absoluteRowDelta: null,
    rowChangeBasisPoints: null,
    flagSchemaChange: true,
    flagSourceBindingChange: true,
    ...overrides,
  };
}

function request({
  baseline = snapshot(),
  current = snapshot(),
  currentSourceRefs = [source()],
  thresholdConfig = thresholds(),
  assessedAt = T3,
} = {}) {
  return {
    schemaVersion: 1,
    baseline,
    current,
    currentSourceRefs,
    thresholds: thresholdConfig,
    assessedAt,
  };
}

test('fresh unchanged dataset yields a bounded accessible CLEAR report with no authority', () => {
  const out = buildDataMonitoringReportV1(request());

  assert.equal(out.status, DataMonitoringStatus.CLEAR);
  assert.equal(out.anomalies.length, 0);
  assert.equal(out.freshness.status, 'FRESH');
  assert.equal(out.downstreamEvaluationRecommended, false);
  assert.equal(out.requiresCanonicalPolicyDecision, false);
  assert.equal(out.readOnly, true);
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.policyDecisionGranted, false);
  assert.equal(out.triggerAuthorized, false);
  assert.equal(out.executionAuthorized, false);
  assert.match(out.accessibleText, /Data monitoring report/u);
  assert.match(out.accessibleText, /Status: CLEAR/u);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.anomalies), true);
});

test('fresh deterministic row and schema changes become ALERT evidence for downstream policy evaluation', () => {
  const baseline = snapshot({ rowCount: 100, at: T1 });
  const current = snapshot({
    revisionId: 'dataset-r2',
    digest: sha('c'),
    rowCount: 125,
    at: T2,
    artifactId: 'artifact-b',
    sourceRef: source({ at: T1 }),
    changedColumns: true,
  });
  const out = buildDataMonitoringReportV1(request({
    baseline,
    current,
    currentSourceRefs: [source({ at: T1 })],
    thresholdConfig: thresholds({
      absoluteRowDelta: 20,
      rowChangeBasisPoints: 2_000,
    }),
  }));

  assert.equal(out.status, DataMonitoringStatus.ALERT);
  assert.deepEqual(
    out.anomalies.map(item => item.code),
    ['SCHEMA_CHANGED', 'ROW_COUNT_ABSOLUTE_THRESHOLD', 'ROW_COUNT_RATIO_THRESHOLD'],
  );
  assert.equal(out.rowCountDelta, 25);
  assert.equal(out.rowChange.basisPointsFloor, '2500');
  assert.equal(out.downstreamEvaluationRecommended, true);
  assert.equal(out.requiresCanonicalPolicyDecision, true);
  assert.equal(out.policyDecisionGranted, false);
  assert.equal(out.triggerAuthorized, false);
});

test('stale source evidence blocks action readiness even when a numeric anomaly is present', () => {
  const baseline = snapshot({ rowCount: 100, at: T1 });
  const expectedSource = source({ revisionId: 'source-r1', digest: sha('b'), at: T1 });
  const current = snapshot({
    revisionId: 'dataset-r2',
    digest: sha('c'),
    rowCount: 150,
    at: T2,
    artifactId: 'artifact-b',
    sourceRef: expectedSource,
  });
  const liveSource = source({
    revisionId: 'source-r2',
    digest: sha('d'),
    at: T3,
  });

  const out = buildDataMonitoringReportV1(request({
    baseline,
    current,
    currentSourceRefs: [liveSource],
    thresholdConfig: thresholds({ absoluteRowDelta: 10 }),
    assessedAt: T4,
  }));

  assert.equal(out.status, DataMonitoringStatus.BLOCKED);
  assert.equal(out.downstreamEvaluationRecommended, false);
  assert.equal(out.requiresCanonicalPolicyDecision, false);
  assert.deepEqual(
    out.anomalies.map(item => item.code),
    ['SOURCE_STALE', 'ROW_COUNT_ABSOLUTE_THRESHOLD'],
  );
  assert.deepEqual(
    out.anomalies[0].reasonCodes,
    ['REVISION_CHANGED', 'CONTENT_CHANGED'],
  );
});

test('dataset without canonical source bindings is freshness-unverified and BLOCKED', () => {
  const baseline = snapshot({ sourceRefs: [], at: T1 });
  const current = snapshot({
    revisionId: 'dataset-r2',
    digest: sha('c'),
    artifactId: 'artifact-b',
    sourceRefs: [],
    at: T2,
  });
  const out = buildDataMonitoringReportV1(request({
    baseline,
    current,
    currentSourceRefs: [],
  }));

  assert.equal(out.status, DataMonitoringStatus.BLOCKED);
  assert.equal(out.freshness.status, 'UNVERIFIED');
  assert.deepEqual(out.anomalies.map(item => item.code), ['SOURCE_FRESHNESS_UNVERIFIED']);
});

test('zero baseline uses explicit unbounded proportional-change evidence without division', () => {
  const baseline = snapshot({ rowCount: 0, at: T1 });
  const current = snapshot({
    revisionId: 'dataset-r2',
    digest: sha('c'),
    rowCount: 1,
    at: T2,
    artifactId: 'artifact-b',
  });
  const out = buildDataMonitoringReportV1(request({
    baseline,
    current,
    currentSourceRefs: [source()],
    thresholdConfig: thresholds({ rowChangeBasisPoints: 1 }),
  }));

  assert.equal(out.status, DataMonitoringStatus.ALERT);
  assert.equal(out.rowChange.basisPointsFloor, null);
  assert.equal(out.rowChange.unboundedFromZeroBaseline, true);
  assert.deepEqual(out.anomalies.map(item => item.code), ['ROW_CHANGE_FROM_ZERO_BASELINE']);
  assert.match(out.accessibleText, /unbounded from zero baseline/u);
});

test('basis-point threshold comparison remains exact for row counts above safe multiplication range', () => {
  const baseline = snapshot({ rowCount: 8_000_000_000_000_000, at: T1 });
  const current = snapshot({
    revisionId: 'dataset-r2',
    digest: sha('c'),
    rowCount: 4_000_000_000_000_000,
    at: T2,
    artifactId: 'artifact-b',
  });
  const out = buildDataMonitoringReportV1(request({
    baseline,
    current,
    currentSourceRefs: [source()],
    thresholdConfig: thresholds({ rowChangeBasisPoints: 5_000 }),
  }));

  assert.equal(out.status, DataMonitoringStatus.ALERT);
  assert.equal(out.rowChange.basisPointsFloor, '5000');
  assert.deepEqual(out.anomalies.map(item => item.code), ['ROW_COUNT_RATIO_THRESHOLD']);
});

test('source-binding changes are reported without leaking source URIs into anomaly messages', () => {
  const beforeSource = source({ id: 'source-a', at: T1 });
  const afterSource = source({ id: 'source-b', at: T1 });
  const baseline = snapshot({ sourceRef: beforeSource, at: T1 });
  const current = snapshot({
    revisionId: 'dataset-r2',
    digest: sha('c'),
    artifactId: 'artifact-b',
    sourceRef: afterSource,
    at: T2,
  });

  const out = buildDataMonitoringReportV1(request({
    baseline,
    current,
    currentSourceRefs: [afterSource],
  }));

  assert.equal(out.status, DataMonitoringStatus.ALERT);
  assert.deepEqual(out.anomalies.map(item => item.code), ['SOURCE_BINDINGS_CHANGED']);
  assert.doesNotMatch(out.accessibleText, /file:\/\//u);
});

test('future source observations and future current datasets fail closed against assessedAt', () => {
  const current = snapshot({
    revisionId: 'dataset-r2',
    digest: sha('c'),
    artifactId: 'artifact-b',
    at: T2,
  });

  assert.throws(
    () => buildDataMonitoringReportV1(request({
      current,
      currentSourceRefs: [source({ at: T4 })],
      assessedAt: T3,
    })),
    /observed after assessedAt/u,
  );

  assert.throws(
    () => buildDataMonitoringReportV1(request({
      current: snapshot({
        revisionId: 'dataset-r2',
        digest: sha('c'),
        artifactId: 'artifact-b',
        at: T4,
      }),
      assessedAt: T3,
    })),
    /current dataset observation is after assessedAt/u,
  );
});

test('baseline observation cannot be after current observation', () => {
  assert.throws(
    () => buildDataMonitoringReportV1(request({
      baseline: snapshot({ at: T2 }),
      current: snapshot({
        revisionId: 'dataset-r2',
        digest: sha('c'),
        artifactId: 'artifact-b',
        at: T1,
      }),
    })),
    /baseline dataset observation cannot be after current/u,
  );
});

test('threshold and source boundaries reject accessors, symbols, unknown fields and sparse arrays', () => {
  let calls = 0;
  const badThresholds = thresholds();
  Object.defineProperty(badThresholds, 'absoluteRowDelta', {
    enumerable: true,
    get() {
      calls += 1;
      return 1;
    },
  });
  assert.throws(
    () => buildDataMonitoringReportV1(request({ thresholdConfig: badThresholds })),
    /enumerable own data property/u,
  );
  assert.equal(calls, 0);

  assert.throws(
    () => buildDataMonitoringReportV1({
      ...request(),
      executionAuthorized: true,
    }),
    /unknown field: executionAuthorized/u,
  );

  const sparse = new Array(1);
  assert.throws(
    () => buildDataMonitoringReportV1(request({ currentSourceRefs: sparse })),
    /currentSourceRefs\[0\] is missing/u,
  );

  const withSymbol = thresholds();
  withSymbol[Symbol('authority')] = true;
  assert.throws(
    () => buildDataMonitoringReportV1(request({ thresholdConfig: withSymbol })),
    /symbol fields/u,
  );
});

test('same revision with changed material remains rejected by canonical dataset delta identity', () => {
  assert.throws(
    () => buildDataMonitoringReportV1(request({
      baseline: snapshot({ revisionId: 'same', digest: sha('a'), rowCount: 100 }),
      current: snapshot({ revisionId: 'same', digest: sha('c'), rowCount: 101 }),
    })),
    /dataset revision identity conflict/u,
  );
});
