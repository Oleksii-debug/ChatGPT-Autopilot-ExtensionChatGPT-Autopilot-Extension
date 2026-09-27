import { normalizeBrowserAgentConfig } from './browser-agent.js';
import { normalizeAiRoutePolicy } from './ai-route-pool.js';
import { normalizeAgentSpecialistDelegationProfileV1 } from './agent-specialist-delegation-profile.js';

export const AGENT_DEFINITION_VERSION = 1;
export const AGENT_DEFINITION_REGISTRY_VERSION = 1;
export const AGENT_DEFINITION_SELECTION_VERSION = 1;
export const AGENT_DEFINITION_REGISTRY_MUTATION_VERSION = 1;

export const AgentDefinitionRegistryMutationKind = Object.freeze({
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const DEF_KEYS = new Set([
  'schemaVersion', 'agentDefinitionId', 'label', 'description', 'instructions',
  'capabilityIds', 'toolIds', 'tags', 'acceptanceCriteria', 'configDefaults', 'modelRoutePolicy',
  'specialistDelegationProfile', 'enabled',
  'definitionRevision',
]);
const REGISTRY_KEYS = new Set(['schemaVersion', 'registryId', 'revision', 'definitions']);
const SELECT_REQUEST_KEYS = new Set(['registry', 'agentDefinitionId']);
const DISCOVER_KEYS = new Set(['registry', 'requiredTags', 'requiredCapabilityIds', 'requiredToolIds']);
const SELECTION_KEYS = new Set([
  'schemaVersion', 'registryId', 'registryRevision', 'agentDefinitionId',
  'definitionRevision', 'definition',
]);
const MATERIALIZE_KEYS = new Set([
  'registry', 'selection', 'jobId', 'goal', 'projectId', 'ownerBudget',
  'ownerCapabilityIds', 'ownerToolIds', 'requestedCapabilityIds', 'requestedToolIds',
]);
const MUTATION_KEYS = new Set([
  'registry', 'registryId', 'expectedRegistryRevision', 'kind',
  'definition', 'agentDefinitionId', 'expectedDefinitionRevision',
]);
const MUTATION_KINDS = new Set(Object.values(AgentDefinitionRegistryMutationKind));
const CONFIG_DEFAULT_KEYS = new Set([
  'startUrl', 'startFromActiveTab', 'maxSteps', 'stepDelayMs',
  'allowCrossOriginNavigation', 'closeOwnedTabsOnStop', 'visionOnDemand',
  'maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens',
  'maxOutputTokensPerCall', 'maxRuntimeMinutes',
  'aiRoutingMode', 'aiPinnedRouteId', 'aiPrimaryProvider', 'aiPrimaryModel',
  'aiStrongProvider', 'aiStrongModel',
]);
const DEFINITION_CEILING_KEYS = Object.freeze([
  'maxSteps', 'maxModelCalls', 'maxInputTokens', 'maxOutputTokens',
  'maxTotalTokens', 'maxOutputTokensPerCall', 'maxRuntimeMinutes',
]);
const MODEL_ROUTE_POLICY_KEYS = new Set([
  'autoSwitch', 'pinnedRouteId', 'orderedRouteIds', 'allowRouteIds', 'denyRouteIds',
  'freeOnly', 'locality', 'maxInputPricePerMillionUsd', 'maxOutputPricePerMillionUsd',
]);
const OWNER_BUDGET_KEYS = new Set([
  ...DEFINITION_CEILING_KEYS,
  'maxCostUsd', 'inputPricePerMillionUsd', 'outputPricePerMillionUsd',
]);

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(value, label, max, min = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    throw new Error(label + ' has invalid length');
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array fields');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return '';
  return id(value, label);
}

function textValue(value, label, max, { optional = false } = {}) {
  if ((value === undefined || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max || value.includes('\0')) {
    throw new Error(label + ' must be exact bounded text');
  }
  return value;
}

function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function nextRevision(value, label) {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(label + ' cannot advance beyond MAX_SAFE_INTEGER');
  }
  return value + 1;
}

function configScalar(value, label) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(label + ' must be an exact scalar data value');
    return value;
  }
  if (typeof value === 'string') {
    if (value !== value.trim() || value.includes('\0')) throw new Error(label + ' must be an exact scalar data value');
    return value;
  }
  throw new Error(label + ' must be an exact scalar data value');
}

