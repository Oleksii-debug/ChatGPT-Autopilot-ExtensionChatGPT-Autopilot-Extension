import { normalizeBrowserAgentConfig } from './browser-agent.js';

export const AGENT_DEFINITION_VERSION = 1;
export const AGENT_DEFINITION_CATALOG_VERSION = 1;
export const AGENT_DEFINITION_BINDING_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const DEF_KEYS = new Set(['schemaVersion', 'definitionId', 'revision', 'name', 'description', 'goal', 'policy', 'tags', 'enabled']);
const CATALOG_KEYS = new Set(['schemaVersion', 'catalogId', 'revision', 'definitions']);
const BIND_KEYS = new Set(['catalog', 'definitionId', 'expectedDefinitionRevision', 'jobId', 'projectId', 'name', 'goal']);
const POLICY_KEYS = new Set([
  'startUrl', 'startFromActiveTab', 'maxSteps', 'stepDelayMs',
  'allowCrossOriginNavigation', 'closeOwnedTabsOnStop', 'approvalMode',
  'credentialDecision', 'siteRules', 'visionOnDemand', 'trustedScriptEnabled',
  'acceptanceCriteria', 'repeatMode', 'intervalSeconds', 'scheduleStartAt',
  'scheduleEndAt', 'activeWindowStart', 'activeWindowEnd', 'aiRoutingMode',
  'aiPrimaryProvider', 'aiPrimaryModel', 'aiStrongProvider', 'aiStrongModel',
  'aiPinnedRouteId',
  'maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens',
  'maxOutputTokensPerCall', 'maxRuntimeMinutes', 'maxCostUsd',
  'inputPricePerMillionUsd', 'outputPricePerMillionUsd',
]);
const MAX_DATA_DEPTH = 8;
const MAX_DATA_NODES = 4096;

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be a plain data object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(label + ' must be a plain data object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(label + ' contains unknown field: ' + String(key));
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error(label + ' must be a canonical array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) throw new Error(label + ' has invalid length');
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) throw new Error(label + ' contains non-canonical array fields');
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

function snapshotData(value, label, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_DATA_NODES) throw new Error(label + ' exceeds the portable data node limit');
  if (depth > MAX_DATA_DEPTH) throw new Error(label + ' exceeds the portable data depth limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(label + ' contains a non-canonical number');
    return value;
  }
  if (typeof value !== 'object') throw new Error(label + ' contains unsupported portable data');
  if (Array.isArray(value)) {
    return denseArray(value, label, 512).map((item, index) => snapshotData(item, label + '[' + index + ']', state, depth + 1));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(label + ' contains a non-plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' contains symbol data');
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    out[key] = snapshotData(descriptor.value, label + '.' + key, state, depth + 1);
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function text(value, label, max, { optional = false } = {}) {
  if ((value === undefined || value === '') && optional) return '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(label + ' must be bounded text');
  const normalized = value.trim();
  if (!normalized && !optional) throw new Error(label + ' is required');
  return normalized;
}

function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) throw new Error(label + ' is invalid');
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function compareId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function normalizeTags(raw) {
  const tags = denseArray(raw, 'AgentDefinitionV1.tags', 32)
    .map((value, index) => exactId(value, 'AgentDefinitionV1.tags[' + index + ']'))
    .sort(compareId);
  if (new Set(tags).size !== tags.length) throw new Error('AgentDefinitionV1.tags contains duplicate identity');
  return Object.freeze(tags);
}

function normalizePortablePolicy(rawPolicy) {
  const raw = record(rawPolicy, POLICY_KEYS, 'AgentDefinitionV1.policy');
  const safe = Object.create(null);
  const inputState = { nodes: 0 };
  for (const key of Object.keys(raw)) safe[key] = snapshotData(raw[key], 'AgentDefinitionV1.policy.' + key, inputState);
  const config = normalizeBrowserAgentConfig({
    ...safe,
    id: 'agent-definition-policy',
    projectId: '',
    name: 'Reusable Agent',
    goal: '',
  }, { id: 'agent-definition-policy' });
  const policy = Object.create(null);
  const outputState = { nodes: 0 };
  for (const key of POLICY_KEYS) {
    if (Object.hasOwn(config, key)) policy[key] = snapshotData(config[key], 'Canonical Agent policy.' + key, outputState);
  }
  return freeze(policy);
}

export function normalizeAgentDefinitionV1(input) {
  const raw = record(input, DEF_KEYS, 'AgentDefinitionV1');
  if (raw.schemaVersion !== AGENT_DEFINITION_VERSION) throw new Error('AgentDefinitionV1.schemaVersion must be numeric 1');
  return freeze({
    schemaVersion: 1,
    definitionId: exactId(raw.definitionId, 'AgentDefinitionV1.definitionId'),
    revision: positiveInteger(raw.revision, 'AgentDefinitionV1.revision'),
    name: text(raw.name, 'AgentDefinitionV1.name', 160),
    description: text(raw.description, 'AgentDefinitionV1.description', 4000, { optional: true }),
    goal: text(raw.goal, 'AgentDefinitionV1.goal', 50000, { optional: true }),
    policy: normalizePortablePolicy(raw.policy),
    tags: normalizeTags(raw.tags),
    enabled: bool(raw.enabled, 'AgentDefinitionV1.enabled'),
  });
}

export function normalizeAgentDefinitionCatalogV1(input) {
  const raw = record(input, CATALOG_KEYS, 'AgentDefinitionCatalogV1');
  if (raw.schemaVersion !== AGENT_DEFINITION_CATALOG_VERSION) throw new Error('AgentDefinitionCatalogV1.schemaVersion must be numeric 1');
  const definitions = denseArray(raw.definitions, 'AgentDefinitionCatalogV1.definitions', 256)
    .map(normalizeAgentDefinitionV1)
    .sort((left, right) => compareId(left.definitionId, right.definitionId));
  if (new Set(definitions.map(item => item.definitionId)).size !== definitions.length) {
    throw new Error('AgentDefinitionCatalogV1 contains duplicate definitionId');
  }
  return freeze({
    schemaVersion: 1,
    catalogId: exactId(raw.catalogId, 'AgentDefinitionCatalogV1.catalogId'),
    revision: positiveInteger(raw.revision, 'AgentDefinitionCatalogV1.revision'),
    definitions,
  });
}

export function instantiateAgentDefinitionV1(input) {
  const raw = record(input, BIND_KEYS, 'AgentDefinition instantiate request');
  const catalog = normalizeAgentDefinitionCatalogV1(raw.catalog);
  const definitionId = exactId(raw.definitionId, 'definitionId');
  const expectedRevision = positiveInteger(raw.expectedDefinitionRevision, 'expectedDefinitionRevision');
  const definition = catalog.definitions.find(item => item.definitionId === definitionId);
  if (!definition || !definition.enabled) throw new Error('Reusable Agent definition is missing or disabled');
  if (definition.revision !== expectedRevision) throw new Error('Reusable Agent definition revision drifted before instantiation');
  const goal = raw.goal === undefined ? definition.goal : text(raw.goal, 'goal', 50000, { optional: true });
  if (!goal) throw new Error('Reusable Agent instantiation requires a goal');
  const name = raw.name === undefined ? definition.name : text(raw.name, 'name', 160);
  const jobId = exactId(raw.jobId, 'jobId');
  const projectId = raw.projectId === undefined ? '' : raw.projectId;
  const config = normalizeBrowserAgentConfig({
    ...definition.policy,
    id: jobId,
    projectId,
    name,
    goal,
  }, { id: jobId });
  return freeze({
    schemaVersion: AGENT_DEFINITION_BINDING_VERSION,
    definitionRef: {
      catalogId: catalog.catalogId,
      catalogRevision: catalog.revision,
      definitionId: definition.definitionId,
      definitionRevision: definition.revision,
    },
    config,
  });
}
