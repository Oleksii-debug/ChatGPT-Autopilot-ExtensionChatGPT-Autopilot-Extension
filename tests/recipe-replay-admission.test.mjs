import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RecipeParameterKind,
  compileRecipeCandidateV1,
} from '../src/core/recipe-compiler.js';
import {
  RecipeLifecycleState,
  RecipeQualificationStatus,
  computeRecipeSubjectSha256V1,
} from '../src/core/recipe-registry.js';
import {
  buildRecipeReplayAdmissionV1,
} from '../src/core/recipe-replay-admission.js';

const STARTED_AT = '2026-09-25T17:00:00.000Z';
const COMPLETED_AT = '2026-09-25T17:05:00.000Z';
const EVALUATED_AT = '2026-09-25T17:06:00.000Z';
const REQUESTED_AT = '2026-09-25T17:07:00.000Z';
const SOURCE_SHA = 'a'.repeat(64);
const EVIDENCE_A_SHA = 'b'.repeat(64);
const EVIDENCE_B_SHA = 'c'.repeat(64);

function compilerInput() {
  return {
    schemaVersion: 1,
    recipeId: 'recipe.replay-safe',
    version: 1,
    parentVersion: 0,
    sourceBindings: [{
      sourceId: 'github-main',
      revisionId: 'commit-22a30a7',
      contentSha256: SOURCE_SHA,
    }],
    parameters: [
      {
        parameterId: 'project-name',
        kind: RecipeParameterKind.OWNER_VALUE,
        required: true,
        sensitive: false,
      },
      {
        parameterId: 'credential',
        kind: RecipeParameterKind.CREDENTIAL_REF,
        required: true,
        sensitive: true,
      },
      {
        parameterId: 'optional-source',
        kind: RecipeParameterKind.SOURCE_REF,
        required: false,
        sensitive: false,
      },
    ],
    trace: {
      traceId: 'trace-replay-safe',
      jobId: 'job-replay-safe',
      planId: 'plan-replay-safe',
      producerId: 'agent-recipe-recorder',
      outcome: 'VERIFIED',
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      steps: [
        {
          stepId: 'inspect',
          kind: 'TOOL',
          dependsOn: [],
          providerId: 'github',
          toolId: 'github.read',
          requiredCapabilityIds: ['repo.read'],
          inputContractRef: 'contract.repo-query.v1',
          outputContractRef: 'contract.repo-snapshot.v1',
          verificationContractRef: 'contract.repo-read-verify.v1',
          parameterIds: ['project-name'],
          verificationEvidenceArtifactId: 'artifact-inspect-evidence',
          verificationEvidenceSha256: EVIDENCE_A_SHA,
          verifiedAt: '2026-09-25T17:03:00.000Z',
        },
        {
          stepId: 'publish-draft',
          kind: 'TOOL',
          dependsOn: ['inspect'],
          providerId: 'github',
          toolId: 'github.comment-draft',
          requiredCapabilityIds: ['repo.write'],
          inputContractRef: 'contract.comment-draft.v1',
          outputContractRef: 'contract.comment-result.v1',
          verificationContractRef: 'contract.comment-verify.v1',
          parameterIds: ['credential', 'optional-source'],
          verificationEvidenceArtifactId: 'artifact-publish-evidence',
          verificationEvidenceSha256: EVIDENCE_B_SHA,
          verifiedAt: COMPLETED_AT,
        },
      ],
    },
  };
}

