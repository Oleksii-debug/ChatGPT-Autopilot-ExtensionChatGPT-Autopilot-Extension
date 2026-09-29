import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RecipeCandidateAdmissionStatus,
  admitTrustedRecipeCandidateV1,
} from '../src/core/recipe-candidate-admission.js';
import {
  RecipeParameterKind,
  compileRecipeCandidateV1,
} from '../src/core/recipe-compiler.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

function sourceBindings() {
  return [
    { sourceId: 'source-a', revisionId: 'rev-a1', contentSha256: SHA_A },
    { sourceId: 'source-b', revisionId: 'rev-b1', contentSha256: SHA_B },
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

function compilerInput(overrides = {}) {
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

function emptyRegistry(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'recipe-registry-main',
    revision: 1,
    recipes: [],
    updatedAt: '2026-09-25T06:00:00.000Z',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    admissionId: 'recipe-admission-1',
    expectedRegistryId: 'recipe-registry-main',
    expectedRegistryRevision: 1,
    compilerInput: compilerInput(),
    admittedAt: '2026-09-25T06:12:00.000Z',
    ...overrides,
  };
}

function artifactForLookup(lookup, overrides = {}) {
  const sha256 = lookup.evidenceArtifactId === 'evidence-fetch-1' ? SHA_C : SHA_D;
  return {
    schemaVersion: 1,
    artifactId: lookup.evidenceArtifactId,
    kind: 'verification-evidence',
    uri: 'artifact://recipe-evidence/' + lookup.evidenceArtifactId,
    mediaType: 'application/json',
    sha256,
    sizeBytes: 128,
    createdAt: '2026-09-25T06:10:05.000Z',
    producerInvocationId: 'verification-invocation-1',
    sensitive: false,
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    recipeRegistry: emptyRegistry(),
    resolveTrustedRecipeTrace: async () => trace(),
    resolveTrustedEvidenceArtifact: async lookup => artifactForLookup(lookup),
    resolveTrustedSecretScan: async lookup => ({
      schemaVersion: 1,
      scanId: 'secret-scan-1',
      scannerId: 'secret-scanner-1',
      subjectSha256: lookup.subjectSha256,
      status: 'PASS',
      findingCount: 0,
      scannedAt: '2026-09-25T06:11:00.000Z',
    }),
    ...overrides,
  };
}

test('admits an independently bound compiler candidate as one exact registry extension without execution authority', async () => {
  const lookups = { trace: [], evidence: [], scan: [] };
  const result = await admitTrustedRecipeCandidateV1(request(), options({
    resolveTrustedRecipeTrace: async lookup => {
      lookups.trace.push(lookup);
      return trace();
    },
    resolveTrustedEvidenceArtifact: async lookup => {
      lookups.evidence.push(lookup);
      return artifactForLookup(lookup);
    },
    resolveTrustedSecretScan: async lookup => {
      lookups.scan.push(lookup);
      return {
        schemaVersion: 1,
        scanId: 'secret-scan-1',
        scannerId: 'secret-scanner-1',
        subjectSha256: lookup.subjectSha256,
        status: 'PASS',
        findingCount: 0,
        scannedAt: '2026-09-25T06:11:00.000Z',
      };
    },
  }));

  assert.equal(result.status, RecipeCandidateAdmissionStatus.CANDIDATE_ADMITTED);
  assert.equal(result.previousRegistryRevision, 1);
  assert.equal(result.nextRegistryRevision, 2);
  assert.equal(result.nextRegistry.revision, 2);
  assert.equal(result.nextRegistry.recipes.length, 1);
  assert.equal(result.recipeDefinition.lifecycle, 'CANDIDATE');
  assert.equal(result.recipeDefinition.qualification.status, 'UNQUALIFIED');
  assert.match(result.subjectSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.traceBindingSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.parameterSchemaSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.traceTrust, 'TRUSTED_RESOLVER');
  assert.equal(result.evidenceTrust, 'TRUSTED_ARTIFACT_REFS');
  assert.equal(result.secretScanTrust, 'TRUSTED_RESOLVER');
  assert.equal(result.registryAdmissionAuthorized, true);
  assert.equal(result.replayAuthorized, false);
  assert.equal(result.promotionAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.permissionGranted, false);
  assert.equal(result.policyDecisionGranted, false);
  assert.equal(result.exactEffectAuthorized, false);
  assert.equal(result.requiresTrustedReplayEvaluation, true);
  assert.equal(result.requiresCanonicalPolicyDecision, true);
  assert.equal(result.requiresCanonicalExactEffect, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.nextRegistry), true);

  assert.equal(lookups.trace.length, 1);
  assert.equal(lookups.trace[0].traceId, 'trace-1');
  assert.equal(lookups.trace[0].jobId, 'job-1');
  assert.equal(lookups.trace[0].planId, 'plan-1');
  assert.match(lookups.trace[0].traceBindingSha256, /^[a-f0-9]{64}$/u);
  assert.equal(lookups.evidence.length, 2);
  assert.equal(lookups.scan.length, 1);
  assert.deepEqual(lookups.scan[0].recipeDefinition, result.recipeDefinition);

  const serializedLookups = JSON.stringify(lookups);
  assert.doesNotMatch(serializedLookups, /Bearer|ghp_|toolArguments|rawOutput|promptText/u);
});

test('stale or foreign registry expectation fails before any trusted resolver is invoked', async () => {
  let calls = 0;
  const deps = options({
    resolveTrustedRecipeTrace: async () => {
      calls += 1;
      return trace();
    },
    resolveTrustedEvidenceArtifact: async lookup => {
      calls += 1;
      return artifactForLookup(lookup);
    },
    resolveTrustedSecretScan: async lookup => {
      calls += 1;
      return {
        schemaVersion: 1,
        scanId: 'secret-scan-1',
        scannerId: 'secret-scanner-1',
        subjectSha256: lookup.subjectSha256,
        status: 'PASS',
        findingCount: 0,
        scannedAt: '2026-09-25T06:11:00.000Z',
      };
    },
  });

  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request({ expectedRegistryRevision: 2 }),
      deps,
    ),
    /expectedRegistryRevision is stale or mismatched/u,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request({ expectedRegistryId: 'foreign-registry' }),
      deps,
    ),
    /expectedRegistryId does not match canonical registry/u,
  );
  assert.equal(calls, 0);
});

