import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VariantQualificationState,
  buildVariantComparisonV1,
  normalizeVariantCandidateV1,
  normalizeVariantEvaluationV1,
  normalizeVariantLabV1,
} from '../src/core/variant-lab-contract.js';

const CREATED = '2026-09-24T22:47:00.000Z';
const SUBMITTED = '2026-09-24T22:48:00.000Z';
const EVALUATED = '2026-09-24T22:49:00.000Z';
const UPDATED = '2026-09-24T22:50:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function candidate(id, producer, overrides = {}) {
  return {
    schemaVersion: 1,
    candidateId: id,
    labId: 'lab-1',
    baseRevisionId: 'base-5d213cd',
    kind: 'CODE',
    producerId: producer,
    isolationRef: `workspace:${id}`,
    artifactIds: [`artifact:${id}`],
    candidateSha256: id === 'variant-a' ? HASH_A : HASH_B,
    createdAt: CREATED,
    submittedAt: SUBMITTED,
    ...overrides,
  };
}

function criterion(id, overrides = {}) {
  return {
    criterionId: id,
    label: `Verify ${id}`,
    verificationContractRef: `verify:${id}:v1`,
    ...overrides,
  };
}

function evaluation(candidateId, criterionId, status = 'PASS', overrides = {}) {
  return {
    schemaVersion: 1,
    evaluationId: `eval:${candidateId}:${criterionId}`,
    labId: 'lab-1',
    candidateId,
    criterionId,
    verifierId: 'verifier-independent',
    status,
    candidateSha256: candidateId === 'variant-a' ? HASH_A : HASH_B,
    evidenceArtifactIds: [`evidence:${candidateId}:${criterionId}`],
    evaluatedAt: EVALUATED,
    ...overrides,
  };
}

function lab(overrides = {}) {
  return {
    schemaVersion: 1,
    labId: 'lab-1',
    objective: 'Compare isolated implementations without ranking by unsupported opinion.',
    baseRevisionId: 'base-5d213cd',
    candidates: [candidate('variant-b', 'producer-b'), candidate('variant-a', 'producer-a')],
    criteria: [criterion('security'), criterion('correctness')],
    evaluations: [],
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...overrides,
  };
}

function fullPassEvaluations() {
  return [
    evaluation('variant-a', 'correctness'),
    evaluation('variant-a', 'security'),
    evaluation('variant-b', 'correctness'),
    evaluation('variant-b', 'security'),
  ];
}

test('candidate identity is exact, immutable and bound to one isolation/base revision', () => {
  const value = normalizeVariantCandidateV1(candidate('variant-a', 'producer-a'));
  assert.equal(value.baseRevisionId, 'base-5d213cd');
  assert.equal(value.isolationRef, 'workspace:variant-a');
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.artifactIds), true);

  assert.throws(() => normalizeVariantCandidateV1(candidate('variant-a', 'producer-a', { schemaVersion: '1' })), /schemaVersion/);
  assert.throws(() => normalizeVariantCandidateV1(candidate(' variant-a', 'producer-a')), /candidateId/);
  assert.throws(() => normalizeVariantCandidateV1(candidate('variant-a', 'producer-a', { submittedAt: '2026-09-24T22:46:00.000Z' })), /predate createdAt/);
});

