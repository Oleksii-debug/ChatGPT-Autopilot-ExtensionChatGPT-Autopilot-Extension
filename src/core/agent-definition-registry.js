import { normalizeBrowserAgentConfig } from './browser-agent.js';

export const AGENT_DEFINITION_VERSION = 1;
export const AGENT_DEFINITION_REGISTRY_VERSION = 1;
export const AGENT_DEFINITION_SELECTION_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const DEF_KEYS = new Set([
  'schemaVersion', 'agentDefinitionId', 'label', 'description', 'instructions',
  'capabilityIds', 'toolIds', 'acceptanceCriteria', 'configDefaults', 'enabled',
  'definitionRevision',
]);
const REGISTRY_KEYS = new Set(['schemaVersion', 'registryId', 'revision', 'definitions']);
const SELECT_REQUEST_KEYS = new Set(['registry', 'agentDefinitionId']);
const SELECTION_KEYS = new Set([
  'schemaVersion', 'registryId', 'registryRevision', 'agentDefinitionId',
  'definitionRevision', 'definition',
]);
const MATERIALIZE_KEYS = new Set([
  'registry', 'selection', 'jobId', 'goal', 'projectId',
  'ownerCapabilityIds', 'ownerToolIds', 'requestedCapabilityIds', 'requestedToolIds',
]);
const CONFIG_DEFAULT_KEYS = new Set([
  'startUrl', 'startFromActiveTab', 'maxSteps', 'stepDelayMs',
  'allowCrossOriginNavigation', 'closeOwnedTabsOnStop', 'visionOnDemand',
  'maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens',
  'maxOutputTokensPerCall', 'maxRuntimeMinutes', 'maxCostUsd',
  'inputPricePerMillionUsd', 'outputPricePerMillionUsd',
  'aiRoutingMode', 'aiPrimaryProvider', 'aiPrimaryModel',
  'aiStrongProvider', 'aiStrongModel', 'repeatMode', 'intervalSeconds',
  'activeWindowStart', 'activeWindowEnd',
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
  const preview = normalizeBrowserAgentConfig({
    ...raw,
    goal: 'Reusable Agent definition preview',
  }, { id: 'agent-definition-preview' });
  const out = {};
  for (const key of CONFIG_DEFAULT_KEYS) {
    if (Object.hasOwn(raw, key)) out[key] = preview[key];
  }
  return freeze(out);
}

function normalizeAcceptanceCriteria(input) {
  const values = denseArray(input, 'AgentDefinitionV1.acceptanceCriteria', 20);
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
  return freeze({
    schemaVersion: AGENT_DEFINITION_VERSION,
    agentDefinitionId: id(raw.agentDefinitionId, 'agentDefinitionId'),
    label: textValue(raw.label, 'label', 300),
    description: textValue(raw.description, 'description', 4000, { optional: true }),
    instructions: textValue(raw.instructions, 'instructions', 12000),
    capabilityIds: ids(raw.capabilityIds, 'capabilityIds', 64),
    toolIds: ids(raw.toolIds, 'toolIds', 128),
    acceptanceCriteria: normalizeAcceptanceCriteria(raw.acceptanceCriteria),
    configDefaults: normalizeConfigDefaults(raw.configDefaults),
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
  const ownerGoal = textValue(raw.goal, 'goal', 50000);
  const composedGoal = 'Reusable Agent definition instructions:\n'
    + current.instructions
    + '\n\nOwner task:\n'
    + ownerGoal;
  if (composedGoal.length > 50000) throw new Error('Materialized Agent goal exceeds Browser Agent limit');

  const config = normalizeBrowserAgentConfig({
    ...current.configDefaults,
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
