import test from 'node:test';
import assert from 'node:assert/strict';

import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';
import {
  OutcomeVerificationVerdict,
  adjudicateOutcomeVerificationV1,
} from '../src/core/outcome-verification-bridge.js';

const createdAt = '2026-09-25T08:00:00.000Z';
const verifiedAt = '2026-09-25T08:05:00.000Z';
const recordedAt = '2026-09-25T08:06:00.000Z';
const evaluatedAt = '2026-09-25T08:10:00.000Z';
const validThrough = '2026-09-25T09:00:00.000Z';

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

function artifact({
  artifactId,
  kind,
  sha256 = 'a'.repeat(64),
  artifactCreatedAt = '2026-09-25T08:04:00.000Z',
  producerInvocationId = 'actor-tool-invocation',
} = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind,
    uri: 'artifact://evidence/' + artifactId,
    mediaType: 'application/json',
    sha256,
    sizeBytes: 128,
    createdAt: artifactCreatedAt,
    producerInvocationId,
    sensitive: false,
  };
}

function verification({
  criterionId,
  status = 'VERIFIED',
  verifierId = 'verifier-1',
  authorityId = 'verification-authority-1',
  at = verifiedAt,
  evidenceArtifactIds,
  reasonCode,
} = {}) {
  const short = criterionId === 'criterion-tests' ? 'tests' : 'artifact';
  return {
    schemaVersion: 1,
    verificationId: 'verification-' + short,
    invocationId: 'effect-' + short,
    observationId: 'observation-' + short,
    status,
    reasonCode: reasonCode || (status === 'VERIFIED' ? 'PASS' : 'CHECK_FAILED'),
    summary: '',
    evidenceArtifactIds:
      evidenceArtifactIds ?? (status === 'VERIFIED' ? ['evidence-' + short] : []),
    verifiedAt: at,
    verifierId,
    verificationAuthorityId: authorityId,
  };
}

function criterionFor(outcomeContract, criterionId) {
  const item = outcomeContract.completionCriteria.find(
    criterion => criterion.criterionId === criterionId,
  );
  return {
    criterionId: item.criterionId,
    description: item.description,
    observable: item.observable,
    requiredEvidenceKinds: [...item.requiredEvidenceKinds],
  };
}

function trustedRecord({
  outcomeContract,
  criterionId,
  status = 'VERIFIED',
  verifierId = 'verifier-1',
  authorityId = 'verification-authority-1',
  verificationAt = verifiedAt,
  recordAt = recordedAt,
  expiresAt = validThrough,
  evidenceKind,
  evidenceArtifactIds,
  evidenceArtifacts,
  reasonCode,
  recordId,
} = {}) {
  const short = criterionId === 'criterion-tests' ? 'tests' : 'artifact';
  const verificationValue = verification({
    criterionId,
    status,
    verifierId,
    authorityId,
    at: verificationAt,
    evidenceArtifactIds,
    reasonCode,
  });
  const defaultKind = evidenceKind
    ?? (criterionId === 'criterion-tests' ? 'TEST' : 'ARTIFACT');
  const artifacts = evidenceArtifacts
    ?? verificationValue.evidenceArtifactIds.map(artifactId => artifact({
      artifactId,
      kind: defaultKind,
    }));
  return {
    schemaVersion: 1,
    recordId: recordId || 'trusted-record-' + short,
    contractId: outcomeContract.contractId,
    contractRevision: outcomeContract.revision,
    verifierPlanId: outcomeContract.verifierPlan.planId,
    criterion: criterionFor(outcomeContract, criterionId),
    verifierId,
    verificationAuthorityId: authorityId,
    verification: verificationValue,
    evidenceArtifacts: artifacts,
    recordedAt: recordAt,
    validThrough: expiresAt,
  };
}

function happyFixture(options = {}) {
  const outcomeContract = contract(options);
  const records = new Map([
    [
      'verification-artifact',
      trustedRecord({ outcomeContract, criterionId: 'criterion-artifact' }),
    ],
    [
      'verification-tests',
      trustedRecord({ outcomeContract, criterionId: 'criterion-tests' }),
    ],
  ]);
  return {
    trustedContract: outcomeContract,
    input: {
      contract: outcomeContract,
      criterionVerifications: [
        {
          criterionId: 'criterion-tests',
          verificationId: 'verification-tests',
        },
        {
          criterionId: 'criterion-artifact',
          verificationId: 'verification-artifact',
        },
      ],
      evaluatedAt,
    },
    records,
  };
}

function resolverFor(records, calls = []) {
  return async lookup => {
    calls.push(lookup);
    const item = records.get(lookup.verificationId);
    return item == null ? null : item;
  };
}

