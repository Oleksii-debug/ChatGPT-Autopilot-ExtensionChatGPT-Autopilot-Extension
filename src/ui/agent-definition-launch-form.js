const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

export const AGENT_DEFINITION_OWNER_BUDGET_KEYS = Object.freeze([
  'maxSteps',
  'maxModelCalls',
  'maxInputTokens',
  'maxOutputTokens',
  'maxTotalTokens',
  'maxOutputTokensPerCall',
  'maxRuntimeMinutes',
  'maxCostUsd',
  'inputPricePerMillionUsd',
  'outputPricePerMillionUsd',
]);

function plainDataRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains a symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedText(value, label, max, { optional = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const text = value.trim();
  if (!text && !optional) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} is too long`);
  return text;
}

function canonicalIdsFromText(value, label, max) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const items = value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean);
  if (items.length > max) throw new Error(`${label} exceeds ${max} entries`);
  const seen = new Set();
  for (const item of items) {
    if (!ID.test(item)) throw new Error(`${label} contains an invalid identity: ${item}`);
    if (seen.has(item)) throw new Error(`${label} contains a duplicate identity: ${item}`);
    seen.add(item);
  }
  return [...items].sort();
}

function canonicalDefinitionIds(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }
  if (value.length > max) throw new Error(`${label} exceeds ${max} entries`);
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || !ID.test(item)) throw new Error(`${label} contains an invalid identity`);
    if (out.includes(item)) throw new Error(`${label} contains duplicate identities`);
    out.push(item);
  }
  return out;
}

function requireSubset(items, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const item of items) {
    if (!allowedSet.has(item)) throw new Error(`${label} exceeds the selected Agent definition authority: ${item}`);
  }
}

export function agentDefinitionOwnerBudgetFromPolicyV1(policy) {
  const raw = plainDataRecord(policy, 'Agent owner policy');
  const out = Object.create(null);
  for (const key of AGENT_DEFINITION_OWNER_BUDGET_KEYS) {
    if (!Object.hasOwn(raw, key)) throw new Error(`Agent owner policy requires ${key}`);
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) || value < 0) {
      throw new Error(`Agent owner policy ${key} must be a canonical non-negative number`);
    }
    if (key !== 'maxCostUsd'
        && key !== 'inputPricePerMillionUsd'
        && key !== 'outputPricePerMillionUsd'
        && !Number.isSafeInteger(value)) {
      throw new Error(`Agent owner policy ${key} must be a non-negative safe integer`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

export function agentDefinitionLaunchScopeTextV1(definition) {
  const raw = plainDataRecord(definition, 'Agent definition');
  const capabilityIds = canonicalDefinitionIds(raw.capabilityIds, 'Agent definition capabilityIds', 64);
  const toolIds = canonicalDefinitionIds(raw.toolIds, 'Agent definition toolIds', 128);
  return Object.freeze({
    ownerCapabilityIdsText: capabilityIds.join('\n'),
    ownerToolIdsText: toolIds.join('\n'),
    requestedCapabilityIdsText: capabilityIds.join('\n'),
    requestedToolIdsText: toolIds.join('\n'),
  });
}

export function buildAgentDefinitionLaunchRequestV1(form, {
  registry,
  definition,
  ownerPolicy,
} = {}) {
  const raw = plainDataRecord(form, 'Agent definition launch form');
  const registryRaw = plainDataRecord(registry, 'Agent definition registry');
  const definitionRaw = plainDataRecord(definition, 'Agent definition');

  const registryId = boundedText(registryRaw.registryId, 'Agent definition registryId', 180);
  if (!ID.test(registryId)) throw new Error('Agent definition registryId is invalid');
  const expectedRegistryRevision = exactPositiveInteger(
    registryRaw.revision,
    'Agent definition registry revision',
  );

  const agentDefinitionId = boundedText(
    definitionRaw.agentDefinitionId,
    'Agent definition ID',
    180,
  );
  if (!ID.test(agentDefinitionId)) throw new Error('Agent definition ID is invalid');
  const expectedDefinitionRevision = exactPositiveInteger(
    definitionRaw.definitionRevision,
    'Agent definition revision',
  );
  if (definitionRaw.enabled !== true) throw new Error('Selected Agent definition is disabled');

  const definitionCapabilityIds = canonicalDefinitionIds(
    definitionRaw.capabilityIds,
    'Agent definition capabilityIds',
    64,
  );
  const definitionToolIds = canonicalDefinitionIds(
    definitionRaw.toolIds,
    'Agent definition toolIds',
    128,
  );

  const ownerCapabilityIds = canonicalIdsFromText(
    raw.ownerCapabilityIdsText,
    'Owner capability grants',
    64,
  );
  const ownerToolIds = canonicalIdsFromText(raw.ownerToolIdsText, 'Owner tool grants', 128);
  const requestedCapabilityIds = canonicalIdsFromText(
    raw.requestedCapabilityIdsText,
    'Requested capability narrowing',
    64,
  );
  const requestedToolIds = canonicalIdsFromText(
    raw.requestedToolIdsText,
    'Requested tool narrowing',
    128,
  );

  requireSubset(ownerCapabilityIds, definitionCapabilityIds, 'Owner capability grants');
  requireSubset(ownerToolIds, definitionToolIds, 'Owner tool grants');
  requireSubset(requestedCapabilityIds, ownerCapabilityIds, 'Requested capability narrowing');
  requireSubset(requestedToolIds, ownerToolIds, 'Requested tool narrowing');

  const request = {
    registryId,
    expectedRegistryRevision,
    agentDefinitionId,
    expectedDefinitionRevision,
    goal: boundedText(raw.goal, 'Owner task', 50000),
    projectId: boundedText(raw.projectId || '', 'Project ID', 180, { optional: true }),
    ownerBudget: agentDefinitionOwnerBudgetFromPolicyV1(ownerPolicy),
    ownerCapabilityIds,
    ownerToolIds,
    requestedCapabilityIds,
    requestedToolIds,
  };

  const jobId = boundedText(raw.jobId || '', 'Job ID', 128, { optional: true });
  if (jobId) request.jobId = jobId;

  return Object.freeze(request);
}
