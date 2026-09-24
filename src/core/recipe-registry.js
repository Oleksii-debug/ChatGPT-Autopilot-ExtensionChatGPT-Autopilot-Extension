/**
 * RecipeRegistryV1 is a deterministic, data-only procedural recipe contract.
 * It deliberately does not execute recipes, grant capabilities, schedule work,
 * persist state, or replace the canonical policy/exact-effect authorities.
 */
export const RECIPE_REGISTRY_VERSION = 1;

export const RecipeLifecycleState = Object.freeze({
  DRAFT: 'DRAFT',
  CANDIDATE: 'CANDIDATE',
  PROMOTED: 'PROMOTED',
  RETIRED: 'RETIRED',
});

export const RecipeQualificationStatus = Object.freeze({
  UNQUALIFIED: 'UNQUALIFIED',
  PASS: 'PASS',
  FAIL: 'FAIL',
});

export const RecipeStepKind = Object.freeze({
  DETERMINISTIC: 'DETERMINISTIC',
  TOOL: 'TOOL',
});

export const RecipeFreshnessStatus = Object.freeze({
  FRESH: 'FRESH',
  STALE: 'STALE',
});

const LIFECYCLE = new Set(Object.values(RecipeLifecycleState));
const QUALIFICATION = new Set(Object.values(RecipeQualificationStatus));
const STEP_KIND = new Set(Object.values(RecipeStepKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RECIPES = 512;
const MAX_STEPS = 128;
const MAX_BINDINGS = 128;
const MAX_IDS = 128;
const MAX_TEXT = 16_000;

function strictRecord(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  const out = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) throw new Error(`${label} contains non-enumerable field: ${key}`);
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field must be a data property: ${key}`);
    }
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    out[key] = descriptor.value;
  }
  return out;
}

function strictArray(input, label, { max, min = 0 } = {}) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${label} must be a plain array`);
  }
  if (!Number.isInteger(max) || input.length < min || input.length > max) {
    throw new Error(`${label} must contain ${min}-${max} items`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index field`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= input.length) {
      throw new Error(`${label} contains invalid index`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
  }
  const out = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function id(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a timestamp`);
  return new Date(parsed).toISOString();
}

function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function normalizeIdList(input, label, { max = MAX_IDS, min = 0 } = {}) {
  const raw = strictArray(input, label, { max, min });
  const values = raw.map((value, index) => id(value, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values.sort(asciiCompare);
}

const SOURCE_BINDING_KEYS = new Set(['sourceId', 'revisionId', 'contentSha256']);
function normalizeSourceBinding(input, label = 'sourceBinding') {
  const raw = strictRecord(input, SOURCE_BINDING_KEYS, label);
  return frozen({
    sourceId: id(raw.sourceId, `${label}.sourceId`),
    revisionId: id(raw.revisionId, `${label}.revisionId`),
    contentSha256: sha256(raw.contentSha256, `${label}.contentSha256`),
  });
}

function normalizeSourceBindings(input, label = 'sourceBindings', { min = 1 } = {}) {
  const raw = strictArray(input, label, { max: MAX_BINDINGS, min });
  const bindings = raw.map((value, index) => normalizeSourceBinding(value, `${label}[${index}]`));
  const seen = new Set();
  for (const binding of bindings) {
    if (seen.has(binding.sourceId)) throw new Error(`${label} contains duplicate sourceId: ${binding.sourceId}`);
    seen.add(binding.sourceId);
  }
  return bindings.sort((a, b) => asciiCompare(a.sourceId, b.sourceId));
}

const STEP_KEYS = new Set([
  'stepId', 'kind', 'title', 'dependsOn', 'providerId', 'toolId',
  'requiredCapabilityIds', 'inputContractRef', 'outputContractRef',
  'verificationContractRef',
]);

function normalizeStep(input, index) {
  const label = `steps[${index}]`;
  const raw = strictRecord(input, STEP_KEYS, label);
  const kind = id(raw.kind, `${label}.kind`);
  if (!STEP_KIND.has(kind)) throw new Error(`${label}.kind is invalid`);
  const providerId = id(raw.providerId, `${label}.providerId`, { optional: true });
  const toolId = id(raw.toolId, `${label}.toolId`, { optional: true });
  const requiredCapabilityIds = normalizeIdList(raw.requiredCapabilityIds ?? [], `${label}.requiredCapabilityIds`, { max: 64 });
  if (kind === RecipeStepKind.DETERMINISTIC) {
    if (providerId || toolId || requiredCapabilityIds.length) {
      throw new Error(`${label} deterministic step cannot declare provider/tool capabilities`);
    }
  } else {
    if (!providerId || !toolId) throw new Error(`${label} tool step requires providerId and toolId`);
    if (!requiredCapabilityIds.length) throw new Error(`${label} tool step requires capability declarations`);
  }
  return frozen({
    stepId: id(raw.stepId, `${label}.stepId`),
    kind,
    title: text(raw.title, `${label}.title`, { max: 500 }),
    dependsOn: normalizeIdList(raw.dependsOn ?? [], `${label}.dependsOn`, { max: MAX_STEPS }),
    providerId,
    toolId,
    requiredCapabilityIds,
    inputContractRef: id(raw.inputContractRef, `${label}.inputContractRef`, { optional: true }),
    outputContractRef: id(raw.outputContractRef, `${label}.outputContractRef`, { optional: true }),
    verificationContractRef: id(raw.verificationContractRef, `${label}.verificationContractRef`, { optional: true }),
  });
}

function assertAcyclic(steps) {
  const byId = new Map(steps.map(step => [step.stepId, step]));
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`step ${step.stepId} depends on unknown step: ${dependency}`);
      if (dependency === step.stepId) throw new Error(`step ${step.stepId} cannot depend on itself`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = stepId => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) throw new Error('recipe steps contain dependency cycle');
    visiting.add(stepId);
    for (const dependency of byId.get(stepId).dependsOn) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.stepId);
}