function compareId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ids(value, label, max, min = 0) {
  const out = denseArray(value, label, max, min).map((item, index) => id(item, label + '[' + index + ']'));
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicate identity');
  return Object.freeze([...out].sort(compareId));
}

function subset(requested, allowed, label) {
  const allowedSet = new Set(allowed);
  const missing = requested.filter(item => !allowedSet.has(item));
  if (missing.length) throw new Error(label + ' exceeds allowed authority: ' + missing.join(', '));
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function normalizeConfigDefaults(input) {
  if (input === undefined) return freeze({});
  const raw = record(input, CONFIG_DEFAULT_KEYS, 'AgentDefinitionV1.configDefaults');
  const safe = Object.create(null);
  for (const key of Object.keys(raw)) {
    safe[key] = configScalar(raw[key], 'AgentDefinitionV1.configDefaults.' + key);
  }
  const preview = normalizeBrowserAgentConfig({
    ...safe,
    goal: 'Reusable Agent definition preview',
  }, { id: 'agent-definition-preview' });
  const out = {};
  for (const key of CONFIG_DEFAULT_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    if (!Object.is(safe[key], preview[key])) {
      throw new Error('AgentDefinitionV1.configDefaults.' + key + ' must already be canonical');
    }
    out[key] = preview[key];
  }
  return freeze(out);
}

export function normalizeAgentModelRoutePolicyV1(input) {
  if (input === undefined || input === null) return null;
  const raw = record(input, MODEL_ROUTE_POLICY_KEYS, 'AgentDefinitionV1.modelRoutePolicy');
  const normalized = normalizeAiRoutePolicy(raw);
  for (const key of ['autoSwitch', 'freeOnly']) {
    if (Object.hasOwn(raw, key) && raw[key] !== normalized[key]) {
      throw new Error('AgentDefinitionV1.modelRoutePolicy.' + key + ' must already be canonical');
    }
  }
  for (const key of ['pinnedRouteId', 'locality']) {
    if (Object.hasOwn(raw, key) && raw[key] !== normalized[key]) {
      throw new Error('AgentDefinitionV1.modelRoutePolicy.' + key + ' must already be canonical');
    }
  }
  for (const key of ['maxInputPricePerMillionUsd', 'maxOutputPricePerMillionUsd']) {
    if (Object.hasOwn(raw, key)
        && (Object.is(raw[key], -0) || !Object.is(raw[key], normalized[key]))) {
      throw new Error('AgentDefinitionV1.modelRoutePolicy.' + key + ' must already be canonical');
    }
  }
  for (const key of ['orderedRouteIds', 'allowRouteIds', 'denyRouteIds']) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (!Array.isArray(value)
        || value.length !== normalized[key].length
        || value.some((item, index) => item !== normalized[key][index])) {
      throw new Error('AgentDefinitionV1.modelRoutePolicy.' + key + ' must already be canonical');
    }
  }
  return freeze({
    autoSwitch: normalized.autoSwitch,
    pinnedRouteId: normalized.pinnedRouteId,
    orderedRouteIds: [...normalized.orderedRouteIds],
    allowRouteIds: [...normalized.allowRouteIds],
    denyRouteIds: [...normalized.denyRouteIds],
    freeOnly: normalized.freeOnly,
    locality: normalized.locality,
    maxInputPricePerMillionUsd: normalized.maxInputPricePerMillionUsd,
    maxOutputPricePerMillionUsd: normalized.maxOutputPricePerMillionUsd,
  });
}

