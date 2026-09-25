import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BenchmarkAssertionOperator,
  BenchmarkCaseOutcome,
  BenchmarkEvaluationStatus,
  evaluateBenchmarkRunV1 as evaluateBenchmarkRunV1Raw,
  normalizeBenchmarkSuiteV1,
} from '../src/core/benchmark-evaluation.js';

const START = '2026-09-24T21:55:00.000Z';
const END = '2026-09-24T21:55:05.000Z';

function suite(overrides = {}) {
  return {
    schemaVersion: 1,
    suiteId: 'core-reliability',
    suiteRevisionId: 'suite-rev-a1',
    title: 'Core reliability benchmark',
    cases: [
      {
        caseId: 'latency',
        title: 'Bounded latency',
        assertions: [
          {
            metricId: 'latencyMs',
            operator: BenchmarkAssertionOperator.AT_MOST,
            threshold: 1000,
          },
        ],
      },
      {
        caseId: 'quality',
        title: 'Quality and error floor',
        assertions: [
          {
            metricId: 'accuracyMilli',
            operator: BenchmarkAssertionOperator.AT_LEAST,
            threshold: 900,
          },
          {
            metricId: 'errorCount',
            operator: BenchmarkAssertionOperator.EQUAL,
            threshold: 0,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function result(caseId, metrics, overrides = {}) {
  return {
    caseId,
    outcome: BenchmarkCaseOutcome.MEASURED,
    metrics,
    evidenceArtifactIds: ['evidence-' + caseId],
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    suiteId: 'core-reliability',
    suiteRevisionId: 'suite-rev-a1',
    subjectId: 'autopilot',
    subjectRevisionId: 'commit-abc123',
    startedAt: START,
    completedAt: END,
    results: [
      result('quality', { errorCount: 0, accuracyMilli: 950 }),
      result('latency', { latencyMs: 800 }),
    ],
    ...overrides,
  };
}

const expectedSubject = {
  subjectId: 'autopilot',
  subjectRevisionId: 'commit-abc123',
};

const trustedExecution = Object.freeze({
  runId: 'run-1',
  producerInvocationId: 'benchmark-runner-1',
  startedAt: START,
  completedAt: END,
});

const DEFAULT_TRUSTED_EVIDENCE_IDS = Object.freeze([
  'evidence-latency',
  'evidence-quality',
  'evidence-quality-2',
  'diagnostic-crash-1',
  'proof-1',
  'proof-error',
]);

function trustedEvidenceArtifacts(ids = DEFAULT_TRUSTED_EVIDENCE_IDS) {
  return ids.map((artifactId, index) => ({
    schemaVersion: 1,
    artifactId,
    kind: 'benchmark-evidence',
    uri: 'artifact://benchmark/' + artifactId,
    mediaType: 'application/json',
    sha256: (index + 1).toString(16).padStart(64, '0'),
    sizeBytes: 1,
    createdAt: END,
    producerInvocationId: 'benchmark-runner-1',
    sensitive: false,
  }));
}

function evaluateBenchmarkRunV1(args = {}) {
  return evaluateBenchmarkRunV1Raw({
    ...args,
    trustedExecution: args.trustedExecution ?? trustedExecution,
    trustedEvidenceArtifacts: args.trustedEvidenceArtifacts ?? trustedEvidenceArtifacts(),
  });
}

test('evaluates a complete run deterministically against exact suite and subject revisions', () => {
  const report = evaluateBenchmarkRunV1({
    suite: suite(),
    run: run(),
    expectedSubject,
  });

  assert.equal(report.status, BenchmarkEvaluationStatus.PASS);
  assert.equal(report.caseCount, 2);
  assert.equal(report.passedCaseCount, 2);
  assert.equal(report.failedCaseCount, 0);
  assert.deepEqual(report.results.map((item) => item.caseId), ['latency', 'quality']);
  assert.deepEqual(
    report.results[1].assertionResults.map((item) => item.metricId),
    ['accuracyMilli', 'errorCount'],
  );
  assert.equal(report.results[1].assertionResults[0].observed, 950);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.results), true);
  assert.equal(Object.isFrozen(report.results[0].metrics), true);
  assert.equal(Object.isFrozen(report.results[0].assertionResults), true);
});

test('retains measured negative results instead of dropping or averaging them away', () => {
  const failing = run({
    results: [
      result('quality', { accuracyMilli: 899, errorCount: 1 }),
      result('latency', { latencyMs: 1001 }),
    ],
  });

  const report = evaluateBenchmarkRunV1({
    suite: suite(),
    run: failing,
    expectedSubject,
  });

  assert.equal(report.status, BenchmarkEvaluationStatus.FAIL);
  assert.equal(report.passedCaseCount, 0);
  assert.equal(report.failedCaseCount, 2);
  assert.deepEqual(
    report.results[0].assertionResults.map((item) => item.passed),
    [false],
  );
  assert.deepEqual(
    report.results[1].assertionResults.map((item) => item.passed),
    [false, false],
  );
});

test('preserves explicit execution errors as failed cases with evidence', () => {
  const crashed = run({
    results: [
      {
        caseId: 'latency',
        outcome: BenchmarkCaseOutcome.ERROR,
        metrics: {},
        evidenceArtifactIds: ['diagnostic-crash-1'],
        reasonCode: 'SUBJECT_CRASHED',
      },
      result('quality', { accuracyMilli: 950, errorCount: 0 }),
    ],
  });

  const report = evaluateBenchmarkRunV1({
    suite: suite(),
    run: crashed,
    expectedSubject,
  });

  assert.equal(report.status, BenchmarkEvaluationStatus.FAIL);
  assert.equal(report.failedCaseCount, 1);
  assert.equal(report.results[0].caseId, 'latency');
  assert.equal(report.results[0].outcome, BenchmarkCaseOutcome.ERROR);
  assert.equal(report.results[0].passed, false);
  assert.equal(report.results[0].reasonCode, 'SUBJECT_CRASHED');
  assert.deepEqual(report.results[0].assertionResults, []);
  assert.deepEqual(report.results[0].evidenceArtifactIds, ['diagnostic-crash-1']);
});

test('requires exact complete case coverage with no duplicates or unknown cases', () => {
  const missing = run({
    results: [result('quality', { accuracyMilli: 950, errorCount: 0 })],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: missing, expectedSubject }),
    /results must be a bounded array/,
  );

  const duplicate = run({
    results: [
      result('quality', { accuracyMilli: 950, errorCount: 0 }),
      result('quality', { accuracyMilli: 950, errorCount: 0 }, {
        evidenceArtifactIds: ['evidence-quality-2'],
      }),
    ],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: duplicate, expectedSubject }),
    /duplicate case result: quality/,
  );

  const unknown = run({
    results: [
      result('quality', { accuracyMilli: 950, errorCount: 0 }),
      result('invented', { latencyMs: 1 }),
    ],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: unknown, expectedSubject }),
    /unknown case result: invented/,
  );
});

test('requires exactly the declared metric set for measured cases', () => {
  const missingMetric = run({
    results: [
      result('quality', { accuracyMilli: 950 }),
      result('latency', { latencyMs: 800 }),
    ],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: missingMetric, expectedSubject }),
    /missing metric: errorCount/,
  );

  const extraMetric = run({
    results: [
      result('quality', { accuracyMilli: 950, errorCount: 0, hiddenScore: 999 }),
      result('latency', { latencyMs: 800 }),
    ],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: extraMetric, expectedSubject }),
    /unknown metric: hiddenScore/,
  );

  const coercedMetric = run({
    results: [
      result('quality', { accuracyMilli: '950', errorCount: 0 }),
      result('latency', { latencyMs: 800 }),
    ],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: coercedMetric, expectedSubject }),
    /safe integer/,
  );
});