const QUALIFICATION_KEYS = new Set([
  'status', 'evaluationId', 'benchmarkSuiteId', 'benchmarkSuiteRevision',
  'verifierId', 'evidenceArtifactIds', 'subjectSha256', 'evaluatedAt',
]);

function normalizeQualification(input, producerId) {
  const raw = strictRecord(input, QUALIFICATION_KEYS, 'qualification');
  const status = id(raw.status, 'qualification.status');
  if (!QUALIFICATION.has(status)) throw new Error('qualification.status is invalid');
  if (status === RecipeQualificationStatus.UNQUALIFIED) {
    const forbidden = [
      'evaluationId', 'benchmarkSuiteId', 'benchmarkSuiteRevision', 'verifierId',
      'subjectSha256', 'evaluatedAt',
    ];
    for (const key of forbidden) {
      if (raw[key] != null && raw[key] !== '') throw new Error(`UNQUALIFIED qualification cannot contain ${key}`);
    }
    const evidence = raw.evidenceArtifactIds ?? [];
    if (strictArray(evidence, 'qualification.evidenceArtifactIds', { max: MAX_IDS }).length) {
      throw new Error('UNQUALIFIED qualification cannot contain evidenceArtifactIds');
    }
    return frozen({
      status,
      evaluationId: '',
      benchmarkSuiteId: '',
      benchmarkSuiteRevision: '',
      verifierId: '',
      evidenceArtifactIds: [],
      subjectSha256: '',
      evaluatedAt: '',
    });
  }

  const verifierId = id(raw.verifierId, 'qualification.verifierId');
  if (verifierId === producerId) throw new Error('qualification verifier must be independent from producer');
  const evidenceArtifactIds = normalizeIdList(
    raw.evidenceArtifactIds,
    'qualification.evidenceArtifactIds',
    { max: MAX_IDS, min: 1 },
  );
  return frozen({
    status,
    evaluationId: id(raw.evaluationId, 'qualification.evaluationId'),
    benchmarkSuiteId: id(raw.benchmarkSuiteId, 'qualification.benchmarkSuiteId'),
    benchmarkSuiteRevision: id(raw.benchmarkSuiteRevision, 'qualification.benchmarkSuiteRevision'),
    verifierId,
    evidenceArtifactIds,
    subjectSha256: sha256(raw.subjectSha256, 'qualification.subjectSha256'),
    evaluatedAt: timestamp(raw.evaluatedAt, 'qualification.evaluatedAt'),
  });
}

const RECIPE_KEYS = new Set([
  'schemaVersion', 'recipeId', 'version', 'parentVersion', 'title', 'description',
  'producerId', 'lifecycle', 'sourceBindings', 'steps', 'qualification', 'createdAt',
]);

