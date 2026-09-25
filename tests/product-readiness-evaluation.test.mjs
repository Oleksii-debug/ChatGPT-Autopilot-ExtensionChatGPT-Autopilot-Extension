import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProductReadinessGateStatus,
  buildProductReadinessEvaluationV1,
} from '../src/core/product-readiness-evaluation.js';

const AS_OF = '2026-09-25T10:05:00.000Z';
const BENCH_START = '2026-09-25T10:00:00.000Z';
const BENCH_END = '2026-09-25T10:00:01.000Z';
const SUBJECT_ID = 'autopilot';
const SUBJECT_REVISION = 'sha-abc123';

function currentReadiness(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: 'github/api',
    toolId: '',
    health: 'READY',
    installationRequired: false,
    installed: true,
    authenticationRequired: false,
    authenticated: true,
    pathKind: 'API',
    latencyMs: 10,
    reasonCode: 'BASELINE_READY',
    ...overrides,
  };
}

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    definitionRevisionId: 'definition-rev-1',
    definitionSha256: 'a'.repeat(64),
    canaryId: 'github-read',
    providerId: 'github/api',
    capabilityId: 'github.read',
    probeKind: 'GITHUB_READ',
    critical: true,
    maxLatencyMs: 1000,
    maxObservationAgeMs: 10 * 60 * 1000,
    requiredPasses: 1,
    failureThreshold: 1,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    definitionRevisionId: 'definition-rev-1',
    definitionSha256: 'a'.repeat(64),
    observationId: 'observation-1',
    canaryId: 'github-read',
    providerId: 'github/api',
    capabilityId: 'github.read',
    status: 'PASS',
    latencyMs: 25,
    observedAt: '2026-09-25T10:04:00.000Z',
    evidenceId: 'provider-evidence-1',
    ...overrides,
  };
}

function providerCheck(overrides = {}) {
  return {
    checkId: 'provider-github',
    required: true,
    currentReadiness: currentReadiness(),
    definitions: [definition()],
    observations: [observation()],
    ...overrides,
  };
}