test('binds run evidence to trusted suite and subject revisions', () => {
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run({ suiteRevisionId: 'suite-rev-stale' }),
      expectedSubject,
    }),
    /suite identity\/revision mismatch/,
  );

  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run({ subjectRevisionId: 'commit-stale' }),
      expectedSubject,
    }),
    /subject identity\/revision mismatch/,
  );

  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run({ subjectId: 'other-product' }),
      expectedSubject,
    }),
    /subject identity\/revision mismatch/,
  );
});

test('requires evidence for every case and exact error semantics', () => {
  const noEvidence = run({
    results: [
      result('quality', { accuracyMilli: 950, errorCount: 0 }, { evidenceArtifactIds: [] }),
      result('latency', { latencyMs: 800 }),
    ],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: noEvidence, expectedSubject }),
    /evidenceArtifactIds must be a bounded array/,
  );

  const duplicateEvidence = run({
    results: [
      result('quality', { accuracyMilli: 950, errorCount: 0 }, {
        evidenceArtifactIds: ['proof-1', 'proof-1'],
      }),
      result('latency', { latencyMs: 800 }),
    ],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: duplicateEvidence, expectedSubject }),
    /duplicate ID: proof-1/,
  );

  const measuredReason = run({
    results: [
      result('quality', { accuracyMilli: 950, errorCount: 0 }, { reasonCode: 'FAKE_REASON' }),
      result('latency', { latencyMs: 800 }),
    ],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: measuredReason, expectedSubject }),
    /reasonCode is only valid for ERROR/,
  );

  const errorWithMetrics = run({
    results: [
      {
        caseId: 'latency',
        outcome: BenchmarkCaseOutcome.ERROR,
        metrics: { latencyMs: 800 },
        evidenceArtifactIds: ['proof-error'],
        reasonCode: 'EXECUTION_ERROR',
      },
      result('quality', { accuracyMilli: 950, errorCount: 0 }),
    ],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: errorWithMetrics, expectedSubject }),
    /must be empty for ERROR outcome/,
  );
});