export function normalizeRecipeDefinitionV1(input) {
  const raw = strictRecord(input, RECIPE_KEYS, 'RecipeDefinitionV1');
  if (raw.schemaVersion !== RECIPE_REGISTRY_VERSION) throw new Error('Unsupported RecipeDefinitionV1 schemaVersion');
  const recipeId = id(raw.recipeId, 'recipeId');
  const version = integer(raw.version, 'version', { min: 1, max: 1_000_000 });
  const parentVersion = integer(raw.parentVersion, 'parentVersion', { min: 0, max: 999_999 });
  if ((version === 1 && parentVersion !== 0) || (version > 1 && parentVersion !== version - 1)) {
    throw new Error('parentVersion must identify the immediately preceding recipe version');
  }
  const lifecycle = id(raw.lifecycle, 'lifecycle');
  if (!LIFECYCLE.has(lifecycle)) throw new Error('lifecycle is invalid');
  const producerId = id(raw.producerId, 'producerId');
  const stepValues = strictArray(raw.steps, 'steps', { max: MAX_STEPS, min: 1 });
  const steps = stepValues.map((value, index) => normalizeStep(value, index));
  if (new Set(steps.map(step => step.stepId)).size !== steps.length) throw new Error('steps contains duplicate stepId');
  assertAcyclic(steps);
  steps.sort((a, b) => asciiCompare(a.stepId, b.stepId));
  const qualification = normalizeQualification(raw.qualification, producerId);
  if (lifecycle === RecipeLifecycleState.DRAFT && qualification.status !== RecipeQualificationStatus.UNQUALIFIED) {
    throw new Error('DRAFT recipe must be UNQUALIFIED');
  }
  if (lifecycle === RecipeLifecycleState.PROMOTED && qualification.status !== RecipeQualificationStatus.PASS) {
    throw new Error('PROMOTED recipe requires PASS qualification');
  }
  return frozen({
    schemaVersion: RECIPE_REGISTRY_VERSION,
    recipeId,
    version,
    parentVersion,
    title: text(raw.title, 'title', { max: 500 }),
    description: text(raw.description, 'description', { max: MAX_TEXT }),
    producerId,
    lifecycle,
    sourceBindings: normalizeSourceBindings(raw.sourceBindings),
    steps,
    qualification,
    createdAt: timestamp(raw.createdAt, 'createdAt'),
  });
}

const REGISTRY_KEYS = new Set(['schemaVersion', 'registryId', 'revision', 'recipes', 'updatedAt']);

export function normalizeRecipeRegistryV1(input) {
  const raw = strictRecord(input, REGISTRY_KEYS, 'RecipeRegistryV1');
  if (raw.schemaVersion !== RECIPE_REGISTRY_VERSION) throw new Error('Unsupported RecipeRegistryV1 schemaVersion');
  const recipeValues = strictArray(raw.recipes, 'recipes', { max: MAX_RECIPES });
  const recipes = recipeValues.map(normalizeRecipeDefinitionV1);
  recipes.sort((a, b) => asciiCompare(a.recipeId, b.recipeId) || a.version - b.version);

  const seen = new Set();
  const byRecipe = new Map();
  for (const recipe of recipes) {
    const identity = `${recipe.recipeId}\u0000${recipe.version}`;
    if (seen.has(identity)) throw new Error(`recipes contains duplicate version: ${recipe.recipeId}@${recipe.version}`);
    seen.add(identity);
    const lineage = byRecipe.get(recipe.recipeId) || [];
    lineage.push(recipe);
    byRecipe.set(recipe.recipeId, lineage);
  }
  for (const [recipeId, lineage] of byRecipe) {
    if (lineage[0].version !== 1) throw new Error(`recipe lineage ${recipeId} must start at version 1`);
    for (let index = 1; index < lineage.length; index += 1) {
      const previous = lineage[index - 1];
      const current = lineage[index];
      if (current.version !== previous.version + 1 || current.parentVersion !== previous.version) {
        throw new Error(`recipe lineage ${recipeId} must be contiguous`);
      }
      if (Date.parse(current.createdAt) < Date.parse(previous.createdAt)) {
        throw new Error(`recipe lineage ${recipeId} createdAt must be monotonic`);
      }
    }
  }

  return frozen({
    schemaVersion: RECIPE_REGISTRY_VERSION,
    registryId: id(raw.registryId, 'registryId'),
    revision: integer(raw.revision, 'revision', { min: 1, max: 1_000_000_000 }),
    recipes,
    updatedAt: timestamp(raw.updatedAt, 'updatedAt'),
  });
}

