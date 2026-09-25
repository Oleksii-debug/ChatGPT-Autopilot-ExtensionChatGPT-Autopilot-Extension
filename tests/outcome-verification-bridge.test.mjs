import test from 'node:test';
import assert from 'node:assert/strict';

import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';
import {
  OutcomeVerificationVerdict,
  adjudicateOutcomeVerificationV1,
} from '../src/core/outcome-verification-bridge.js';

const createdAt = '2026-09-25T08:00:00.000Z';
const evaluatedAt = '2026-09-25T08:10:00.000Z';

function contract({ requiredEvidenceArtifactCount = 1 } = {}) {
  return createOutcomeContractV1({
    contractId: 'outcome-1',
    projectId: 'project-1',
    desiredResult: 'Ship a tested artifact.',
    completionCriteria: [
      {
        criterionId: 'criterion-artifact',
        description: 'Required artifact exists.',
        observable: 'Artifact evidence is independently verified.',
        requiredEvidenceKinds: ['ARTIFACT'],
      },
      {
        criterionId: 'criterion-tests',
        description: 'Required tests pass.',
        observable: 'Test evidence is independently verified.',
        requiredEvidenceKinds: ['TEST'],
      },
    ],
    constraints: [],
    sourceTruth: [
      {
        sourceId: 'source-main',
        location: 'repo://main',
        revisionId: 'rev-main-1',
        purpose: 'Canonical source revision.',
      },
    ],
    allowedAuthority: [],
    budgetBoundaries: {
      maxModelCalls: 10,
      maxRuntimeSeconds: 3600,
      maxCostUsdMicros: 0,
      maxConcurrency: 2,
      enforcementAuthority: 'NONE',
    },
    deliverables: [
      {
        deliverableId: 'deliverable-1',
        kind: 'CODE',
        description: 'Tested code artifact.',
        criterionIds: ['criterion-artifact', 'criterion-tests'],
      },
    ],
    verifierPlan: {
      planId: 'verifier-plan-1',
      actorId: 'actor-1',
      verifierId: 'verifier-1',
      criterionIds: ['criterion-artifact', 'criterion-tests'],
      requiredEvidenceArtifactCount,
      independent: true,
      verificationAuthority: 'EXTERNAL_REQUIRED',
    },
    triggerRefs: [],
    createdAt,
  });
}

function verification({
  criterionId,
  status = 'VERIFIED',
  verifierId = 'verifier-1',
  authorityId = 'verification-authority-1',
  verifiedAt = '2026-09-25T08:05:00.000Z',
  evidenceArtifactIds,
  invocationId,
  reasonCode,
} = {}) {
  const short = criterionId === 'criterion-tests' ? 'tests' : 'artifact';
  return {
    schemaVersion: 1,
    verificationId: 'verification-' + short,
    invocationId: invocationId || 'verify-' + short,
    observationId: 'observation-' + short,
    status,
    reasonCode: reasonCode || (status === 'VERIFIED' ? 'PASS' : 'CHECK_FAILED'),
    summary: '',
    evidenceArtifactIds: evidenceArtifactIds ?? (status === 'VERIFIED' ? ['evidence-' + short] : []),
    verifiedAt,
    verifierId,
    verificationAuthorityId: authorityId,
  };
}

function artifact({
  artifactId,
  producerInvocationId,
  sha256 = 'a'.repeat(64),
  createdAt: artifactCreatedAt = '2026-09-25T08:04:00.000Z',
} = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'verification-evidence',
    uri: 'artifact://evidence/' + artifactId,
    mediaType: 'application/json',
    sha256,
    sizeBytes: 128,
    createdAt: artifactCreatedAt,
    producerInvocationId,
    sensitive: false,
  };
}

function happyInput() {
  return {
    contract: contract(),
    criterionVerifications: [
      {
        criterionId: 'criterion-tests',
        verification: verification({ criterionId: 'criterion-tests' }),
        evidenceKinds: ['TEST'],
      },
      {
        criterionId: 'criterion-artifact',
        verification: verification({ criterionId: 'criterion-artifact' }),
        evidenceKinds: ['ARTIFACT'],
      },
    ],
    evidenceArtifacts: [
      artifact({ artifactId: 'evidence-tests', producerInvocationId: 'verify-tests' }),
      artifact({ artifactId: 'evidence-artifact', producerInvocationId: 'verify-artifact' }),
    ],
    evaluatedAt,
  };
}