async function fixture() {
  const proposal = await compileRecipeCandidateV1(compilerInput());
  const subjectSha256 = await computeRecipeSubjectSha256V1(proposal.recipeDefinition);
  const promoted = {
    ...proposal.recipeDefinition,
    lifecycle: RecipeLifecycleState.PROMOTED,
    qualification: {
      status: RecipeQualificationStatus.PASS,
      evaluationId: 'eval-recipe-replay-safe',
      benchmarkSuiteId: 'suite-recipe-replay',
      benchmarkSuiteRevision: 'suite-rev-1',
      verifierId: 'verifier-independent',
      evidenceArtifactIds: ['artifact-eval-recipe-replay'],
      subjectSha256,
      evaluatedAt: EVALUATED_AT,
    },
  };
  const trustedEvaluation = {
    verifierId: 'verifier-independent',
    report: {
      schemaVersion: 1,
      runId: 'eval-recipe-replay-safe',
      suiteId: 'suite-recipe-replay',
      suiteRevisionId: 'suite-rev-1',
      subjectId: promoted.recipeId,
      subjectRevisionId: subjectSha256,
      startedAt: COMPLETED_AT,
      completedAt: EVALUATED_AT,
      status: 'PASS',
      caseCount: 1,
      passedCaseCount: 1,
      failedCaseCount: 0,
      results: [{
        caseId: 'replay-safety',
        outcome: 'MEASURED',
        passed: true,
        reasonCode: '',
        metrics: { score: 1 },
        evidenceArtifactIds: ['artifact-eval-recipe-replay'],
        assertionResults: [],
      }],
    },
  };
  const registry = {
    schemaVersion: 1,
    registryId: 'recipe-registry-main',
    revision: 1,
    recipes: [promoted],
    updatedAt: EVALUATED_AT,
  };
  const currentSourceBindings = promoted.sourceBindings.map(binding => ({ ...binding }));
  const parameterRefs = [
    {
      parameterId: 'project-name',
      kind: RecipeParameterKind.OWNER_VALUE,
      referenceId: 'owner-value:project-name-1',
    },
    {
      parameterId: 'credential',
      kind: RecipeParameterKind.CREDENTIAL_REF,
      referenceId: 'credential-ref:github-account-main',
    },
  ];
  return {
    proposal,
    promoted,
    trustedEvaluation,
    registry,
    currentSourceBindings,
    parameterRefs,
  };
}

function request(fx, overrides = {}) {
  return {
    registry: fx.registry,
    recipeId: fx.promoted.recipeId,
    currentSourceBindings: fx.currentSourceBindings,
    trustedEvaluations: [fx.trustedEvaluation],
    compilerProposal: fx.proposal,
    parameterRefs: fx.parameterRefs,
    replayId: 'replay-1',
    requestedAt: REQUESTED_AT,
    ...overrides,
  };
}

test('admits exact promoted fresh recipe as a value-free non-authorizing replay blueprint', async () => {
  const fx = await fixture();
  const result = await buildRecipeReplayAdmissionV1(request(fx));

  assert.equal(result.replayAdmissionReady, true);
  assert.equal(result.recipeId, fx.promoted.recipeId);
  assert.equal(result.recipeVersion, 1);
  assert.equal(result.recipeSubjectSha256, fx.promoted.qualification.subjectSha256);
  assert.equal(result.parameterSchemaSha256, fx.proposal.parameterSchemaBinding.contentSha256);
  assert.deepEqual(result.requiredCapabilityIds, ['repo.read', 'repo.write']);
  assert.deepEqual(result.missingOptionalParameterIds, ['optional-source']);

  const inspect = result.steps.find(step => step.stepId === 'inspect');
  assert.deepEqual(inspect.parameterRefs, [{
    parameterId: 'project-name',
    kind: RecipeParameterKind.OWNER_VALUE,
    referenceId: 'owner-value:project-name-1',
    sensitive: false,
  }]);

  const publish = result.steps.find(step => step.stepId === 'publish-draft');
  assert.deepEqual(publish.parameterRefs, [{
    parameterId: 'credential',
    kind: RecipeParameterKind.CREDENTIAL_REF,
    referenceId: 'credential-ref:github-account-main',
    sensitive: true,
  }]);

  assert.equal(result.rawParameterValuesAccepted, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.permissionGranted, false);
  assert.equal(result.policyDecisionGranted, false);
  assert.equal(result.exactEffectAuthorized, false);
  assert.equal(result.requiresCanonicalReferenceResolution, true);
  assert.equal(result.requiresCanonicalPolicyDecision, true);
  assert.equal(result.requiresCanonicalAgentRuntime, true);
  assert.equal(result.requiresCanonicalExactEffect, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.steps), true);
});

test('rejects caller-only promotion, stale sources, and a request from before qualification', async () => {
  const fx = await fixture();

  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, { trustedEvaluations: [] })),
    /no active trusted PROMOTED version/,
  );

  const stale = fx.currentSourceBindings.map(binding => (
    binding.sourceId === 'github-main'
      ? { ...binding, revisionId: 'commit-stale' }
      : binding
  ));
  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, { currentSourceBindings: stale })),
    /recipe source binding is stale/,
  );

  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, {
      requestedAt: '2026-09-25T17:05:30.000Z',
    })),
    /predates trusted recipe qualification/,
  );
});

