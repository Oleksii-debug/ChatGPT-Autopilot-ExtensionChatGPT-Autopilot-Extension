import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSharedProjectRecipeCatalogV1,
  SHARED_PROJECT_RECIPE_CATALOG_SCHEMA_VERSION,
} from '../src/core/shared-project-recipe-catalog.js';
import {
  computeRecipeSubjectSha256V1,
  RecipeLifecycleState,
  RecipeQualificationStatus,
} from '../src/core/recipe-registry.js';
import {
  GovernancePrincipalKind,
  GovernancePrincipalStatus,
} from '../src/core/identity-governance.js';

const T0 = '2026-09-25T08:00:00.000Z';
const T1 = '2026-09-25T08:10:00.000Z';
const T2 = '2026-09-25T08:20:00.000Z';
const T3 = '2026-09-25T09:00:00.000Z';
const T4 = '2026-09-25T10:00:00.000Z';
const HASH = char => char.repeat(64);

function project() {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    revisionId: 'project-r1',
    title: 'Project A',
    sourceRefs: [],
    artifactRefs: [],
    createdAt: T0,
  };
}

function registryForIdentity(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'identity-registry-1',
    organizationId: 'org-1',
    revision: 3,
    principals: [
      {
        principalId: 'owner',
        organizationId: 'org-1',
        kind: GovernancePrincipalKind.USER,
        displayName: 'Owner',
        parentPrincipalId: '',
        status: GovernancePrincipalStatus.ACTIVE,
        createdAt: T0,
        revokedAt: '',
      },
      {
        principalId: 'agent-a',
        organizationId: 'org-1',
        kind: GovernancePrincipalKind.AGENT,
        displayName: 'Agent A',
        parentPrincipalId: 'owner',
        status: GovernancePrincipalStatus.ACTIVE,
        createdAt: T1,
        revokedAt: '',
      },
    ],
    roles: [
      {
        roleId: 'project-member',
        title: 'Project member',
        capabilityCeilingIds: ['project.read'],
        providerCeilingIds: ['recipe-registry'],
        outboundDataClassIds: ['internal'],
      },
    ],
    grants: [
      {
        grantId: 'grant-owner',
        principalId: 'owner',
        roleId: 'project-member',
        resourceKeys: ['project:project-a'],
        grantedByPrincipalId: 'owner',
        createdAt: T1,
        expiresAt: '',
        revokedAt: '',
      },
      {
        grantId: 'grant-agent',
        principalId: 'agent-a',
        roleId: 'project-member',
        resourceKeys: ['project:project-a'],
        grantedByPrincipalId: 'owner',
        createdAt: T2,
        expiresAt: '',
        revokedAt: '',
      },
    ],
    credentialOwnership: [],
    updatedAt: T4,
    ...overrides,
  };
}

function governanceRequest(overrides = {}) {
  return {
    projectSnapshot: project(),
    identityRegistry: registryForIdentity(),
    memberships: [
      {
        membershipId: 'm-owner',
        projectId: 'project-a',
        principalId: 'owner',
        invitedByPrincipalId: 'owner',
        joinedAt: T1,
        leftAt: '',
      },
      {
        membershipId: 'm-agent',
        projectId: 'project-a',
        principalId: 'agent-a',
        invitedByPrincipalId: 'owner',
        joinedAt: T2,
        leftAt: '',
      },
    ],
    auditEvents: [],
    evaluatedAt: T4,
    ...overrides,
  };
}