test('all criteria require canonical independent VerificationV1 plus hashed evidence', () => {
  const result = adjudicateOutcomeVerificationV1(happyInput());

  assert.equal(result.verdict, OutcomeVerificationVerdict.VERIFIED);
  assert.equal(result.completionEvidenceReady, true);
  assert.equal(result.verifiedCriteria, 2);
  assert.deepEqual(result.reopenCriterionIds, []);
  assert.equal(result.verificationProvenance, 'CANONICAL_VERIFICATION_V1_WITH_HASHED_ARTIFACT_REFS');
  assert.equal(result.completionAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.verificationAuthorityMinted, false);
  assert.equal(result.requiresCanonicalCompletionCommit, true);
  assert.deepEqual(result.criteria.map(item => item.criterionId), [
    'criterion-artifact',
    'criterion-tests',
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.criteria));
});

test('FAILED or AMBIGUOUS verification deterministically reopens instead of authorizing completion', () => {
  for (const status of ['FAILED', 'AMBIGUOUS']) {
    const input = happyInput();
    input.criterionVerifications = [
      {
        criterionId: 'criterion-artifact',
        verification: verification({
          criterionId: 'criterion-artifact',
          status,
          evidenceArtifactIds: [],
        }),
        evidenceKinds: [],
      },
      {
        criterionId: 'criterion-tests',
        verification: verification({ criterionId: 'criterion-tests' }),
        evidenceKinds: ['TEST'],
      },
    ];
    input.evidenceArtifacts = [
      artifact({ artifactId: 'evidence-tests', producerInvocationId: 'verify-tests' }),
    ];

    const result = adjudicateOutcomeVerificationV1(input);
    assert.equal(result.verdict, OutcomeVerificationVerdict.REOPEN);
    assert.equal(result.completionEvidenceReady, false);
    assert.deepEqual(result.reopenCriterionIds, ['criterion-artifact']);
    assert.equal(result.criteria[0].verificationStatus, status);
    assert.equal(result.completionAuthorized, false);
  }
});

test('VERIFIED without required evidence kinds or artifact count reopens as incomplete evidence', () => {
  const kindInput = happyInput();
  kindInput.criterionVerifications[0].evidenceKinds = ['OTHER'];
  const kindResult = adjudicateOutcomeVerificationV1(kindInput);
  assert.equal(kindResult.verdict, OutcomeVerificationVerdict.REOPEN);
  assert.deepEqual(kindResult.reopenCriterionIds, ['criterion-tests']);
  assert.equal(
    kindResult.criteria.find(item => item.criterionId === 'criterion-tests').reasonCode,
    'EVIDENCE_KIND_INCOMPLETE',
  );

  const countInput = happyInput();
  countInput.contract = contract({ requiredEvidenceArtifactCount: 2 });
  const countResult = adjudicateOutcomeVerificationV1(countInput);
  assert.equal(countResult.verdict, OutcomeVerificationVerdict.REOPEN);
  assert.deepEqual(countResult.reopenCriterionIds, ['criterion-artifact', 'criterion-tests']);
  assert.ok(countResult.criteria.every(item => item.reasonCode === 'EVIDENCE_ARTIFACT_COUNT_INSUFFICIENT'));
});

test('foreign verifier, missing verification authority, and self-verifier plans fail closed', () => {
  const foreign = happyInput();
  foreign.criterionVerifications[0].verification = verification({
    criterionId: 'criterion-tests',
    verifierId: 'verifier-other',
  });
  assert.throws(
    () => adjudicateOutcomeVerificationV1(foreign),
    /declared independent verifier/,
  );

  const noAuthority = happyInput();
  noAuthority.criterionVerifications[0].verification = verification({
    criterionId: 'criterion-tests',
    authorityId: null,
  });
  assert.throws(
    () => adjudicateOutcomeVerificationV1(noAuthority),
    /lacks external verificationAuthorityId/,
  );

  const selfPlan = {
    ...contract(),
    verifierPlan: {
      ...contract().verifierPlan,
      actorId: 'same-agent',
      verifierId: 'same-agent',
    },
  };
  assert.throws(
    () => adjudicateOutcomeVerificationV1({
      ...happyInput(),
      contract: selfPlan,
    }),
    /independent from actor/,
  );
});

