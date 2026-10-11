import test from 'node:test';
import assert from 'node:assert/strict';

import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';

function buildInput(budgetOverrides = {}) {
  return {
    contractId: 'outcome-numeric-exact',
    projectId: 'project-1',
    desiredResult: 'Preserve exact durable OutcomeContract numeric identity.',
    completionCriteria: [{
      criterionId: 'criterion-1',
      description: 'Budget identity remains exact across admission and recovery.',
      observable: 'Validate the canonical OutcomeContract boundary.',
      requiredEvidenceKinds: ['test-report'],
    }],
    constraints: ['Do not create authority outside the existing OutcomeContract boundary.'],
    sourceTruth: [{
      sourceId: 'source-main',
      location: 'github://owner/repo/main',
      revisionId: 'main-exact',
      purpose: 'Canonical repository truth.',
    }],
    allowedAuthority: [],
    budgetBoundaries: {
      maxModelCalls: 0,
      maxRuntimeSeconds: 1,
      maxCostUsdMicros: 0,
      maxConcurrency: 1,
      ...budgetOverrides,
    },
    deliverables: [{
      deliverableId: 'deliverable-1',
      kind: 'code-change',
      description: 'Exact signed-zero rejection.',
      criterionIds: ['criterion-1'],
    }],
    verifierPlan: {
      planId: 'verify-1',
      actorId: 'agent-actor',
      verifierId: 'agent-verifier',
      criterionIds: ['criterion-1'],
      requiredEvidenceArtifactCount: 1,
      independent: true,
    },
    triggerRefs: [],
    createdAt: '2026-09-29T19:55:00.000Z',
  };
}

test('OutcomeContract rejects signed zero in zero-permitted durable budget fields', () => {
  assert.throws(
    () => createOutcomeContractV1(buildInput({ maxModelCalls: -0 })),
    /maxModelCalls must be an exact integer/,
  );
  assert.throws(
    () => createOutcomeContractV1(buildInput({ maxCostUsdMicros: -0 })),
    /maxCostUsdMicros must be an exact integer/,
  );
});

test('OutcomeContract preserves canonical positive zero budget values', () => {
  const contract = createOutcomeContractV1(buildInput());
  assert.equal(Object.is(contract.budgetBoundaries.maxModelCalls, 0), true);
  assert.equal(Object.is(contract.budgetBoundaries.maxModelCalls, -0), false);
  assert.equal(Object.is(contract.budgetBoundaries.maxCostUsdMicros, 0), true);
  assert.equal(Object.is(contract.budgetBoundaries.maxCostUsdMicros, -0), false);
});

test('SourceTruth SHA-256 survives JSON restart without widening OutcomeContract authority', () => {
  const digest = 'a'.repeat(64);
  const input = buildInput();
  input.sourceTruth[0].contentSha256 = digest;

  const first = createOutcomeContractV1(input);
  const restarted = createOutcomeContractV1(JSON.parse(JSON.stringify(input)));
  assert.equal(first.sourceTruth[0].contentSha256, digest);
  assert.equal(restarted.sourceTruth[0].contentSha256, digest);
  assert.equal(first.executionAuthorized, false);
  assert.equal(restarted.executionAuthorized, false);

  for (const invalid of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), ' a'.repeat(64)]) {
    const poisoned = buildInput();
    poisoned.sourceTruth[0].contentSha256 = invalid;
    assert.throws(() => createOutcomeContractV1(poisoned), /contentSha256 must be an exact lowercase SHA-256 digest/);
  }

  let getterCalls = 0;
  const accessor = buildInput();
  Object.defineProperty(accessor.sourceTruth[0], 'contentSha256', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('Untrusted source accessor must not execute');
    },
  });
  assert.throws(() => createOutcomeContractV1(accessor), /data property/);
  assert.equal(getterCalls, 0);
});