test('suite normalization rejects duplicate cases, duplicate metric assertions and invalid operators', () => {
  const duplicateCase = suite();
  duplicateCase.cases.push(structuredClone(duplicateCase.cases[0]));
  assert.throws(() => normalizeBenchmarkSuiteV1(duplicateCase), /duplicate caseId/);

  const duplicateMetric = suite();
  duplicateMetric.cases[0].assertions.push({
    metricId: 'latencyMs',
    operator: BenchmarkAssertionOperator.AT_LEAST,
    threshold: 0,
  });
  assert.throws(() => normalizeBenchmarkSuiteV1(duplicateMetric), /duplicate metric assertion/);

  const invalidOperator = suite();
  invalidOperator.cases[0].assertions[0].operator = 'AVERAGE';
  assert.throws(() => normalizeBenchmarkSuiteV1(invalidOperator), /operator is invalid/);
});

test('fails closed on accessors, exotic prototypes, symbols, hidden fields and sparse arrays', () => {
  const accessorSuite = suite();
  Object.defineProperty(accessorSuite, 'suiteRevisionId', {
    enumerable: true,
    configurable: true,
    get() { return 'suite-rev-a1'; },
  });
  assert.throws(() => normalizeBenchmarkSuiteV1(accessorSuite), /data properties only/);

  const exoticSubject = Object.create({ subjectId: 'autopilot' });
  exoticSubject.subjectRevisionId = 'commit-abc123';
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: run(), expectedSubject: exoticSubject }),
    /plain object/,
  );

  const symbolRun = run();
  symbolRun[Symbol('authority')] = 'PASS';
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: symbolRun, expectedSubject }),
    /symbol fields/,
  );

  const hiddenRun = run();
  Object.defineProperty(hiddenRun, 'callerPassedCount', {
    enumerable: false,
    configurable: true,
    value: 2,
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: hiddenRun, expectedSubject }),
    /enumerable own data properties/,
  );

  const sparseCases = suite();
  delete sparseCases.cases[0];
  assert.throws(() => normalizeBenchmarkSuiteV1(sparseCases), /must not be sparse/);
});

