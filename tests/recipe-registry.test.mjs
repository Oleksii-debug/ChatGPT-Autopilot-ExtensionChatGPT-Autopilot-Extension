import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RecipeLifecycleState,
  RecipeQualificationStatus,
  RecipeFreshnessStatus,
  assertRecipeRegistryExtensionV1,
  assertRecipeReplayEligibleV1,
  assessRecipeSourceFreshnessV1,
  getCurrentRecipeVersionV1,
  normalizeRecipeDefinitionV1,
  normalizeRecipeRegistryV1,
  recipeRequiredCapabilityIdsV1,
  resolvePromotedRecipeV1,
} from '../src/core/recipe-registry.js';

const AT = '2026-09-24T22:21:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const SUBJECT = 'c'.repeat(64);

function binding(overrides = {}) {
  return {
    sourceId: 'github-main',
    revisionId: 'commit-5d213cd',
    contentSha256: HASH_A,
    ...overrides,
  };
}

function qualification(status = 'PASS', overrides = {}) {
  if (status === 'UNQUALIFIED') {
    return { status, evidenceArtifactIds: [], ...overrides };
  }
  return {
    status,
    evaluationId: 'eval-1',
    benchmarkSuiteId: 'suite-recipe-replay',
    benchmarkSuiteRevision: 'suite-rev-3',
    verifierId: 'verifier-1',
    evidenceArtifactIds: ['artifact-eval-report'],
    subjectSha256: SUBJECT,
    evaluatedAt: AT,
    ...overrides,
  };
}

function recipe(overrides = {}) {
  return {
    schemaVersion: 1,
    recipeId: 'recipe.safe-repo-review',
    version: 1,
    parentVersion: 0,
    title: 'Safe repository review',
    description: 'Read current repository state and produce independently checked evidence.',
    producerId: 'actor-1',
    lifecycle: 'PROMOTED',
    sourceBindings: [binding()],
    steps: [
      {
        stepId: 'inspect',
        kind: 'TOOL',
        title: 'Inspect repository',
        dependsOn: [],
        providerId: 'github',
        toolId: 'github.read',
        requiredCapabilityIds: ['repo.read'],
        inputContractRef: 'contract.repo-read.v1',
        outputContractRef: 'contract.repo-snapshot.v1',
        verificationContractRef: '',
      },
      {
        stepId: 'summarize',
        kind: 'DETERMINISTIC',
        title: 'Summarize bounded evidence',
        dependsOn: ['inspect'],
        providerId: '',
        toolId: '',
        requiredCapabilityIds: [],
        inputContractRef: 'contract.repo-snapshot.v1',
        outputContractRef: 'contract.summary.v1',
        verificationContractRef: 'contract.summary-verify.v1',
      },
    ],
    qualification: qualification(),
    createdAt: AT,
    ...overrides,
  };
}

function registry(recipes, overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'recipe-registry-main',
    revision: 1,
    recipes,
    updatedAt: AT,
    ...overrides,
  };
}

test('RecipeDefinitionV1 is deterministic, frozen, source-bound, and declarative-only', () => {
  const value = normalizeRecipeDefinitionV1(recipe());
  assert.equal(value.lifecycle, RecipeLifecycleState.PROMOTED);
  assert.equal(value.qualification.status, RecipeQualificationStatus.PASS);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.steps), true);
  assert.equal(Object.isFrozen(value.sourceBindings), true);
  assert.deepEqual(recipeRequiredCapabilityIdsV1(value), ['repo.read']);
  assert.equal('policyDecision' in value, false);
  assert.equal('arguments' in value.steps[0], false);
});

test('PROMOTED requires passing independent verifier evidence and a benchmark binding', () => {
  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    qualification: qualification('FAIL'),
  })), /PROMOTED recipe requires PASS/);

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    qualification: qualification('PASS', { verifierId: 'actor-1' }),
  })), /independent/);

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    qualification: qualification('PASS', { evidenceArtifactIds: [] }),
  })), /1-128 items/);

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    qualification: qualification('PASS', { benchmarkSuiteRevision: '' }),
  })), /benchmarkSuiteRevision/);
});