test('evidence must be exact hashed artifacts from the verification invocation and exact time interval', () => {
  const missing = happyInput();
  missing.evidenceArtifacts = [
    artifact({ artifactId: 'evidence-artifact', producerInvocationId: 'verify-artifact' }),
  ];
  assert.throws(
    () => adjudicateOutcomeVerificationV1(missing),
    /unknown evidence artifact: evidence-tests/,
  );

  const unhashed = happyInput();
  unhashed.evidenceArtifacts[0] = artifact({
    artifactId: 'evidence-tests',
    producerInvocationId: 'verify-tests',
    sha256: '',
  });
  assert.throws(() => adjudicateOutcomeVerificationV1(unhashed), /must have sha256/);

  const foreignProducer = happyInput();
  foreignProducer.evidenceArtifacts[0] = artifact({
    artifactId: 'evidence-tests',
    producerInvocationId: 'other-invocation',
  });
  assert.throws(() => adjudicateOutcomeVerificationV1(foreignProducer), /producer does not match/);

  const stale = happyInput();
  stale.evidenceArtifacts[0] = artifact({
    artifactId: 'evidence-tests',
    producerInvocationId: 'verify-tests',
    createdAt: '2026-09-25T07:59:59.000Z',
  });
  assert.throws(() => adjudicateOutcomeVerificationV1(stale), /predates the exact outcome contract/);

  const future = happyInput();
  future.evidenceArtifacts[0] = artifact({
    artifactId: 'evidence-tests',
    producerInvocationId: 'verify-tests',
    createdAt: '2026-09-25T08:06:00.000Z',
  });
  assert.throws(() => adjudicateOutcomeVerificationV1(future), /future-dated relative to verification/);
});

test('future verification and extraneous unreferenced evidence fail closed', () => {
  const future = happyInput();
  future.criterionVerifications[0].verification = verification({
    criterionId: 'criterion-tests',
    verifiedAt: '2026-09-25T08:11:00.000Z',
  });
  assert.throws(() => adjudicateOutcomeVerificationV1(future), /verification is future-dated/);

  const extra = happyInput();
  extra.evidenceArtifacts.push(artifact({
    artifactId: 'evidence-unused',
    producerInvocationId: 'verify-unused',
  }));
  assert.throws(
    () => adjudicateOutcomeVerificationV1(extra),
    /evidenceArtifacts must exactly cover/,
  );
});

test('criterion coverage is exact: duplicates, unknown IDs, and omissions reject', () => {
  const duplicate = happyInput();
  duplicate.criterionVerifications[1] = duplicate.criterionVerifications[0];
  assert.throws(() => adjudicateOutcomeVerificationV1(duplicate), /duplicate criterionId/);

  const unknown = happyInput();
  unknown.criterionVerifications[0] = {
    ...unknown.criterionVerifications[0],
    criterionId: 'criterion-unknown',
  };
  assert.throws(() => adjudicateOutcomeVerificationV1(unknown), /exactly cover/);

  const missing = happyInput();
  missing.criterionVerifications.pop();
  assert.throws(() => adjudicateOutcomeVerificationV1(missing), /exactly cover/);
});

test('hostile accessors, symbols, sparse arrays, and authority-forging request fields reject without getter execution', () => {
  let getterCalls = 0;
  const accessorRow = {
    verification: verification({ criterionId: 'criterion-tests' }),
    evidenceKinds: ['TEST'],
  };
  Object.defineProperty(accessorRow, 'criterionId', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'criterion-tests';
    },
  });
  const accessorInput = happyInput();
  accessorInput.criterionVerifications[0] = accessorRow;
  assert.throws(
    () => adjudicateOutcomeVerificationV1(accessorInput),
    /enumerable own data properties/,
  );
  assert.equal(getterCalls, 0);

  const symbolInput = happyInput();
  symbolInput[Symbol('authority')] = true;
  assert.throws(() => adjudicateOutcomeVerificationV1(symbolInput), /unknown field/);

  const sparseInput = happyInput();
  const sparse = new Array(2);
  sparse[0] = sparseInput.criterionVerifications[0];
  sparseInput.criterionVerifications = sparse;
  assert.throws(() => adjudicateOutcomeVerificationV1(sparseInput), /dense data array/);

  const forged = {
    ...happyInput(),
    completionAuthorized: true,
  };
  assert.throws(() => adjudicateOutcomeVerificationV1(forged), /unknown field/);
});