function normalizeOwnerBudget(input) {
  const raw = record(input, OWNER_BUDGET_KEYS, 'Agent definition owner budget');
  const safe = Object.create(null);
  for (const key of OWNER_BUDGET_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error('Agent definition owner budget is missing required field: ' + key);
    }
    safe[key] = configScalar(raw[key], 'Agent definition owner budget.' + key);
  }
  const preview = normalizeBrowserAgentConfig({
    ...safe,
    goal: 'Reusable Agent owner budget preview',
  }, { id: 'agent-definition-owner-budget-preview' });
  const out = {};
  for (const key of OWNER_BUDGET_KEYS) {
    if (!Object.is(safe[key], preview[key])) {
      throw new Error('Agent definition owner budget.' + key + ' must already be canonical');
    }
    out[key] = preview[key];
  }
  return freeze(out);
}

function intersectDefinitionCeiling(definitionDefaults, ownerBudget, key) {
  if (!Object.hasOwn(definitionDefaults, key)) return ownerBudget[key];
  const requested = definitionDefaults[key];
  const owner = ownerBudget[key];
  if (key === 'maxSteps' || key === 'maxOutputTokensPerCall') {
    return Math.min(requested, owner);
  }
  if (owner === 0) return requested;
  if (requested === 0) return owner;
  return Math.min(requested, owner);
}

function normalizeAcceptanceCriteria(input) {
  const values = denseArray(input, 'AgentDefinitionV1.acceptanceCriteria', 20)
    .map((value, index) => textValue(value, 'acceptanceCriteria[' + index + ']', 1000));
  const preview = normalizeBrowserAgentConfig({
    goal: 'Reusable Agent definition preview',
    acceptanceCriteria: values,
  }, { id: 'agent-definition-preview' });
  return Object.freeze([...preview.acceptanceCriteria]);
}

function canonicalDefinitionEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizeAgentDefinitionV1(input) {
  const raw = record(input, DEF_KEYS, 'AgentDefinitionV1');
  if (raw.schemaVersion !== AGENT_DEFINITION_VERSION) {
    throw new Error('AgentDefinitionV1.schemaVersion must be numeric 1');
  }
  const capabilityIds = ids(raw.capabilityIds, 'capabilityIds', 64);
  const toolIds = ids(raw.toolIds, 'toolIds', 128);
  let specialistDelegationProfile;
  if (Object.hasOwn(raw, 'specialistDelegationProfile')) {
    specialistDelegationProfile = raw.specialistDelegationProfile === null
      ? null
      : normalizeAgentSpecialistDelegationProfileV1(raw.specialistDelegationProfile);
    if (specialistDelegationProfile) {
      subset(
        specialistDelegationProfile.requiredCapabilityIds,
        capabilityIds,
        'Agent specialist delegation capabilities',
      );
      subset(
        specialistDelegationProfile.requiredToolIds,
        toolIds,
        'Agent specialist delegation tools',
      );
    }
  }
  return freeze({
    schemaVersion: AGENT_DEFINITION_VERSION,
    agentDefinitionId: id(raw.agentDefinitionId, 'agentDefinitionId'),
    label: textValue(raw.label, 'label', 160),
    description: textValue(raw.description, 'description', 4000, { optional: true }),
    instructions: textValue(raw.instructions, 'instructions', 12000),
    capabilityIds,
    toolIds,
    tags: ids(raw.tags, 'tags', 32),
    acceptanceCriteria: normalizeAcceptanceCriteria(raw.acceptanceCriteria),
    configDefaults: normalizeConfigDefaults(raw.configDefaults),
    modelRoutePolicy: normalizeAgentModelRoutePolicyV1(raw.modelRoutePolicy),
    ...(Object.hasOwn(raw, 'specialistDelegationProfile') ? { specialistDelegationProfile } : {}),
    enabled: bool(raw.enabled, 'enabled'),
    definitionRevision: positiveInteger(raw.definitionRevision, 'definitionRevision'),
  });
}

