import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ParallelFanInStatus,
  buildParallelFanInEvidenceV1,
} from '../src/core/parallel-fanin-evidence.js';

const NOW = '2026-09-25T12:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function node(nodeId, overrides = {}) {
  return {
    nodeId,
    title: 'Node ' + nodeId,
    objective: 'Complete ' + nodeId,
    dependsOn: [],
    conflictKeys: [],
    ownerId: 'worker-' + nodeId,
    executionPlane: 'LOCAL',
    acceptanceCriteria: [],
    budget: {},
    state: 'VERIFIED',
    evidence: 'verified node evidence',
    updatedAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

function plan(nodes = [node('a'), node('b')]) {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    jobId: 'job-1',
    objective: 'Parallel research',
    successCriteria: [],
    nodes,
    createdAt: '2026-09-25T09:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    revision: 4,
  };
}

function artifact(artifactId, sha256, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'evidence',
    uri: 'artifact://' + artifactId,
    mediaType: 'application/json',
    sha256,
    sizeBytes: 12,
    createdAt: '2026-09-25T10:05:00.000Z',
    producerInvocationId: 'invoke-' + artifactId,
    sensitive: false,
    ...overrides,
  };
}

function verification(nodeId, evidenceArtifactIds, overrides = {}) {
  return {
    schemaVersion: 1,
    verificationId: 'verify-' + nodeId,
    invocationId: 'invoke-' + nodeId,
    observationId: 'observe-' + nodeId,
    status: 'VERIFIED',
    reasonCode: 'EVIDENCE_OK',
    summary: 'Independent evidence reviewed.',
    evidenceArtifactIds,
    verifiedAt: '2026-09-25T10:10:00.000Z',
    verifierId: 'verifier-' + nodeId,
    verificationAuthorityId: 'authority-1',
    effectId: '',
    executionId: '',
    attempt: 0,
    ...overrides,
  };
}

function claim(claimId, subjectId, predicateId, valueDigest, evidenceArtifactIds) {
  return {
    claimId,
    subjectId,
    predicateId,
    valueDigest,
    evidenceArtifactIds,
  };
}

function result(nodeId, evidenceId, valueDigest, overrides = {}) {
  return {
    nodeId,
    verification: verification(nodeId, [evidenceId]),
    resultArtifactIds: [evidenceId],
    claims: [
      claim(
        'claim-' + nodeId,
        'subject-1',
        'predicate-1',
        valueDigest,
        [evidenceId],
      ),
    ],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    fanInId: 'fanin-1',
    evaluatedAt: NOW,
    plan: plan(),
    participantNodeIds: ['a', 'b'],
    results: [
      result('a', 'evidence-a', SHA_C),
      result('b', 'evidence-b', SHA_C),
    ],
    evidenceArtifacts: [
      artifact('evidence-a', SHA_A),
      artifact('evidence-b', SHA_B),
    ],
    ...overrides,
  };
}

test('complete parallel fan-in reports evidence-complete without granting synthesis authority', () => {
  const out = buildParallelFanInEvidenceV1(request());

  assert.equal(out.status, ParallelFanInStatus.EVIDENCE_COMPLETE);
  assert.equal(out.summary.participantCount, 2);
  assert.equal(out.summary.reportedVerifiedCount, 2);
  assert.equal(out.summary.contradictionCount, 0);
  assert.deepEqual(out.nonTerminalParticipantIds, []);
  assert.deepEqual(out.missingResultNodeIds, []);
  assert.equal(out.synthesisAuthorized, false);
  assert.equal(out.truthResolved, false);
});

test('same subject and predicate with distinct declared value digests produces a structural contradiction group', () => {
  const input = request();
  input.results[1] = result('b', 'evidence-b', SHA_B);

  const out = buildParallelFanInEvidenceV1(input);

  assert.equal(out.status, ParallelFanInStatus.CONTRADICTION_REPORTED);
  assert.equal(out.contradictions.length, 1);
  assert.equal(out.contradictions[0].subjectId, 'subject-1');
  assert.equal(out.contradictions[0].predicateId, 'predicate-1');
  assert.deepEqual(out.contradictions[0].distinctValueDigests, [SHA_B, SHA_C]);
  assert.equal(out.contradictions[0].truthResolved, false);
  assert.equal(out.contradictions[0].requiresIndependentResolution, true);
  assert.equal(out.requiresIndependentContradictionResolution, true);
});