test('binds replay to exact compiler recipe subject and exact parameter schema bytes', async () => {
  const fx = await fixture();

  const subjectDrift = {
    ...fx.proposal,
    recipeDefinition: {
      ...fx.proposal.recipeDefinition,
      title: 'Mutated after trusted evaluation',
    },
  };
  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, { compilerProposal: subjectDrift })),
    /immutable recipe subject does not match promoted recipe/,
  );

  const schemaDrift = {
    ...fx.proposal,
    parameters: fx.proposal.parameters.map(parameter => (
      parameter.parameterId === 'project-name'
        ? { ...parameter, required: false }
        : { ...parameter }
    )),
  };
  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, { compilerProposal: schemaDrift })),
    /parameter schema binding does not match declared schema/,
  );

  const foreignBinding = {
    ...fx.proposal,
    parameterSchemaBinding: {
      ...fx.proposal.parameterSchemaBinding,
      sourceId: 'recipe-parameters:' + 'f'.repeat(32),
    },
  };
  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, { compilerProposal: foreignBinding })),
    /parameter schema binding does not match declared schema/,
  );
});

test('requires complete typed opaque references and rejects raw value aliases', async () => {
  const fx = await fixture();

  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, {
      parameterRefs: [fx.parameterRefs[0]],
    })),
    /required recipe parameter has no opaque reference: credential/,
  );

  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, {
      parameterRefs: [
        fx.parameterRefs[0],
        {
          ...fx.parameterRefs[1],
          kind: RecipeParameterKind.SOURCE_REF,
          referenceId: 'source-ref:not-a-credential',
        },
      ],
    })),
    /kind does not match declaration/,
  );

  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, {
      parameterRefs: [
        fx.parameterRefs[0],
        {
          ...fx.parameterRefs[1],
          referenceId: 'SECRET-LITERAL',
        },
      ],
    })),
    /opaque namespace/,
  );

  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, {
      parameterRefs: [
        fx.parameterRefs[0],
        {
          ...fx.parameterRefs[1],
          value: 'SECRET',
        },
      ],
    })),
    /unknown field: value/,
  );

  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, {
      parameterRefs: [
        ...fx.parameterRefs,
        {
          parameterId: 'undeclared',
          kind: RecipeParameterKind.OWNER_VALUE,
          referenceId: 'owner-value:undeclared',
        },
      ],
    })),
    /undeclared parameterId/,
  );
});

test('optional references may be admitted without changing recipe authority', async () => {
  const fx = await fixture();
  const result = await buildRecipeReplayAdmissionV1(request(fx, {
    parameterRefs: [
      ...fx.parameterRefs,
      {
        parameterId: 'optional-source',
        kind: RecipeParameterKind.SOURCE_REF,
        referenceId: 'source-ref:artifact-input-1',
      },
    ],
  }));

  assert.deepEqual(result.missingOptionalParameterIds, []);
  const publish = result.steps.find(step => step.stepId === 'publish-draft');
  assert.deepEqual(
    publish.parameterRefs.map(item => item.parameterId),
    ['credential', 'optional-source'],
  );
  assert.equal(result.executionAuthorized, false);
});

test('hostile descriptors and Proxy arrays execute zero ordinary getters', async () => {
  const fx = await fixture();

  let proposalGetterReads = 0;
  const hostileProposal = { ...fx.proposal };
  Object.defineProperty(hostileProposal, 'parameters', {
    enumerable: true,
    get() {
      proposalGetterReads += 1;
      throw new Error('proposal getter must not execute');
    },
  });
  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, { compilerProposal: hostileProposal })),
    /enumerable own data property/,
  );
  assert.equal(proposalGetterReads, 0);

  let arrayGets = 0;
  const proxiedRefs = new Proxy([...fx.parameterRefs], {
    get(target, property, receiver) {
      arrayGets += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = await buildRecipeReplayAdmissionV1(request(fx, {
    parameterRefs: proxiedRefs,
  }));
  assert.equal(result.replayAdmissionReady, true);
  assert.equal(arrayGets, 0);
});

test('compiler authority flags cannot be upgraded by caller-shaped proposal data', async () => {
  const fx = await fixture();
  const forged = {
    ...fx.proposal,
    executionAuthorized: true,
  };
  await assert.rejects(
    () => buildRecipeReplayAdmissionV1(request(fx, { compilerProposal: forged })),
    /executionAuthorized violates compiler authority fence/,
  );

  await assert.rejects(
    () => buildRecipeReplayAdmissionV1({
      ...request(fx),
      policyDecision: 'ALLOW',
    }),
    /unknown field: policyDecision/,
  );
});
