import {
  RecipeLifecycleState,
  RecipeQualificationStatus,
  RecipeStepKind,
  normalizeRecipeDefinitionV1,
} from './recipe-registry.js';

export const RECIPE_COMPILER_SCHEMA_VERSION = 1;
export const MAX_RECIPE_COMPILER_STEPS = 128;
export const MAX_RECIPE_COMPILER_PARAMETERS = 128;
export const MAX_RECIPE_COMPILER_SOURCE_BINDINGS = 128;

export const RecipeParameterKind = Object.freeze({
  OWNER_VALUE: 'OWNER_VALUE',
  SOURCE_REF: 'SOURCE_REF',
  CREDENTIAL_REF: 'CREDENTIAL_REF',
});

const PARAMETER_KINDS = new Set(Object.values(RecipeParameterKind));
const STEP_KINDS = new Set(Object.values(RecipeStepKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

const INPUT_KEYS = new Set([
  'schemaVersion',
  'recipeId',
  'version',
  'parentVersion',
  'sourceBindings',
  'parameters',
  'trace',
]);
const SOURCE_KEYS = new Set(['sourceId', 'revisionId', 'contentSha256']);
const PARAMETER_KEYS = new Set([
  'parameterId',
  'kind',
  'required',
  'sensitive',
]);
const TRACE_KEYS = new Set([
  'traceId',
  'jobId',
  'planId',
  'producerId',
  'outcome',
  'startedAt',
  'completedAt',
  'steps',
]);
const TRACE_STEP_KEYS = new Set([
  'stepId',
  'kind',
  'dependsOn',
  'providerId',
  'toolId',
  'requiredCapabilityIds',
  'inputContractRef',
  'outputContractRef',
  'verificationContractRef',
  'parameterIds',
  'verificationEvidenceArtifactId',
  'verificationEvidenceSha256',
  'verifiedAt',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new Error(label + ' must not contain symbol fields');
    }
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(label + ' must contain enumerable own data properties only');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
  }
}

function denseArray(value, label, { min = 0, max }) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < min
      || lengthDescriptor.value > max) {
    throw new Error(label + ' must be a bounded array');
  }
  const length = lengthDescriptor.value;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains non-index array data');
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || !Object.hasOwn(descriptor, 'value')
        || descriptor.enumerable !== true) {
      throw new Error(label + ' must contain canonical enumerable data indices only');
    }
  }

  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(label + ' must not be sparse');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function id(value, label, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function integer(value, label, { min, max }) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value < min
      || value > max) {
    throw new Error(label + ' is out of bounds');
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !SHA256.test(value)) {
    throw new Error(label + ' must be canonical lowercase SHA-256');
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueIds(value, label, { min = 0, max = 128 } = {}) {
  const items = denseArray(value, label, { min, max })
    .map((item, index) => id(item, label + '[' + index + ']'));
  if (new Set(items).size !== items.length) throw new Error(label + ' contains duplicates');
  items.sort(compareText);
  return items;
}

function normalizeSourceBinding(input, index) {
  const label = 'sourceBindings[' + index + ']';
  const raw = record(input, label);
  exactKeys(raw, SOURCE_KEYS, label);
  return freezeDeep({
    sourceId: id(raw.sourceId, label + ' sourceId'),
    revisionId: id(raw.revisionId, label + ' revisionId'),
    contentSha256: sha256(raw.contentSha256, label + ' contentSha256'),
  });
}

function normalizeSourceBindings(input) {
  const values = denseArray(input, 'sourceBindings', {
    min: 1,
    max: MAX_RECIPE_COMPILER_SOURCE_BINDINGS,
  }).map(normalizeSourceBinding);

  const seen = new Set();
  for (const value of values) {
    if (seen.has(value.sourceId)) throw new Error('sourceBindings contains duplicate sourceId');
    seen.add(value.sourceId);
  }
  values.sort((a, b) => compareText(a.sourceId, b.sourceId));
  return Object.freeze(values);
}

function normalizeParameter(input, index) {
  const label = 'parameters[' + index + ']';
  const raw = record(input, label);
  exactKeys(raw, PARAMETER_KEYS, label);
  const kind = id(raw.kind, label + ' kind');
  if (!PARAMETER_KINDS.has(kind)) throw new Error(label + ' kind is invalid');
  const sensitive = boolean(raw.sensitive, label + ' sensitive');
  if (kind === RecipeParameterKind.CREDENTIAL_REF && sensitive !== true) {
    throw new Error(label + ' CREDENTIAL_REF must be sensitive');
  }
  return freezeDeep({
    parameterId: id(raw.parameterId, label + ' parameterId'),
    kind,
    required: boolean(raw.required, label + ' required'),
    sensitive,
  });
}

function normalizeParameters(input) {
  const values = denseArray(input, 'parameters', {
    max: MAX_RECIPE_COMPILER_PARAMETERS,
  }).map(normalizeParameter);

  const seen = new Set();
  for (const value of values) {
    if (seen.has(value.parameterId)) throw new Error('parameters contains duplicate parameterId');
    seen.add(value.parameterId);
  }
  values.sort((a, b) => compareText(a.parameterId, b.parameterId));
  return Object.freeze(values);
}

function normalizeTraceStep(input, index, context) {
  const label = 'trace.steps[' + index + ']';
  const raw = record(input, label);
  exactKeys(raw, TRACE_STEP_KEYS, label);

  const kind = id(raw.kind, label + ' kind');
  if (!STEP_KINDS.has(kind)) throw new Error(label + ' kind is invalid');
  const stepId = id(raw.stepId, label + ' stepId');
  const providerId = id(raw.providerId, label + ' providerId', { optional: true });
  const toolId = id(raw.toolId, label + ' toolId', { optional: true });
  const requiredCapabilityIds = uniqueIds(
    raw.requiredCapabilityIds,
    label + ' requiredCapabilityIds',
    { max: 64 },
  );

  if (kind === RecipeStepKind.DETERMINISTIC) {
    if (providerId || toolId || requiredCapabilityIds.length) {
      throw new Error(label + ' deterministic step cannot declare provider/tool capabilities');
    }
  } else {
    if (!providerId || !toolId || !requiredCapabilityIds.length) {
      throw new Error(label + ' tool step requires provider, tool and capabilities');
    }
  }

  const verifiedAt = timestamp(raw.verifiedAt, label + ' verifiedAt');
  if (Date.parse(verifiedAt) < context.startedAtMs
      || Date.parse(verifiedAt) > context.completedAtMs) {
    throw new Error(label + ' verifiedAt is outside the trace interval');
  }

  return freezeDeep({
    stepId,
    kind,
    dependsOn: Object.freeze(uniqueIds(raw.dependsOn, label + ' dependsOn', {
      max: MAX_RECIPE_COMPILER_STEPS,
    })),
    providerId,
    toolId,
    requiredCapabilityIds: Object.freeze(requiredCapabilityIds),
    inputContractRef: id(raw.inputContractRef, label + ' inputContractRef'),
    outputContractRef: id(raw.outputContractRef, label + ' outputContractRef'),
    verificationContractRef: id(
      raw.verificationContractRef,
      label + ' verificationContractRef',
    ),
    parameterIds: Object.freeze(uniqueIds(
      raw.parameterIds,
      label + ' parameterIds',
      { max: MAX_RECIPE_COMPILER_PARAMETERS },
    )),
    verificationEvidenceArtifactId: id(
      raw.verificationEvidenceArtifactId,
      label + ' verificationEvidenceArtifactId',
    ),
    verificationEvidenceSha256: sha256(
      raw.verificationEvidenceSha256,
      label + ' verificationEvidenceSha256',
    ),
    verifiedAt,
  });
}

function assertTraceGraph(steps) {
  const byId = new Map();
  for (const step of steps) {
    if (byId.has(step.stepId)) throw new Error('trace.steps contains duplicate stepId');
    byId.set(step.stepId, step);
  }

  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error('trace step ' + step.stepId + ' depends on unknown step: ' + dependency);
      }
      if (dependency === step.stepId) {
        throw new Error('trace step ' + step.stepId + ' cannot depend on itself');
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (stepId) => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) throw new Error('trace.steps contains dependency cycle');
    visiting.add(stepId);
    for (const dependency of byId.get(stepId).dependsOn) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.stepId);
}

