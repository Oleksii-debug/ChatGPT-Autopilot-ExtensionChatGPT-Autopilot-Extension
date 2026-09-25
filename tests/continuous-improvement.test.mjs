import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BenchmarkAssertionOperator,
  BenchmarkCaseOutcome,
  BenchmarkEvaluationStatus,
} from '../src/core/benchmark-evaluation.js';
import { VerificationStatus } from '../src/core/universal-agent-contracts.js';
import {
  ContinuousImprovementGateStatus,
  ContinuousImprovementKind,
  ContinuousImprovementTriggerKind,
  assessContinuousImprovementCandidateV1,
  normalizeContinuousImprovementCandidateV1,
} from '../src/core/continuous-improvement.js';

const BASE_SHA = 'a'.repeat(64);
const PROPOSAL_SHA = 'b'.repeat(64);
const SOURCE_EVIDENCE_SHA = 'c'.repeat(64);
const BENCHMARK_EVIDENCE_SHA = 'd'.repeat(64);

const SOURCE_EVIDENCE_AT = '2026-09-25T05:40:00.000Z';
const SOURCE_VERIFIED_AT = '2026-09-25T05:45:00.000Z';
const PROPOSAL_AT = '2026-09-25T05:50:00.000Z';
const CANDIDATE_AT = '2026-09-25T06:00:00.000Z';
const BENCHMARK_START = '2026-09-25T06:05:00.000Z';
const BENCHMARK_END = '2026-09-25T06:06:00.000Z';

function artifact(artifactId, sha256, createdAt, producerInvocationId = 'worker.invocation') {
  return {
    schemaVersion:1,
    artifactId,
    kind:'improvement-evidence',
    uri:'artifact://improvement/' + artifactId,
    mediaType:'application/json',
    sha256,
    sizeBytes:10,
    createdAt,
    producerInvocationId,
    sensitive:false,
  };
}

function sourceVerification(overrides = {}) {
  return {
    schemaVersion:1,
    verificationId:'verification.accepted-work',
    invocationId:'worker.invocation',
    observationId:'observation.accepted-work',
    status:VerificationStatus.VERIFIED,
    reasonCode:'ACCEPTED_WORK_VERIFIED',
    summary:'Accepted work has independently verified source evidence.',
    evidenceArtifactIds:['source.evidence'],
    verifiedAt:SOURCE_VERIFIED_AT,
    verifierId:'verifier.independent',
    verificationAuthorityId:'verification.authority',
    attempt:1,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    schemaVersion:1,
    improvementId:'improvement.route-1',
    projectId:'project.autopilot',
    kind:ContinuousImprovementKind.ROUTING,
    triggerKind:ContinuousImprovementTriggerKind.ACCEPTED_WORK,
    title:'Prefer a verified deterministic route',
    rationale:'Promote only after exact-byte benchmark evidence and owner review.',
    actorId:'worker.actor',
    independentVerifierId:'verifier.independent',
    baselineSubjectId:'routing.subject',
    baselineRevisionId:'routing.rev-1',
    baselineSha256:BASE_SHA,
    proposalSubjectId:'routing.subject',
    proposalRevisionId:'routing.rev-2',
    proposalArtifact:artifact('proposal.bytes', PROPOSAL_SHA, PROPOSAL_AT),
    evidenceArtifacts:[artifact('source.evidence', SOURCE_EVIDENCE_SHA, SOURCE_EVIDENCE_AT)],
    sourceVerification:sourceVerification(),
    benchmarkSuiteId:'improvement.suite',
    benchmarkSuiteRevisionId:'suite.rev-1',
    createdAt:CANDIDATE_AT,
    ...overrides,
  };
}

function suite(overrides = {}) {
  return {
    schemaVersion:1,
    suiteId:'improvement.suite',
    suiteRevisionId:'suite.rev-1',
    title:'Continuous improvement qualification',
    cases:[{
      caseId:'quality',
      title:'No regression',
      assertions:[{
        metricId:'score',
        operator:BenchmarkAssertionOperator.AT_LEAST,
        threshold:100,
      }],
    }],
    ...overrides,
  };
}

function benchmarkResult(score = 100) {
  return {
    caseId:'quality',
    outcome:BenchmarkCaseOutcome.MEASURED,
    metrics:{ score },
    evidenceArtifactIds:['benchmark.evidence'],
  };
}

function benchmarkRun(score = 100, overrides = {}) {
  return {
    schemaVersion:1,
    runId:'benchmark.run-1',
    suiteId:'improvement.suite',
    suiteRevisionId:'suite.rev-1',
    subjectId:'proposal.bytes',
    subjectRevisionId:'sha256:' + PROPOSAL_SHA,
    startedAt:BENCHMARK_START,
    completedAt:BENCHMARK_END,
    results:[benchmarkResult(score)],
    ...overrides,
  };
}

