import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RoiAutomationKind,
  RoiAutomationQualificationStatus,
  RoiReportStatus,
  RoiRunOutcomeStatus,
  RoiTimeAvoidedQuality,
  buildRoiOpportunityReportV1,
} from '../src/core/roi-opportunity-engine.js';

function trustedRun(overrides = {}) {
  return {
    schemaVersion: 1,
    recordId: 'record-1',
    projectId: 'project-1',
    runId: 'run-1',
    workflowClassId: 'workflow.invoice-review',
    sourceRevisionId: 'revision-1',
    startedAt: '2026-09-01T10:00:00.000Z',
    finishedAt: '2026-09-01T10:05:00.000Z',
    recordedAt: '2026-09-01T10:06:00.000Z',
    validThrough: '2026-12-01T00:00:00.000Z',
    outcomeStatus: RoiRunOutcomeStatus.VERIFIED,
    verificationRecordId: 'verification-record-1',
    verificationAuthorityId: 'verifier-authority-1',
    evidenceArtifactIds: ['artifact-1'],
    machineApiCostUsdMicros: 50_000,
    runtimeMs: 300_000,
    ownerCoordinationSeconds: 120,
    ownerReviewSeconds: 180,
    reworkCount: 0,
    reworkOwnerSeconds: 0,
    verifierReopenCount: 0,
    repeatedContextBytesAvoided: 25_000,
    automationKind: RoiAutomationKind.MANUAL,
    automationAssetId: '',
    automationQualificationRecordId: '',
    automationQualificationStatus: RoiAutomationQualificationStatus.UNQUALIFIED,
    timeAvoidedQuality: RoiTimeAvoidedQuality.NONE,
    ownerTimeAvoidedLowerSeconds: 0,
    ownerTimeAvoidedUpperSeconds: 0,
    delayCauseIds: ['delay.wait-provider'],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    reportId: 'roi-report-1',
    projectId: 'project-1',
    evaluatedAt: '2026-09-25T08:40:00.000Z',
    minimumEvidenceRuns: 2,
    minimumOpportunityOccurrences: 2,
    runEvidenceIds: ['record-1', 'record-2', 'record-3'],
    ...overrides,
  };
}

function resolver(records) {
  const byId = new Map(records.map(item => [item.recordId, item]));
  return async recordId => byId.get(recordId) ?? null;
}

test('aggregates evidence-backed ROI and ranks repeated verified manual opportunity', async () => {
  const records = [
    trustedRun(),
    trustedRun({
      recordId: 'record-2',
      runId: 'run-2',
      verificationRecordId: 'verification-record-2',
      evidenceArtifactIds: ['artifact-2'],
      startedAt: '2026-09-02T10:00:00.000Z',
      finishedAt: '2026-09-02T10:04:00.000Z',
      recordedAt: '2026-09-02T10:05:00.000Z',
      machineApiCostUsdMicros: 70_000,
      runtimeMs: 240_000,
      ownerCoordinationSeconds: 90,
      ownerReviewSeconds: 150,
      repeatedContextBytesAvoided: 20_000,
      verifierReopenCount: 1,
      reworkCount: 1,
      reworkOwnerSeconds: 60,
      delayCauseIds: ['delay.wait-provider', 'delay.owner-review'],
    }),
    trustedRun({
      recordId: 'record-3',
      runId: 'run-3',
      workflowClassId: 'workflow.status-digest',
      verificationRecordId: 'verification-record-3',
      evidenceArtifactIds: ['artifact-3'],
      startedAt: '2026-09-03T10:00:00.000Z',
      finishedAt: '2026-09-03T10:01:00.000Z',
      recordedAt: '2026-09-03T10:02:00.000Z',
      machineApiCostUsdMicros: 30_000,
      runtimeMs: 60_000,
      ownerCoordinationSeconds: 5,
      ownerReviewSeconds: 10,
      repeatedContextBytesAvoided: 80_000,
      automationKind: RoiAutomationKind.RECIPE,
      automationAssetId: 'recipe.status-digest',
      automationQualificationRecordId: 'qualification-recipe-1',
      automationQualificationStatus: RoiAutomationQualificationStatus.PASS,
      timeAvoidedQuality: RoiTimeAvoidedQuality.OBSERVED,
      ownerTimeAvoidedLowerSeconds: 600,
      ownerTimeAvoidedUpperSeconds: 600,
      delayCauseIds: [],
    }),
  ];

  const report = await buildRoiOpportunityReportV1(request(), {
    resolveTrustedRunEvidence: resolver(records),
  });

  assert.equal(report.status, RoiReportStatus.PARTIAL_EVIDENCE);
  assert.equal(report.outcomes.verifiedOutcomesCompleted, 3);
  assert.equal(report.spend.machineApiSpendUsdMicros, 150_000);
  assert.equal(report.spend.runtimeMs, 600_000);
  assert.equal(report.context.repeatedContextBytesAvoided, 125_000);
  assert.equal(report.ownerTime.observedOwnerTimeAvoidedSeconds, 600);
  assert.equal(report.ownerTime.boundedOwnerTimeAvoidedLowerSeconds, 600);
  assert.equal(report.quality.totalVerifierReopenEvents, 1);
  assert.equal(report.quality.empiricalVerifierReopenRunRateBasisPoints, 3333);
  assert.equal(report.quality.totalReworkEvents, 1);
  assert.equal(report.topDelayCauses[0].causeId, 'delay.wait-provider');
  assert.equal(report.topDelayCauses[0].occurrenceCount, 2);
  assert.equal(report.automationOpportunities.length, 1);
  assert.equal(report.automationOpportunities[0].workflowClassId, 'workflow.invoice-review');
  assert.equal(report.automationOpportunities[0].verifiedManualOccurrenceCount, 2);
  assert.equal(report.automationOpportunities[0].recommendationAuthorized, false);
  assert.equal(report.recommendationAuthorized, false);
  assert.equal(report.executionAuthorized, false);
});

