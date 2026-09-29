import { compileRecipeCandidateV1 } from './recipe-compiler.js';
import {
  assertRecipeRegistryExtensionV1,
  computeRecipeSubjectSha256V1,
  getCurrentRecipeVersionV1,
  normalizeRecipeRegistryV1,
} from './recipe-registry.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const RECIPE_CANDIDATE_ADMISSION_VERSION = 1;

export const RecipeCandidateAdmissionStatus = Object.freeze({
  CANDIDATE_ADMITTED: 'CANDIDATE_ADMITTED',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE_ARTIFACTS = 128;

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'admissionId',
  'expectedRegistryId',
  'expectedRegistryRevision',
  'compilerInput',
  'admittedAt',
]);

const OPTIONS_KEYS = new Set([
  'recipeRegistry',
  'resolveTrustedRecipeTrace',
  'resolveTrustedEvidenceArtifact',
  'resolveTrustedSecretScan',
]);

const SECRET_SCAN_KEYS = new Set([
  'schemaVersion',
  'scanId',
  'scannerId',
  'subjectSha256',
  'status',
  'findingCount',
  'scannedAt',
]);

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain or null-prototype object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' field ' + key + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw new Error(label + ' must be a positive safe integer');
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) {
    throw new Error(label + ' must be a non-negative safe integer');
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(label + ' must be canonical lowercase SHA-256');
  }
  return value;
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new Error(label + ' must be a function');
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeRequest(input) {
  const raw = strictRecord(input, REQUEST_KEYS, 'RecipeCandidateAdmissionRequestV1');
  if (raw.schemaVersion !== RECIPE_CANDIDATE_ADMISSION_VERSION) {
    throw new Error('Unsupported RecipeCandidateAdmissionRequestV1 schemaVersion');
  }
  return Object.freeze({
    schemaVersion: RECIPE_CANDIDATE_ADMISSION_VERSION,
    admissionId: exactId(raw.admissionId, 'admissionId'),
    expectedRegistryId: exactId(raw.expectedRegistryId, 'expectedRegistryId'),
    expectedRegistryRevision: positiveInteger(
      raw.expectedRegistryRevision,
      'expectedRegistryRevision',
    ),
    // Deliberately do not traverse untrusted compilerInput here. The canonical
    // compiler owns its descriptor-safe deep admission boundary.
    compilerInput: raw.compilerInput,
    admittedAt: exactTimestamp(raw.admittedAt, 'admittedAt'),
  });
}

function normalizeOptions(input) {
  const raw = strictRecord(input, OPTIONS_KEYS, 'Recipe candidate trusted options');
  if (!raw.recipeRegistry) {
    throw new Error('Recipe candidate admission requires canonical recipeRegistry');
  }
  return Object.freeze({
    recipeRegistry: normalizeRecipeRegistryV1(raw.recipeRegistry),
    resolveTrustedRecipeTrace: requiredFunction(
      raw.resolveTrustedRecipeTrace,
      'resolveTrustedRecipeTrace',
    ),
    resolveTrustedEvidenceArtifact: requiredFunction(
      raw.resolveTrustedEvidenceArtifact,
      'resolveTrustedEvidenceArtifact',
    ),
    resolveTrustedSecretScan: requiredFunction(
      raw.resolveTrustedSecretScan,
      'resolveTrustedSecretScan',
    ),
  });
}

function originalSourceBindings(compiled) {
  const synthetic = new Set([
    compiled.parameterSchemaBinding.sourceId,
    compiled.traceBinding.sourceId,
  ]);
  const values = compiled.recipeDefinition.sourceBindings
    .filter(binding => !synthetic.has(binding.sourceId))
    .map(binding => ({ ...binding }));
  if (values.length + synthetic.size !== compiled.recipeDefinition.sourceBindings.length) {
    throw new Error('Compiler provenance bindings are not exact');
  }
  return values;
}

function trustedCompilerInput(compiled, trustedTrace) {
  return {
    schemaVersion: 1,
    recipeId: compiled.recipeDefinition.recipeId,
    version: compiled.recipeDefinition.version,
    parentVersion: compiled.recipeDefinition.parentVersion,
    sourceBindings: originalSourceBindings(compiled),
    parameters: compiled.parameters.map(parameter => ({ ...parameter })),
    trace: trustedTrace,
  };
}

