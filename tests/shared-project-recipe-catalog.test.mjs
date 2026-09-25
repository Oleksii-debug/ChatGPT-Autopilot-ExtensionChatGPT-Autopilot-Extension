import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSharedProjectRecipeCatalogV1,
  SHARED_PROJECT_RECIPE_CATALOG_SCHEMA_VERSION,
  SHARED_PROJECT_RECIPE_SHARE_CAPABILITY,
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

function identityRegistry({ agentCapability = true, revokeAgentAt = '' } = {}) {
  return {
    schemaVersion: 1,
    registryId: 'identity-registry-1',
    organizationId: 'org-1',
    revision: 4,
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
        status: revokeAgentAt ? GovernancePrincipalStatus.REVOKED : GovernancePrincipalStatus.ACTIVE,
        createdAt: T1,
        revokedAt: revokeAgentAt,
      },
    ],
    roles: [
      {
        roleId: 'role-owner',
        title: 'Project owner ceiling',
        capabilityCeilingIds: ['project.read', SHARED_PROJECT_RECIPE_SHARE_CAPABILITY],
        providerCeilingIds: ['recipe-registry'],
        outboundDataClassIds: ['internal'],
      },
      {
        roleId: 'role-agent',
        title: 'Project agent ceiling',
        capabilityCeilingIds: agentCapability
          ? ['project.read', SHARED_PROJECT_RECIPE_SHARE_CAPABILITY]
          : ['project.read'],
        providerCeilingIds: ['recipe-registry'],
        outboundDataClassIds: ['internal'],
      },
    ],
    grants: [
      {
        grantId: 'grant-owner',
        principalId: 'owner',
        roleId: 'role-owner',
        resourceKeys: ['project:project-a'],
        grantedByPrincipalId: 'owner',
        createdAt: T1,
        expiresAt: '',
        revokedAt: '',
      },
      {
        grantId: 'grant-agent',
        principalId: 'agent-a',
        roleId: 'role-agent',
        resourceKeys: ['project:project-a'],
        grantedByPrincipalId: 'owner',
        createdAt: T2,
        expiresAt: '',
        revokedAt: revokeAgentAt,
      },
    ],
    credentialOwnership: [],
    updatedAt: T4,
  };
}

function binding() {
  return {
    schemaVersion: 1,
    bindingId: 'shared-project-a',
    projectId: 'project-a',
    projectRevisionId: 'project-r1',
    organizationId: 'org-1',
    governanceRegistryId: 'identity-registry-1',
    governanceRegistryRevision: 4,
    ownerPrincipalId: 'owner',
    resourceKey: 'project:project-a',
    createdAt: T2,
  };
}

function trustedResolver({ registry = identityRegistry(), projectSnapshot = project(), projectBinding = binding() } = {}) {
  return {
    resolveSharedProjectBinding(requestedBindingId) {
      return requestedBindingId === projectBinding.bindingId ? projectBinding : null;
    },
    resolveProjectSnapshot({ projectId, projectRevisionId }) {
      return projectId === projectSnapshot.projectId
        && projectRevisionId === projectSnapshot.revisionId
        ? projectSnapshot
        : null;
    },
    resolveIdentityGovernanceRegistry({ governanceRegistryId, governanceRegistryRevision, organizationId }) {
      return governanceRegistryId === registry.registryId
        && governanceRegistryRevision === registry.revision
        && organizationId === registry.organizationId
        ? registry
        : null;
    },
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

async function qualifiedRecipe(recipeId = 'recipe-a', version = 1, overrides = {}) {
  const draft = { ...recipeBase(recipeId, version), ...overrides };
  const subjectSha256 = await computeRecipeSubjectSha256V1(draft);
  return {
    ...draft,
    qualification: {
      ...draft.qualification,
      subjectSha256,
    },
  };
}

function trustedEvaluation(recipe, evidenceArtifactId = 'evidence-a') {
  return {
    verifierId: recipe.qualification.verifierId,
    report: {
      schemaVersion: 1,
      runId: recipe.qualification.evaluationId,
      suiteId: recipe.qualification.benchmarkSuiteId,
      suiteRevisionId: recipe.qualification.benchmarkSuiteRevision,
      subjectId: recipe.recipeId,
      subjectRevisionId: recipe.qualification.subjectSha256,
      startedAt: recipe.createdAt,
      completedAt: recipe.qualification.evaluatedAt,
      status: 'PASS',
      caseCount: 1,
      passedCaseCount: 1,
      failedCaseCount: 0,
      results: [
        {
          caseId: `case-${recipe.recipeId}-${recipe.version}`,
          passed: true,
          evidenceArtifactIds: [evidenceArtifactId],
        },
      ],
    },
  };
}

function share(overrides = {}) {
  return {
    shareId: 'share-a',
    projectId: 'project-a',
    projectRevisionId: 'project-r1',
    recipeId: 'recipe-a',
    version: 1,
    sharedByPrincipalId: 'agent-a',
    sharedAt: T3,
    revokedAt: '',
    ...overrides,
  };
}

async function request(overrides = {}) {
  const recipe = await qualifiedRecipe();
  return {
    bindingId: 'shared-project-a',
    recipeRegistry: {
      schemaVersion: 1,
      registryId: 'recipe-registry-1',
      revision: 5,
      recipes: [recipe],
      updatedAt: T3,
    },
    trustedEvaluations: [trustedEvaluation(recipe)],
    shares: [share()],
    evaluatedAt: T4,
    ...overrides,
  };
}

test('shared Recipe catalog composes canonical Project access and grants no authority', async () => {
  const out = await buildSharedProjectRecipeCatalogV1(
    await request(),
    trustedResolver(),
  );

  assert.equal(out.schemaVersion, SHARED_PROJECT_RECIPE_CATALOG_SCHEMA_VERSION);
  assert.equal(out.bindingId, 'shared-project-a');
  assert.equal(out.projectId, 'project-a');
  assert.equal(out.projectRevisionId, 'project-r1');
  assert.equal(out.organizationId, 'org-1');
  assert.equal(out.governanceRegistryId, 'identity-registry-1');
  assert.equal(out.recipeRegistryId, 'recipe-registry-1');
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].recipeId, 'recipe-a');
  assert.equal(out.items[0].version, 1);
  assert.equal(out.items[0].requiredShareCapabilityId, SHARED_PROJECT_RECIPE_SHARE_CAPABILITY);
  assert.equal(out.items[0].lifecycle, 'PROMOTED');
  assert.equal(out.items[0].qualificationStatus, 'PASS');
  assert.equal(out.items[0].admissionAuthorized, false);
  assert.equal(out.items[0].executionAuthorized, false);
  assert.equal(out.items[0].mutationAuthorized, false);
  assert.equal(out.admissionAuthorized, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.mutationAuthorized, false);
  assert.equal(out.requiresCanonicalPolicyDecision, true);
  assert.equal(out.policyDecision, 'NONE');
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.items), true);
});

