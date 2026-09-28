import { assertSpecialistHandoffScopedV1 } from './universal-agent-contracts.js';

const VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_SPECIALISTS = 256;
const MAX_CAPABILITIES = 64;
const MAX_TASK_KINDS = 64;
const MAX_LABEL_LENGTH = 512;

const REGISTRY_KEYS = new Set(['schemaVersion', 'revision', 'bindingKey', 'specialists']);
const DEFINITION_KEYS = new Set([
  'schemaVersion',
  'specialistId',
  'providerId',
  'label',
  'enabled',
  'priority',
  'maxConcurrentAssignments',
  'capabilityIds',
  'taskKinds',
]);
const PUT_KEYS = new Set(['registry', 'expectedRevision', 'expectedBindingKey', 'definition']);
const SELECT_KEYS = new Set([
  'registry',
  'taskKind',
  'requiredCapabilityIds',
  'allowedSpecialistIds',
  'allowedProviderIds',
]);
const HANDOFF_BIND_KEYS = new Set([
  'registry',
  'expectedRegistryRevision',
  'expectedRegistryBindingKey',
  'handoff',
  'allowedSpecialistIds',
  'allowedProviderIds',
]);

function fail(code) {
  throw new Error(code);
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}_PLAIN_OBJECT_REQUIRED`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label}_PLAIN_OBJECT_REQUIRED`);

  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label}_UNKNOWN_FIELD`);
  const out = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${label}_DATA_FIELD_REQUIRED`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${label}_UNKNOWN_FIELD`);
  }
}

function schemaVersion(value, label) {
  if (value !== VERSION) fail(`${label}_SCHEMA_VERSION`);
  return VERSION;
}

function canonicalId(value, label) {
  if (typeof value !== 'string') fail(`${label}_INVALID`);
  if (value !== value.trim() || !ID.test(value)) fail(`${label}_INVALID`);
  return value;
}

function exactBindingKey(value, label) {
  if (typeof value !== 'string' || !value.length) fail(`${label}_INVALID`);
  return value;
}

function boundedText(value, label, maxLength) {
  if (typeof value !== 'string') fail(`${label}_INVALID`);
  const text = value.trim();
  if (!text || text.length > maxLength) fail(`${label}_INVALID`);
  return text;
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label}_INVALID`);
  return value;
}

function boundedInteger(value, label, min, max) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    fail(`${label}_INVALID`);
  }
  return value;
}