function normalizeSecretScan(input, candidate, admittedAt, subjectSha256) {
  const raw = strictRecord(input, SECRET_SCAN_KEYS, 'TrustedRecipeSecretScanV1');
  if (raw.schemaVersion !== 1) {
    throw new Error('Unsupported TrustedRecipeSecretScanV1 schemaVersion');
  }
  const status = exactId(raw.status, 'secret scan status');
  if (status !== 'PASS') throw new Error('Trusted Recipe secret scan did not PASS');
  const scannerId = exactId(raw.scannerId, 'secret scan scannerId');
  if (scannerId === candidate.producerId) {
    throw new Error('Trusted Recipe secret scan must be independent from recipe producer');
  }
  if (exactSha256(raw.subjectSha256, 'secret scan subjectSha256') !== subjectSha256) {
    throw new Error('Trusted Recipe secret scan subject digest mismatch');
  }
  if (nonNegativeInteger(raw.findingCount, 'secret scan findingCount') !== 0) {
    throw new Error('Trusted Recipe secret scan PASS cannot contain findings');
  }
  const scannedAt = exactTimestamp(raw.scannedAt, 'secret scan scannedAt');
  if (Date.parse(scannedAt) < Date.parse(candidate.createdAt)) {
    throw new Error('Trusted Recipe secret scan predates candidate creation');
  }
  if (Date.parse(scannedAt) > Date.parse(admittedAt)) {
    throw new Error('Trusted Recipe secret scan postdates admission');
  }
  return freezeDeep({
    schemaVersion: 1,
    scanId: exactId(raw.scanId, 'secret scan scanId'),
    scannerId,
    subjectSha256,
    status,
    findingCount: 0,
    scannedAt,
  });
}

function assertLineageCandidate(registry, candidate) {
  const current = getCurrentRecipeVersionV1(registry, candidate.recipeId);
  if (!current) {
    if (candidate.version !== 1 || candidate.parentVersion !== 0) {
      throw new Error('New Recipe candidate lineage must start at version 1');
    }
    return;
  }
  if (candidate.version !== current.version + 1
      || candidate.parentVersion !== current.version) {
    throw new Error('Recipe candidate must append exactly one version to current lineage');
  }
}

function traceLookup(request, compiled) {
  return freezeDeep({
    schemaVersion: RECIPE_CANDIDATE_ADMISSION_VERSION,
    admissionId: request.admissionId,
    traceId: compiled.trace.traceId,
    jobId: compiled.trace.jobId,
    planId: compiled.trace.planId,
    producerId: compiled.trace.producerId,
    recipeId: compiled.recipeDefinition.recipeId,
    recipeVersion: compiled.recipeDefinition.version,
    traceBindingSha256: compiled.traceBinding.contentSha256,
    requestedAt: request.admittedAt,
  });
}

function evidenceLookup(request, compiled, evidence) {
  return freezeDeep({
    schemaVersion: RECIPE_CANDIDATE_ADMISSION_VERSION,
    admissionId: request.admissionId,
    traceId: compiled.trace.traceId,
    stepId: evidence.stepId,
    evidenceArtifactId: evidence.evidenceArtifactId,
    evidenceSha256: evidence.evidenceSha256,
    verifiedAt: evidence.verifiedAt,
    requestedAt: request.admittedAt,
  });
}

function secretScanLookup(request, compiled, subjectSha256) {
  return freezeDeep({
    schemaVersion: RECIPE_CANDIDATE_ADMISSION_VERSION,
    admissionId: request.admissionId,
    recipeId: compiled.recipeDefinition.recipeId,
    recipeVersion: compiled.recipeDefinition.version,
    subjectSha256,
    recipeDefinition: compiled.recipeDefinition,
    requestedAt: request.admittedAt,
  });
}

/**
 * Admits one structurally sanitized RecipeCompilerV1 candidate into the
 * canonical append-only RecipeRegistryV1 snapshot after independently resolving
 * the exact run trace, every verification-evidence ArtifactRefV1 and a
 * subject-digest-bound clean secret scan.
 *
 * This function is persistence-free. registryAdmissionAuthorized means only
 * that the returned nextRegistry is a valid exact +1 candidate extension of
 * the supplied trusted registry snapshot. It grants no replay, promotion,
 * execution, policy, permission, provider or effect authority.
 */