test('reports estimated time only as a bounded range, never a fabricated precise point', async () => {
  const records = [
    trustedRun({
      timeAvoidedQuality: RoiTimeAvoidedQuality.OBSERVED,
      ownerTimeAvoidedLowerSeconds: 120,
      ownerTimeAvoidedUpperSeconds: 120,
    }),
    trustedRun({
      recordId: 'record-2',
      runId: 'run-2',
      verificationRecordId: 'verification-record-2',
      evidenceArtifactIds: ['artifact-2'],
      timeAvoidedQuality: RoiTimeAvoidedQuality.ESTIMATED,
      ownerTimeAvoidedLowerSeconds: 60,
      ownerTimeAvoidedUpperSeconds: 300,
    }),
  ];
  const report = await buildRoiOpportunityReportV1(request({
    runEvidenceIds: ['record-1', 'record-2'],
  }), { resolveTrustedRunEvidence: resolver(records) });

  assert.equal(report.ownerTime.observedOwnerTimeAvoidedSeconds, 120);
  assert.equal(report.ownerTime.estimatedOwnerTimeAvoidedLowerSeconds, 60);
  assert.equal(report.ownerTime.estimatedOwnerTimeAvoidedUpperSeconds, 300);
  assert.equal(report.ownerTime.boundedOwnerTimeAvoidedLowerSeconds, 180);
  assert.equal(report.ownerTime.boundedOwnerTimeAvoidedUpperSeconds, 420);
  assert.equal(report.ownerTime.hasEstimatedTimeAvoided, true);
  assert.equal(report.ownerTime.precisePointEstimateAuthorized, false);
});

test('counts verified Recipe/Skill coverage only from PASS-qualified automation records', async () => {
  const records = [
    trustedRun({
      automationKind: RoiAutomationKind.RECIPE,
      automationAssetId: 'recipe-1',
      automationQualificationRecordId: 'q-1',
      automationQualificationStatus: RoiAutomationQualificationStatus.PASS,
    }),
    trustedRun({
      recordId: 'record-2',
      runId: 'run-2',
      verificationRecordId: 'verification-record-2',
      evidenceArtifactIds: ['artifact-2'],
      automationKind: RoiAutomationKind.SKILL,
      automationAssetId: 'skill-1',
      automationQualificationRecordId: 'q-2',
      automationQualificationStatus: RoiAutomationQualificationStatus.FAIL,
    }),
    trustedRun({
      recordId: 'record-3',
      runId: 'run-3',
      verificationRecordId: 'verification-record-3',
      evidenceArtifactIds: ['artifact-3'],
    }),
  ];
  const report = await buildRoiOpportunityReportV1(request(), {
    resolveTrustedRunEvidence: resolver(records),
  });
  assert.equal(report.automationCoverage.repeatedWorkflowRunCount, 3);
  assert.equal(report.automationCoverage.verifiedRecipeOrSkillRunCount, 1);
  assert.equal(report.automationCoverage.verifiedRecipeOrSkillCoverageBasisPoints, 3333);
  assert.equal(report.automationCoverage.empiricalRateOnly, true);
});

test('suppresses opportunities when report-wide evidence count is insufficient', async () => {
  const one = trustedRun();
  const report = await buildRoiOpportunityReportV1(request({
    runEvidenceIds: ['record-1'],
    minimumEvidenceRuns: 2,
  }), { resolveTrustedRunEvidence: resolver([one]) });
  assert.equal(report.status, RoiReportStatus.INSUFFICIENT_EVIDENCE);
  assert.deepEqual(report.automationOpportunities, []);
});