function assertParameterBindings(parameters, steps) {
  const parameterIds = new Set(parameters.map((parameter) => parameter.parameterId));
  const used = new Set();

  for (const step of steps) {
    for (const parameterId of step.parameterIds) {
      if (!parameterIds.has(parameterId)) {
        throw new Error(
          'trace step ' + step.stepId + ' references undeclared parameterId: ' + parameterId,
        );
      }
      used.add(parameterId);
    }
  }

  for (const parameter of parameters) {
    if (!used.has(parameter.parameterId)) {
      throw new Error('parameter is not bound to any trace step: ' + parameter.parameterId);
    }
  }
}

function normalizeTrace(input, parameters) {
  const raw = record(input, 'trace');
  exactKeys(raw, TRACE_KEYS, 'trace');

  if (raw.outcome !== 'VERIFIED') {
    throw new Error('trace outcome must be VERIFIED');
  }

  const startedAt = timestamp(raw.startedAt, 'trace startedAt');
  const completedAt = timestamp(raw.completedAt, 'trace completedAt');
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = Date.parse(completedAt);
  if (completedAtMs < startedAtMs) {
    throw new Error('trace completedAt cannot predate startedAt');
  }

  const producerId = id(raw.producerId, 'trace producerId');
  const steps = denseArray(raw.steps, 'trace.steps', {
    min: 1,
    max: MAX_RECIPE_COMPILER_STEPS,
  }).map((step, index) => normalizeTraceStep(step, index, {
    startedAtMs,
    completedAtMs,
  }));

  assertTraceGraph(steps);
  assertParameterBindings(parameters, steps);

  steps.sort((a, b) => compareText(a.stepId, b.stepId));

  return freezeDeep({
    traceId: id(raw.traceId, 'trace traceId'),
    jobId: id(raw.jobId, 'trace jobId'),
    planId: id(raw.planId, 'trace planId'),
    producerId,
    outcome: 'VERIFIED',
    startedAt,
    completedAt,
    steps: Object.freeze(steps),
  });
}