test('share creation fails closed when canonical Project ceiling lacks project.recipe.share', async () => {
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      await request(),
      trustedResolver({ registry: identityRegistry({ agentCapability: false }) }),
    ),
    /outside canonical Project recipe-share ceiling: CAPABILITY_OUTSIDE_CEILING/,
  );
});

test('active share fails closed when sharer is revoked after sharing', async () => {
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      await request(),
      trustedResolver({ registry: identityRegistry({ revokeAgentAt: T4 }) }),
    ),
    /active share .* outside canonical Project recipe-share ceiling: PRINCIPAL_INACTIVE/,
  );
});

test('revoked share remains canonical historical evidence but is absent from active catalog', async () => {
  const out = await buildSharedProjectRecipeCatalogV1(
    await request({
      shares: [share({ revokedAt: T4 })],
    }),
    trustedResolver({ registry: identityRegistry({ revokeAgentAt: T4 }) }),
  );

  assert.equal(out.projectId, 'project-a');
  assert.equal(out.projectRevisionId, 'project-r1');
  assert.deepEqual(out.items, []);
  assert.equal(out.executionAuthorized, false);
});

test('share must bind the exact current trusted promoted Recipe version', async () => {
  const recipe1 = await qualifiedRecipe('recipe-a', 1);
  const recipe2Base = recipeBase('recipe-a', 2);
  recipe2Base.createdAt = T3;
  recipe2Base.qualification = {
    ...recipe2Base.qualification,
    evidenceArtifactIds: ['evidence-b'],
    evaluatedAt: T4,
  };
  const recipe2 = await qualifiedRecipe('recipe-a', 2, recipe2Base);
  const trusted2 = trustedEvaluation(recipe2, 'evidence-b');

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
    buildSharedProjectRecipeCatalogV1(input, trustedResolver()),
    /does not bind current trusted PROMOTED version/,
  );
});

test('untrusted Recipe qualification cannot make a shared Recipe discoverable', async () => {
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      await request({ trustedEvaluations: [] }),
      trustedResolver(),
    ),
    /no trusted active PROMOTED version/,
  );
});

test('share must bind exact Project id and revision from canonical collaboration authority', async () => {
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      await request({ shares: [share({ projectId: 'project-b' })] }),
      trustedResolver(),
    ),
    /does not match canonical shared Project binding/,
  );

  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      await request({ shares: [share({ projectRevisionId: 'project-r2' })] }),
      trustedResolver(),
    ),
    /does not match canonical shared Project binding/,
  );
});

test('future sharing, duplicate active Recipe identity, and future Recipe registry fail closed', async () => {
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      await request({ shares: [share({ sharedAt: '2026-09-25T10:00:00.001Z' })] }),
      trustedResolver(),
    ),
    /later than catalog evaluation time/,
  );

  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      await request({
        shares: [
          share({ shareId: 'share-a' }),
          share({ shareId: 'share-b' }),
        ],
      }),
      trustedResolver(),
    ),
    /multiple active shares expose the same recipe identity/,
  );

  const recipe = await qualifiedRecipe();
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      await request({
        recipeRegistry: {
          schemaVersion: 1,
          registryId: 'recipe-registry-1',
          revision: 6,
          recipes: [recipe],
          updatedAt: '2026-09-25T10:00:00.001Z',
        },
      }),
      trustedResolver(),
    ),
    /recipe registry is newer than catalog evaluation time/,
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
    buildSharedProjectRecipeCatalogV1(getter, trustedResolver()),
    /enumerable data properties only/,
  );
  assert.equal(reads, 0);

  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      { ...base, executionAuthorized: true },
      trustedResolver(),
    ),
    /unknown field/,
  );

  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      { ...base, shares: [share({ recipeId: ' recipe-a' })] },
      trustedResolver(),
    ),
    /exact canonical identity representation/,
  );

  const sparse = new Array(2);
  sparse[0] = share();
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      { ...base, shares: sparse },
      trustedResolver(),
    ),
    /dense data-only array/,
  );

  const hidden = [...base.shares];
  Object.defineProperty(hidden, 'authority', { value: 'ALLOW', enumerable: false });
  await assert.rejects(
    buildSharedProjectRecipeCatalogV1(
      { ...base, shares: hidden },
      trustedResolver(),
    ),
    /non-index data/,
  );
});