test('binds every case evidence ID to a trusted immutable ArtifactRefV1 inventory', () => {
  const fabricated = run({
    results: [
      result('quality', { accuracyMilli: 950, errorCount: 0 }, {
        evidenceArtifactIds: ['fabricated-proof'],
      }),
      result('latency', { latencyMs: 800 }),
    ],
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: fabricated,
      expectedSubject,
      trustedEvidenceArtifacts: trustedEvidenceArtifacts(),
    }),
    /unknown trusted evidence artifact: fabricated-proof/,
  );

  const noDigest = trustedEvidenceArtifacts();
  noDigest[0] = { ...noDigest[0], sha256: '' };
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run(),
      expectedSubject,
      trustedEvidenceArtifacts: noDigest,
    }),
    /must include sha256/,
  );

  const duplicated = trustedEvidenceArtifacts();
  duplicated.push(structuredClone(duplicated[0]));
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run(),
      expectedSubject,
      trustedEvidenceArtifacts: duplicated,
    }),
    /duplicate artifactId/,
  );
});

test('rejects accessor-backed bounded array entries without executing getters', () => {
  let reads = 0;
  const accessorCases = suite();
  const originalCase = accessorCases.cases[0];
  Object.defineProperty(accessorCases.cases, '0', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return originalCase; },
  });
  assert.throws(
    () => normalizeBenchmarkSuiteV1(accessorCases),
    /own enumerable data indices/,
  );
  assert.equal(reads, 0);

  const accessorResults = run();
  const originalResult = accessorResults.results[0];
  Object.defineProperty(accessorResults.results, '0', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return originalResult; },
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: accessorResults,
      expectedSubject,
    }),
    /own enumerable data indices/,
  );
  assert.equal(reads, 0);

  const accessorEvidence = run();
  const evidenceIds = accessorEvidence.results[0].evidenceArtifactIds;
  const originalEvidenceId = evidenceIds[0];
  Object.defineProperty(evidenceIds, '0', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return originalEvidenceId; },
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: accessorEvidence,
      expectedSubject,
    }),
    /own enumerable data indices/,
  );
  assert.equal(reads, 0);
});

test('rejects hidden allowed authority fields and trusted-artifact accessors', () => {
  const hiddenSuite = suite();
  Object.defineProperty(hiddenSuite, 'suiteRevisionId', {
    enumerable: false,
    configurable: true,
    value: 'suite-rev-a1',
  });
  assert.throws(
    () => normalizeBenchmarkSuiteV1(hiddenSuite),
    /enumerable own data properties/,
  );

  const hiddenRun = run();
  Object.defineProperty(hiddenRun, 'runId', {
    enumerable: false,
    configurable: true,
    value: 'run-1',
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: hiddenRun, expectedSubject }),
    /enumerable own data properties/,
  );

  const hiddenMetric = run();
  Object.defineProperty(hiddenMetric.results[1].metrics, 'latencyMs', {
    enumerable: false,
    configurable: true,
    value: 800,
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({ suite: suite(), run: hiddenMetric, expectedSubject }),
    /enumerable own data properties/,
  );

  let reads = 0;
  const trusted = trustedEvidenceArtifacts();
  const originalSha = trusted[0].sha256;
  Object.defineProperty(trusted[0], 'sha256', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return originalSha; },
  });
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run(),
      expectedSubject,
      trustedEvidenceArtifacts: trusted,
    }),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);
});