test('requires canonical resolver identity, project binding, freshness and unique run identity', async () => {
  await assert.rejects(
    buildRoiOpportunityReportV1(request(), {}),
    /resolver is required/,
  );

  const wrongRecord = trustedRun({ recordId: 'different' });
  await assert.rejects(
    buildRoiOpportunityReportV1(request({ runEvidenceIds: ['record-1'] }), {
      resolveTrustedRunEvidence: async () => wrongRecord,
    }),
    /recordId does not match/,
  );

  const wrongProject = trustedRun({ projectId: 'project-2' });
  await assert.rejects(
    buildRoiOpportunityReportV1(request({ runEvidenceIds: ['record-1'] }), {
      resolveTrustedRunEvidence: resolver([wrongProject]),
    }),
    /projectId does not match/,
  );

  const stale = trustedRun({ validThrough: '2026-09-24T00:00:00.000Z' });
  await assert.rejects(
    buildRoiOpportunityReportV1(request({ runEvidenceIds: ['record-1'] }), {
      resolveTrustedRunEvidence: resolver([stale]),
    }),
    /trusted evidence is stale/,
  );

  const duplicateRun = trustedRun({
    recordId: 'record-2',
    verificationRecordId: 'verification-record-2',
    evidenceArtifactIds: ['artifact-2'],
  });
  await assert.rejects(
    buildRoiOpportunityReportV1(request({ runEvidenceIds: ['record-1', 'record-2'] }), {
      resolveTrustedRunEvidence: resolver([trustedRun(), duplicateRun]),
    }),
    /duplicate runId/,
  );
});

test('rejects identity aliases and malformed automation/time evidence', async () => {
  const padded = trustedRun({ runId: ' run-1' });
  await assert.rejects(
    buildRoiOpportunityReportV1(request({ runEvidenceIds: ['record-1'] }), {
      resolveTrustedRunEvidence: resolver([padded]),
    }),
    /exact canonical identity/,
  );

  const manualClaim = trustedRun({
    automationAssetId: 'recipe-1',
    automationQualificationRecordId: 'qualification-1',
    automationQualificationStatus: RoiAutomationQualificationStatus.PASS,
  });
  await assert.rejects(
    buildRoiOpportunityReportV1(request({ runEvidenceIds: ['record-1'] }), {
      resolveTrustedRunEvidence: resolver([manualClaim]),
    }),
    /manual run cannot claim automation qualification/,
  );

  const fakeObserved = trustedRun({
    timeAvoidedQuality: RoiTimeAvoidedQuality.OBSERVED,
    ownerTimeAvoidedLowerSeconds: 10,
    ownerTimeAvoidedUpperSeconds: 20,
  });
  await assert.rejects(
    buildRoiOpportunityReportV1(request({ runEvidenceIds: ['record-1'] }), {
      resolveTrustedRunEvidence: resolver([fakeObserved]),
    }),
    /OBSERVED owner-time evidence must be exact/,
  );
});

test('does not execute accessor-backed trusted-record fields or array elements', async () => {
  let getterCalls = 0;
  const hostile = trustedRun();
  Object.defineProperty(hostile, 'machineApiCostUsdMicros', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 0;
    },
  });
  await assert.rejects(
    buildRoiOpportunityReportV1(request({ runEvidenceIds: ['record-1'] }), {
      resolveTrustedRunEvidence: async () => hostile,
    }),
    /enumerable own data property/,
  );
  assert.equal(getterCalls, 0);

  const valid = trustedRun();
  let elementGetterCalls = 0;
  const hostileCauses = [];
  Object.defineProperty(hostileCauses, '0', {
    enumerable: true,
    configurable: true,
    get() {
      elementGetterCalls += 1;
      return 'delay.secret';
    },
  });
  hostileCauses.length = 1;
  valid.delayCauseIds = hostileCauses;
  await assert.rejects(
    buildRoiOpportunityReportV1(request({ runEvidenceIds: ['record-1'] }), {
      resolveTrustedRunEvidence: resolver([valid]),
    }),
    /enumerable own data property/,
  );
  assert.equal(elementGetterCalls, 0);
});

test('fails closed when exact sums exceed safe integer range', async () => {
  const records = [
    trustedRun({ machineApiCostUsdMicros: Number.MAX_SAFE_INTEGER }),
    trustedRun({
      recordId: 'record-2',
      runId: 'run-2',
      verificationRecordId: 'verification-record-2',
      evidenceArtifactIds: ['artifact-2'],
      machineApiCostUsdMicros: 1,
    }),
  ];
  await assert.rejects(
    buildRoiOpportunityReportV1(request({ runEvidenceIds: ['record-1', 'record-2'] }), {
      resolveTrustedRunEvidence: resolver(records),
    }),
    /machine\/API spend exceeds exact safe-integer range/,
  );
});
