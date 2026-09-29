import { createSha256FingerprintV1 } from './fingerprint.js';
import {
  RECIPE_COMPILER_SCHEMA_VERSION,
  RecipeParameterKind,
} from './recipe-compiler.js';
import {
  RecipeLifecycleState,
  RecipeQualificationStatus,
  computeRecipeSubjectSha256V1,
  normalizeRecipeDefinitionV1,
  recipeRequiredCapabilityIdsV1,
  resolveReplayEligibleRecipeV1,
} from './recipe-registry.js';

export const RECIPE_REPLAY_ADMISSION_VERSION = 1;
export const MAX_RECIPE_REPLAY_PARAMETERS = 128;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PARAMETER_KINDS = new Set(Object.values(RecipeParameterKind));

const REQUEST_KEYS = new Set([
  'registry',
  'recipeId',
  'currentSourceBindings',
  'trustedEvaluations',
  'compilerProposal',
  'parameterRefs',
  'replayId',
  'requestedAt',
]);

const PROPOSAL_KEYS = new Set([
  'schemaVersion',
  'proposalId',
  'recipeDefinition',
  'parameters',
  'parameterBindings',
  'parameterSchemaBinding',
  'traceBinding',
  'verificationEvidence',
  'trace',
  'traceTrust',
  'evidenceTrust',
  'rawContentAccepted',
  'parameterValuesAccepted',
  'registryAdmissionAuthorized',
  'replayAuthorized',
  'promotionAuthorized',
  'executionAuthorized',
  'permissionGranted',
  'requiresCanonicalRecipeRegistry',
  'requiresCanonicalTraceResolution',
  'requiresCanonicalEvidenceResolution',
  'requiresTrustedReplayEvaluation',
  'requiresSecretScan',
]);

const PARAMETER_KEYS = new Set(['parameterId', 'kind', 'required', 'sensitive']);
const PARAMETER_BINDING_KEYS = new Set(['stepId', 'parameterIds']);
const SOURCE_BINDING_KEYS = new Set(['sourceId', 'revisionId', 'contentSha256']);
const PARAMETER_REF_KEYS = new Set(['parameterId', 'kind', 'referenceId']);

const REFERENCE_PREFIX = Object.freeze({
  [RecipeParameterKind.OWNER_VALUE]: 'owner-value:',
  [RecipeParameterKind.SOURCE_REF]: 'source-ref:',
  [RecipeParameterKind.CREDENTIAL_REF]: 'credential-ref:',
});

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' contains a symbol field');
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' field ' + key + ' must be an enumerable own data property');
    }
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
    out[key] = descriptor.value;
  }
  return out;
}

function required(raw, key, label) {
  if (!Object.hasOwn(raw, key)) throw new Error(label + ' requires ' + key);
  return raw[key];
}

function denseArray(value, label, { min = 0, max = MAX_RECIPE_REPLAY_PARAMETERS } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < min
      || lengthDescriptor.value > max) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains a non-index field');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must be an exact id');
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(label + ' must be canonical lowercase SHA-256');
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeParameter(value, index) {
  const label = 'compilerProposal.parameters[' + index + ']';
  const raw = strictRecord(value, PARAMETER_KEYS, label);
  const kind = exactId(required(raw, 'kind', label), label + '.kind');
  if (!PARAMETER_KINDS.has(kind)) throw new Error(label + '.kind is invalid');
  const sensitive = exactBoolean(required(raw, 'sensitive', label), label + '.sensitive');
  if (kind === RecipeParameterKind.CREDENTIAL_REF && sensitive !== true) {
    throw new Error(label + ' CREDENTIAL_REF must remain sensitive');
  }
  return freezeDeep({
    parameterId: exactId(required(raw, 'parameterId', label), label + '.parameterId'),
    kind,
    required: exactBoolean(required(raw, 'required', label), label + '.required'),
    sensitive,
  });
}

function normalizeParameters(value) {
  const parameters = denseArray(value, 'compilerProposal.parameters')
    .map(normalizeParameter);
  const ids = parameters.map(item => item.parameterId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('compilerProposal.parameters contains duplicate parameterId');
  }
  parameters.sort((a, b) => compareText(a.parameterId, b.parameterId));
  return Object.freeze(parameters);
}