function recipeBase(recipeId = 'recipe-a', version = 1) {
  return {
    schemaVersion: 1,
    recipeId,
    version,
    parentVersion: version - 1,
    title: 'Verified recipe',
    description: 'A project-shareable verified procedure.',
    producerId: 'producer-a',
    lifecycle: RecipeLifecycleState.PROMOTED,
    sourceBindings: [
      {
        sourceId: 'source-a',
        revisionId: 'r1',
        contentSha256: HASH('a'),
      },
    ],
    steps: [
      {
        stepId: 'step-1',
        kind: 'DETERMINISTIC',
        title: 'Prepare evidence',
        dependsOn: [],
        providerId: '',
        toolId: '',
        requiredCapabilityIds: [],
        inputContractRef: '',
        outputContractRef: '',
        verificationContractRef: '',
      },
    ],
    qualification: {
      status: RecipeQualificationStatus.PASS,
      evaluationId: `evaluation-${recipeId}-${version}`,
      benchmarkSuiteId: 'suite-a',
      benchmarkSuiteRevision: 'suite-r1',
      verifierId: 'verifier-a',
      evidenceArtifactIds: ['evidence-a'],
      subjectSha256: HASH('f'),
      evaluatedAt: T3,
    },
    createdAt: T2,
  };
}

async function qualifiedRecipe(recipeId = 'recipe-a', version = 1) {
  const draft = recipeBase(recipeId, version);
  const subjectSha256 = await computeRecipeSubjectSha256V1(draft);
  return {
    ...draft,
    qualification: {
      ...draft.qualification,
      subjectSha256,
    },
  };
}

function trustedEvaluation(recipe) {
  return {
    verifierId: recipe.qualification.verifierId,
    report: {
      schemaVersion: 1,
      runId: recipe.qualification.evaluationId,
      suiteId: recipe.qualification.benchmarkSuiteId,
      suiteRevisionId: recipe.qualification.benchmarkSuiteRevision,
      subjectId: recipe.recipeId,
      subjectRevisionId: recipe.qualification.subjectSha256,
      startedAt: T2,
      completedAt: recipe.qualification.evaluatedAt,
      status: 'PASS',
      caseCount: 1,
      passedCaseCount: 1,
      failedCaseCount: 0,
      results: [
        {
          caseId: 'case-a',
          passed: true,
          evidenceArtifactIds: ['evidence-a'],
        },
      ],
    },
  };
}

function share(overrides = {}) {
  return {
    shareId: 'share-a',
    projectId: 'project-a',
    recipeId: 'recipe-a',
    version: 1,
    sharedByPrincipalId: 'owner',
    sharedAt: T3,
    revokedAt: '',
    ...overrides,
  };
}

async function request(overrides = {}) {
  const recipe = await qualifiedRecipe();
  return {
    projectGovernanceRequest: governanceRequest(),
    recipeRegistry: {
      schemaVersion: 1,
      registryId: 'recipe-registry-1',
      revision: 5,
      recipes: [recipe],
      updatedAt: T3,
    },
    trustedEvaluations: [trustedEvaluation(recipe)],
    shares: [share()],
    ...overrides,
  };
}

test('shared Project catalog exposes only trusted promoted recipes and grants no authority', async () => {
  const out = await buildSharedProjectRecipeCatalogV1(await request());

  assert.equal(out.schemaVersion, SHARED_PROJECT_RECIPE_CATALOG_SCHEMA_VERSION);
  assert.equal(out.projectId, 'project-a');
  assert.equal(out.projectRevisionId, 'project-r1');
  assert.equal(out.recipeRegistryId, 'recipe-registry-1');
  assert.equal(out.recipeRegistryRevision, 5);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].recipeId, 'recipe-a');
  assert.equal(out.items[0].version, 1);
  assert.equal(out.items[0].lifecycle, 'PROMOTED');
  assert.equal(out.items[0].qualificationStatus, 'PASS');
  assert.equal(out.items[0].admissionAuthorized, false);
  assert.equal(out.items[0].executionAuthorized, false);
  assert.equal(out.admissionAuthorized, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.requiresPolicyDecision, true);
  assert.equal(out.policyDecision, 'NONE');
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.items), true);
});