function contractResolverFor(outcomeContract, calls = []) {
  return async lookup => {
    calls.push(lookup);
    if (lookup.contractId !== outcomeContract.contractId
      || lookup.contractRevision !== outcomeContract.revision) {
      return null;
    }
    return outcomeContract;
  };
}

async function adjudicate(fixture) {
  return adjudicateOutcomeVerificationV1(fixture.input, {
    resolveTrustedOutcomeContract: contractResolverFor(
      fixture.trustedContract ?? fixture.input.contract,
    ),
    resolveTrustedVerificationRecord: resolverFor(fixture.records),
  });
}

test('all criteria require trusted ledger records with canonical verification and hashed artifacts', async () => {
  const fixture = happyFixture();
  const calls = [];
  const contractCalls = [];
  const result = await adjudicateOutcomeVerificationV1(fixture.input, {
    resolveTrustedOutcomeContract: contractResolverFor(
      fixture.trustedContract,
      contractCalls,
    ),
    resolveTrustedVerificationRecord: resolverFor(fixture.records, calls),
  });

  assert.equal(result.verdict, OutcomeVerificationVerdict.VERIFIED);
  assert.equal(result.completionEvidenceReady, true);
  assert.equal(result.verifiedCriteria, 2);
  assert.deepEqual(result.reopenCriterionIds, []);
  assert.equal(
    result.verificationProvenance,
    'TRUSTED_CANONICAL_VERIFICATION_RECORD_WITH_HASHED_ARTIFACT_REFS',
  );
  assert.equal(result.trustedVerificationResolverRequired, true);
  assert.equal(result.completionAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.verificationAuthorityMinted, false);
  assert.equal(result.requiresCanonicalCompletionCommit, true);
  assert.deepEqual(
    result.criteria.map(item => item.criterionId),
    ['criterion-artifact', 'criterion-tests'],
  );
  assert.deepEqual(
    contractCalls,
    [{ contractId: 'outcome-1', contractRevision: 1 }],
  );
  assert.ok(contractCalls.every(item => Object.isFrozen(item)));
  assert.deepEqual(
    calls.map(item => item.criterionId),
    ['criterion-artifact', 'criterion-tests'],
  );
  assert.ok(calls.every(item => Object.isFrozen(item)));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.criteria));
});

test('missing trusted contract/verification resolvers or records fail closed', async () => {
  const fixture = happyFixture();
  await assert.rejects(
    () => adjudicateOutcomeVerificationV1(fixture.input, {
      resolveTrustedVerificationRecord: resolverFor(fixture.records),
    }),
    /trusted outcome contract resolver is required/i,
  );
  await assert.rejects(
    () => adjudicateOutcomeVerificationV1(fixture.input, {
      resolveTrustedOutcomeContract: contractResolverFor(fixture.trustedContract),
    }),
    /trusted verification record resolver is required/i,
  );
  await assert.rejects(
    () => adjudicateOutcomeVerificationV1(fixture.input, {
      resolveTrustedOutcomeContract: async () => null,
      resolveTrustedVerificationRecord: resolverFor(fixture.records),
    }),
    /Trusted canonical Outcome Contract was not found/i,
  );

  fixture.records.delete('verification-tests');
  await assert.rejects(
    () => adjudicate(fixture),
    /trusted verification record was not found/i,
  );
});

test('same id/revision cannot substitute canonical Outcome Contract semantics', async () => {
  const cases = [
    ['desiredResult', value => { value.desiredResult = 'Ship something else.'; }],
    ['sourceTruth', value => { value.sourceTruth[0].revisionId = 'rev-main-2'; }],
    ['constraints', value => { value.constraints = ['Changed constraint.']; }],
    ['allowedAuthority', value => {
      value.allowedAuthority = [{
        authorityId: 'authority-1',
        scopeId: 'scope-1',
        purpose: 'Changed authority requirement.',
        authorityEffect: 'REQUIREMENT_ONLY',
      }];
    }],
    ['budgetBoundaries', value => { value.budgetBoundaries.maxModelCalls += 1; }],
    ['deliverables', value => { value.deliverables[0].description = 'Changed deliverable.'; }],
    ['triggerRefs', value => {
      value.triggerRefs = [{
        triggerId: 'trigger-1',
        kind: 'EVENT',
        schedulingAuthority: 'REFERENCE_ONLY',
      }];
    }],
  ];

  for (const [name, mutate] of cases) {
    const fixture = happyFixture();
    const substituted = structuredClone(fixture.input.contract);
    mutate(substituted);
    fixture.input.contract = substituted;
    await assert.rejects(
      () => adjudicate(fixture),
      /does not match the requested exact contract revision semantics/,
      name,
    );
  }
});