function buildCandidateRecipe({
  recipeId,
  version,
  parentVersion,
  sourceBindings,
  trace,
}) {
  const steps = trace.steps.map((step) => ({
    stepId: step.stepId,
    kind: step.kind,
    title: 'Recorded step ' + step.stepId,
    dependsOn: [...step.dependsOn],
    providerId: step.providerId,
    toolId: step.toolId,
    requiredCapabilityIds: [...step.requiredCapabilityIds],
    inputContractRef: step.inputContractRef,
    outputContractRef: step.outputContractRef,
    verificationContractRef: step.verificationContractRef,
  }));

  return normalizeRecipeDefinitionV1({
    schemaVersion: 1,
    recipeId,
    version,
    parentVersion,
    title: 'Recorded procedure ' + recipeId,
    description: 'Structurally sanitized candidate compiled from verified run trace ' + trace.traceId + '.',
    producerId: trace.producerId,
    lifecycle: RecipeLifecycleState.CANDIDATE,
    sourceBindings: sourceBindings.map((binding) => ({ ...binding })),
    steps,
    qualification: {
      status: RecipeQualificationStatus.UNQUALIFIED,
      evidenceArtifactIds: [],
    },
    createdAt: trace.completedAt,
  });
}

function buildParameterBindings(steps) {
  return Object.freeze(
    steps
      .filter((step) => step.parameterIds.length > 0)
      .map((step) => freezeDeep({
        stepId: step.stepId,
        parameterIds: Object.freeze([...step.parameterIds]),
      })),
  );
}

function buildVerificationEvidence(steps) {
  return Object.freeze(
    steps.map((step) => freezeDeep({
      stepId: step.stepId,
      evidenceArtifactId: step.verificationEvidenceArtifactId,
      evidenceSha256: step.verificationEvidenceSha256,
      verifiedAt: step.verifiedAt,
    })),
  );
}

/**
 * Compiles a value-free, non-authorizing Recipe candidate from a structural
 * record of a successful run. Raw prompts, tool arguments, outputs, tokens,
 * credentials, transcript text and parameter values are intentionally absent
 * from the accepted schema and therefore fail closed as unknown fields.
 *
 * The returned candidate is compatible with RecipeRegistryV1, but this
 * compiler cannot admit, execute, replay, evaluate, or promote it. The trace
 * and evidence identities remain UNVERIFIED_INPUT until canonical authorities
 * resolve them independently.
 */
export function compileRecipeCandidateV1(input) {
  const raw = record(input, 'RecipeCompilerInputV1');
  exactKeys(raw, INPUT_KEYS, 'RecipeCompilerInputV1');
  if (raw.schemaVersion !== RECIPE_COMPILER_SCHEMA_VERSION) {
    throw new Error('Unsupported RecipeCompilerInputV1 schemaVersion');
  }

  const recipeId = id(raw.recipeId, 'recipeId');
  const version = integer(raw.version, 'version', { min: 1, max: 1_000_000 });
  const parentVersion = integer(raw.parentVersion, 'parentVersion', {
    min: 0,
    max: 999_999,
  });
  const sourceBindings = normalizeSourceBindings(raw.sourceBindings);
  const parameters = normalizeParameters(raw.parameters);
  const trace = normalizeTrace(raw.trace, parameters);
  const recipeDefinition = buildCandidateRecipe({
    recipeId,
    version,
    parentVersion,
    sourceBindings,
    trace,
  });

  return freezeDeep({
    schemaVersion: RECIPE_COMPILER_SCHEMA_VERSION,
    proposalId: 'recipe-candidate:' + trace.traceId,
    recipeDefinition,
    parameters,
    parameterBindings: buildParameterBindings(trace.steps),
    verificationEvidence: buildVerificationEvidence(trace.steps),
    trace: {
      traceId: trace.traceId,
      jobId: trace.jobId,
      planId: trace.planId,
      producerId: trace.producerId,
      outcome: trace.outcome,
      startedAt: trace.startedAt,
      completedAt: trace.completedAt,
    },
    traceTrust: 'UNVERIFIED_INPUT',
    evidenceTrust: 'UNVERIFIED_INPUT',
    rawContentAccepted: false,
    parameterValuesAccepted: false,
    registryAdmissionAuthorized: false,
    replayAuthorized: false,
    promotionAuthorized: false,
    executionAuthorized: false,
    permissionGranted: false,
    requiresCanonicalRecipeRegistry: true,
    requiresCanonicalTraceResolution: true,
    requiresCanonicalEvidenceResolution: true,
    requiresTrustedReplayEvaluation: true,
    requiresSecretScan: true,
  });
}
