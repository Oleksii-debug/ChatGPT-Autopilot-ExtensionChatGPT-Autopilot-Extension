import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OutcomeEvidenceStatus,
  createOutcomeContractV1,
  normalizeOutcomeContractV1,
  projectOutcomeEvidenceV1,
} from '../src/core/outcome-contract.js';

const AT = '2026-09-25T00:20:00.000Z';
const VERIFIED_AT = '2026-09-25T00:21:00.000Z';

function criterion(id, overrides = {}) {
  return {
    criterionId: id,
    description: `Criterion ${id} must hold.`,
    observable: `Observe ${id} in canonical evidence.`,
    requiredEvidenceKinds: ['test-report'],
    ...overrides,
  };
}

function source(id = 'source-main', overrides = {}) {
  return {
    sourceId: id,
    location: `github://owner/repo/${id}`,
    revisionId: `${id}-revision-1`,
    purpose: 'Canonical implementation truth.',
    ...overrides,
  };
}

function authority(id = 'authority-repo-write', overrides = {}) {
  return {
    authorityId: id,
    scopeId: 'scope-repo',
    purpose: 'Permit the canonical executor to mutate the admitted repository.',
    ...overrides,
  };
}

function deliverable(id, criterionIds, overrides = {}) {
  return {
    deliverableId: id,
    kind: 'code-change',
    description: `Deliverable ${id}.`,
    criterionIds,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    contractId: 'outcome-1',
    projectId: 'project-1',
    desiredResult: 'Ship the requested capability with observable proof and no duplicate authority.',
    completionCriteria: [
      criterion('criterion-b'),
      criterion('criterion-a'),
    ],
    constraints: [
      'Do not create a second scheduler.',
      'Preserve exact-effect reconciliation.',
    ],
    sourceTruth: [source()],
    allowedAuthority: [authority()],
    budgetBoundaries: {
      maxModelCalls: 50,
      maxRuntimeSeconds: 7_200,
      maxCostUsdMicros: 5_000_000,
      maxConcurrency: 4,
    },
    deliverables: [
      deliverable('deliverable-b', ['criterion-b']),
      deliverable('deliverable-a', ['criterion-a']),
    ],
    verifierPlan: {
      planId: 'verify-plan-1',
      actorId: 'actor-1',
      verifierId: 'verifier-1',
      criterionIds: ['criterion-b', 'criterion-a'],
      requiredEvidenceArtifactCount: 1,
      independent: true,
    },
    triggerRefs: [
      { triggerId: 'trigger-manual', kind: 'manual' },
    ],
    createdAt: AT,
    ...overrides,
  };
}

function assessment(criterionId, overrides = {}) {
  return {
    criterionId,
    status: 'VERIFIED',
    evidenceArtifactIds: [`evidence-${criterionId}`],
    assessedBy: 'verifier-1',
    assessedAt: VERIFIED_AT,
    ...overrides,
  };
}

test('normalizes the complete North-Star Outcome Contract surface deterministically without granting authority', () => {
  const result = createOutcomeContractV1(input());

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.revision, 1);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.ownerAccepted, false);
  assert.equal(result.executionAuthorized, false);
  assert.deepEqual(result.completionCriteria.map(item => item.criterionId), ['criterion-a', 'criterion-b']);
  assert.deepEqual(result.deliverables.map(item => item.deliverableId), ['deliverable-a', 'deliverable-b']);
  assert.deepEqual(result.verifierPlan.criterionIds, ['criterion-a', 'criterion-b']);
  assert.equal(result.verifierPlan.independent, true);
  assert.equal(result.verifierPlan.verificationAuthority, 'EXTERNAL_REQUIRED');
  assert.equal(result.allowedAuthority[0].authorityEffect, 'REQUIREMENT_ONLY');
  assert.equal(result.budgetBoundaries.enforcementAuthority, 'NONE');
  assert.equal(result.triggerRefs[0].schedulingAuthority, 'REFERENCE_ONLY');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.completionCriteria), true);
  assert.equal(Object.isFrozen(result.verifierPlan), true);

  const roundTrip = normalizeOutcomeContractV1(result);
  assert.deepEqual(roundTrip, result);
});