test('share must bind the exact current trusted promoted recipe version', async () => {
  const recipe1 = await qualifiedRecipe('recipe-a', 1);
  const recipe2Base = recipeBase('recipe-a', 2);
  recipe2Base.createdAt = T3;
  recipe2Base.qualification.evaluatedAt = T4;
  recipe2Base.qualification.evidenceArtifactIds = ['evidence-b'];
  const subjectSha256 = await computeRecipeSubjectSha256V1(recipe2Base);
  const recipe2 = {
    ...recipe2Base,
    qualification: { ...recipe2Base.qualification, subjectSha256 },
  };
  const trusted2 = trustedEvaluation(recipe2);
  trusted2.report.startedAt = T3;
  trusted2.report.results[0].evidenceArtifactIds = ['evidence-b'];

  const input = await request({
    recipeRegistry: {
      schemaVersion: 1,
      registryId: 'recipe-registry-1',
      revision: 6,
      recipes: [recipe1, recipe2],
      updatedAt: T4,
    },
    trustedEvaluations: [trustedEvaluation(recipe1), trusted2],
    shares: [share({ version: 1 })],
  });

  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(input),
    /does not bind current trusted PROMOTED version/,
  );
});

test('untrusted qualification evidence cannot make a shared recipe discoverable', async () => {
  const input = await request({ trustedEvaluations: [] });
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(input),
    /no trusted active PROMOTED version/,
  );
});

test('revoked share disappears at the exact revocation boundary', async () => {
  const input = await request({
    shares: [share({ revokedAt: T4 })],
  });
  const out = await buildSharedProjectRecipeCatalogV1(input);
  assert.deepEqual(out.items, []);
});

test('active share fails closed when sharer is no longer an active Project participant', async () => {
  const input = await request({
    projectGovernanceRequest: governanceRequest({
      memberships: [
        {
          membershipId: 'm-owner',
          projectId: 'project-a',
          principalId: 'owner',
          invitedByPrincipalId: 'owner',
          joinedAt: T1,
          leftAt: T4,
        },
      ],
    }),
  });
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(input),
    /no active Project participant sharer/,
  );
});

test('catalog rejects wrong Project binding, future share, duplicate active identity, and newer recipe truth', async () => {
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(await request({
      shares: [share({ projectId: 'project-b' })],
    })),
    /does not match shared Project governance/,
  );

  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(await request({
      shares: [share({ sharedAt: '2026-09-25T10:00:00.001Z' })],
    })),
    /later than Project evaluation time/,
  );

  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(await request({
      shares: [
        share({ shareId: 'share-a' }),
        share({ shareId: 'share-b' }),
      ],
    })),
    /multiple active shares expose the same recipe identity/,
  );

  const recipe = await qualifiedRecipe();
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(await request({
      recipeRegistry: {
        schemaVersion: 1,
        registryId: 'recipe-registry-1',
        revision: 6,
        recipes: [recipe],
        updatedAt: '2026-09-25T10:00:00.001Z',
      },
    })),
    /recipe registry is newer than Project governance evaluation time/,
  );
});

test('strict request/share boundaries reject getters, aliases, sparse arrays and hidden authority', async () => {
  const base = await request();
  let reads = 0;
  const getter = { ...base };
  Object.defineProperty(getter, 'shares', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return base.shares;
    },
  });
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(getter),
    /enumerable data properties only/,
  );
  assert.equal(reads, 0);

  await assert.rejects(
    buildSharedProjectRecipeCatalogV1({ ...base, executionAuthorized: true }),
    /unknown field/,
  );

  await assert.rejects(
    buildSharedProjectRecipeCatalogV1({
      ...base,
      shares: [share({ recipeId: ' recipe-a' })],
    }),
    /exact canonical identity representation/,
  );

  const sparse = new Array(2);
  sparse[0] = share();
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1({ ...base, shares: sparse }),
    /dense data-only array/,
  );

  const hidden = [...base.shares];
  Object.defineProperty(hidden, 'authority', { value: 'ALLOW', enumerable: false });
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1({ ...base, shares: hidden }),
    /non-index data/,
  );
});