function denseArray(value, label, maxItems) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label}_ARRAY_REQUIRED`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > maxItems) {
    fail(`${label}_ARRAY_INVALID`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) fail(`${label}_ARRAY_DECORATED`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${label}_ARRAY_DATA_ONLY`);
    }
  }
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${label}_ARRAY_DENSE_REQUIRED`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function canonicalIdList(value, label, maxItems) {
  const items = denseArray(value, label, maxItems).map((item, index) => canonicalId(item, `${label}_${index}`));
  if (new Set(items).size !== items.length) fail(`${label}_DUPLICATE`);
  items.sort(compareText);
  return Object.freeze(items);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function normalizeDefinition(value) {
  const raw = plain(value, 'SPECIALIST_DEFINITION');
  exactKeys(raw, DEFINITION_KEYS, 'SPECIALIST_DEFINITION');
  const definition = {
    schemaVersion: schemaVersion(raw.schemaVersion, 'SPECIALIST_DEFINITION'),
    specialistId: canonicalId(raw.specialistId, 'SPECIALIST_ID'),
    providerId: canonicalId(raw.providerId, 'SPECIALIST_PROVIDER_ID'),
    label: boundedText(raw.label, 'SPECIALIST_LABEL', MAX_LABEL_LENGTH),
    enabled: exactBoolean(raw.enabled, 'SPECIALIST_ENABLED'),
    priority: boundedInteger(raw.priority, 'SPECIALIST_PRIORITY', 0, 1_000_000),
    maxConcurrentAssignments: boundedInteger(
      raw.maxConcurrentAssignments,
      'SPECIALIST_MAX_CONCURRENT_ASSIGNMENTS',
      1,
      1024,
    ),
    capabilityIds: canonicalIdList(raw.capabilityIds, 'SPECIALIST_CAPABILITY_IDS', MAX_CAPABILITIES),
    taskKinds: canonicalIdList(raw.taskKinds, 'SPECIALIST_TASK_KINDS', MAX_TASK_KINDS),
  };
  if (!definition.capabilityIds.length) fail('SPECIALIST_CAPABILITY_IDS_EMPTY');
  if (!definition.taskKinds.length) fail('SPECIALIST_TASK_KINDS_EMPTY');
  return freeze(definition);
}

function definitionProjection(definition) {
  return [
    definition.schemaVersion,
    definition.specialistId,
    definition.providerId,
    definition.label,
    definition.enabled,
    definition.priority,
    definition.maxConcurrentAssignments,
    definition.capabilityIds,
    definition.taskKinds,
  ];
}

function registryBindingKey(revision, specialists) {
  return JSON.stringify([
    VERSION,
    revision,
    specialists.map(definitionProjection),
  ]);
}

function registrySnapshot(revision, specialists) {
  const bindingKey = registryBindingKey(revision, specialists);
  return freeze({
    schemaVersion: VERSION,
    revision,
    bindingKey,
    specialists,
  });
}

function sameDefinition(left, right) {
  return JSON.stringify(definitionProjection(left)) === JSON.stringify(definitionProjection(right));
}

export function createEmptySpecialistRegistryV1() {
  return registrySnapshot(0, []);
}

export function normalizeSpecialistDefinitionV1(value) {
  return normalizeDefinition(value);
}

export function normalizeSpecialistRegistryV1(value) {
  const raw = plain(value, 'SPECIALIST_REGISTRY');
  exactKeys(raw, REGISTRY_KEYS, 'SPECIALIST_REGISTRY');
  const revision = boundedInteger(raw.revision, 'SPECIALIST_REGISTRY_REVISION', 0, Number.MAX_SAFE_INTEGER);
  const specialistValues = denseArray(raw.specialists, 'SPECIALIST_REGISTRY_SPECIALISTS', MAX_SPECIALISTS);
  const specialists = specialistValues.map(normalizeDefinition);
  const seen = new Set();
  for (const definition of specialists) {
    if (seen.has(definition.specialistId)) fail('SPECIALIST_REGISTRY_DUPLICATE_ID');
    seen.add(definition.specialistId);
  }
  specialists.sort((a, b) => compareText(a.specialistId, b.specialistId));
  schemaVersion(raw.schemaVersion, 'SPECIALIST_REGISTRY');
  const expectedBindingKey = registryBindingKey(revision, specialists);
  if (exactBindingKey(raw.bindingKey, 'SPECIALIST_REGISTRY_BINDING_KEY') !== expectedBindingKey) {
    fail('SPECIALIST_REGISTRY_BINDING_KEY_INCONSISTENT');
  }
  return registrySnapshot(revision, specialists);
}

export function putSpecialistDefinitionV1(input) {
  const raw = plain(input, 'SPECIALIST_PUT');
  exactKeys(raw, PUT_KEYS, 'SPECIALIST_PUT');
  const registry = normalizeSpecialistRegistryV1(raw.registry);
  const expectedRevision = boundedInteger(
    raw.expectedRevision,
    'SPECIALIST_EXPECTED_REVISION',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (expectedRevision !== registry.revision) fail('SPECIALIST_REGISTRY_REVISION_CONFLICT');
  const expectedBindingKey = exactBindingKey(raw.expectedBindingKey, 'SPECIALIST_EXPECTED_BINDING_KEY');
  if (expectedBindingKey !== registry.bindingKey) fail('SPECIALIST_REGISTRY_BINDING_KEY_CONFLICT');
  const definition = normalizeDefinition(raw.definition);
  const existing = registry.specialists.find((item) => item.specialistId === definition.specialistId);
  if (existing && sameDefinition(existing, definition)) return registry;
  if (!existing && registry.specialists.length >= MAX_SPECIALISTS) fail('SPECIALIST_REGISTRY_LIMIT');

  const specialists = registry.specialists.filter((item) => item.specialistId !== definition.specialistId);
  specialists.push(definition);
  specialists.sort((a, b) => compareText(a.specialistId, b.specialistId));
  return registrySnapshot(registry.revision + 1, specialists);
}

function optionalIdFilter(value, label) {
  if (value == null) return null;
  return canonicalIdList(value, label, MAX_SPECIALISTS);
}

function ensureAllowed(definition, allowedSpecialistIds, allowedProviderIds) {
  if (allowedSpecialistIds && !allowedSpecialistIds.includes(definition.specialistId)) {
    fail('SPECIALIST_NOT_ALLOWED');
  }
  if (allowedProviderIds && !allowedProviderIds.includes(definition.providerId)) {
    fail('SPECIALIST_PROVIDER_NOT_ALLOWED');
  }
}

export function selectSpecialistCandidatesV1(input) {
  const raw = plain(input, 'SPECIALIST_SELECTION');
  exactKeys(raw, SELECT_KEYS, 'SPECIALIST_SELECTION');
  const registry = normalizeSpecialistRegistryV1(raw.registry);
  const taskKind = canonicalId(raw.taskKind, 'SPECIALIST_SELECTION_TASK_KIND');
  const requiredCapabilityIds = canonicalIdList(
    raw.requiredCapabilityIds,
    'SPECIALIST_SELECTION_REQUIRED_CAPABILITY_IDS',
    MAX_CAPABILITIES,
  );
  if (!requiredCapabilityIds.length) fail('SPECIALIST_SELECTION_REQUIRED_CAPABILITY_IDS_EMPTY');
  const allowedSpecialistIds = optionalIdFilter(raw.allowedSpecialistIds, 'SPECIALIST_SELECTION_ALLOWED_SPECIALIST_IDS');
  const allowedProviderIds = optionalIdFilter(raw.allowedProviderIds, 'SPECIALIST_SELECTION_ALLOWED_PROVIDER_IDS');
  const specialistAllow = allowedSpecialistIds ? new Set(allowedSpecialistIds) : null;
  const providerAllow = allowedProviderIds ? new Set(allowedProviderIds) : null;

  const candidates = registry.specialists
    .filter((definition) => definition.enabled)
    .filter((definition) => definition.taskKinds.includes(taskKind))
    .filter((definition) => requiredCapabilityIds.every((capabilityId) => definition.capabilityIds.includes(capabilityId)))
    .filter((definition) => specialistAllow === null || specialistAllow.has(definition.specialistId))
    .filter((definition) => providerAllow === null || providerAllow.has(definition.providerId))
    .sort((a, b) => b.priority - a.priority || compareText(a.specialistId, b.specialistId))
    .map((definition) => freeze({
      specialistId: definition.specialistId,
      providerId: definition.providerId,
      label: definition.label,
      priority: definition.priority,
      maxConcurrentAssignments: definition.maxConcurrentAssignments,
      capabilityIds: definition.capabilityIds,
      taskKinds: definition.taskKinds,
    }));

  return freeze({
    schemaVersion: VERSION,
    registryRevision: registry.revision,
    registryBindingKey: registry.bindingKey,
    taskKind,
    requiredCapabilityIds,
    candidateSpecialistIds: candidates.map((candidate) => candidate.specialistId),
    candidates,
    advisoryOnly: true,
    specialistSelectionAuthorized: false,
    handoffAuthorized: false,
    executionAuthorized: false,
    providerCallAuthorized: false,
    credentialUseAuthorized: false,
    policyDecisionGranted: false,
    persistenceAuthorized: false,
    schedulingAuthorized: false,
    completionAuthorized: false,
    verificationAuthorized: false,
    requiresCanonicalSpecialistHandoff: true,
    requiresCurrentPolicyRevalidation: true,
    requiresCurrentBudgetRevalidation: true,
  });
}

export function bindSpecialistHandoffToRegistryV1(input) {
  const raw = plain(input, 'SPECIALIST_HANDOFF_BINDING');
  exactKeys(raw, HANDOFF_BIND_KEYS, 'SPECIALIST_HANDOFF_BINDING');
  const registry = normalizeSpecialistRegistryV1(raw.registry);
  const expectedRegistryRevision = boundedInteger(
    raw.expectedRegistryRevision,
    'SPECIALIST_HANDOFF_EXPECTED_REGISTRY_REVISION',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (expectedRegistryRevision !== registry.revision) fail('SPECIALIST_HANDOFF_REGISTRY_REVISION_CONFLICT');
  const expectedRegistryBindingKey = exactBindingKey(
    raw.expectedRegistryBindingKey,
    'SPECIALIST_HANDOFF_EXPECTED_REGISTRY_BINDING_KEY',
  );
  if (expectedRegistryBindingKey !== registry.bindingKey) fail('SPECIALIST_HANDOFF_REGISTRY_BINDING_KEY_CONFLICT');

  const handoffRaw = plain(raw.handoff, 'SPECIALIST_HANDOFF_INPUT');
  const requestedSpecialistId = canonicalId(handoffRaw.specialistId, 'SPECIALIST_HANDOFF_SPECIALIST_ID');
  const definition = registry.specialists.find((item) => item.specialistId === requestedSpecialistId);
  if (!definition) fail('SPECIALIST_HANDOFF_SPECIALIST_NOT_FOUND');
  if (!definition.enabled) fail('SPECIALIST_HANDOFF_SPECIALIST_DISABLED');

  const allowedSpecialistIds = optionalIdFilter(raw.allowedSpecialistIds, 'SPECIALIST_HANDOFF_ALLOWED_SPECIALIST_IDS');
  const allowedProviderIds = optionalIdFilter(raw.allowedProviderIds, 'SPECIALIST_HANDOFF_ALLOWED_PROVIDER_IDS');
  ensureAllowed(definition, allowedSpecialistIds, allowedProviderIds);

  const handoff = assertSpecialistHandoffScopedV1(raw.handoff, definition.capabilityIds);
  if (handoff.specialistId !== definition.specialistId) fail('SPECIALIST_HANDOFF_SPECIALIST_ID_MISMATCH');

  return freeze({
    schemaVersion: VERSION,
    registryRevision: registry.revision,
    registryBindingKey: registry.bindingKey,
    handoffId: handoff.handoffId,
    specialistId: definition.specialistId,
    providerId: definition.providerId,
    requestedCapabilityIds: handoff.requestedCapabilityIds,
    maxModelCalls: handoff.maxModelCalls,
    maxRuntimeSeconds: handoff.maxRuntimeSeconds,
    maxCostUsdMicros: handoff.maxCostUsdMicros,
    advisoryOnly: true,
    canonicalSpecialistHandoffValidated: true,
    specialistSelectionAuthorized: false,
    handoffAuthorized: false,
    executionAuthorized: false,
    providerCallAuthorized: false,
    credentialUseAuthorized: false,
    policyDecisionGranted: false,
    persistenceAuthorized: false,
    schedulingAuthorized: false,
    completionAuthorized: false,
    verificationAuthorized: false,
    requiresCurrentPolicyRevalidation: true,
    requiresCurrentBudgetRevalidation: true,
    requiresCurrentCredentialScopeRevalidation: true,
  });
}