test('non-terminal participant holds fan-in in WAITING and cannot submit result evidence', () => {
  const p = plan([
    node('a'),
    node('b', {
      state: 'RUNNING',
      evidence: '',
      updatedAt: '2026-09-25T10:00:00.000Z',
    }),
  ]);
  const out = buildParallelFanInEvidenceV1(request({
    plan: p,
    results: [result('a', 'evidence-a', SHA_C)],
  }));

  assert.equal(out.status, ParallelFanInStatus.WAITING);
  assert.deepEqual(out.nonTerminalParticipantIds, ['b']);

  assert.throws(
    () => buildParallelFanInEvidenceV1(request({ plan: p })),
    /cannot report a non-terminal participant/u,
  );
});

test('terminal participant without a result is evidence-incomplete rather than silently synthesized', () => {
  const out = buildParallelFanInEvidenceV1(request({
    results: [result('a', 'evidence-a', SHA_C)],
  }));

  assert.equal(out.status, ParallelFanInStatus.EVIDENCE_INCOMPLETE);
  assert.deepEqual(out.missingResultNodeIds, ['b']);
  assert.equal(out.summary.missingResultCount, 1);
});

test('reported FAILED or AMBIGUOUS verification keeps fan-in negative', () => {
  for (const status of ['FAILED', 'AMBIGUOUS']) {
    const input = request();
    input.results[1] = result('b', 'evidence-b', SHA_C, {
      verification: verification('b', ['evidence-b'], {
        status,
        reasonCode: 'CHECK_' + status,
      }),
    });
    const out = buildParallelFanInEvidenceV1(input);
    assert.equal(out.status, ParallelFanInStatus.REPORTED_NEGATIVE);
    assert.equal(out.summary.reportedNegativeCount, 1);
  }
});

test('FAILED or CANCELLED participant state remains negative even with caller-reported VERIFIED evidence', () => {
  for (const state of ['FAILED', 'CANCELLED']) {
    const p = plan([
      node('a'),
      node('b', {
        state,
        evidence: state === 'FAILED' ? 'failure evidence' : 'cancel evidence',
      }),
    ]);
    const out = buildParallelFanInEvidenceV1(request({ plan: p }));

    assert.equal(out.status, ParallelFanInStatus.REPORTED_NEGATIVE);
    assert.equal(out.summary.reportedNegativeCount, 1);
    assert.equal(out.summary.negativeTerminalNodeCount, 1);
    assert.equal(out.results.find(item => item.nodeId === 'b').nodeState, state);
  }
});

test('result artifacts must be covered by the exact result verification evidence set', () => {
  const input = request();
  input.results[0] = result('a', 'evidence-a', SHA_C, {
    resultArtifactIds: ['evidence-b'],
  });

  assert.throws(
    () => buildParallelFanInEvidenceV1(input),
    /result artifact must be included in result verification evidence/u,
  );
});

test('verification and claim evidence must resolve to materialized exact artifacts', () => {
  const missingVerification = request();
  missingVerification.results[0] = result('a', 'unknown-artifact', SHA_C);
  assert.throws(
    () => buildParallelFanInEvidenceV1(missingVerification),
    /verification references unknown evidence artifact/u,
  );

  const outsideVerification = request();
  outsideVerification.results[0] = result('a', 'evidence-a', SHA_C, {
    claims: [
      claim('claim-a', 'subject-1', 'predicate-1', SHA_C, ['evidence-b']),
    ],
  });
  assert.throws(
    () => buildParallelFanInEvidenceV1(outsideVerification),
    /must be included in result verification evidence/u,
  );

  const uppercase = request();
  uppercase.evidenceArtifacts[0] = artifact('evidence-a', SHA_A.toUpperCase());
  assert.throws(
    () => buildParallelFanInEvidenceV1(uppercase),
    /exact lowercase sha256 digest/u,
  );
});

test('self-verification is surfaced as negative evidence and never becomes synthesis-ready', () => {
  const input = request();
  input.results[0] = result('a', 'evidence-a', SHA_C, {
    verification: verification('a', ['evidence-a'], {
      verifierId: 'worker-a',
    }),
  });

  const out = buildParallelFanInEvidenceV1(input);

  assert.equal(out.status, ParallelFanInStatus.REPORTED_NEGATIVE);
  assert.equal(out.results[0].selfVerificationReported, true);
  assert.equal(out.summary.selfVerificationRiskCount, 1);
});

test('verification cannot depend on evidence created after verifiedAt', () => {
  const input = request();
  input.evidenceArtifacts[0] = artifact('evidence-a', SHA_A, {
    createdAt: '2026-09-25T10:11:00.000Z',
  });
  input.results[0] = result('a', 'evidence-a', SHA_C, {
    verification: verification('a', ['evidence-a'], {
      verifiedAt: '2026-09-25T10:10:00.000Z',
    }),
  });

  assert.throws(
    () => buildParallelFanInEvidenceV1(input),
    /evidence created after verification: evidence-a/u,
  );
});