function normalizeParameterBinding(value, index) {
  const label = 'compilerProposal.parameterBindings[' + index + ']';
  const raw = strictRecord(value, PARAMETER_BINDING_KEYS, label);
  const parameterIds = denseArray(
    required(raw, 'parameterIds', label),
    label + '.parameterIds',
    { min: 1 },
  ).map((item, itemIndex) => exactId(item, label + '.parameterIds[' + itemIndex + ']'));
  if (new Set(parameterIds).size !== parameterIds.length) {
    throw new Error(label + '.parameterIds contains duplicates');
  }
  parameterIds.sort(compareText);
  return freezeDeep({
    stepId: exactId(required(raw, 'stepId', label), label + '.stepId'),
    parameterIds: Object.freeze(parameterIds),
  });
}

function normalizeParameterBindings(value) {
  const bindings = denseArray(value, 'compilerProposal.parameterBindings')
    .map(normalizeParameterBinding);
  const stepIds = bindings.map(item => item.stepId);
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error('compilerProposal.parameterBindings contains duplicate stepId');
  }
  bindings.sort((a, b) => compareText(a.stepId, b.stepId));
  return Object.freeze(bindings);
}

function normalizeParameterSchemaBinding(value) {
  const raw = strictRecord(value, SOURCE_BINDING_KEYS, 'compilerProposal.parameterSchemaBinding');
  return freezeDeep({
    sourceId: exactId(
      required(raw, 'sourceId', 'compilerProposal.parameterSchemaBinding'),
      'compilerProposal.parameterSchemaBinding.sourceId',
    ),
    revisionId: exactId(
      required(raw, 'revisionId', 'compilerProposal.parameterSchemaBinding'),
      'compilerProposal.parameterSchemaBinding.revisionId',
    ),
    contentSha256: exactSha256(
      required(raw, 'contentSha256', 'compilerProposal.parameterSchemaBinding'),
      'compilerProposal.parameterSchemaBinding.contentSha256',
    ),
  });
}

function normalizeCompilerProposal(value) {
  const raw = strictRecord(value, PROPOSAL_KEYS, 'compilerProposal');
  if (required(raw, 'schemaVersion', 'compilerProposal') !== RECIPE_COMPILER_SCHEMA_VERSION) {
    throw new Error('compilerProposal schemaVersion is unsupported');
  }
  const recipeDefinition = normalizeRecipeDefinitionV1(
    required(raw, 'recipeDefinition', 'compilerProposal'),
  );
  if (recipeDefinition.lifecycle !== RecipeLifecycleState.CANDIDATE
      || recipeDefinition.qualification.status !== RecipeQualificationStatus.UNQUALIFIED) {
    throw new Error('compilerProposal recipeDefinition must remain CANDIDATE/UNQUALIFIED');
  }

  const exactFlags = [
    ['rawContentAccepted', false],
    ['parameterValuesAccepted', false],
    ['registryAdmissionAuthorized', false],
    ['replayAuthorized', false],
    ['promotionAuthorized', false],
    ['executionAuthorized', false],
    ['permissionGranted', false],
    ['requiresCanonicalRecipeRegistry', true],
    ['requiresCanonicalTraceResolution', true],
    ['requiresCanonicalEvidenceResolution', true],
    ['requiresTrustedReplayEvaluation', true],
    ['requiresSecretScan', true],
  ];
  for (const [key, expected] of exactFlags) {
    if (exactBoolean(required(raw, key, 'compilerProposal'), 'compilerProposal.' + key) !== expected) {
      throw new Error('compilerProposal.' + key + ' violates compiler authority fence');
    }
  }
  if (required(raw, 'traceTrust', 'compilerProposal') !== 'UNVERIFIED_INPUT'
      || required(raw, 'evidenceTrust', 'compilerProposal') !== 'UNVERIFIED_INPUT') {
    throw new Error('compilerProposal trust markers are invalid');
  }

  exactId(required(raw, 'proposalId', 'compilerProposal'), 'compilerProposal.proposalId');

  return freezeDeep({
    recipeDefinition,
    parameters: normalizeParameters(required(raw, 'parameters', 'compilerProposal')),
    parameterBindings: normalizeParameterBindings(
      required(raw, 'parameterBindings', 'compilerProposal'),
    ),
    parameterSchemaBinding: normalizeParameterSchemaBinding(
      required(raw, 'parameterSchemaBinding', 'compilerProposal'),
    ),
  });
}

function assertSchemaTopology(proposal) {
  const stepIds = new Set(proposal.recipeDefinition.steps.map(step => step.stepId));
  const parameterIds = new Set(proposal.parameters.map(parameter => parameter.parameterId));
  const used = new Set();
  for (const binding of proposal.parameterBindings) {
    if (!stepIds.has(binding.stepId)) {
      throw new Error('parameter binding references unknown recipe step: ' + binding.stepId);
    }
    for (const parameterId of binding.parameterIds) {
      if (!parameterIds.has(parameterId)) {
        throw new Error('parameter binding references undeclared parameter: ' + parameterId);
      }
      used.add(parameterId);
    }
  }
  for (const parameter of proposal.parameters) {
    if (!used.has(parameter.parameterId)) {
      throw new Error('declared recipe parameter is not bound to a step: ' + parameter.parameterId);
    }
  }
}