test('DRAFT cannot smuggle successful qualification and tool steps cannot mint capability authority', () => {
  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    lifecycle: 'DRAFT',
  })), /DRAFT recipe must be UNQUALIFIED/);

  const draft = normalizeRecipeDefinitionV1(recipe({
    lifecycle: 'DRAFT',
    qualification: qualification('UNQUALIFIED'),
  }));
  assert.equal(draft.qualification.status, 'UNQUALIFIED');

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    steps: [{ ...recipe().steps[0], requiredCapabilityIds: [] }],
  })), /requires capability declarations/);

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    steps: [{ ...recipe().steps[1], requiredCapabilityIds: ['repo.write'] }],
  })), /deterministic step cannot declare/);
});

test('recipe step graph rejects missing dependencies, cycles, duplicate IDs and sparse arrays', () => {
  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    steps: [{ ...recipe().steps[0], dependsOn: ['missing'] }],
  })), /unknown step/);

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    steps: [
      { ...recipe().steps[0], stepId: 'a', dependsOn: ['b'] },
      { ...recipe().steps[1], stepId: 'b', dependsOn: ['a'] },
    ],
  })), /dependency cycle/);

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    steps: [recipe().steps[0], { ...recipe().steps[0] }],
  })), /duplicate stepId/);

  const sparse = new Array(1);
  assert.throws(() => normalizeRecipeDefinitionV1(recipe({ steps: sparse })), /must not be sparse/);
});

test('strict contract rejects accessors, exotic prototypes, symbols, hidden fields and coercion aliases', () => {
  const accessor = recipe();
  Object.defineProperty(accessor, 'lifecycle', {
    enumerable: true,
    get() { throw new Error('getter must not execute'); },
  });
  assert.throws(() => normalizeRecipeDefinitionV1(accessor), /data property/);

  const exotic = Object.create({ lifecycle: 'PROMOTED' });
  Object.assign(exotic, recipe());
  assert.throws(() => normalizeRecipeDefinitionV1(exotic), /plain data object/);

  const symbolic = recipe();
  symbolic[Symbol('authority')] = 'ALLOW';
  assert.throws(() => normalizeRecipeDefinitionV1(symbolic), /symbol field/);

  const hidden = recipe();
  Object.defineProperty(hidden, 'authority', { value: 'ALLOW', enumerable: false });
  assert.throws(() => normalizeRecipeDefinitionV1(hidden), /non-enumerable field/);

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({ version: '1' })), /version is invalid/);
  assert.throws(() => normalizeRecipeDefinitionV1(recipe({ recipeId: ' recipe.safe-repo-review' })), /recipeId is invalid/);
});

test('registry canonicalizes ordering and enforces contiguous immutable version lineage', () => {
  const v1 = recipe({ lifecycle: 'CANDIDATE', qualification: qualification('PASS') });
  const v2 = recipe({
    version: 2,
    parentVersion: 1,
    title: 'Safe repository review v2',
    createdAt: '2026-09-24T22:22:00.000Z',
  });
  const value = normalizeRecipeRegistryV1(registry([v2, v1]));
  assert.deepEqual(value.recipes.map(item => item.version), [1, 2]);
  assert.equal(getCurrentRecipeVersionV1(value, v1.recipeId).version, 2);

  assert.throws(() => normalizeRecipeRegistryV1(registry([v2])), /must start at version 1/);
  assert.throws(() => normalizeRecipeRegistryV1(registry([v1, { ...v2, version: 3, parentVersion: 2 }])), /contiguous/);
  assert.throws(() => normalizeRecipeRegistryV1(registry([v1, { ...v1 }])), /duplicate version/);
});