export function assertRecipeRegistryExtensionV1(previousInput, nextInput) {
  const previous = normalizeRecipeRegistryV1(previousInput);
  const next = normalizeRecipeRegistryV1(nextInput);
  if (next.registryId !== previous.registryId) throw new Error('registryId is immutable');
  if (next.revision !== previous.revision + 1) throw new Error('registry revision must advance exactly once');
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) throw new Error('registry updatedAt cannot move backwards');

  const nextByIdentity = new Map(next.recipes.map(recipe => [`${recipe.recipeId}\u0000${recipe.version}`, recipe]));
  for (const recipe of previous.recipes) {
    const identity = `${recipe.recipeId}\u0000${recipe.version}`;
    const current = nextByIdentity.get(identity);
    if (!current) throw new Error(`existing recipe version cannot be removed: ${recipe.recipeId}@${recipe.version}`);
    if (JSON.stringify(current) !== JSON.stringify(recipe)) {
      throw new Error(`existing recipe version is immutable: ${recipe.recipeId}@${recipe.version}`);
    }
  }

  const previousMax = new Map();
  for (const recipe of previous.recipes) previousMax.set(recipe.recipeId, recipe.version);
  for (const recipe of next.recipes) {
    const max = previousMax.get(recipe.recipeId);
    if (max != null && recipe.version > max && recipe.version !== max + 1) {
      throw new Error(`new recipe version must append to lineage: ${recipe.recipeId}@${recipe.version}`);
    }
  }
  return next;
}

export function getCurrentRecipeVersionV1(registryInput, recipeIdInput) {
  const registry = normalizeRecipeRegistryV1(registryInput);
  const recipeId = id(recipeIdInput, 'recipeId');
  const versions = registry.recipes.filter(recipe => recipe.recipeId === recipeId);
  return versions.length ? versions[versions.length - 1] : null;
}

export function resolvePromotedRecipeV1(registryInput, recipeIdInput) {
  const registry = normalizeRecipeRegistryV1(registryInput);
  const recipeId = id(recipeIdInput, 'recipeId');
  const versions = registry.recipes.filter(recipe => recipe.recipeId === recipeId);
  if (!versions.length) return null;
  if (versions[versions.length - 1].lifecycle === RecipeLifecycleState.RETIRED) return null;
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    if (versions[index].lifecycle === RecipeLifecycleState.PROMOTED) return versions[index];
  }
  return null;
}

export function assessRecipeSourceFreshnessV1(recipeInput, currentSourceBindingsInput) {
  const recipe = normalizeRecipeDefinitionV1(recipeInput);
  const current = normalizeSourceBindings(currentSourceBindingsInput, 'currentSourceBindings', { min: 0 });
  const byId = new Map(current.map(binding => [binding.sourceId, binding]));
  const drift = [];
  for (const expected of recipe.sourceBindings) {
    const actual = byId.get(expected.sourceId);
    if (!actual) {
      drift.push(frozen({ sourceId: expected.sourceId, reason: 'MISSING_SOURCE' }));
      continue;
    }
    if (actual.revisionId !== expected.revisionId) {
      drift.push(frozen({ sourceId: expected.sourceId, reason: 'REVISION_CHANGED' }));
      continue;
    }
    if (actual.contentSha256 !== expected.contentSha256) {
      drift.push(frozen({ sourceId: expected.sourceId, reason: 'CONTENT_CHANGED' }));
    }
  }
  drift.sort((a, b) => asciiCompare(a.sourceId, b.sourceId) || asciiCompare(a.reason, b.reason));
  return frozen({
    recipeId: recipe.recipeId,
    version: recipe.version,
    status: drift.length ? RecipeFreshnessStatus.STALE : RecipeFreshnessStatus.FRESH,
    drift,
  });
}

export function assertRecipeReplayEligibleV1(recipeInput, currentSourceBindingsInput) {
  const recipe = normalizeRecipeDefinitionV1(recipeInput);
  if (recipe.lifecycle !== RecipeLifecycleState.PROMOTED) throw new Error('recipe is not PROMOTED');
  if (recipe.qualification.status !== RecipeQualificationStatus.PASS) throw new Error('recipe qualification is not PASS');
  const freshness = assessRecipeSourceFreshnessV1(recipe, currentSourceBindingsInput);
  if (freshness.status !== RecipeFreshnessStatus.FRESH) {
    const evidence = freshness.drift.map(item => `${item.sourceId}:${item.reason}`).join(', ');
    throw new Error(`recipe source binding is stale: ${evidence}`);
  }
  return recipe;
}

export function recipeRequiredCapabilityIdsV1(recipeInput) {
  const recipe = normalizeRecipeDefinitionV1(recipeInput);
  const values = new Set();
  for (const step of recipe.steps) for (const capabilityId of step.requiredCapabilityIds) values.add(capabilityId);
  return Object.freeze([...values].sort(asciiCompare));
}