async function recomputeParameterSchemaBinding(proposal) {
  const canonical = JSON.stringify([
    'chatgpt-autopilot-recipe-parameter-schema-v1',
    proposal.parameters,
    proposal.parameterBindings,
  ]);
  const tagged = await createSha256FingerprintV1(canonical, { cryptoApi: globalThis.crypto });
  if (typeof tagged !== 'string' || !tagged.startsWith('sha256:')) {
    throw new Error('parameter schema fingerprint helper returned invalid output');
  }
  const digest = exactSha256(
    tagged.slice('sha256:'.length),
    'recomputed parameter schema SHA-256',
  );
  return freezeDeep({
    sourceId: 'recipe-parameters:' + digest.slice(0, 32),
    revisionId: 'sha256:' + digest,
    contentSha256: digest,
  });
}

function normalizeParameterRef(value, index) {
  const label = 'parameterRefs[' + index + ']';
  const raw = strictRecord(value, PARAMETER_REF_KEYS, label);
  const kind = exactId(required(raw, 'kind', label), label + '.kind');
  if (!PARAMETER_KINDS.has(kind)) throw new Error(label + '.kind is invalid');
  const referenceId = exactId(required(raw, 'referenceId', label), label + '.referenceId');
  if (!referenceId.startsWith(REFERENCE_PREFIX[kind])) {
    throw new Error(label + '.referenceId must use the opaque namespace for ' + kind);
  }
  return freezeDeep({
    parameterId: exactId(required(raw, 'parameterId', label), label + '.parameterId'),
    kind,
    referenceId,
  });
}

function normalizeParameterRefs(value, parameters) {
  const refs = denseArray(value, 'parameterRefs')
    .map(normalizeParameterRef);
  const ids = refs.map(item => item.parameterId);
  if (new Set(ids).size !== ids.length) throw new Error('parameterRefs contains duplicate parameterId');

  const byParameter = new Map(parameters.map(item => [item.parameterId, item]));
  for (const ref of refs) {
    const parameter = byParameter.get(ref.parameterId);
    if (!parameter) throw new Error('parameterRefs contains undeclared parameterId: ' + ref.parameterId);
    if (parameter.kind !== ref.kind) {
      throw new Error('parameterRefs kind does not match declaration: ' + ref.parameterId);
    }
  }
  const refIds = new Set(ids);
  for (const parameter of parameters) {
    if (parameter.required && !refIds.has(parameter.parameterId)) {
      throw new Error('required recipe parameter has no opaque reference: ' + parameter.parameterId);
    }
  }
  refs.sort((a, b) => compareText(a.parameterId, b.parameterId));
  return Object.freeze(refs);
}

function sameBinding(left, right) {
  return left.sourceId === right.sourceId
    && left.revisionId === right.revisionId
    && left.contentSha256 === right.contentSha256;
}

function buildSteps(recipe, proposal, refs) {
  const bindingByStep = new Map(
    proposal.parameterBindings.map(binding => [binding.stepId, binding]),
  );
  const refById = new Map(refs.map(ref => [ref.parameterId, ref]));
  const parameterById = new Map(
    proposal.parameters.map(parameter => [parameter.parameterId, parameter]),
  );

  return Object.freeze(recipe.steps.map(step => {
    const binding = bindingByStep.get(step.stepId);
    const parameterRefs = binding
      ? binding.parameterIds
        .map(parameterId => {
          const ref = refById.get(parameterId);
          if (!ref) return null;
          const declaration = parameterById.get(parameterId);
          return freezeDeep({
            parameterId,
            kind: declaration.kind,
            referenceId: ref.referenceId,
            sensitive: declaration.sensitive,
          });
        })
        .filter(Boolean)
      : [];

    return freezeDeep({
      stepId: step.stepId,
      kind: step.kind,
      dependsOn: Object.freeze([...step.dependsOn]),
      providerId: step.providerId,
      toolId: step.toolId,
      requiredCapabilityIds: Object.freeze([...step.requiredCapabilityIds]),
      inputContractRef: step.inputContractRef,
      outputContractRef: step.outputContractRef,
      verificationContractRef: step.verificationContractRef,
      parameterRefs: Object.freeze(parameterRefs),
    });
  }));
}