export function normalizeAgentDefinitionRegistryV1(input) {
  const raw = record(input, REGISTRY_KEYS, 'AgentDefinitionRegistryV1');
  if (raw.schemaVersion !== AGENT_DEFINITION_REGISTRY_VERSION) {
    throw new Error('AgentDefinitionRegistryV1.schemaVersion must be numeric 1');
  }
  const definitions = denseArray(raw.definitions, 'definitions', 128)
    .map(normalizeAgentDefinitionV1)
    .sort((left, right) => compareId(left.agentDefinitionId, right.agentDefinitionId));
  if (new Set(definitions.map(item => item.agentDefinitionId)).size !== definitions.length) {
    throw new Error('AgentDefinitionRegistryV1 contains duplicate agentDefinitionId');
  }
  return freeze({
    schemaVersion: AGENT_DEFINITION_REGISTRY_VERSION,
    registryId: id(raw.registryId, 'registryId'),
    revision: positiveInteger(raw.revision, 'registry revision'),
    definitions,
  });
}

export function normalizeAgentDefinitionSelectionV1(input) {
  const raw = record(input, SELECTION_KEYS, 'AgentDefinitionSelectionV1');
  if (raw.schemaVersion !== AGENT_DEFINITION_SELECTION_VERSION) {
    throw new Error('AgentDefinitionSelectionV1.schemaVersion must be numeric 1');
  }
  const definition = normalizeAgentDefinitionV1(raw.definition);
  const selection = {
    schemaVersion: AGENT_DEFINITION_SELECTION_VERSION,
    registryId: id(raw.registryId, 'registryId'),
    registryRevision: positiveInteger(raw.registryRevision, 'registryRevision'),
    agentDefinitionId: id(raw.agentDefinitionId, 'agentDefinitionId'),
    definitionRevision: positiveInteger(raw.definitionRevision, 'definitionRevision'),
    definition,
  };
  if (selection.agentDefinitionId !== definition.agentDefinitionId
    || selection.definitionRevision !== definition.definitionRevision) {
    throw new Error('AgentDefinitionSelectionV1 identity does not match definition snapshot');
  }
  return freeze(selection);
}

export function selectAgentDefinitionV1(input = {}) {
  const raw = record(input, SELECT_REQUEST_KEYS, 'Agent definition selection request');
  const registry = normalizeAgentDefinitionRegistryV1(raw.registry);
  const agentDefinitionId = id(raw.agentDefinitionId, 'agentDefinitionId');
  const definition = registry.definitions.find(item => item.agentDefinitionId === agentDefinitionId);
  if (!definition || !definition.enabled) throw new Error('Agent definition is missing or disabled');
  return normalizeAgentDefinitionSelectionV1({
    schemaVersion: AGENT_DEFINITION_SELECTION_VERSION,
    registryId: registry.registryId,
    registryRevision: registry.revision,
    agentDefinitionId: definition.agentDefinitionId,
    definitionRevision: definition.definitionRevision,
    definition,
  });
}

export function discoverAgentDefinitionsV1(input = {}) {
  const raw = record(input, DISCOVER_KEYS, 'Agent definition discovery request');
  const registry = normalizeAgentDefinitionRegistryV1(raw.registry);
  const requiredTags = ids(raw.requiredTags === undefined ? [] : raw.requiredTags, 'requiredTags', 32);
  const requiredCapabilityIds = ids(
    raw.requiredCapabilityIds === undefined ? [] : raw.requiredCapabilityIds,
    'requiredCapabilityIds',
    64,
  );
  const requiredToolIds = ids(raw.requiredToolIds === undefined ? [] : raw.requiredToolIds, 'requiredToolIds', 128);
  const containsAll = (available, required) => required.every(item => available.includes(item));
  const definitions = registry.definitions
    .filter(item => item.enabled)
    .filter(item => containsAll(item.tags, requiredTags))
    .filter(item => containsAll(item.capabilityIds, requiredCapabilityIds))
    .filter(item => containsAll(item.toolIds, requiredToolIds))
    .map(item => freeze({
      agentDefinitionId: item.agentDefinitionId,
      definitionRevision: item.definitionRevision,
      label: item.label,
      description: item.description,
      tags: item.tags,
      capabilityIds: item.capabilityIds,
      toolIds: item.toolIds,
    }));
  return freeze({
    schemaVersion: 1,
    registryId: registry.registryId,
    registryRevision: registry.revision,
    requiredTags,
    requiredCapabilityIds,
    requiredToolIds,
    definitions,
    authority: {
      permissionGranted: false,
      executionAuthorized: false,
    },
  });
}

