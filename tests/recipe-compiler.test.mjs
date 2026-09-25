import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RecipeParameterKind,
  compileRecipeCandidateV1,
} from '../src/core/recipe-compiler.js';
import { normalizeRecipeDefinitionV1 } from '../src/core/recipe-registry.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

function sourceBindings() {
  return [
    { sourceId: 'source-b', revisionId: 'rev-b1', contentSha256: SHA_B },
    { sourceId: 'source-a', revisionId: 'rev-a1', contentSha256: SHA_A },
  ];
}

function parameters() {
  return [
    {
      parameterId: 'credential.github',
      kind: RecipeParameterKind.CREDENTIAL_REF,
      required: true,
      sensitive: true,
    },
    {
      parameterId: 'owner.target',
      kind: RecipeParameterKind.OWNER_VALUE,
      required: true,
      sensitive: false,
    },
  ];
}

function steps() {
  return [
    {
      stepId: 'step.fetch',
      kind: 'TOOL',
      dependsOn: [],
      providerId: 'github',
      toolId: 'repo.fetch',
      requiredCapabilityIds: ['repo.read'],
      inputContractRef: 'contract.fetch.input.v1',
      outputContractRef: 'contract.fetch.output.v1',
      verificationContractRef: 'contract.fetch.verify.v1',
      parameterIds: ['owner.target', 'credential.github'],
      verificationEvidenceArtifactId: 'evidence-fetch-1',
      verificationEvidenceSha256: SHA_C,
      verifiedAt: '2026-09-25T06:10:10.000Z',
    },
    {
      stepId: 'step.summarize',
      kind: 'DETERMINISTIC',
      dependsOn: ['step.fetch'],
      providerId: '',
      toolId: '',
      requiredCapabilityIds: [],
      inputContractRef: 'contract.summary.input.v1',
      outputContractRef: 'contract.summary.output.v1',
      verificationContractRef: 'contract.summary.verify.v1',
      parameterIds: [],
      verificationEvidenceArtifactId: 'evidence-summary-1',
      verificationEvidenceSha256: SHA_D,
      verifiedAt: '2026-09-25T06:10:20.000Z',
    },
  ];
}

function trace(overrides = {}) {
  return {
    traceId: 'trace-1',
    jobId: 'job-1',
    planId: 'plan-1',
    producerId: 'agent-1',
    outcome: 'VERIFIED',
    startedAt: '2026-09-25T06:10:00.000Z',
    completedAt: '2026-09-25T06:10:30.000Z',
    steps: steps(),
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    schemaVersion: 1,
    recipeId: 'recipe.repo-review',
    version: 1,
    parentVersion: 0,
    sourceBindings: sourceBindings(),
    parameters: parameters(),
    trace: trace(),
    ...overrides,
  };
}

test('compiles a registry-compatible value-free CANDIDATE without granting authority', () => {
  const compiled = compileRecipeCandidateV1(input());
  assert.equal(compiled.schemaVersion, 1);
  assert.equal(compiled.proposalId, 'recipe-candidate:trace-1');
  assert.equal(compiled.recipeDefinition.lifecycle, 'CANDIDATE');
  assert.equal(compiled.recipeDefinition.qualification.status, 'UNQUALIFIED');
  assert.equal(compiled.recipeDefinition.producerId, 'agent-1');
  assert.equal(compiled.recipeDefinition.createdAt, '2026-09-25T06:10:30.000Z');

  assert.deepEqual(
    compiled.recipeDefinition.sourceBindings.map(item => item.sourceId),
    ['source-a', 'source-b'],
  );
  assert.deepEqual(
    compiled.parameters.map(item => item.parameterId),
    ['credential.github', 'owner.target'],
  );
  assert.deepEqual(compiled.parameterBindings, [{
    stepId: 'step.fetch',
    parameterIds: ['credential.github', 'owner.target'],
  }]);
  assert.deepEqual(
    compiled.verificationEvidence.map(item => [
      item.stepId,
      item.evidenceArtifactId,
    ]),
    [
      ['step.fetch', 'evidence-fetch-1'],
      ['step.summarize', 'evidence-summary-1'],
    ],
  );

  assert.equal(compiled.traceTrust, 'UNVERIFIED_INPUT');
  assert.equal(compiled.evidenceTrust, 'UNVERIFIED_INPUT');
  assert.equal(compiled.rawContentAccepted, false);
  assert.equal(compiled.parameterValuesAccepted, false);
  assert.equal(compiled.registryAdmissionAuthorized, false);
  assert.equal(compiled.replayAuthorized, false);
  assert.equal(compiled.promotionAuthorized, false);
  assert.equal(compiled.executionAuthorized, false);
  assert.equal(compiled.permissionGranted, false);
  assert.equal(compiled.requiresCanonicalRecipeRegistry, true);
  assert.equal(compiled.requiresCanonicalTraceResolution, true);
  assert.equal(compiled.requiresCanonicalEvidenceResolution, true);
  assert.equal(compiled.requiresTrustedReplayEvaluation, true);
  assert.equal(compiled.requiresSecretScan, true);

  assert.deepEqual(
    normalizeRecipeDefinitionV1(compiled.recipeDefinition),
    compiled.recipeDefinition,
  );
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.parameters), true);
  assert.equal(Object.isFrozen(compiled.recipeDefinition), true);

  const serialized = JSON.stringify(compiled);
  assert.doesNotMatch(serialized, /Bearer|token=|promptText|rawOutput|toolArguments/u);
});