function trustedExecution(score = 100, overrides = {}) {
  return {
    runId:'benchmark.run-1',
    suiteId:'improvement.suite',
    suiteRevisionId:'suite.rev-1',
    subjectId:'proposal.bytes',
    subjectRevisionId:'sha256:' + PROPOSAL_SHA,
    producerInvocationId:'benchmark.runner',
    startedAt:BENCHMARK_START,
    completedAt:BENCHMARK_END,
    results:[benchmarkResult(score)],
    ...overrides,
  };
}

function trustedBenchmarkEvidence(overrides = {}) {
  return [artifact(
    'benchmark.evidence',
    BENCHMARK_EVIDENCE_SHA,
    BENCHMARK_END,
    'benchmark.runner',
  )].map((value) => ({ ...value, ...overrides }));
}

function assessment(score = 100, overrides = {}) {
  return {
    candidate:candidate(),
    suite:suite(),
    run:benchmarkRun(score),
    trustedExecution:trustedExecution(score),
    trustedEvidenceArtifacts:trustedBenchmarkEvidence(),
    ...overrides,
  };
}

test('normalizes an exact revision-bound candidate without granting promotion authority', () => {
  const normalized = normalizeContinuousImprovementCandidateV1(candidate());
  assert.equal(normalized.kind, ContinuousImprovementKind.ROUTING);
  assert.equal(normalized.triggerKind, ContinuousImprovementTriggerKind.ACCEPTED_WORK);
  assert.equal(normalized.benchmarkSubjectId, 'proposal.bytes');
  assert.equal(normalized.benchmarkSubjectRevisionId, 'sha256:' + PROPOSAL_SHA);
  assert.equal(normalized.sourceVerificationTrust, 'UNVERIFIED_REFERENCE');
  assert.equal(normalized.requiresTrustedBenchmark, true);
  assert.equal(normalized.requiresOwnerReview, true);
  assert.equal(normalized.promotionAuthorized, false);
  assert.equal(normalized.executionAuthorized, false);
  assert.equal(normalized.policyMutationAuthorized, false);
  assert.equal(normalized.recipePromotionAuthorized, false);
  assert.equal(normalized.skillPromotionAuthorized, false);
  assert.equal(Object.isFrozen(normalized), true);
});

test('trusted canonical benchmark PASS yields owner-review readiness but never promotion', () => {
  const result = assessContinuousImprovementCandidateV1(assessment());
  assert.equal(result.benchmarkStatus, BenchmarkEvaluationStatus.PASS);
  assert.equal(result.gateStatus, ContinuousImprovementGateStatus.READY_FOR_OWNER_REVIEW);
  assert.equal(result.proposalSha256, PROPOSAL_SHA);
  assert.equal(result.benchmarkSubjectRevisionId, 'sha256:' + PROPOSAL_SHA);
  assert.equal(result.requiresOwnerReview, true);
  assert.equal(result.requiresCanonicalPromotionAuthority, true);
  assert.equal(result.promotionAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.policyMutationAuthorized, false);
  assert.equal(result.recipePromotionAuthorized, false);
  assert.equal(result.skillPromotionAuthorized, false);
});

test('negative benchmark evidence remains an explicit rejection and cannot become success', () => {
  const result = assessContinuousImprovementCandidateV1(assessment(99));
  assert.equal(result.benchmarkStatus, BenchmarkEvaluationStatus.FAIL);
  assert.equal(result.benchmarkFailedCaseCount, 1);
  assert.equal(result.gateStatus, ContinuousImprovementGateStatus.BENCHMARK_REJECTED);
  assert.equal(result.promotionAuthorized, false);
});

test('benchmark subject is cryptographically bound to the exact proposal ArtifactRef bytes', () => {
  const foreignRevision = 'sha256:' + 'e'.repeat(64);
  assert.throws(() => assessContinuousImprovementCandidateV1(assessment(100, {
    run:benchmarkRun(100, { subjectRevisionId:foreignRevision }),
    trustedExecution:trustedExecution(100, { subjectRevisionId:foreignRevision }),
  })), /subject identity\/revision mismatch/);
});

test('candidate benchmark suite identity and revision cannot be substituted', () => {
  assert.throws(() => assessContinuousImprovementCandidateV1(assessment(100, {
    candidate:candidate({ benchmarkSuiteRevisionId:'suite.rev-2' }),
  })), /benchmark suite identity\/revision does not match/);
});

test('benchmark cannot predate the exact proposal bytes it claims to qualify', () => {
  const laterProposal = artifact(
    'proposal.bytes',
    PROPOSAL_SHA,
    '2026-09-25T06:05:00.001Z',
  );
  assert.throws(() => assessContinuousImprovementCandidateV1(assessment(100, {
    candidate:candidate({
      proposalArtifact:laterProposal,
      createdAt:'2026-09-25T06:05:01.000Z',
    }),
  })), /benchmark cannot start before proposalArtifact exists/);
});