test('criteria, verifier coverage and required deliverables are cross-reference complete', () => {
  assert.throws(() => createOutcomeContractV1(input({
    verifierPlan: {
      ...input().verifierPlan,
      criterionIds: ['criterion-a'],
    },
  })), /exactly cover all completion criteria/);

  assert.throws(() => createOutcomeContractV1(input({
    deliverables: [deliverable('only-a', ['criterion-a'])],
  })), /lacks a required deliverable binding: criterion-b/);

  assert.throws(() => createOutcomeContractV1(input({
    deliverables: [
      deliverable('bad', ['criterion-missing']),
      deliverable('good', ['criterion-a', 'criterion-b']),
    ],
  })), /unknown criterionId: criterion-missing/);
});

test('source truth must be revision-bound and verifier must be distinct from actor', () => {
  assert.throws(() => createOutcomeContractV1(input({
    sourceTruth: [source('source-main', { revisionId: '' })],
  })), /revisionId/);

  assert.throws(() => createOutcomeContractV1(input({
    verifierPlan: {
      ...input().verifierPlan,
      verifierId: 'actor-1',
    },
  })), /independent from actor/);

  assert.throws(() => createOutcomeContractV1(input({
    verifierPlan: {
      ...input().verifierPlan,
      independent: false,
    },
  })), /explicitly require independence/);
});

test('budget/time/concurrency boundaries are exact non-enforcing contract data', () => {
  const result = createOutcomeContractV1(input({
    budgetBoundaries: {
      maxModelCalls: 0,
      maxRuntimeSeconds: 1,
      maxCostUsdMicros: 0,
      maxConcurrency: 1,
    },
  }));
  assert.equal(result.budgetBoundaries.maxModelCalls, 0);
  assert.equal(result.budgetBoundaries.maxCostUsdMicros, 0);
  assert.equal(result.budgetBoundaries.enforcementAuthority, 'NONE');

  assert.throws(() => createOutcomeContractV1(input({
    budgetBoundaries: { ...input().budgetBoundaries, maxConcurrency: 0 },
  })), /maxConcurrency/);
  assert.throws(() => createOutcomeContractV1(input({
    budgetBoundaries: { ...input().budgetBoundaries, maxModelCalls: '50' },
  })), /exact integer/);
});

test('contract representation and nested declarations cannot mint authority', () => {
  const normalized = createOutcomeContractV1(input());

  assert.throws(() => normalizeOutcomeContractV1({
    ...normalized,
    ownerAccepted: true,
  }), /cannot authenticate owner acceptance/);

  assert.throws(() => normalizeOutcomeContractV1({
    ...normalized,
    executionAuthorized: true,
  }), /cannot grant execution authority/);

  assert.throws(() => normalizeOutcomeContractV1({
    ...normalized,
    policyDecision: 'ALLOW',
  }), /unknown field/);

  assert.throws(() => normalizeOutcomeContractV1({
    ...normalized,
    allowedAuthority: [{
      ...normalized.allowedAuthority[0],
      authorityEffect: 'GRANT',
    }],
  }), /cannot grant authority/);

  assert.throws(() => normalizeOutcomeContractV1({
    ...normalized,
    budgetBoundaries: {
      ...normalized.budgetBoundaries,
      enforcementAuthority: 'SELF',
    },
  }), /cannot become enforcement authority/);

  assert.throws(() => normalizeOutcomeContractV1({
    ...normalized,
    verifierPlan: {
      ...normalized.verifierPlan,
      verificationAuthority: 'SELF',
    },
  }), /cannot mint verifier authority/);

  assert.throws(() => normalizeOutcomeContractV1({
    ...normalized,
    triggerRefs: [{
      ...normalized.triggerRefs[0],
      schedulingAuthority: 'EXECUTE',
    }],
  }), /cannot grant scheduling authority/);
});