test('compiler accepts only a declared VERIFIED trace and never upgrades its trust', () => {
  for (const outcome of ['FAILED', 'PARTIAL', '', true]) {
    assert.throws(
      () => compileRecipeCandidateV1(input({ trace: trace({ outcome }) })),
      /outcome must be VERIFIED/u,
    );
  }
  const compiled = compileRecipeCandidateV1(input());
  assert.equal(compiled.trace.outcome, 'VERIFIED');
  assert.equal(compiled.traceTrust, 'UNVERIFIED_INPUT');
  assert.equal(compiled.promotionAuthorized, false);
});

test('raw prompt, arguments, outputs, credentials and parameter values are outside the accepted schema', () => {
  const withRawPrompt = input();
  withRawPrompt.trace.rawPrompt = 'SECRET prompt';
  assert.throws(() => compileRecipeCandidateV1(withRawPrompt), /unknown field: rawPrompt/u);

  const withArgs = input();
  withArgs.trace.steps[0].toolArguments = { token: 'SECRET' };
  assert.throws(() => compileRecipeCandidateV1(withArgs), /unknown field: toolArguments/u);

  const withOutput = input();
  withOutput.trace.steps[0].rawOutput = 'SECRET output';
  assert.throws(() => compileRecipeCandidateV1(withOutput), /unknown field: rawOutput/u);

  const withParameterValue = input();
  withParameterValue.parameters[0].value = 'ghp_SECRET';
  assert.throws(() => compileRecipeCandidateV1(withParameterValue), /unknown field: value/u);
});

test('credential parameters are value-free and must remain explicitly sensitive', () => {
  const unsafe = input();
  unsafe.parameters[0].sensitive = false;
  assert.throws(() => compileRecipeCandidateV1(unsafe), /CREDENTIAL_REF must be sensitive/u);

  const unknownKind = input();
  unknownKind.parameters[0].kind = 'PASSWORD';
  assert.throws(() => compileRecipeCandidateV1(unknownKind), /kind is invalid/u);
});

test('every declared parameter must be used and every step binding must resolve', () => {
  const undeclared = input();
  undeclared.trace.steps[0].parameterIds.push('missing.parameter');
  assert.throws(() => compileRecipeCandidateV1(undeclared), /undeclared parameterId/u);

  const unused = input();
  unused.parameters.push({
    parameterId: 'owner.unused',
    kind: RecipeParameterKind.OWNER_VALUE,
    required: false,
    sensitive: false,
  });
  assert.throws(() => compileRecipeCandidateV1(unused), /not bound to any trace step/u);

  const duplicate = input();
  duplicate.parameters.push({ ...duplicate.parameters[1] });
  assert.throws(() => compileRecipeCandidateV1(duplicate), /duplicate parameterId/u);
});

test('trace step graph fails closed on dangling dependencies, cycles and duplicate IDs', () => {
  const dangling = input();
  dangling.trace.steps[1].dependsOn = ['missing.step'];
  assert.throws(() => compileRecipeCandidateV1(dangling), /depends on unknown step/u);

  const cycle = input();
  cycle.trace.steps[0].dependsOn = ['step.summarize'];
  assert.throws(() => compileRecipeCandidateV1(cycle), /dependency cycle/u);

  const duplicate = input();
  duplicate.trace.steps[1].stepId = 'step.fetch';
  assert.throws(() => compileRecipeCandidateV1(duplicate), /duplicate stepId/u);
});

test('step kind semantics reuse RecipeRegistry rules rather than minting tool authority', () => {
  const deterministicWithTool = input();
  deterministicWithTool.trace.steps[1].providerId = 'github';
  deterministicWithTool.trace.steps[1].toolId = 'repo.fetch';
  deterministicWithTool.trace.steps[1].requiredCapabilityIds = ['repo.read'];
  assert.throws(
    () => compileRecipeCandidateV1(deterministicWithTool),
    /deterministic step cannot declare provider\/tool capabilities/u,
  );

  const toolWithoutCapability = input();
  toolWithoutCapability.trace.steps[0].requiredCapabilityIds = [];
  assert.throws(
    () => compileRecipeCandidateV1(toolWithoutCapability),
    /tool step requires provider, tool and capabilities/u,
  );
});

