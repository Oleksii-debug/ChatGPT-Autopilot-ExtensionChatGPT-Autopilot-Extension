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


import { buildRoiOwnerAdvisoryV1, RoiOwnerAdvisoryStatus } from '../src/core/roi-owner-advisory.js';

test('offline ROI reports no stale gains and does not access canonical resolver', async () => {
  let calls=0;
  const advisory=await buildRoiOwnerAdvisoryV1({}, {
    resolveTrustedRunEvidence() {calls++;throw new Error('must not be called');},
  },{offline:true});
  assert.equal(advisory.status,RoiOwnerAdvisoryStatus.OFFLINE);
  assert.equal(advisory.observedOwnerTimeAvoidedSeconds,null);
  assert.equal(advisory.observedOwnerAttentionSeconds,null);
  assert.equal(advisory.telemetryEmitted,false);
  assert.equal(advisory.deploymentAuthorized,false);
  assert.equal(calls,0);
});

test('insufficient evidence cannot yield an opportunity or simulated savings',async()=>{
  const a=await buildRoiOwnerAdvisoryV1(
    request({runEvidenceIds:['record-1'],minimumEvidenceRuns:2}),
    {resolveTrustedRunEvidence:resolver([trustedRun()])});
  assert.equal(a.status,RoiOwnerAdvisoryStatus.INSUFFICIENT_EVIDENCE);
  assert.equal(a.observedOwnerTimeAvoidedSeconds,null);
  assert.equal(a.netOwnerTimeLowerSeconds,null);
  assert.deepEqual(a.opportunities,[]);
});

test('two verified manual outcomes show advisory Recipe opportunity but no new permission',async()=>{
  const a=await buildRoiOwnerAdvisoryV1(
    request({runEvidenceIds:['record-1','record-2'],minimumEvidenceRuns:2}),
    {resolveTrustedRunEvidence:resolver([
      trustedRun(),
      trustedRun({recordId:'record-2',runId:'run-2',verificationRecordId:'verify-2',
        evidenceArtifactIds:['artifact-2'],startedAt:'2026-09-02T10:00:00.000Z',
        finishedAt:'2026-09-02T10:05:00.000Z',recordedAt:'2026-09-02T10:06:00.000Z'}),
    ])});
  assert.equal(a.status,RoiOwnerAdvisoryStatus.PARTIAL_EVIDENCE);
  assert.equal(a.verifiedOutcomeCount,2);
  assert.equal(a.observedOwnerAttentionSeconds,600);
  assert.equal(a.netOwnerTimeLowerSeconds,-600);
  assert.equal(a.noComparableModelEvidence,true);
  assert.equal(a.opportunities.length,1);
  assert.equal(a.opportunities[0].advisoryPath,'EVALUATE_DETERMINISTIC_RECIPE_OR_TOOL');
  assert.equal(a.opportunities[0].shorterModelPath,'NOT_EVALUATED');
  assert.equal(a.opportunities[0].policyOrExecutionAuthorized,false);
  assert.equal(a.recommendationAuthorized,false);
  assert.equal(a.deploymentAuthorized,false);
  assert.equal(a.telemetryEmitted,false);
});

test('observed and estimated savings remain separated and net is an exact bounded interval',async()=>{
  const a=await buildRoiOwnerAdvisoryV1(
    request({runEvidenceIds:['record-1','record-2'],minimumEvidenceRuns:2}),
    {resolveTrustedRunEvidence:resolver([
      trustedRun({
        timeAvoidedQuality:RoiTimeAvoidedQuality.OBSERVED,
        ownerTimeAvoidedLowerSeconds:900,ownerTimeAvoidedUpperSeconds:900,
      }),
      trustedRun({
        recordId:'record-2',runId:'run-2',verificationRecordId:'verify-2',
        evidenceArtifactIds:['artifact-2'],
        timeAvoidedQuality:RoiTimeAvoidedQuality.ESTIMATED,
        ownerTimeAvoidedLowerSeconds:100,ownerTimeAvoidedUpperSeconds:400,
      }),
    ])});
  assert.equal(a.status,RoiOwnerAdvisoryStatus.EVIDENCE_BACKED);
  assert.equal(a.observedOwnerTimeAvoidedSeconds,900);
  assert.deepEqual(a.estimatedOwnerTimeAvoidedSeconds,{lower:100,upper:400});
  assert.equal(a.netOwnerTimeLowerSeconds,400);
  assert.equal(a.netOwnerTimeUpperSeconds,700);
  assert.equal(a.machineSpendUsdMicros,100000);
});

test('ROI accessor-backed dependency is rejected before accessor or evidence read',async()=>{
  let getters=0;
  const dependencies={};
  Object.defineProperty(dependencies,'resolveTrustedRunEvidence',{
    enumerable:true,get(){getters++;return async()=>trustedRun();}
  });
  await assert.rejects(buildRoiOwnerAdvisoryV1(
    request({runEvidenceIds:['record-1']}),dependencies), /enumerable own data property/);
  assert.equal(getters,0);
});

test('ROI malformed historical or future evidence fails closed, not marketed as gain',async()=>{
  const bad=trustedRun({recordedAt:'2026-11-01T00:00:00.000Z'});
  await assert.rejects(buildRoiOwnerAdvisoryV1(
    request({runEvidenceIds:['record-1']}),{resolveTrustedRunEvidence:resolver([bad])}),
    /future-recorded/);
});

test('untrusted offline options fail closed before executing getters or reading evidence', async () => {
  let getters = 0, evidenceReads = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'offline', {
    enumerable: true,
    get() { getters += 1; return true; },
  });
  const polluted = Object.create({ offline: true });
  const symbolKey = { offline: true };
  symbolKey[Symbol('hidden')] = 'owner-policy';
  const badOptions = [
    { offline: 'true' }, { offline: 1 }, { offline: null },
    { offline: false, allowNetwork: true }, accessorOptions,
    polluted, symbolKey, [true], null,
  ];
  const dependencies = {
    resolveTrustedRunEvidence() {
      evidenceReads += 1;
      throw new Error('must not access trusted evidence');
    },
  };
  for (const options of badOptions) {
    await assert.rejects(buildRoiOwnerAdvisoryV1(request(), dependencies, options),
      /ROI offline options/);
  }
  assert.equal(getters, 0);
  assert.equal(evidenceReads, 0);
  const offline = await buildRoiOwnerAdvisoryV1({}, dependencies, { offline: true });
  assert.equal(offline.status, RoiOwnerAdvisoryStatus.OFFLINE);
  assert.equal(evidenceReads, 0);
});