test('caller-declared VERIFIED is insufficient when trusted trace content differs', async () => {
  const changed = trace();
  changed.steps[0].verificationEvidenceSha256 = SHA_D;

  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request(),
      options({ resolveTrustedRecipeTrace: async () => changed }),
    ),
    /Trusted Recipe trace digest does not match compiler trace/u,
  );
});

test('trusted trace resolver output remains descriptor-safe and cannot smuggle authority', async () => {
  let reads = 0;
  const hostile = trace();
  Object.defineProperty(hostile, 'outcome', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'VERIFIED';
    },
  });

  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request(),
      options({ resolveTrustedRecipeTrace: async () => hostile }),
    ),
    /enumerable own data properties/u,
  );
  assert.equal(reads, 0);

  const aliased = trace();
  aliased.permissionGranted = true;
  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request(),
      options({ resolveTrustedRecipeTrace: async () => aliased }),
    ),
    /unknown field: permissionGranted/u,
  );
});

test('every evidence ArtifactRef must exact-match trusted artifact identity, bytes and chronology', async () => {
  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request(),
      options({
        resolveTrustedEvidenceArtifact: async lookup =>
          artifactForLookup(lookup, { artifactId: 'evidence-substituted' }),
      }),
    ),
    /evidence artifactId mismatch/u,
  );

  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request(),
      options({
        resolveTrustedEvidenceArtifact: async lookup =>
          artifactForLookup(lookup, { sha256: SHA_A }),
      }),
    ),
    /evidence SHA-256 mismatch/u,
  );

  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request(),
      options({
        resolveTrustedEvidenceArtifact: async lookup =>
          artifactForLookup(lookup, { createdAt: '2026-09-25T06:10:25.000Z' }),
      }),
    ),
    /evidence postdates verification/u,
  );
});

test('secret scan is exact-subject, clean, independent and causal', async () => {
  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request(),
      options({
        resolveTrustedSecretScan: async () => ({
          schemaVersion: 1,
          scanId: 'secret-scan-1',
          scannerId: 'secret-scanner-1',
          subjectSha256: SHA_A,
          status: 'PASS',
          findingCount: 0,
          scannedAt: '2026-09-25T06:11:00.000Z',
        }),
      }),
    ),
    /secret scan subject digest mismatch/u,
  );

  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request(),
      options({
        resolveTrustedSecretScan: async lookup => ({
          schemaVersion: 1,
          scanId: 'secret-scan-1',
          scannerId: 'agent-1',
          subjectSha256: lookup.subjectSha256,
          status: 'PASS',
          findingCount: 0,
          scannedAt: '2026-09-25T06:11:00.000Z',
        }),
      }),
    ),
    /must be independent from recipe producer/u,
  );

  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request(),
      options({
        resolveTrustedSecretScan: async lookup => ({
          schemaVersion: 1,
          scanId: 'secret-scan-1',
          scannerId: 'secret-scanner-1',
          subjectSha256: lookup.subjectSha256,
          status: 'PASS',
          findingCount: 1,
          scannedAt: '2026-09-25T06:11:00.000Z',
        }),
      }),
    ),
    /PASS cannot contain findings/u,
  );

  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request(),
      options({
        resolveTrustedSecretScan: async lookup => ({
          schemaVersion: 1,
          scanId: 'secret-scan-1',
          scannerId: 'secret-scanner-1',
          subjectSha256: lookup.subjectSha256,
          status: 'FAIL',
          findingCount: 1,
          scannedAt: '2026-09-25T06:11:00.000Z',
        }),
      }),
    ),
    /did not PASS/u,
  );
});