test('registry extension is append-only and preserves existing version bytes', () => {
  const v1 = recipe({ lifecycle: 'CANDIDATE', qualification: qualification('PASS') });
  const before = registry([v1]);
  const v2 = recipe({
    version: 2,
    parentVersion: 1,
    title: 'Safe repository review v2',
    createdAt: '2026-09-24T22:22:00.000Z',
  });
  const after = registry([v1, v2], {
    revision: 2,
    updatedAt: '2026-09-24T22:23:00.000Z',
  });
  assert.equal(assertRecipeRegistryExtensionV1(before, after).recipes.length, 2);

  assert.throws(() => assertRecipeRegistryExtensionV1(before, registry([], {
    revision: 2,
    updatedAt: '2026-09-24T22:23:00.000Z',
  })), /cannot be removed/);

  assert.throws(() => assertRecipeRegistryExtensionV1(before, registry([
    { ...v1, title: 'Mutated in place' },
  ], {
    revision: 2,
    updatedAt: '2026-09-24T22:23:00.000Z',
  })), /immutable/);

  assert.throws(() => assertRecipeRegistryExtensionV1(before, { ...after, revision: 3 }), /registry revision must advance exactly once/);
});

test('promoted resolution keeps prior promoted version while a candidate is evaluated, but latest RETIRED disables replay', () => {
  const promoted = recipe();
  const candidate = recipe({
    version: 2,
    parentVersion: 1,
    lifecycle: 'CANDIDATE',
    qualification: qualification('FAIL'),
    createdAt: '2026-09-24T22:22:00.000Z',
  });
  const withCandidate = registry([promoted, candidate]);
  assert.equal(resolvePromotedRecipeV1(withCandidate, promoted.recipeId).version, 1);

  const retired = recipe({
    version: 3,
    parentVersion: 2,
    lifecycle: 'RETIRED',
    qualification: qualification('UNQUALIFIED'),
    createdAt: '2026-09-24T22:23:00.000Z',
  });
  assert.equal(resolvePromotedRecipeV1(registry([promoted, candidate, retired]), promoted.recipeId), null);
});

test('source drift is explicit and replay eligibility fails closed on missing/revised/substituted bytes', () => {
  const value = recipe();
  assert.equal(assessRecipeSourceFreshnessV1(value, [binding()]).status, RecipeFreshnessStatus.FRESH);
  assert.equal(assertRecipeReplayEligibleV1(value, [binding()]).recipeId, value.recipeId);

  let report = assessRecipeSourceFreshnessV1(value, [binding({ revisionId: 'commit-new' })]);
  assert.equal(report.status, 'STALE');
  assert.deepEqual(report.drift, [{ sourceId: 'github-main', reason: 'REVISION_CHANGED' }]);
  assert.throws(() => assertRecipeReplayEligibleV1(value, [binding({ revisionId: 'commit-new' })]), /REVISION_CHANGED/);

  report = assessRecipeSourceFreshnessV1(value, [binding({ contentSha256: HASH_B })]);
  assert.deepEqual(report.drift, [{ sourceId: 'github-main', reason: 'CONTENT_CHANGED' }]);
  assert.throws(() => assertRecipeReplayEligibleV1(value, [binding({ contentSha256: HASH_B })]), /CONTENT_CHANGED/);

  const otherOnly = [{ sourceId: 'other', revisionId: 'r1', contentSha256: HASH_B }];
  assert.deepEqual(assessRecipeSourceFreshnessV1(value, otherOnly).drift, [
    { sourceId: 'github-main', reason: 'MISSING_SOURCE' },
  ]);
  assert.deepEqual(assessRecipeSourceFreshnessV1(value, []).drift, [
    { sourceId: 'github-main', reason: 'MISSING_SOURCE' },
  ]);
});

test('replay eligibility never upgrades non-promoted or failed candidates', () => {
  assert.throws(() => assertRecipeReplayEligibleV1(recipe({
    lifecycle: 'CANDIDATE',
    qualification: qualification('PASS'),
  }), [binding()]), /not PROMOTED/);

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    lifecycle: 'PROMOTED',
    qualification: qualification('FAIL'),
  })), /requires PASS/);
});
