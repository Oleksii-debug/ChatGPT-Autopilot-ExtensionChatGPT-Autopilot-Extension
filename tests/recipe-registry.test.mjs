import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RecipeLifecycleState,
  RecipeQualificationStatus,
  RecipeFreshnessStatus,
  assertRecipeRegistryExtensionV1,
  assertRecipeReplayEligibleV1,
  assessRecipeSourceFreshnessV1,
  computeRecipeSubjectSha256V1,
  getCurrentRecipeVersionV1,
  normalizeRecipeDefinitionV1,
  normalizeRecipeRegistryV1,
  recipeRequiredCapabilityIdsV1,
  resolvePromotedRecipeV1,
  resolveReplayEligibleRecipeV1,
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

async function authorizedRecipe(overrides = {}) {
  const value = recipe(overrides);
  const subjectSha256 = await computeRecipeSubjectSha256V1(value);
  return {
    ...value,
    qualification: {
      ...value.qualification,
      subjectSha256,
    },
  };
}

function trustedEvaluationFor(value, overrides = {}) {
  const base = {
    verifierId: value.qualification.verifierId,
    report: {
      schemaVersion: 1,
      runId: value.qualification.evaluationId,
      suiteId: value.qualification.benchmarkSuiteId,
      suiteRevisionId: value.qualification.benchmarkSuiteRevision,
      subjectId: value.recipeId,
      subjectRevisionId: value.qualification.subjectSha256,
      startedAt: value.createdAt,
      completedAt: value.qualification.evaluatedAt,
      status: 'PASS',
      caseCount: 1,
      passedCaseCount: 1,
      failedCaseCount: 0,
      results: [{
        caseId: 'recipe-replay',
        outcome: 'MEASURED',
        passed: true,
        reasonCode: '',
        metrics: { score: 1 },
        evidenceArtifactIds: [...value.qualification.evidenceArtifactIds],
        assertionResults: [],
      }],
    },
  };
  return {
    ...base,
    ...overrides,
    report: {
      ...base.report,
      ...(overrides.report || {}),
    },
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

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    createdAt: '2026-09-24T22:22:00.000Z',
    qualification: qualification('PASS', { evaluatedAt: AT }),
  })), /cannot predate recipe creation/);
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
    qualification: qualification('PASS', { evaluatedAt: '2026-09-24T22:22:00.000Z' }),
    createdAt: '2026-09-24T22:22:00.000Z',
  });
  const value = normalizeRecipeRegistryV1(registry([v2, v1], {
    updatedAt: '2026-09-24T22:22:00.000Z',
  }));
  assert.deepEqual(value.recipes.map(item => item.version), [1, 2]);
  assert.equal(getCurrentRecipeVersionV1(value, v1.recipeId).version, 2);

  assert.throws(() => normalizeRecipeRegistryV1(registry([v2])), /must start at version 1/);
  assert.throws(() => normalizeRecipeRegistryV1(registry([v1, { ...v2, version: 3, parentVersion: 2 }])), /contiguous/);
  assert.throws(() => normalizeRecipeRegistryV1(registry([v1, { ...v1 }])), /duplicate version/);
  assert.throws(() => normalizeRecipeRegistryV1(registry([v1, v2], {
    updatedAt: '2026-09-24T22:21:30.000Z',
  })), /updatedAt predates recipe version/);
});

test('registry revision cannot contain qualification evidence from its future boundary', async () => {
  const future = await authorizedRecipe({
    qualification: qualification('PASS', {
      evaluatedAt: '2026-09-24T22:22:00.000Z',
    }),
  });
  const futureTrustedEvaluation = trustedEvaluationFor(future);
  assert.equal(futureTrustedEvaluation.report.completedAt, '2026-09-24T22:22:00.000Z');

  assert.throws(
    () => normalizeRecipeRegistryV1(registry([future], {
      updatedAt: AT,
    })),
    /updatedAt predates recipe qualification/,
  );

  const boundary = await authorizedRecipe({
    qualification: qualification('PASS', { evaluatedAt: AT }),
  });
  const boundaryRegistry = normalizeRecipeRegistryV1(registry([boundary], {
    updatedAt: AT,
  }));
  assert.equal(boundaryRegistry.recipes[0].qualification.evaluatedAt, AT);
  assert.equal(
    (await resolvePromotedRecipeV1(
      boundaryRegistry,
      boundary.recipeId,
      [trustedEvaluationFor(boundary)],
    )).version,
    1,
  );
});

