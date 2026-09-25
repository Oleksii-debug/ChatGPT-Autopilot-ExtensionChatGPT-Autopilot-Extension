import { assessSharedProjectAccessV1 } from './shared-project-collaboration.js';
import {
  normalizeRecipeRegistryV1,
  resolvePromotedRecipeV1,
} from './recipe-registry.js';

export const SHARED_PROJECT_RECIPE_CATALOG_SCHEMA_VERSION = 1;
export const SHARED_PROJECT_RECIPE_SHARE_CAPABILITY = 'project.recipe.share';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_SHARES = 2_000;
const MAX_TRUSTED_EVALUATIONS = 2_000;

const REQUEST_KEYS = new Set([
  'bindingId',
  'viewerPrincipalId',
  'recipeRegistry',
  'trustedEvaluations',
  'shares',
  'evaluatedAt',
]);
const SHARE_KEYS = new Set([
  'shareId',
  'projectId',
  'projectRevisionId',
  'recipeId',
  'version',
  'sharedByPrincipalId',
  'sharedAt',
  'revokedAt',
]);

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function strictRecord(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must contain enumerable data properties only`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function strictArray(input, label, max) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index data`);
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} contains invalid indexed data`);
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be dense data-only array`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function normalizeShare(input, index, evaluatedAt) {
  const label = `shares[${index}]`;
  const raw = strictRecord(input, SHARE_KEYS, label);
  const sharedAt = timestamp(raw.sharedAt, `${label}.sharedAt`);
  const revokedAt = timestamp(raw.revokedAt, `${label}.revokedAt`, { optional: true });
  if (revokedAt && Date.parse(revokedAt) <= Date.parse(sharedAt)) {
    throw new Error(`${label}.revokedAt must be after sharedAt`);
  }
  if (Date.parse(sharedAt) > Date.parse(evaluatedAt)) {
    throw new Error(`${label}.sharedAt cannot be later than catalog evaluation time`);
  }
  return freezeDeep({
    shareId: exactId(raw.shareId, `${label}.shareId`),
    projectId: exactId(raw.projectId, `${label}.projectId`),
    projectRevisionId: exactId(raw.projectRevisionId, `${label}.projectRevisionId`),
    recipeId: exactId(raw.recipeId, `${label}.recipeId`),
    version: positiveInteger(raw.version, `${label}.version`),
    sharedByPrincipalId: exactId(raw.sharedByPrincipalId, `${label}.sharedByPrincipalId`),
    sharedAt,
    revokedAt,
  });
}

function uniqueBy(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[key])) throw new Error(`${label} contains duplicate ${key}: ${item[key]}`);
    seen.add(item[key]);
  }
}

function activeShareAt(share, evaluatedAt) {
  const atMillis = Date.parse(evaluatedAt);
  return Date.parse(share.sharedAt) <= atMillis
    && (!share.revokedAt || atMillis < Date.parse(share.revokedAt));
}

function accessRequest(bindingId, principalId, at, capabilityId) {
  return {
    bindingId,
    principalId,
    at,
    requestedCapabilityIds: [capabilityId],
    requestedProviderIds: [],
    requestedOutboundDataClassIds: [],
  };
}

function assertCanonicalCatalogViewer(access) {
  if (!access.collaborationEligible) {
    throw new Error(`catalog viewer is outside canonical shared Project read ceiling: ${access.reasonCode}`);
  }
}

function assertShareBindsAccess(share, access, label) {
  if (access.projectId !== share.projectId
      || access.projectRevisionId !== share.projectRevisionId) {
    throw new Error(`${label} does not match canonical shared Project binding`);
  }
  if (!access.collaborationEligible) {
    throw new Error(`${label} sharer is outside canonical Project recipe-share ceiling: ${access.reasonCode}`);
  }
}

/**
 * Builds a read-only recipe catalog for a canonical shared Project binding.
 *
 * The Project collaboration contract owns identity/revision/governance scope.
 * This module only verifies that the sharer fits the canonical
 * project.recipe.share ceiling and that the RecipeRegistry exposes an exact,
 * trusted active PROMOTED version. Sharing never authorizes admission, replay,
 * provider use, execution, mutation, or any underlying effect.
 */