export function materializeAgentDefinitionV1(input = {}) {
  const raw = record(input, MATERIALIZE_KEYS, 'Agent definition materialization request');
  const registry = normalizeAgentDefinitionRegistryV1(raw.registry);
  const selection = normalizeAgentDefinitionSelectionV1(raw.selection);
  const current = registry.definitions.find(item => item.agentDefinitionId === selection.agentDefinitionId);
  if (selection.registryId !== registry.registryId || selection.registryRevision !== registry.revision) {
    throw new Error('Agent definition registry identity or revision drifted');
  }
  if (!current || !current.enabled) throw new Error('Selected Agent definition is missing or disabled');
  if (selection.definitionRevision !== current.definitionRevision
    || !canonicalDefinitionEqual(selection.definition, current)) {
    throw new Error('Selected Agent definition drifted from current registry definition');
  }

  const ownerBudget = normalizeOwnerBudget(raw.ownerBudget);
  const ownerCapabilityIds = ids(raw.ownerCapabilityIds, 'ownerCapabilityIds', 64);
  const ownerToolIds = ids(raw.ownerToolIds, 'ownerToolIds', 128);
  const requestedCapabilityIds = ids(raw.requestedCapabilityIds, 'requestedCapabilityIds', 64);
  const requestedToolIds = ids(raw.requestedToolIds, 'requestedToolIds', 128);
  subset(requestedCapabilityIds, ownerCapabilityIds, 'Requested Agent capabilities');
  subset(requestedCapabilityIds, current.capabilityIds, 'Requested Agent capabilities');
  subset(requestedToolIds, ownerToolIds, 'Requested Agent tools');
  subset(requestedToolIds, current.toolIds, 'Requested Agent tools');

  const jobId = id(raw.jobId, 'jobId');
  const projectId = optionalId(raw.projectId, 'projectId');

  let specialistDelegationBinding;
  if (current.specialistDelegationProfile) {
    if (current.specialistDelegationProfile.enabled) {
      subset(
        current.specialistDelegationProfile.requiredCapabilityIds,
        requestedCapabilityIds,
        'Agent specialist delegation capabilities for materialized job',
      );
      subset(
        current.specialistDelegationProfile.requiredToolIds,
        requestedToolIds,
        'Agent specialist delegation tools for materialized job',
      );
    }
    specialistDelegationBinding = freeze({
      schemaVersion: 1,
      jobId,
      projectId,
      registryId: registry.registryId,
      registryRevision: registry.revision,
      agentDefinitionId: current.agentDefinitionId,
      definitionRevision: current.definitionRevision,
      profile: current.specialistDelegationProfile,
      authority: {
        proposalOnly: true,
        executionAuthorized: false,
        policyAuthorized: false,
        schedulingAuthorized: false,
        recoveryAuthorized: false,
        credentialAuthorized: false,
        completionAuthorized: false,
        verificationAuthorized: false,
        capacityReserved: false,
      },
    });
  }

  const ownerGoal = textValue(raw.goal, 'goal', 50000);
  const composedGoal = 'Reusable Agent definition instructions:\n'
    + current.instructions
    + '\n\nOwner task:\n'
    + ownerGoal;
  if (composedGoal.length > 50000) throw new Error('Materialized Agent goal exceeds Browser Agent limit');

  const effectiveBudget = {};
  for (const key of DEFINITION_CEILING_KEYS) {
    effectiveBudget[key] = intersectDefinitionCeiling(current.configDefaults, ownerBudget, key);
  }
  effectiveBudget.maxCostUsd = ownerBudget.maxCostUsd;
  effectiveBudget.inputPricePerMillionUsd = ownerBudget.inputPricePerMillionUsd;
  effectiveBudget.outputPricePerMillionUsd = ownerBudget.outputPricePerMillionUsd;

  const config = normalizeBrowserAgentConfig({
    ...current.configDefaults,
    ...effectiveBudget,
    id: jobId,
    projectId,
    name: current.label,
    goal: composedGoal,
    acceptanceCriteria: current.acceptanceCriteria,
  }, { id: jobId });

  if (config.approvalMode !== 'CONSEQUENTIAL'
    || config.credentialDecision !== 'ASK'
    || config.trustedScriptEnabled !== false
    || config.siteRules.length !== 0) {
    throw new Error('Reusable Agent definition attempted to mint owner policy authority');
  }

  return freeze({
    schemaVersion: 1,
    definitionBinding: {
      registryId: registry.registryId,
      registryRevision: registry.revision,
      agentDefinitionId: current.agentDefinitionId,
      definitionRevision: current.definitionRevision,
    },
    config,
    routerOverride: current.modelRoutePolicy
      ? freeze({ routePolicy: current.modelRoutePolicy })
      : freeze({}),
    ...(specialistDelegationBinding ? { specialistDelegationBinding } : {}),
    scope: {
      capabilityIds: requestedCapabilityIds,
      toolIds: requestedToolIds,
    },
    authority: {
      executionAuthorized: false,
      policyAuthorized: false,
      schedulingAuthorized: false,
      recoveryAuthorized: false,
      credentialAuthorized: false,
      completionAuthorized: false,
      verificationAuthorized: false,
    },
  });
}