test('registry extension is append-only and preserves existing version bytes', () => {
  const v1 = recipe({ lifecycle: 'CANDIDATE', qualification: qualification('PASS') });
  const before = registry([v1]);
  const v2 = recipe({
    version: 2,
    parentVersion: 1,
    title: 'Safe repository review v2',
    qualification: qualification('PASS', { evaluatedAt: '2026-09-24T22:22:00.000Z' }),
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

test('effective promotion requires exact trusted EVAL binding to immutable recipe content', async () => {
  const promoted = await authorizedRecipe();
  const trusted = trustedEvaluationFor(promoted);

  assert.equal(
    (await resolvePromotedRecipeV1(
      registry([promoted]),
      promoted.recipeId,
      [trusted],
    )).version,
    1,
  );

  const callerOnlyPass = recipe();
  assert.equal(
    await resolvePromotedRecipeV1(
      registry([callerOnlyPass]),
      callerOnlyPass.recipeId,
      [],
    ),
    null,
    'caller-owned PASS metadata is never promotion authority',
  );

  const mutated = { ...promoted, title: 'Mutated after evaluation' };
  await assert.rejects(
    () => resolvePromotedRecipeV1(
      registry([mutated]),
      mutated.recipeId,
      [trusted],
    ),
    /subjectSha256 does not match immutable recipe content/,
  );

  await assert.rejects(
    () => resolvePromotedRecipeV1(
      registry([promoted]),
      promoted.recipeId,
      [{ ...trusted, verifierId: 'verifier-other' }],
    ),
    /verifier does not match recipe qualification/,
  );

  await assert.rejects(
    () => resolvePromotedRecipeV1(
      registry([promoted]),
      promoted.recipeId,
      [trustedEvaluationFor(promoted, {
        report: { suiteRevisionId: 'suite-rev-other' },
      })],
    ),
    /suite identity does not match recipe qualification/,
  );

  await assert.rejects(
    () => resolvePromotedRecipeV1(
      registry([promoted]),
      promoted.recipeId,
      [trustedEvaluationFor(promoted, {
        report: {
          results: [{
            caseId: 'recipe-replay',
            outcome: 'MEASURED',
            passed: true,
            reasonCode: '',
            metrics: { score: 1 },
            evidenceArtifactIds: ['artifact-other'],
            assertionResults: [],
          }],
        },
      })],
    ),
    /evidence does not match recipe qualification/,
  );
});

test('retirement is a durable barrier until a newer version is explicitly re-promoted', async () => {
  const promoted = await authorizedRecipe();
  const trustedV1 = trustedEvaluationFor(promoted);
  const candidate = recipe({
    version: 2,
    parentVersion: 1,
    lifecycle: 'CANDIDATE',
    qualification: qualification('FAIL', { evaluatedAt: '2026-09-24T22:22:00.000Z' }),
    createdAt: '2026-09-24T22:22:00.000Z',
  });
  const withCandidate = registry([promoted, candidate], {
    updatedAt: '2026-09-24T22:22:00.000Z',
  });
  assert.equal(
    (await resolvePromotedRecipeV1(withCandidate, promoted.recipeId, [trustedV1])).version,
    1,
  );
  assert.equal(
    (await resolveReplayEligibleRecipeV1(
      withCandidate,
      promoted.recipeId,
      [binding()],
      [trustedV1],
    )).version,
    1,
  );

  const retired = recipe({
    version: 3,
    parentVersion: 2,
    lifecycle: 'RETIRED',
    qualification: qualification('UNQUALIFIED'),
    createdAt: '2026-09-24T22:23:00.000Z',
  });
  const candidateAfterRetirement = recipe({
    version: 4,
    parentVersion: 3,
    lifecycle: 'CANDIDATE',
    qualification: qualification('FAIL', { evaluatedAt: '2026-09-24T22:24:00.000Z' }),
    createdAt: '2026-09-24T22:24:00.000Z',
  });
  const retiredRegistry = registry([promoted, candidate, retired, candidateAfterRetirement], {
    updatedAt: '2026-09-24T22:24:00.000Z',
  });
  assert.equal(
    await resolvePromotedRecipeV1(retiredRegistry, promoted.recipeId, [trustedV1]),
    null,
    'PROMOTED v1 must not resurrect through RETIRED v3 when v4 is only a candidate',
  );
  await assert.rejects(
    () => resolveReplayEligibleRecipeV1(
      retiredRegistry,
      promoted.recipeId,
      [binding()],
      [trustedV1],
    ),
    /no active trusted PROMOTED/,
  );

  const rePromoted = await authorizedRecipe({
    version: 5,
    parentVersion: 4,
    title: 'Safe repository review v5',
    qualification: qualification('PASS', {
      evaluationId: 'eval-5',
      evaluatedAt: '2026-09-24T22:25:00.000Z',
    }),
    createdAt: '2026-09-24T22:25:00.000Z',
  });
  const trustedV5 = trustedEvaluationFor(rePromoted);
  const reactivated = registry(
    [promoted, candidate, retired, candidateAfterRetirement, rePromoted],
    {
      updatedAt: '2026-09-24T22:25:00.000Z',
    },
  );
  assert.equal(
    (await resolvePromotedRecipeV1(
      reactivated,
      promoted.recipeId,
      [trustedV1, trustedV5],
    )).version,
    5,
  );
});

test('source drift is explicit and replay eligibility fails closed on missing/revised/substituted bytes', async () => {
  const value = await authorizedRecipe();
  const trusted = trustedEvaluationFor(value);
  assert.equal(assessRecipeSourceFreshnessV1(value, [binding()]).status, RecipeFreshnessStatus.FRESH);
  assert.equal(
    (await assertRecipeReplayEligibleV1(value, [binding()], trusted)).recipeId,
    value.recipeId,
  );

  let report = assessRecipeSourceFreshnessV1(value, [binding({ revisionId: 'commit-new' })]);
  assert.equal(report.status, 'STALE');
  assert.deepEqual(report.drift, [{ sourceId: 'github-main', reason: 'REVISION_CHANGED' }]);
  await assert.rejects(
    () => assertRecipeReplayEligibleV1(
      value,
      [binding({ revisionId: 'commit-new' })],
      trusted,
    ),
    /REVISION_CHANGED/,
  );

  report = assessRecipeSourceFreshnessV1(value, [binding({ contentSha256: HASH_B })]);
  assert.deepEqual(report.drift, [{ sourceId: 'github-main', reason: 'CONTENT_CHANGED' }]);
  await assert.rejects(
    () => assertRecipeReplayEligibleV1(
      value,
      [binding({ contentSha256: HASH_B })],
      trusted,
    ),
    /CONTENT_CHANGED/,
  );

  const otherOnly = [{ sourceId: 'other', revisionId: 'r1', contentSha256: HASH_B }];
  assert.deepEqual(assessRecipeSourceFreshnessV1(value, otherOnly).drift, [
    { sourceId: 'github-main', reason: 'MISSING_SOURCE' },
  ]);
  assert.deepEqual(assessRecipeSourceFreshnessV1(value, []).drift, [
    { sourceId: 'github-main', reason: 'MISSING_SOURCE' },
  ]);
});

test('replay eligibility never upgrades non-promoted or failed candidates', async () => {
  await assert.rejects(
    () => assertRecipeReplayEligibleV1(
      recipe({
        lifecycle: 'CANDIDATE',
        qualification: qualification('PASS'),
      }),
      [binding()],
      null,
    ),
    /not PROMOTED/,
  );

  assert.throws(() => normalizeRecipeDefinitionV1(recipe({
    lifecycle: 'PROMOTED',
    qualification: qualification('FAIL'),
  })), /requires PASS/);
});