test('actor and independent verifier identities cannot collapse', () => {
  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    independentVerifierId:'worker.actor',
    sourceVerification:sourceVerification({ verifierId:'worker.actor' }),
  })), /must differ from actorId/);
});

test('source verification must be VERIFIED, independently attributed and exactly cover evidence', () => {
  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    sourceVerification:sourceVerification({ status:VerificationStatus.FAILED }),
  })), /must be VERIFIED/);

  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    sourceVerification:sourceVerification({ verifierId:'other.verifier' }),
  })), /does not match independentVerifierId/);

  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    evidenceArtifacts:[
      artifact('source.evidence', SOURCE_EVIDENCE_SHA, SOURCE_EVIDENCE_AT),
      artifact('source.extra', 'e'.repeat(64), SOURCE_EVIDENCE_AT),
    ],
  })), /must exactly cover evidenceArtifacts/);
});

test('source evidence and verification obey causal time and exact canonical representations', () => {
  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    evidenceArtifacts:[
      artifact('source.evidence', SOURCE_EVIDENCE_SHA, '2026-09-25T05:45:00.001Z'),
    ],
  })), /cannot postdate sourceVerification/);

  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    sourceVerification:sourceVerification({ verifiedAt:'2026-09-25T06:00:00.001Z' }),
  })), /cannot postdate improvement candidate/);

  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    createdAt:'2026-09-25T06:00:00Z',
  })), /canonical ISO-8601/);

  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    baselineSha256:'A'.repeat(64),
  })), /lowercase SHA-256/);
});

test('candidate must describe a real change to the same subject', () => {
  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    proposalSubjectId:'other.subject',
  })), /must match baselineSubjectId/);

  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    proposalRevisionId:'routing.rev-1',
  })), /must differ from baselineRevisionId/);

  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    proposalArtifact:artifact('proposal.bytes', BASE_SHA, PROPOSAL_AT),
  })), /must materially differ/);
});

test('candidate record and collection boundaries execute zero ordinary caller getters', () => {
  let candidateReads = 0;
  const proxiedCandidate = new Proxy(candidate(), {
    get(target, key, receiver) {
      candidateReads += 1;
      if (key === 'actorId') return 'forged.actor';
      return Reflect.get(target, key, receiver);
    },
  });
  const normalized = normalizeContinuousImprovementCandidateV1(proxiedCandidate);
  assert.equal(candidateReads, 0);
  assert.equal(normalized.actorId, 'worker.actor');

  let arrayReads = 0;
  const proxiedEvidence = new Proxy(
    [artifact('source.evidence', SOURCE_EVIDENCE_SHA, SOURCE_EVIDENCE_AT)],
    {
      get(target, key, receiver) {
        arrayReads += 1;
        if (key === 'length') return 9999;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const withProxyArray = normalizeContinuousImprovementCandidateV1(candidate({
    evidenceArtifacts:proxiedEvidence,
  }));
  assert.equal(arrayReads, 0);
  assert.equal(withProxyArray.evidenceArtifacts.length, 1);

  let requestReads = 0;
  const proxiedRequest = new Proxy(assessment(), {
    get(target, key, receiver) {
      requestReads += 1;
      if (key === 'candidate') return null;
      return Reflect.get(target, key, receiver);
    },
  });
  const assessed = assessContinuousImprovementCandidateV1(proxiedRequest);
  assert.equal(requestReads, 0);
  assert.equal(assessed.gateStatus, ContinuousImprovementGateStatus.READY_FOR_OWNER_REVIEW);
});

test('hidden, symbol, sparse, exotic and unknown authority fields fail closed', () => {
  const hidden = candidate();
  Object.defineProperty(hidden, 'actorId', {
    enumerable:false,
    configurable:true,
    value:'worker.actor',
  });
  assert.throws(() => normalizeContinuousImprovementCandidateV1(hidden), /enumerable own data property/);

  const symbolic = candidate();
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeContinuousImprovementCandidateV1(symbolic), /symbol field/);

  const unknown = candidate();
  unknown.promotionAuthorized = true;
  assert.throws(() => normalizeContinuousImprovementCandidateV1(unknown), /unknown field/);

  const sparse = new Array(1);
  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    evidenceArtifacts:sparse,
  })), /dense data-only array/);

  const exotic = [artifact('source.evidence', SOURCE_EVIDENCE_SHA, SOURCE_EVIDENCE_AT)];
  Object.setPrototypeOf(exotic, null);
  assert.throws(() => normalizeContinuousImprovementCandidateV1(candidate({
    evidenceArtifacts:exotic,
  })), /bounded plain array/);
});