test('strict boundary rejects accessors, symbols, hidden fields, exotic records and sparse arrays', () => {
  const getter = candidate('variant-a', 'producer-a');
  Object.defineProperty(getter, 'producerId', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(() => normalizeVariantCandidateV1(getter), /data property/);

  const symbolic = candidate('variant-a', 'producer-a');
  symbolic[Symbol('authority')] = 'ALLOW';
  assert.throws(() => normalizeVariantCandidateV1(symbolic), /symbol field/);

  const hidden = candidate('variant-a', 'producer-a');
  Object.defineProperty(hidden, 'authority', { value: 'ALLOW', enumerable: false });
  assert.throws(() => normalizeVariantCandidateV1(hidden), /non-enumerable field/);

  const exotic = Object.create({ authority: 'ALLOW' });
  Object.assign(exotic, candidate('variant-a', 'producer-a'));
  assert.throws(() => normalizeVariantCandidateV1(exotic), /plain data object/);

  const sparse = new Array(2);
  assert.throws(() => normalizeVariantLabV1(lab({ candidates: sparse })), /must not be sparse/);
});

test('lab requires at least two isolated candidates on one exact lab/base and disjoint outputs', () => {
  const value = normalizeVariantLabV1(lab());
  assert.deepEqual(value.candidates.map(item => item.candidateId), ['variant-a', 'variant-b']);

  assert.throws(() => normalizeVariantLabV1(lab({ candidates: [candidate('variant-a', 'producer-a')] })), /2-32 items/);
  assert.throws(() => normalizeVariantLabV1(lab({
    candidates: [candidate('variant-a', 'producer-a'), candidate('variant-b', 'producer-b', { baseRevisionId: 'other-base' })],
  })), /baseRevisionId mismatch/);
  assert.throws(() => normalizeVariantLabV1(lab({
    candidates: [candidate('variant-a', 'producer-a'), candidate('variant-b', 'producer-b', { isolationRef: 'workspace:variant-a' })],
  })), /share isolationRef/);
  assert.throws(() => normalizeVariantLabV1(lab({
    candidates: [candidate('variant-a', 'producer-a'), candidate('variant-b', 'producer-b', { artifactIds: ['artifact:variant-a'] })],
  })), /not isolated/);
});

test('evaluation references exact lab/candidate/criterion, has evidence and independent verifier', () => {
  const value = normalizeVariantEvaluationV1(evaluation('variant-a', 'security'));
  assert.equal(value.status, 'PASS');
  assert.equal(Object.isFrozen(value.evidenceArtifactIds), true);

  assert.throws(() => normalizeVariantLabV1(lab({ evaluations: [
    evaluation('missing', 'security'),
  ] })), /unknown candidate/);
  assert.throws(() => normalizeVariantLabV1(lab({ evaluations: [
    evaluation('variant-a', 'missing'),
  ] })), /unknown criterion/);
  assert.throws(() => normalizeVariantLabV1(lab({ evaluations: [
    evaluation('variant-a', 'security', 'PASS', { verifierId: 'producer-a' }),
  ] })), /independent/);
  assert.throws(() => normalizeVariantEvaluationV1(evaluation('variant-a', 'security', 'PASS', { evidenceArtifactIds: [] })), /1-128 items/);
  assert.throws(() => normalizeVariantLabV1(lab({ evaluations: [
    evaluation('variant-a', 'security', 'PASS', { candidateSha256: HASH_B }),
  ] })), /candidateSha256 mismatch/);
});

test('variant provenance timestamps require one exact canonical representation', () => {
  assert.throws(
    () => normalizeVariantCandidateV1(candidate('variant-a', 'producer-a', {
      submittedAt: '2026-09-24T22:48:00Z',
    })),
    /canonical ISO timestamp/,
  );

  assert.throws(
    () => normalizeVariantEvaluationV1(evaluation('variant-a', 'security', 'PASS', {
      evaluatedAt: '2026-09-25T00:49:00.000+02:00',
    })),
    /canonical ISO timestamp/,
  );
});

test('evaluation timestamps are causal and lab updatedAt covers candidate/evaluation evidence', () => {
  assert.throws(() => normalizeVariantLabV1(lab({ evaluations: [
    evaluation('variant-a', 'security', 'PASS', { evaluatedAt: CREATED }),
  ] })), /predates candidate submission/);

  assert.throws(() => normalizeVariantLabV1(lab({
    evaluations: [evaluation('variant-a', 'security')],
    updatedAt: '2026-09-24T22:48:30.000Z',
  })), /updatedAt predates evaluation/);
});

test('candidate/criterion pair can have only one exact evaluation', () => {
  assert.throws(() => normalizeVariantLabV1(lab({ evaluations: [
    evaluation('variant-a', 'security'),
    evaluation('variant-a', 'security', 'FAIL', { evaluationId: 'eval-other' }),
  ] })), /duplicate candidate\/criterion/);
});

test('comparison is deterministic and reports INCOMPLETE without inventing a winner or score', () => {
  const comparison = buildVariantComparisonV1(lab({ evaluations: [
    evaluation('variant-b', 'security'),
  ] }));
  assert.deepEqual(comparison.criteria.map(item => item.criterionId), ['correctness', 'security']);
  assert.deepEqual(comparison.candidates.map(item => item.candidateId), ['variant-a', 'variant-b']);
  assert.equal(comparison.candidates[0].qualification, VariantQualificationState.INCOMPLETE);
  assert.equal(comparison.candidates[1].qualification, VariantQualificationState.INCOMPLETE);
  assert.equal(comparison.advisoryOnly, true);
  assert.equal(comparison.evaluationAuthority, 'UNVERIFIED_INPUT');
  assert.equal(comparison.synthesisAuthorized, false);
  assert.equal('winner' in comparison, false);
  assert.equal('score' in comparison, false);
});

test('reported FAIL and complete PASS sets remain advisory and never authorize synthesis', () => {
  const evaluations = fullPassEvaluations();
  evaluations[0] = evaluation('variant-a', 'correctness', 'FAIL');
  let comparison = buildVariantComparisonV1(lab({ evaluations }));
  assert.equal(
    comparison.candidates.find(item => item.candidateId === 'variant-a').qualification,
    VariantQualificationState.REPORTED_FAIL,
  );
  assert.equal(
    comparison.candidates.find(item => item.candidateId === 'variant-b').qualification,
    VariantQualificationState.EVIDENCE_COMPLETE,
  );
  assert.equal(comparison.synthesisAuthorized, false);

  comparison = buildVariantComparisonV1(lab({ evaluations: fullPassEvaluations() }));
  assert.deepEqual(
    comparison.candidates.map(item => item.qualification),
    [VariantQualificationState.EVIDENCE_COMPLETE, VariantQualificationState.EVIDENCE_COMPLETE],
  );
  assert.equal(comparison.synthesisAuthorized, false);
  assert.equal(comparison.candidates.every(item => item.advisoryOnly), true);
  assert.equal(comparison.candidates.every(item => item.evaluationAuthority === 'UNVERIFIED_INPUT'), true);
});