export async function buildSharedProjectRecipeCatalogV1(input = {}, trustedProjectResolver) {
  const request = strictRecord(input, REQUEST_KEYS, 'SharedProjectRecipeCatalogRequestV1');
  const bindingId = exactId(request.bindingId, 'bindingId');
  const viewerPrincipalId = exactId(request.viewerPrincipalId, 'viewerPrincipalId');
  const evaluatedAt = timestamp(request.evaluatedAt, 'evaluatedAt');
  const catalogAccess = await assessSharedProjectAccessV1(
    accessRequest(bindingId, viewerPrincipalId, evaluatedAt, 'project.read'),
    trustedProjectResolver,
  );
  assertCanonicalCatalogViewer(catalogAccess);
  const recipeRegistry = normalizeRecipeRegistryV1(request.recipeRegistry);
  if (Date.parse(recipeRegistry.updatedAt) > Date.parse(evaluatedAt)) {
    throw new Error('recipe registry is newer than catalog evaluation time');
  }

  const trustedEvaluations = strictArray(
    request.trustedEvaluations,
    'trustedEvaluations',
    MAX_TRUSTED_EVALUATIONS,
  );
  const shares = strictArray(request.shares, 'shares', MAX_SHARES)
    .map((item, index) => normalizeShare(item, index, evaluatedAt));
  uniqueBy(shares, 'shareId', 'shares');

  const activeRecipeIdentities = new Set();
  const resolvedByRecipeId = new Map();
  const items = [];
  const catalogProjectId = catalogAccess.projectId;
  const catalogProjectRevisionId = catalogAccess.projectRevisionId;
  const organizationId = catalogAccess.organizationId;
  const governanceRegistryId = catalogAccess.governanceRegistryId;
  const governanceRegistryRevision = catalogAccess.governanceRegistryRevision;

  for (const share of shares) {
    const initialAccess = await assessSharedProjectAccessV1(
      accessRequest(
        bindingId,
        share.sharedByPrincipalId,
        share.sharedAt,
        SHARED_PROJECT_RECIPE_SHARE_CAPABILITY,
      ),
      trustedProjectResolver,
    );
    assertShareBindsAccess(share, initialAccess, `share ${share.shareId}`);

    if (catalogProjectId !== initialAccess.projectId
        || catalogProjectRevisionId !== initialAccess.projectRevisionId
        || organizationId !== initialAccess.organizationId
        || governanceRegistryId !== initialAccess.governanceRegistryId
        || governanceRegistryRevision !== initialAccess.governanceRegistryRevision) {
      throw new Error('share does not resolve to canonical catalog Project authority');
    }

    if (!activeShareAt(share, evaluatedAt)) continue;

    const currentAccess = share.sharedAt === evaluatedAt
      ? initialAccess
      : await assessSharedProjectAccessV1(
        accessRequest(
          bindingId,
          share.sharedByPrincipalId,
          evaluatedAt,
          SHARED_PROJECT_RECIPE_SHARE_CAPABILITY,
        ),
        trustedProjectResolver,
      );
    assertShareBindsAccess(share, currentAccess, `active share ${share.shareId}`);

    const identity = `${share.recipeId}@${share.version}`;
    if (activeRecipeIdentities.has(identity)) {
      throw new Error(`multiple active shares expose the same recipe identity: ${identity}`);
    }
    activeRecipeIdentities.add(identity);

    let recipe = resolvedByRecipeId.get(share.recipeId);
    if (recipe === undefined) {
      recipe = await resolvePromotedRecipeV1(
        recipeRegistry,
        share.recipeId,
        trustedEvaluations,
      );
      resolvedByRecipeId.set(share.recipeId, recipe);
    }
    if (!recipe) {
      throw new Error(`shared recipe has no trusted active PROMOTED version: ${share.recipeId}`);
    }
    if (recipe.version !== share.version) {
      throw new Error(`share does not bind current trusted PROMOTED version: ${identity}`);
    }
    if (Date.parse(share.sharedAt) < Date.parse(recipe.createdAt)) {
      throw new Error(`share predates recipe version creation: ${identity}`);
    }

    items.push(freezeDeep({
      shareId: share.shareId,
      projectId: share.projectId,
      projectRevisionId: share.projectRevisionId,
      recipeId: recipe.recipeId,
      version: recipe.version,
      title: recipe.title,
      description: recipe.description,
      sharedByPrincipalId: share.sharedByPrincipalId,
      sharedAt: share.sharedAt,
      producerId: recipe.producerId,
      sourceBindings: [...recipe.sourceBindings],
      stepCount: recipe.steps.length,
      lifecycle: recipe.lifecycle,
      qualificationStatus: recipe.qualification.status,
      evaluationId: recipe.qualification.evaluationId,
      requiredShareCapabilityId: SHARED_PROJECT_RECIPE_SHARE_CAPABILITY,
      requiresCanonicalPolicyDecision: true,
      admissionAuthorized: false,
      executionAuthorized: false,
      mutationAuthorized: false,
    }));
  }

  items.sort((a, b) => asciiCompare(a.recipeId, b.recipeId)
    || a.version - b.version
    || asciiCompare(a.shareId, b.shareId));

  return freezeDeep({
    schemaVersion: SHARED_PROJECT_RECIPE_CATALOG_SCHEMA_VERSION,
    bindingId,
    viewerPrincipalId,
    projectId: catalogProjectId,
    projectRevisionId: catalogProjectRevisionId,
    organizationId,
    governanceRegistryId,
    governanceRegistryRevision,
    recipeRegistryId: recipeRegistry.registryId,
    recipeRegistryRevision: recipeRegistry.revision,
    evaluatedAt,
    items,
    requiredShareCapabilityId: SHARED_PROJECT_RECIPE_SHARE_CAPABILITY,
    requiresCanonicalPolicyDecision: true,
    policyDecision: 'NONE',
    admissionAuthorized: false,
    executionAuthorized: false,
    mutationAuthorized: false,
  });
}