test('evaluation request boundary is data-only before reading trusted inputs', () => {
  const baseRequest = {
    suite: suite(),
    run: run(),
    expectedSubject,
    trustedExecution,
    trustedEvidenceArtifacts: trustedEvidenceArtifacts(),
  };

  let reads = 0;
  const accessor = { ...baseRequest };
  Object.defineProperty(accessor, 'trustedExecution', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return trustedExecution; },
  });
  assert.throws(
    () => evaluateBenchmarkRunV1Raw(accessor),
    /enumerable own data properties only/,
  );
  assert.equal(reads, 0, 'outer authority getter must never execute');

  const hidden = { ...baseRequest };
  Object.defineProperty(hidden, 'run', {
    enumerable: false,
    configurable: true,
    value: run(),
  });
  assert.throws(
    () => evaluateBenchmarkRunV1Raw(hidden),
    /enumerable own data properties only/,
  );

  const symbol = { ...baseRequest, [Symbol('trusted-alias')]: trustedExecution };
  assert.throws(
    () => evaluateBenchmarkRunV1Raw(symbol),
    /symbol fields/,
  );

  const exotic = Object.assign(
    Object.create({ trustedExecution }),
    {
      suite: suite(),
      run: run(),
      expectedSubject,
      trustedEvidenceArtifacts: trustedEvidenceArtifacts(),
    },
  );
  assert.throws(
    () => evaluateBenchmarkRunV1Raw(exotic),
    /plain object/,
  );

  assert.throws(
    () => evaluateBenchmarkRunV1Raw({ ...baseRequest, callerPassed: true }),
    /unknown field: callerPassed/,
  );

  const nullPrototype = Object.assign(Object.create(null), baseRequest);
  assert.equal(
    evaluateBenchmarkRunV1Raw(nullPrototype).status,
    BenchmarkEvaluationStatus.PASS,
  );
});

test('rejects non-canonical timestamps and completed-before-started runs', () => {
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run({ startedAt: '2026-09-24T21:55:00Z' }),
      expectedSubject,
    }),
    /canonical ISO timestamp/,
  );

  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run({
        startedAt: '2026-09-24T21:55:05.000Z',
        completedAt: '2026-09-24T21:55:00.000Z',
      }),
      expectedSubject,
    }),
    /precedes startedAt/,
  );
});

test('binds trusted evidence causally to the exact benchmark execution', () => {
  const afterRun = trustedEvidenceArtifacts();
  afterRun[0] = { ...afterRun[0], createdAt: '2026-09-24T21:55:06.000Z' };
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run(),
      expectedSubject,
      trustedEvidenceArtifacts: afterRun,
    }),
    /outside the trusted benchmark execution interval/,
  );

  const beforeRun = trustedEvidenceArtifacts();
  beforeRun[0] = { ...beforeRun[0], createdAt: '2026-09-24T21:54:59.999Z' };
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run(),
      expectedSubject,
      trustedEvidenceArtifacts: beforeRun,
    }),
    /outside the trusted benchmark execution interval/,
  );

  const foreignProducer = trustedEvidenceArtifacts();
  foreignProducer[0] = { ...foreignProducer[0], producerInvocationId: 'other-runner' };
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run(),
      expectedSubject,
      trustedEvidenceArtifacts: foreignProducer,
    }),
    /producer does not match trusted benchmark execution/,
  );

  const exact = evaluateBenchmarkRunV1({
    suite: suite(),
    run: run(),
    expectedSubject,
  });
  assert.equal(exact.status, BenchmarkEvaluationStatus.PASS);
});

test('caller run identity and interval must match separately trusted execution provenance', () => {
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run({ runId: 'forged-run' }),
      expectedSubject,
    }),
    /execution identity\/time does not match trusted execution/,
  );
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run({ completedAt: '2026-09-24T21:55:06.000Z' }),
      expectedSubject,
    }),
    /execution identity\/time does not match trusted execution/,
  );
  assert.throws(
    () => evaluateBenchmarkRunV1({
      suite: suite(),
      run: run(),
      expectedSubject,
      trustedExecution: { ...trustedExecution, producerInvocationId: 'different-runner' },
    }),
    /producer does not match trusted benchmark execution/,
  );
});