test('verification chronology must follow the terminal node and precede fan-in evaluation', () => {
  const early = request();
  early.results[0] = result('a', 'evidence-a', SHA_C, {
    verification: verification('a', ['evidence-a'], {
      verifiedAt: '2026-09-25T09:59:59.999Z',
    }),
  });
  assert.throws(
    () => buildParallelFanInEvidenceV1(early),
    /predates terminal node state/u,
  );

  const future = request();
  future.results[0] = result('a', 'evidence-a', SHA_C, {
    verification: verification('a', ['evidence-a'], {
      verifiedAt: '2026-09-25T12:00:00.001Z',
    }),
  });
  assert.throws(
    () => buildParallelFanInEvidenceV1(future),
    /after evaluatedAt/u,
  );

  const alias = request();
  alias.results[0] = result('a', 'evidence-a', SHA_C, {
    verification: verification('a', ['evidence-a'], {
      verifiedAt: '2026-09-25T10:10:00Z',
    }),
  });
  assert.throws(
    () => buildParallelFanInEvidenceV1(alias),
    /canonical ISO timestamp/u,
  );
});

test('result ordering is deterministic and independent of participant/result/artifact input order', () => {
  const forward = buildParallelFanInEvidenceV1(request());
  const input = request();
  input.participantNodeIds.reverse();
  input.results.reverse();
  input.evidenceArtifacts.reverse();
  const reverse = buildParallelFanInEvidenceV1(input);

  assert.deepEqual(forward.participantNodeIds, reverse.participantNodeIds);
  assert.deepEqual(forward.results, reverse.results);
  assert.deepEqual(forward.evidenceArtifacts, reverse.evidenceArtifacts);
  assert.deepEqual(forward.contradictions, reverse.contradictions);
});

test('duplicate participants, results and claims fail closed', () => {
  assert.throws(
    () => buildParallelFanInEvidenceV1(request({
      participantNodeIds: ['a', 'a'],
    })),
    /participantNodeIds contains duplicates/u,
  );

  const duplicateResult = request();
  duplicateResult.results = [
    result('a', 'evidence-a', SHA_C),
    result('a', 'evidence-a', SHA_C),
  ];
  assert.throws(
    () => buildParallelFanInEvidenceV1(duplicateResult),
    /duplicate nodeId/u,
  );

  const duplicateClaim = request();
  const r = result('a', 'evidence-a', SHA_C);
  r.claims.push({ ...r.claims[0] });
  duplicateClaim.results[0] = r;
  assert.throws(
    () => buildParallelFanInEvidenceV1(duplicateClaim),
    /duplicate claimId/u,
  );
});

test('descriptor/symbol/sparse boundaries fail closed without executing getters', () => {
  let getterCalls = 0;
  const bad = result('a', 'evidence-a', SHA_C);
  Object.defineProperty(bad, 'nodeId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'a';
    },
  });
  const input = request();
  input.results[0] = bad;
  assert.throws(
    () => buildParallelFanInEvidenceV1(input),
    /enumerable own data properties/u,
  );
  assert.equal(getterCalls, 0);

  const symbolic = request();
  symbolic[Symbol('authority')] = true;
  assert.throws(
    () => buildParallelFanInEvidenceV1(symbolic),
    /unknown field/u,
  );

  const sparse = new Array(2);
  sparse[0] = 'a';
  const sparseInput = request({ participantNodeIds: sparse });
  assert.throws(
    () => buildParallelFanInEvidenceV1(sparseInput),
    /enumerable own data property/u,
  );
});

test('output is deeply frozen and explicitly grants no truth, verification, merge, task or execution authority', () => {
  const out = buildParallelFanInEvidenceV1(request());

  assert.equal(out.sourceTrust, 'UNVERIFIED_INPUT');
  assert.equal(out.readOnly, true);
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.truthResolved, false);
  assert.equal(out.synthesisAuthorized, false);
  assert.equal(out.mergeAuthorized, false);
  assert.equal(out.taskMutationAuthorized, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.verificationAuthorityMinted, false);
  assert.equal(out.requiresCanonicalVerificationResolution, true);
  assert.equal(out.requiresCanonicalArtifactResolution, true);
  assert.ok(Object.isFrozen(out));
  assert.ok(Object.isFrozen(out.results));
  assert.ok(Object.isFrozen(out.results[0]));
  assert.ok(Object.isFrozen(out.summary));
});