function suite(overrides = {}) {
  return {
    schemaVersion: 1,
    suiteId: 'release-core',
    suiteRevisionId: 'suite-rev-1',
    title: 'Release core benchmark',
    cases: [
      {
        caseId: 'core',
        title: 'Core correctness',
        assertions: [
          {
            metricId: 'passCount',
            operator: 'AT_LEAST',
            threshold: 1,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function result(metric = 1, overrides = {}) {
  return {
    caseId: 'core',
    outcome: 'MEASURED',
    metrics: { passCount: metric },
    evidenceArtifactIds: ['benchmark-evidence-1'],
    ...overrides,
  };
}

function benchmarkExecution({
  metric = 1,
  startedAt = BENCH_START,
  completedAt = BENCH_END,
  subjectRevisionId = SUBJECT_REVISION,
} = {}) {
  const results = [result(metric)];
  return {
    run: {
      schemaVersion: 1,
      runId: 'benchmark-run-1',
      suiteId: 'release-core',
      suiteRevisionId: 'suite-rev-1',
      subjectId: SUBJECT_ID,
      subjectRevisionId,
      startedAt,
      completedAt,
      results: structuredClone(results),
    },
    trustedExecution: {
      runId: 'benchmark-run-1',
      suiteId: 'release-core',
      suiteRevisionId: 'suite-rev-1',
      subjectId: SUBJECT_ID,
      subjectRevisionId,
      producerInvocationId: 'benchmark-runner-1',
      startedAt,
      completedAt,
      results: structuredClone(results),
    },
    trustedEvidenceArtifacts: [
      {
        schemaVersion: 1,
        artifactId: 'benchmark-evidence-1',
        kind: 'benchmark-evidence',
        uri: 'artifact://benchmark/benchmark-evidence-1',
        mediaType: 'application/json',
        sha256: 'b'.repeat(64),
        sizeBytes: 1,
        createdAt: completedAt,
        producerInvocationId: 'benchmark-runner-1',
        sensitive: false,
      },
    ],
  };
}

function benchmarkCheck(options = {}, overrides = {}) {
  const execution = benchmarkExecution(options);
  return {
    checkId: 'benchmark-core',
    required: true,
    maxAgeMs: 10 * 60 * 1000,
    suite: suite(),
    run: execution.run,
    trustedExecution: execution.trustedExecution,
    trustedEvidenceArtifacts: execution.trustedEvidenceArtifacts,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    evaluationId: 'readiness-eval-1',
    subjectId: SUBJECT_ID,
    subjectRevisionId: SUBJECT_REVISION,
    asOf: AS_OF,
    providerChecks: [providerCheck()],
    benchmarkChecks: [benchmarkCheck()],
    ...overrides,
  };
}

test('reports READY only when required provider and fresh benchmark evidence are ready', () => {
  const report = buildProductReadinessEvaluationV1(request());

  assert.equal(report.status, ProductReadinessGateStatus.READY);
  assert.equal(report.summary.requiredCheckCount, 2);
  assert.equal(report.summary.requiredReadyCount, 2);
  assert.equal(report.summary.requiredBlockedCount, 0);
  assert.equal(report.providerChecks[0].health, 'READY');
  assert.equal(report.providerChecks[0].gateStatus, 'READY');
  assert.deepEqual(report.providerChecks[0].evidenceIds, ['provider-evidence-1']);
  assert.equal(report.benchmarkChecks[0].evaluationStatus, 'PASS');
  assert.equal(report.benchmarkChecks[0].gateStatus, 'READY');
});

test('required missing provider authentication blocks readiness even when canary passes', () => {
  const provider = providerCheck({
    currentReadiness: currentReadiness({
      authenticationRequired: true,
      authenticated: false,
    }),
  });
  const report = buildProductReadinessEvaluationV1(request({
    providerChecks: [provider],
  }));

  assert.equal(report.status, ProductReadinessGateStatus.BLOCKED);
  assert.equal(report.providerChecks[0].reasonCode, 'PROVIDER_AUTH_REQUIRED');
});

test('required provider installation gap blocks readiness', () => {
  const provider = providerCheck({
    currentReadiness: currentReadiness({
      installationRequired: true,
      installed: false,
    }),
  });
  const report = buildProductReadinessEvaluationV1(request({
    providerChecks: [provider],
  }));

  assert.equal(report.status, ProductReadinessGateStatus.BLOCKED);
  assert.equal(report.providerChecks[0].reasonCode, 'PROVIDER_INSTALL_REQUIRED');
});

test('transient required provider failure is DEGRADED when canary threshold is not reached', () => {
  const provider = providerCheck({
    definitions: [definition({ failureThreshold: 2 })],
    observations: [observation({ status: 'FAIL' })],
  });
  const report = buildProductReadinessEvaluationV1(request({
    providerChecks: [provider],
  }));

  assert.equal(report.status, ProductReadinessGateStatus.DEGRADED);
  assert.equal(report.providerChecks[0].health, 'DEGRADED');
  assert.equal(report.providerChecks[0].reasonCode, 'PROVIDER_DEGRADED');
});

test('missing fresh required canary evidence makes readiness UNKNOWN instead of optimistic', () => {
  const report = buildProductReadinessEvaluationV1(request({
    providerChecks: [providerCheck({ observations: [] })],
  }));

  assert.equal(report.status, ProductReadinessGateStatus.UNKNOWN);
  assert.equal(report.providerChecks[0].health, 'UNKNOWN');
  assert.equal(report.providerChecks[0].reasonCode, 'PROVIDER_HEALTH_UNKNOWN');
});

test('negative benchmark result blocks readiness and preserves failure counts', () => {
  const report = buildProductReadinessEvaluationV1(request({
    benchmarkChecks: [benchmarkCheck({ metric: 0 })],
  }));

  assert.equal(report.status, ProductReadinessGateStatus.BLOCKED);
  assert.equal(report.benchmarkChecks[0].evaluationStatus, 'FAIL');
  assert.equal(report.benchmarkChecks[0].failedCaseCount, 1);
  assert.equal(report.benchmarkChecks[0].reasonCode, 'BENCHMARK_FAILED');
});

test('stale benchmark pass is UNKNOWN and cannot certify current revision readiness', () => {
  const staleEnd = '2026-09-25T09:00:01.000Z';
  const staleStart = '2026-09-25T09:00:00.000Z';
  const report = buildProductReadinessEvaluationV1(request({
    benchmarkChecks: [benchmarkCheck(
      { startedAt: staleStart, completedAt: staleEnd },
      { maxAgeMs: 60 * 1000 },
    )],
  }));

  assert.equal(report.status, ProductReadinessGateStatus.UNKNOWN);
  assert.equal(report.benchmarkChecks[0].evaluationStatus, 'PASS');
  assert.equal(report.benchmarkChecks[0].gateStatus, 'UNKNOWN');
  assert.equal(report.benchmarkChecks[0].reasonCode, 'BENCHMARK_STALE');
});

test('future benchmark evidence fails closed against readiness asOf', () => {
  assert.throws(
    () => buildProductReadinessEvaluationV1(request({
      benchmarkChecks: [benchmarkCheck({
        startedAt: '2026-09-25T10:05:30.000Z',
        completedAt: '2026-09-25T10:06:00.000Z',
      })],
    })),
    /benchmark evidence occurs after readiness asOf/u,
  );
});

test('benchmark evidence is bound to the exact requested subject revision', () => {
  assert.throws(
    () => buildProductReadinessEvaluationV1(request({
      benchmarkChecks: [benchmarkCheck({ subjectRevisionId: 'sha-stale' })],
    })),
    /subject identity\/revision mismatch/u,
  );
});

test('optional failures do not impersonate required release blockers', () => {
  const optionalFailure = benchmarkCheck(
    { metric: 0 },
    { required: false },
  );
  const report = buildProductReadinessEvaluationV1(request({
    benchmarkChecks: [optionalFailure],
  }));

  assert.equal(report.status, ProductReadinessGateStatus.READY);
  assert.equal(report.benchmarkChecks[0].gateStatus, 'BLOCKED');
  assert.equal(report.summary.requiredCheckCount, 1);
  assert.equal(report.summary.requiredReadyCount, 1);
});

test('zero required checks can never claim READY', () => {
  const report = buildProductReadinessEvaluationV1(request({
    providerChecks: [providerCheck({ required: false })],
    benchmarkChecks: [benchmarkCheck({}, { required: false })],
  }));

  assert.equal(report.status, ProductReadinessGateStatus.UNKNOWN);
  assert.equal(report.summary.requiredCheckCount, 0);
});

test('duplicate check, provider and suite identities fail closed', () => {
  assert.throws(
    () => buildProductReadinessEvaluationV1(request({
      providerChecks: [
        providerCheck(),
        providerCheck({ checkId: 'provider-github-2' }),
      ],
    })),
    /duplicate providerId/u,
  );

  const driveProvider = providerCheck({
    checkId: 'provider-drive',
    currentReadiness: currentReadiness({ providerId: 'drive/api' }),
    definitions: [definition({
      canaryId: 'drive-read',
      providerId: 'drive/api',
      capabilityId: 'drive.read',
      probeKind: 'DRIVE_METADATA_READ',
    })],
    observations: [observation({
      observationId: 'drive-observation-1',
      canaryId: 'drive-read',
      providerId: 'drive/api',
      capabilityId: 'drive.read',
    })],
  });
  assert.throws(
    () => buildProductReadinessEvaluationV1(request({
      providerChecks: [
        providerCheck({ checkId: 'same-check' }),
        driveProvider,
      ],
      benchmarkChecks: [benchmarkCheck({}, { checkId: 'same-check' })],
    })),
    /duplicate checkId/u,
  );

  const secondBenchmark = benchmarkCheck({}, { checkId: 'benchmark-core-2' });
  assert.throws(
    () => buildProductReadinessEvaluationV1(request({
      benchmarkChecks: [benchmarkCheck(), secondBenchmark],
    })),
    /duplicate suiteId/u,
  );
});

test('descriptor boundaries reject accessors, symbols and sparse arrays without executing getters', () => {
  let reads = 0;
  const provider = providerCheck();
  Object.defineProperty(provider, 'required', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return true;
    },
  });

  assert.throws(
    () => buildProductReadinessEvaluationV1(request({ providerChecks: [provider] })),
    /enumerable own data properties/u,
  );
  assert.equal(reads, 0);

  const symbolic = request();
  symbolic[Symbol('releaseAuthority')] = true;
  assert.throws(
    () => buildProductReadinessEvaluationV1(symbolic),
    /symbol fields/u,
  );

  const sparse = new Array(1);
  assert.throws(
    () => buildProductReadinessEvaluationV1(request({ providerChecks: sparse })),
    /enumerable own data property/u,
  );
});

test('readiness report is deeply frozen and grants no policy, execution or release authority', () => {
  const report = buildProductReadinessEvaluationV1(request());

  assert.equal(report.readOnly, true);
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.policyDecisionAuthorized, false);
  assert.equal(report.readinessMutationAuthorized, false);
  assert.equal(report.releaseAuthorized, false);
  assert.equal(report.requiresIndependentPhysicalAcceptance, true);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.providerChecks));
  assert.ok(Object.isFrozen(report.providerChecks[0]));
  assert.ok(Object.isFrozen(report.benchmarkChecks));
  assert.ok(Object.isFrozen(report.summary));
});