test('trusted canonical contract boundary rejects accessors without executing them', async () => {
  const fixture = happyFixture();
  const hostile = structuredClone(fixture.trustedContract);
  let getterCalls = 0;
  Object.defineProperty(hostile, 'desiredResult', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'Forged result';
    },
  });

  await assert.rejects(
    () => adjudicateOutcomeVerificationV1(fixture.input, {
      resolveTrustedOutcomeContract: async () => hostile,
      resolveTrustedVerificationRecord: resolverFor(fixture.records),
    }),
    /field desiredResult must be an enumerable data property/,
  );
  assert.equal(getterCalls, 0);
});

test('caller-forged verifier, authority and VERIFIED status cannot enter the trusted boundary', async () => {
  const fixture = happyFixture();
  fixture.input.criterionVerifications[0] = {
    criterionId: 'criterion-tests',
    verificationId: 'verification-tests',
    verification: {
      ...verification({
        criterionId: 'criterion-tests',
        verifierId: 'verifier-1',
        authorityId: 'invented-authority',
      }),
      status: 'VERIFIED',
    },
  };

  await assert.rejects(
    () => adjudicate(fixture),
    /contains unknown field: verification/,
  );
});

test('trusted record binds exact verifier identity, authority, contract revision and verifier plan', async () => {
  for (const [name, mutate, expected] of [
    [
      'record verifier mismatch',
      record => { record.verifierId = 'verifier-other'; },
      /verifierId binding is mismatched/,
    ],
    [
      'record authority mismatch',
      record => { record.verificationAuthorityId = 'authority-other'; },
      /verificationAuthorityId binding is mismatched/,
    ],
    [
      'wrong contract revision',
      record => { record.contractRevision += 1; },
      /exact outcome contract revision/,
    ],
    [
      'wrong verifier plan',
      record => { record.verifierPlanId = 'verifier-plan-other'; },
      /verifierPlanId is mismatched/,
    ],
  ]) {
    const fixture = happyFixture();
    mutate(fixture.records.get('verification-tests'));
    await assert.rejects(() => adjudicate(fixture), expected, name);
  }
});

test('trusted criterion semantics are exact and cannot be rebound to changed completion criteria', async () => {
  const fixture = happyFixture();
  fixture.records.get('verification-tests').criterion.observable =
    'Different observable that was never independently verified.';

  await assert.rejects(
    () => adjudicate(fixture),
    /criterion does not match the exact outcome criterion/,
  );
});

test('FAILED or AMBIGUOUS trusted verification reopens instead of authorizing completion', async () => {
  for (const status of ['FAILED', 'AMBIGUOUS']) {
    const fixture = happyFixture();
    fixture.records.set(
      'verification-artifact',
      trustedRecord({
        outcomeContract: fixture.input.contract,
        criterionId: 'criterion-artifact',
        status,
        evidenceArtifactIds: [],
        evidenceArtifacts: [],
      }),
    );

    const result = await adjudicate(fixture);
    assert.equal(result.verdict, OutcomeVerificationVerdict.REOPEN);
    assert.equal(result.completionEvidenceReady, false);
    assert.deepEqual(result.reopenCriterionIds, ['criterion-artifact']);
    assert.equal(result.criteria[0].verificationStatus, status);
    assert.equal(result.completionAuthorized, false);
  }
});

test('VERIFIED evidence kind and count derive only from trusted ArtifactRef records', async () => {
  const kindFixture = happyFixture();
  kindFixture.records.set(
    'verification-tests',
    trustedRecord({
      outcomeContract: kindFixture.input.contract,
      criterionId: 'criterion-tests',
      evidenceKind: 'OTHER',
    }),
  );
  const kindResult = await adjudicate(kindFixture);
  assert.equal(kindResult.verdict, OutcomeVerificationVerdict.REOPEN);
  assert.deepEqual(kindResult.reopenCriterionIds, ['criterion-tests']);
  assert.equal(
    kindResult.criteria.find(item => item.criterionId === 'criterion-tests').reasonCode,
    'EVIDENCE_KIND_INCOMPLETE',
  );

  const countFixture = happyFixture({ requiredEvidenceArtifactCount: 2 });
  const countResult = await adjudicate(countFixture);
  assert.equal(countResult.verdict, OutcomeVerificationVerdict.REOPEN);
  assert.deepEqual(
    countResult.reopenCriterionIds,
    ['criterion-artifact', 'criterion-tests'],
  );
  assert.ok(
    countResult.criteria.every(
      item => item.reasonCode === 'EVIDENCE_ARTIFACT_COUNT_INSUFFICIENT',
    ),
  );
});