test('all structurally verified criteria yield only unverified EVIDENCE_READY, never completion authority', () => {
  const contract = createOutcomeContractV1(input());
  const result = projectOutcomeEvidenceV1({
    contract,
    assessments: [
      assessment('criterion-b'),
      assessment('criterion-a'),
    ],
  });

  assert.equal(result.status, OutcomeEvidenceStatus.EVIDENCE_READY);
  assert.equal(result.verifiedCriteria, 2);
  assert.equal(result.totalCriteria, 2);
  assert.equal(result.verificationProvenance, 'UNVERIFIED_INPUT');
  assert.equal(result.completionAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.deepEqual(result.assessments.map(item => item.criterionId), ['criterion-a', 'criterion-b']);
});

test('FAILED, PARTIAL and AMBIGUOUS criteria cannot be projected as evidence-ready success', () => {
  const contract = createOutcomeContractV1(input());
  for (const status of ['FAILED', 'PARTIAL', 'AMBIGUOUS']) {
    const result = projectOutcomeEvidenceV1({
      contract,
      assessments: [
        assessment('criterion-a'),
        assessment('criterion-b', {
          status,
          evidenceArtifactIds: [],
        }),
      ],
    });
    assert.equal(result.status, OutcomeEvidenceStatus.INCOMPLETE);
    assert.equal(result.verifiedCriteria, 1);
    assert.equal(result.completionAuthorized, false);
  }
});

test('criterion evidence must be complete, unique, attributed to declared verifier and sufficient', () => {
  const contract = createOutcomeContractV1(input());

  assert.throws(() => projectOutcomeEvidenceV1({
    contract,
    assessments: [assessment('criterion-a')],
  }), /exactly cover all completion criteria/);

  assert.throws(() => projectOutcomeEvidenceV1({
    contract,
    assessments: [
      assessment('criterion-a'),
      assessment('criterion-a'),
    ],
  }), /contains duplicates/);

  assert.throws(() => projectOutcomeEvidenceV1({
    contract,
    assessments: [
      assessment('criterion-a', { assessedBy: 'actor-1' }),
      assessment('criterion-b'),
    ],
  }), /not attributed to the declared verifier/);

  assert.throws(() => projectOutcomeEvidenceV1({
    contract,
    assessments: [
      assessment('criterion-a', { evidenceArtifactIds: [] }),
      assessment('criterion-b'),
    ],
  }), /at least 1 item/);
});

test('strict descriptor boundary rejects getters, hidden fields, symbols and sparse arrays without executing accessors', () => {
  let getterReads = 0;

  const accessor = input();
  Object.defineProperty(accessor, 'desiredResult', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'unsafe';
    },
  });
  assert.throws(() => createOutcomeContractV1(accessor), /enumerable data property/);
  assert.equal(getterReads, 0);

  const hidden = input();
  Object.defineProperty(hidden, 'executionAuthorized', {
    enumerable: false,
    value: true,
  });
  assert.throws(() => createOutcomeContractV1(hidden), /unknown field|enumerable data property/);

  const symbolic = input();
  symbolic[Symbol('authority')] = 'ALLOW';
  assert.throws(() => createOutcomeContractV1(symbolic), /unknown field/);

  const sparse = input();
  sparse.completionCriteria = Array(2);
  sparse.completionCriteria[0] = criterion('criterion-a');
  assert.throws(() => createOutcomeContractV1(sparse), /dense data array/);

  const nestedGetter = input();
  const criteria = [];
  Object.defineProperty(criteria, '0', {
    enumerable: true,
    get() {
      getterReads += 1;
      return criterion('criterion-a');
    },
  });
  criteria.length = 1;
  nestedGetter.completionCriteria = criteria;
  assert.throws(() => createOutcomeContractV1(nestedGetter), /enumerable data property/);
  assert.equal(getterReads, 0);
});

test('coercive versions, ids, booleans and status aliases fail closed', () => {
  const contract = createOutcomeContractV1(input());

  assert.throws(() => normalizeOutcomeContractV1({
    ...contract,
    schemaVersion: '1',
  }), /schemaVersion/);

  assert.throws(() => createOutcomeContractV1(input({
    contractId: 7,
  })), /contractId/);

  assert.throws(() => projectOutcomeEvidenceV1({
    contract,
    assessments: [
      assessment('criterion-a', { status: 'verified' }),
      assessment('criterion-b'),
    ],
  }), /status is invalid/);
});

test('null-prototype contract records are accepted as JSON-style data', () => {
  const normal = createOutcomeContractV1(input());
  const nullProto = Object.assign(Object.create(null), normal);
  const result = normalizeOutcomeContractV1(nullProto);
  assert.equal(result.contractId, 'outcome-1');
  assert.equal(result.ownerAccepted, false);
  assert.equal(result.executionAuthorized, false);
});