export async function admitTrustedRecipeCandidateV1(input, trustedOptions) {
  const request = normalizeRequest(input);
  const options = normalizeOptions(trustedOptions);
  const registry = options.recipeRegistry;

  if (registry.registryId !== request.expectedRegistryId) {
    throw new Error('Recipe candidate expectedRegistryId does not match canonical registry');
  }
  if (registry.revision !== request.expectedRegistryRevision) {
    throw new Error('Recipe candidate expectedRegistryRevision is stale or mismatched');
  }
  if (Date.parse(request.admittedAt) < Date.parse(registry.updatedAt)) {
    throw new Error('Recipe candidate admission cannot predate canonical registry state');
  }

  const compiled = await compileRecipeCandidateV1(request.compilerInput);
  const candidate = compiled.recipeDefinition;
  if (candidate.lifecycle !== 'CANDIDATE'
      || candidate.qualification.status !== 'UNQUALIFIED'
      || compiled.registryAdmissionAuthorized !== false
      || compiled.replayAuthorized !== false
      || compiled.promotionAuthorized !== false
      || compiled.executionAuthorized !== false
      || compiled.permissionGranted !== false) {
    throw new Error('Recipe compiler output violates candidate authority fence');
  }
  if (Date.parse(candidate.createdAt) > Date.parse(request.admittedAt)) {
    throw new Error('Recipe candidate creation postdates admission');
  }
  assertLineageCandidate(registry, candidate);

  const trustedTrace = await options.resolveTrustedRecipeTrace(
    traceLookup(request, compiled),
  );
  const trustedCompiled = await compileRecipeCandidateV1(
    trustedCompilerInput(compiled, trustedTrace),
  );
  if (trustedCompiled.traceBinding.contentSha256 !== compiled.traceBinding.contentSha256) {
    throw new Error('Trusted Recipe trace digest does not match compiler trace');
  }
  if (JSON.stringify(trustedCompiled.recipeDefinition) !== JSON.stringify(candidate)) {
    throw new Error('Trusted Recipe trace does not reproduce exact candidate');
  }

  if (compiled.verificationEvidence.length > MAX_EVIDENCE_ARTIFACTS) {
    throw new Error('Recipe candidate references too many verification evidence artifacts');
  }
  const evidenceArtifactRefs = [];
  const seenEvidenceIds = new Set();
  for (const evidence of compiled.verificationEvidence) {
    if (seenEvidenceIds.has(evidence.evidenceArtifactId)) {
      throw new Error('Recipe candidate reuses verification evidence artifact identity');
    }
    seenEvidenceIds.add(evidence.evidenceArtifactId);
    const resolved = await options.resolveTrustedEvidenceArtifact(
      evidenceLookup(request, compiled, evidence),
    );
    const artifact = normalizeArtifactRefV1(resolved);
    if (artifact.artifactId !== evidence.evidenceArtifactId) {
      throw new Error('Trusted Recipe evidence artifactId mismatch for ' + evidence.stepId);
    }
    if (!artifact.sha256 || artifact.sha256 !== evidence.evidenceSha256) {
      throw new Error('Trusted Recipe evidence SHA-256 mismatch for ' + evidence.stepId);
    }
    if (Date.parse(artifact.createdAt) > Date.parse(evidence.verifiedAt)) {
      throw new Error('Trusted Recipe evidence postdates verification for ' + evidence.stepId);
    }
    if (Date.parse(evidence.verifiedAt) > Date.parse(request.admittedAt)) {
      throw new Error('Trusted Recipe verification postdates admission for ' + evidence.stepId);
    }
    evidenceArtifactRefs.push(artifact);
  }

  const subjectSha256 = await computeRecipeSubjectSha256V1(candidate);
  const secretScan = normalizeSecretScan(
    await options.resolveTrustedSecretScan(
      secretScanLookup(request, compiled, subjectSha256),
    ),
    candidate,
    request.admittedAt,
    subjectSha256,
  );

  const nextRegistry = assertRecipeRegistryExtensionV1(registry, {
    schemaVersion: 1,
    registryId: registry.registryId,
    revision: registry.revision + 1,
    recipes: [...registry.recipes, candidate],
    updatedAt: request.admittedAt,
  });

  return freezeDeep({
    schemaVersion: RECIPE_CANDIDATE_ADMISSION_VERSION,
    status: RecipeCandidateAdmissionStatus.CANDIDATE_ADMITTED,
    admissionId: request.admissionId,
    registryId: registry.registryId,
    previousRegistryRevision: registry.revision,
    nextRegistryRevision: nextRegistry.revision,
    recipeId: candidate.recipeId,
    recipeVersion: candidate.version,
    subjectSha256,
    traceBindingSha256: compiled.traceBinding.contentSha256,
    parameterSchemaSha256: compiled.parameterSchemaBinding.contentSha256,
    evidenceArtifactRefs,
    secretScan,
    recipeDefinition: candidate,
    nextRegistry,
    traceTrust: 'TRUSTED_RESOLVER',
    evidenceTrust: 'TRUSTED_ARTIFACT_REFS',
    secretScanTrust: 'TRUSTED_RESOLVER',
    registryAdmissionAuthorized: true,
    replayAuthorized: false,
    promotionAuthorized: false,
    executionAuthorized: false,
    permissionGranted: false,
    policyDecisionGranted: false,
    exactEffectAuthorized: false,
    requiresTrustedReplayEvaluation: true,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalExactEffect: true,
  });
}