test('trusted record freshness and chronology fail closed', async () => {
  for (const [name, mutate, expected] of [
    [
      'expired',
      record => { record.validThrough = '2026-09-25T08:09:59.000Z'; },
      /record is stale/,
    ],
    [
      'recorded before verification',
      record => { record.recordedAt = '2026-09-25T08:04:59.000Z'; },
      /record predates its verification/,
    ],
    [
      'future record',
      record => { record.recordedAt = '2026-09-25T08:10:01.000Z'; },
      /record chronology is invalid/,
    ],
    [
      'future verification',
      record => {
        record.verification.verifiedAt = '2026-09-25T08:10:01.000Z';
        record.recordedAt = '2026-09-25T08:10:02.000Z';
      },
      /verification is future-dated/,
    ],
  ]) {
    const fixture = happyFixture();
    mutate(fixture.records.get('verification-tests'));
    await assert.rejects(() => adjudicate(fixture), expected, name);
  }
});

test('trusted ArtifactRefs must be hashed, exactly referenced and causally timed', async () => {
  const unhashed = happyFixture();
  unhashed.records.get('verification-tests').evidenceArtifacts[0].sha256 = '';
  await assert.rejects(() => adjudicate(unhashed), /must have sha256/);

  const extra = happyFixture();
  extra.records.get('verification-tests').evidenceArtifacts.push(
    artifact({ artifactId: 'evidence-extra', kind: 'TEST' }),
  );
  await assert.rejects(
    () => adjudicate(extra),
    /evidenceArtifactIds must exactly match trusted identity/,
  );

  const missing = happyFixture();
  missing.records.get('verification-tests').evidenceArtifacts = [];
  await assert.rejects(
    () => adjudicate(missing),
    /evidenceArtifactIds must exactly match trusted identity/,
  );

  const stale = happyFixture();
  stale.records.get('verification-tests').evidenceArtifacts[0].createdAt =
    '2026-09-25T07:59:59.000Z';
  await assert.rejects(
    () => adjudicate(stale),
    /evidence predates the exact outcome contract/,
  );

  const future = happyFixture();
  future.records.get('verification-tests').evidenceArtifacts[0].createdAt =
    '2026-09-25T08:05:01.000Z';
  await assert.rejects(
    () => adjudicate(future),
    /evidence is future-dated relative to verification/,
  );
});

test('criterion coverage and trusted record reuse are exact', async () => {
  const duplicate = happyFixture();
  duplicate.input.criterionVerifications[1] =
    duplicate.input.criterionVerifications[0];
  await assert.rejects(() => adjudicate(duplicate), /duplicate criterionId/);

  const unknown = happyFixture();
  unknown.input.criterionVerifications[0] = {
    criterionId: 'criterion-unknown',
    verificationId: 'verification-tests',
  };
  await assert.rejects(
    () => adjudicate(unknown),
    /criterionVerifications must exactly match trusted identity/,
  );

  const reused = happyFixture();
  reused.records.get('verification-tests').recordId =
    reused.records.get('verification-artifact').recordId;
  await assert.rejects(
    () => adjudicate(reused),
    /recordId cannot be reused/,
  );
});

test('hostile accessors, symbols and sparse arrays reject without getter execution', async () => {
  let getterCalls = 0;
  const accessorRow = { verificationId: 'verification-tests' };
  Object.defineProperty(accessorRow, 'criterionId', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'criterion-tests';
    },
  });
  const accessor = happyFixture();
  accessor.input.criterionVerifications[0] = accessorRow;
  await assert.rejects(
    () => adjudicate(accessor),
    /enumerable own data properties/,
  );
  assert.equal(getterCalls, 0);

  const symbolInput = happyFixture();
  symbolInput.input[Symbol('authority')] = true;
  await assert.rejects(() => adjudicate(symbolInput), /unknown field/);

  const sparseInput = happyFixture();
  const sparse = new Array(2);
  sparse[0] = sparseInput.input.criterionVerifications[0];
  sparseInput.input.criterionVerifications = sparse;
  await assert.rejects(() => adjudicate(sparseInput), /dense data array/);
});

test('hostile trusted resolver records reject without accessor execution', async () => {
  const fixture = happyFixture();
  let getterCalls = 0;
  const hostile = structuredClone(fixture.records.get('verification-tests'));
  Object.defineProperty(hostile, 'verificationAuthorityId', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'verification-authority-1';
    },
  });
  fixture.records.set('verification-tests', hostile);

  await assert.rejects(
    () => adjudicate(fixture),
    /enumerable own data properties/,
  );
  assert.equal(getterCalls, 0);
});