test('candidate must append exactly one version to the current immutable Recipe lineage', async () => {
  const version1 = await compileRecipeCandidateV1(compilerInput());
  const registry = emptyRegistry({
    revision: 7,
    recipes: [version1.recipeDefinition],
    updatedAt: '2026-09-25T06:12:00.000Z',
  });
  const version2Input = compilerInput({
    version: 2,
    parentVersion: 1,
    trace: trace({
      traceId: 'trace-2',
      completedAt: '2026-09-25T06:20:30.000Z',
      steps: steps().map(step => ({
        ...step,
        verifiedAt: step.stepId === 'step.fetch'
          ? '2026-09-25T06:20:10.000Z'
          : '2026-09-25T06:20:20.000Z',
      })),
      startedAt: '2026-09-25T06:20:00.000Z',
    }),
  });
  const trustedVersion2Trace = version2Input.trace;
  const v2Request = request({
    admissionId: 'recipe-admission-2',
    expectedRegistryRevision: 7,
    compilerInput: version2Input,
    admittedAt: '2026-09-25T06:22:00.000Z',
  });

  const result = await admitTrustedRecipeCandidateV1(v2Request, options({
    recipeRegistry: registry,
    resolveTrustedRecipeTrace: async () => trustedVersion2Trace,
    resolveTrustedEvidenceArtifact: async lookup => artifactForLookup(
      lookup,
      { createdAt: '2026-09-25T06:20:05.000Z' },
    ),
    resolveTrustedSecretScan: async lookup => ({
      schemaVersion: 1,
      scanId: 'secret-scan-2',
      scannerId: 'secret-scanner-1',
      subjectSha256: lookup.subjectSha256,
      status: 'PASS',
      findingCount: 0,
      scannedAt: '2026-09-25T06:21:00.000Z',
    }),
  }));
  assert.equal(result.nextRegistry.revision, 8);
  assert.deepEqual(
    result.nextRegistry.recipes.map(item => item.version),
    [1, 2],
  );

  const skipped = compilerInput({
    version: 3,
    parentVersion: 2,
    trace: trustedVersion2Trace,
  });
  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request({
        expectedRegistryRevision: 7,
        compilerInput: skipped,
        admittedAt: '2026-09-25T06:22:00.000Z',
      }),
      options({
        recipeRegistry: registry,
        resolveTrustedRecipeTrace: async () => trustedVersion2Trace,
      }),
    ),
    /must append exactly one version/u,
  );
});

test('request and trusted result boundaries reject authority aliases/accessors without getter execution', async () => {
  let reads = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'admissionId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'recipe-admission-pwned';
    },
  });
  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(hostile, options()),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0);

  const aliased = request();
  aliased.executionAuthorized = true;
  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(aliased, options()),
    /unknown field: executionAuthorized/u,
  );

  const hostileScanOptions = options({
    resolveTrustedSecretScan: async lookup => {
      const scan = {
        schemaVersion: 1,
        scanId: 'secret-scan-1',
        scannerId: 'secret-scanner-1',
        subjectSha256: lookup.subjectSha256,
        status: 'PASS',
        findingCount: 0,
        scannedAt: '2026-09-25T06:11:00.000Z',
      };
      Object.defineProperty(scan, 'status', {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return 'PASS';
        },
      });
      return scan;
    },
  });
  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(request(), hostileScanOptions),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0);
});

test('admission chronology fails closed before registry mutation', async () => {
  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request({ admittedAt: '2026-09-25T05:59:59.000Z' }),
      options(),
    ),
    /cannot predate canonical registry state/u,
  );

  await assert.rejects(
    () => admitTrustedRecipeCandidateV1(
      request({ admittedAt: '2026-09-25T06:10:29.000Z' }),
      options(),
    ),
    /candidate creation postdates admission/u,
  );
});