/**
 * Resolves one exact replay-eligible promoted Recipe and binds it to the exact
 * value-free parameter schema emitted by RecipeCompilerV1. The output is only
 * a structural replay blueprint. It cannot execute a tool, resolve an opaque
 * owner/source/credential reference, mutate AgentPlan, grant policy, or create
 * exact-effect authority.
 */
export async function buildRecipeReplayAdmissionV1(input = {}) {
  const raw = strictRecord(input, REQUEST_KEYS, 'RecipeReplayAdmissionRequestV1');
  const replayId = exactId(
    required(raw, 'replayId', 'RecipeReplayAdmissionRequestV1'),
    'replayId',
  );
  const recipeId = exactId(
    required(raw, 'recipeId', 'RecipeReplayAdmissionRequestV1'),
    'recipeId',
  );
  const requestedAt = exactTimestamp(
    required(raw, 'requestedAt', 'RecipeReplayAdmissionRequestV1'),
    'requestedAt',
  );
  const proposal = normalizeCompilerProposal(
    required(raw, 'compilerProposal', 'RecipeReplayAdmissionRequestV1'),
  );
  assertSchemaTopology(proposal);

  const recipe = await resolveReplayEligibleRecipeV1(
    required(raw, 'registry', 'RecipeReplayAdmissionRequestV1'),
    recipeId,
    required(raw, 'currentSourceBindings', 'RecipeReplayAdmissionRequestV1'),
    required(raw, 'trustedEvaluations', 'RecipeReplayAdmissionRequestV1'),
  );

  if (proposal.recipeDefinition.recipeId !== recipe.recipeId
      || proposal.recipeDefinition.version !== recipe.version) {
    throw new Error('compilerProposal recipe identity does not match promoted recipe');
  }
  if (Date.parse(requestedAt) < Date.parse(recipe.qualification.evaluatedAt)) {
    throw new Error('replay request predates trusted recipe qualification');
  }

  const [proposalSubjectSha256, promotedSubjectSha256, recomputedSchemaBinding] = await Promise.all([
    computeRecipeSubjectSha256V1(proposal.recipeDefinition),
    computeRecipeSubjectSha256V1(recipe),
    recomputeParameterSchemaBinding(proposal),
  ]);
  if (proposalSubjectSha256 !== promotedSubjectSha256) {
    throw new Error('compilerProposal immutable recipe subject does not match promoted recipe');
  }
  if (!sameBinding(recomputedSchemaBinding, proposal.parameterSchemaBinding)) {
    throw new Error('compilerProposal parameter schema binding does not match declared schema');
  }
  const promotedSchemaBinding = recipe.sourceBindings.find(
    binding => binding.sourceId === proposal.parameterSchemaBinding.sourceId,
  );
  if (!promotedSchemaBinding || !sameBinding(promotedSchemaBinding, proposal.parameterSchemaBinding)) {
    throw new Error('promoted recipe is not bound to compiler parameter schema');
  }

  const parameterRefs = normalizeParameterRefs(
    required(raw, 'parameterRefs', 'RecipeReplayAdmissionRequestV1'),
    proposal.parameters,
  );
  const missingOptionalParameterIds = proposal.parameters
    .filter(parameter => !parameter.required
      && !parameterRefs.some(ref => ref.parameterId === parameter.parameterId))
    .map(parameter => parameter.parameterId);

  return freezeDeep({
    schemaVersion: RECIPE_REPLAY_ADMISSION_VERSION,
    replayId,
    recipeId: recipe.recipeId,
    compilerProposalBindingScope: 'RECIPE_SUBJECT_AND_PARAMETER_SCHEMA_ONLY',
    recipeVersion: recipe.version,
    recipeSubjectSha256: promotedSubjectSha256,
    parameterSchemaSha256: proposal.parameterSchemaBinding.contentSha256,
    requestedAt,
    requiredCapabilityIds: recipeRequiredCapabilityIdsV1(recipe),
    missingOptionalParameterIds: Object.freeze(missingOptionalParameterIds),
    steps: buildSteps(recipe, proposal, parameterRefs),
    replayAdmissionReady: true,
    opaqueReferencesOnly: true,
    rawParameterValuesAccepted: false,
    executionAuthorized: false,
    permissionGranted: false,
    policyDecisionGranted: false,
    exactEffectAuthorized: false,
    requiresCanonicalReferenceResolution: true,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalAgentRuntime: true,
    requiresCanonicalExactEffect: true,
  });
}