test('replay contracts and evidence artifact identity are mandatory for every recorded step', () => {
  const noVerifyContract = input();
  noVerifyContract.trace.steps[0].verificationContractRef = '';
  assert.throws(() => compileRecipeCandidateV1(noVerifyContract), /verificationContractRef is invalid/u);

  const noInputContract = input();
  noInputContract.trace.steps[0].inputContractRef = '';
  assert.throws(() => compileRecipeCandidateV1(noInputContract), /inputContractRef is invalid/u);

  const noEvidenceArtifact = input();
  noEvidenceArtifact.trace.steps[0].verificationEvidenceArtifactId = '';
  assert.throws(() => compileRecipeCandidateV1(noEvidenceArtifact), /verificationEvidenceArtifactId is invalid/u);
});

test('trace evidence timestamps and hashes are causally and canonically bound', () => {
  const beforeRun = input();
  beforeRun.trace.steps[0].verifiedAt = '2026-09-25T06:09:59.000Z';
  assert.throws(() => compileRecipeCandidateV1(beforeRun), /outside the trace interval/u);

  const afterRun = input();
  afterRun.trace.steps[1].verifiedAt = '2026-09-25T06:10:31.000Z';
  assert.throws(() => compileRecipeCandidateV1(afterRun), /outside the trace interval/u);

  const backwards = input({ trace: trace({
    startedAt: '2026-09-25T06:10:31.000Z',
    completedAt: '2026-09-25T06:10:30.000Z',
  }) });
  assert.throws(() => compileRecipeCandidateV1(backwards), /cannot predate startedAt/u);

  const uppercaseHash = input();
  uppercaseHash.trace.steps[0].verificationEvidenceSha256 = 'C'.repeat(64);
  assert.throws(() => compileRecipeCandidateV1(uppercaseHash), /lowercase SHA-256/u);
});

test('candidate version lineage is validated by the canonical RecipeRegistry contract', () => {
  assert.throws(
    () => compileRecipeCandidateV1(input({ version: 2, parentVersion: 0 })),
    /parentVersion/u,
  );
  assert.throws(
    () => compileRecipeCandidateV1(input({ version: 1, parentVersion: 1 })),
    /parentVersion/u,
  );
});

test('source bindings are exact, unique, deterministic revision identities', () => {
  const duplicate = input();
  duplicate.sourceBindings.push({
    sourceId: 'source-a',
    revisionId: 'other',
    contentSha256: SHA_D,
  });
  assert.throws(() => compileRecipeCandidateV1(duplicate), /duplicate sourceId/u);

  const badDigest = input();
  badDigest.sourceBindings[0].contentSha256 = 'B'.repeat(64);
  assert.throws(() => compileRecipeCandidateV1(badDigest), /lowercase SHA-256/u);
});

test('strict boundary rejects accessors without executing getters', () => {
  let reads = 0;
  const hostile = input();
  Object.defineProperty(hostile, 'recipeId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'recipe.pwned';
    },
  });
  assert.throws(
    () => compileRecipeCandidateV1(hostile),
    /enumerable own data properties/u,
  );
  assert.equal(reads, 0);

  const hostileStep = input();
  Object.defineProperty(hostileStep.trace.steps[0], 'toolId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'repo.delete';
    },
  });
  assert.throws(
    () => compileRecipeCandidateV1(hostileStep),
    /enumerable own data properties/u,
  );
  assert.equal(reads, 0);
});

test('strict boundary rejects hidden/symbol/exotic records and sparse/side arrays', () => {
  const hidden = input();
  Object.defineProperty(hidden, 'authority', {
    enumerable: false,
    configurable: true,
    value: 'ALLOW',
  });
  assert.throws(() => compileRecipeCandidateV1(hidden), /enumerable own data properties/u);

  const symbolic = input();
  symbolic[Symbol('authority')] = 'ALLOW';
  assert.throws(() => compileRecipeCandidateV1(symbolic), /symbol fields/u);

  const exotic = Object.assign(Object.create({ permissionGranted: true }), input());
  assert.throws(() => compileRecipeCandidateV1(exotic), /plain object/u);

  const sparse = input();
  sparse.trace.steps = new Array(1);
  assert.throws(() => compileRecipeCandidateV1(sparse), /must not be sparse/u);

  const side = input();
  side.parameters.extraAuthority = true;
  assert.throws(() => compileRecipeCandidateV1(side), /non-index array data/u);
});

test('canonical ordering is independent from caller ordering', () => {
  const left = compileRecipeCandidateV1(input());

  const rightInput = input();
  rightInput.sourceBindings.reverse();
  rightInput.parameters.reverse();
  rightInput.trace.steps[0].parameterIds.reverse();
  const right = compileRecipeCandidateV1(rightInput);

  assert.deepEqual(left.recipeDefinition.sourceBindings, right.recipeDefinition.sourceBindings);
  assert.deepEqual(left.parameters, right.parameters);
  assert.deepEqual(left.parameterBindings, right.parameterBindings);
});