/**
 * Builds the next canonical AgentDefinitionRegistry snapshot under exact
 * compare-and-swap revision guards. This is deliberately a pure proposal:
 * callers must persist it through the existing durable storage/update
 * authority after re-checking the same expected revision.
 */
export function proposeAgentDefinitionRegistryMutationV1(input = {}) {
  const raw = record(input, MUTATION_KEYS, 'Agent definition registry mutation request');
  const registry = normalizeAgentDefinitionRegistryV1(raw.registry);
  const registryId = id(raw.registryId, 'registryId');
  if (registryId !== registry.registryId) {
    throw new Error('Agent definition registry identity does not match mutation target');
  }
  const expectedRegistryRevision = positiveInteger(
    raw.expectedRegistryRevision,
    'expectedRegistryRevision',
  );
  if (expectedRegistryRevision !== registry.revision) {
    throw new Error('Agent definition registry revision drifted before mutation');
  }
  if (typeof raw.kind !== 'string' || !MUTATION_KINDS.has(raw.kind)) {
    throw new Error('Agent definition registry mutation kind is invalid');
  }

  const nextRegistryRevision = nextRevision(registry.revision, 'Agent definition registry revision');
  let nextDefinitions;
  let agentDefinitionId;
  let previousDefinitionRevision = 0;
  let nextDefinitionRevision = 0;

  if (raw.kind === AgentDefinitionRegistryMutationKind.CREATE) {
    if (!Object.hasOwn(raw, 'definition')) {
      throw new Error('CREATE mutation requires definition');
    }
    if (Object.hasOwn(raw, 'agentDefinitionId') || Object.hasOwn(raw, 'expectedDefinitionRevision')) {
      throw new Error('CREATE mutation must not supply existing-definition identity');
    }
    const definition = normalizeAgentDefinitionV1(raw.definition);
    agentDefinitionId = definition.agentDefinitionId;
    if (definition.definitionRevision !== 1) {
      throw new Error('CREATE mutation requires definitionRevision 1');
    }
    if (registry.definitions.some(item => item.agentDefinitionId === agentDefinitionId)) {
      throw new Error('CREATE mutation target already exists');
    }
    nextDefinitionRevision = 1;
    nextDefinitions = [...registry.definitions, definition];
  } else if (raw.kind === AgentDefinitionRegistryMutationKind.UPDATE) {
    if (!Object.hasOwn(raw, 'definition')
      || !Object.hasOwn(raw, 'agentDefinitionId')
      || !Object.hasOwn(raw, 'expectedDefinitionRevision')) {
      throw new Error('UPDATE mutation requires agentDefinitionId, definition and expectedDefinitionRevision');
    }
    agentDefinitionId = id(raw.agentDefinitionId, 'agentDefinitionId');
    const definition = normalizeAgentDefinitionV1(raw.definition);
    if (definition.agentDefinitionId !== agentDefinitionId) {
      throw new Error('UPDATE mutation definition identity does not match target');
    }
    const current = registry.definitions.find(item => item.agentDefinitionId === agentDefinitionId);
    if (!current) throw new Error('UPDATE mutation target does not exist');
    const expectedDefinitionRevision = positiveInteger(
      raw.expectedDefinitionRevision,
      'expectedDefinitionRevision',
    );
    if (expectedDefinitionRevision !== current.definitionRevision) {
      throw new Error('Agent definition revision drifted before update');
    }
    previousDefinitionRevision = current.definitionRevision;
    nextDefinitionRevision = nextRevision(current.definitionRevision, 'Agent definition revision');
    if (definition.definitionRevision !== nextDefinitionRevision) {
      throw new Error('UPDATE mutation must increment definitionRevision exactly once');
    }
    nextDefinitions = registry.definitions.map(item => (
      item.agentDefinitionId === agentDefinitionId ? definition : item
    ));
  } else {
    if (!Object.hasOwn(raw, 'agentDefinitionId') || !Object.hasOwn(raw, 'expectedDefinitionRevision')) {
      throw new Error('DELETE mutation requires agentDefinitionId and expectedDefinitionRevision');
    }
    if (Object.hasOwn(raw, 'definition')) {
      throw new Error('DELETE mutation must not supply definition');
    }
    agentDefinitionId = id(raw.agentDefinitionId, 'agentDefinitionId');
    const current = registry.definitions.find(item => item.agentDefinitionId === agentDefinitionId);
    if (!current) throw new Error('DELETE mutation target does not exist');
    const expectedDefinitionRevision = positiveInteger(
      raw.expectedDefinitionRevision,
      'expectedDefinitionRevision',
    );
    if (expectedDefinitionRevision !== current.definitionRevision) {
      throw new Error('Agent definition revision drifted before delete');
    }
    previousDefinitionRevision = current.definitionRevision;
    nextDefinitions = registry.definitions.filter(item => item.agentDefinitionId !== agentDefinitionId);
  }

  const nextRegistry = normalizeAgentDefinitionRegistryV1({
    schemaVersion: AGENT_DEFINITION_REGISTRY_VERSION,
    registryId: registry.registryId,
    revision: nextRegistryRevision,
    definitions: nextDefinitions,
  });

  return freeze({
    schemaVersion: AGENT_DEFINITION_REGISTRY_MUTATION_VERSION,
    kind: raw.kind,
    registryId: registry.registryId,
    previousRegistryRevision: registry.revision,
    nextRegistryRevision,
    agentDefinitionId,
    previousDefinitionRevision,
    nextDefinitionRevision,
    nextRegistry,
    authority: {
      persistenceAuthorized: false,
      executionAuthorized: false,
      policyAuthorized: false,
      schedulingAuthorized: false,
      recoveryAuthorized: false,
    },
  });
}
