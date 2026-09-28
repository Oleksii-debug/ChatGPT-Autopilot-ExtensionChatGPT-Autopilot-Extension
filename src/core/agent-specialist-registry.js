const SCHEMA = "SpecialistRegistryV1";
const DEFINITION_SCHEMA = "SpecialistDefinitionV1";
const SELECTION_SCHEMA = "SpecialistCandidateSelectionV1";

const MAX_SPECIALISTS = 256;
const MAX_CAPABILITIES = 64;
const MAX_TASK_KINDS = 64;
const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 512;

const REGISTRY_KEYS = new Set(["schema", "revision", "specialists"]);
const DEFINITION_KEYS = new Set([
  "schema",
  "specialistId",
  "providerId",
  "label",
  "enabled",
  "priority",
  "maxConcurrentAssignments",
  "capabilityIds",
  "taskKinds",
]);
const PUT_KEYS = new Set(["registry", "expectedRevision", "definition"]);
const SELECT_KEYS = new Set([
  "registry",
  "taskKind",
  "requiredCapabilityIds",
  "allowedSpecialistIds",
  "allowedProviderIds",
]);

function fail(code) {
  throw new TypeError(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotRecord(value, allowedKeys, code) {
  if (!isPlainRecord(value)) fail(code);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length !== 0) fail(`${code}_SYMBOL`);

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedKeys.has(key)) fail(`${code}_UNKNOWN_FIELD`);
    if (!descriptor.enumerable) fail(`${code}_HIDDEN_FIELD`);
    if (!("value" in descriptor)) fail(`${code}_ACCESSOR`);
    out[key] = descriptor.value;
  }
  return out;
}

function exactString(value, code, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) fail(code);
  if (value.trim() !== value) fail(`${code}_NONCANONICAL`);
  if (/\u0000/.test(value)) fail(`${code}_NUL`);
  return value;
}

function exactBoolean(value, code) {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function boundedInteger(value, code, min, max) {
  if (!Number.isInteger(value) || Object.is(value, -0) || value < min || value > max) fail(code);
  return value;
}

function canonicalStringArray(value, code, maxItems = MAX_CAPABILITIES) {
  if (!Array.isArray(value) || value.length > maxItems) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${code}_SYMBOL`);
  if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key))) {
    fail(`${code}_DECORATED`);
  }
  const out = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`${code}_SPARSE_OR_ACCESSOR`);
    const item = exactString(descriptor.value, `${code}_ITEM`);
    if (seen.has(item)) fail(`${code}_DUPLICATE`);
    seen.add(item);
    out.push(item);
  }
  out.sort();
  return Object.freeze(out);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function normalizeDefinition(value) {
  const record = snapshotRecord(value, DEFINITION_KEYS, "SPECIALIST_DEFINITION_INVALID");
  if (record.schema !== DEFINITION_SCHEMA) fail("SPECIALIST_DEFINITION_SCHEMA");

  const definition = {
    schema: DEFINITION_SCHEMA,
    specialistId: exactString(record.specialistId, "SPECIALIST_ID_INVALID"),
    providerId: exactString(record.providerId, "SPECIALIST_PROVIDER_ID_INVALID"),
    label: exactString(record.label, "SPECIALIST_LABEL_INVALID", MAX_LABEL_LENGTH),
    enabled: exactBoolean(record.enabled, "SPECIALIST_ENABLED_INVALID"),
    priority: boundedInteger(record.priority, "SPECIALIST_PRIORITY_INVALID", 0, 1_000_000),
    maxConcurrentAssignments: boundedInteger(
      record.maxConcurrentAssignments,
      "SPECIALIST_MAX_CONCURRENCY_INVALID",
      1,
      1024,
    ),
    capabilityIds: canonicalStringArray(record.capabilityIds, "SPECIALIST_CAPABILITIES", MAX_CAPABILITIES),
    taskKinds: canonicalStringArray(record.taskKinds, "SPECIALIST_TASK_KINDS", MAX_TASK_KINDS),
  };

  if (definition.capabilityIds.length === 0) fail("SPECIALIST_CAPABILITIES_EMPTY");
  if (definition.taskKinds.length === 0) fail("SPECIALIST_TASK_KINDS_EMPTY");
  return deepFreeze(definition);
}

function sameDefinition(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createEmptySpecialistRegistryV1() {
  return deepFreeze({ schema: SCHEMA, revision: 0, specialists: [] });
}

export function normalizeSpecialistDefinitionV1(value) {
  return normalizeDefinition(value);
}

export function normalizeSpecialistRegistryV1(value) {
  const record = snapshotRecord(value, REGISTRY_KEYS, "SPECIALIST_REGISTRY_INVALID");
  if (record.schema !== SCHEMA) fail("SPECIALIST_REGISTRY_SCHEMA");
  const revision = boundedInteger(record.revision, "SPECIALIST_REGISTRY_REVISION_INVALID", 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.specialists) || record.specialists.length > MAX_SPECIALISTS) {
    fail("SPECIALIST_REGISTRY_SPECIALISTS_INVALID");
  }

  const listDescriptors = Object.getOwnPropertyDescriptors(record.specialists);
  if (Object.getOwnPropertySymbols(record.specialists).length !== 0) fail("SPECIALIST_REGISTRY_SPECIALISTS_SYMBOL");
  if (Object.keys(listDescriptors).some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key))) {
    fail("SPECIALIST_REGISTRY_SPECIALISTS_DECORATED");
  }

  const specialists = [];
  const ids = new Set();
  for (let index = 0; index < record.specialists.length; index += 1) {
    const descriptor = listDescriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail("SPECIALIST_REGISTRY_SPECIALISTS_SPARSE_OR_ACCESSOR");
    }
    const definition = normalizeDefinition(descriptor.value);
    if (ids.has(definition.specialistId)) fail("SPECIALIST_REGISTRY_DUPLICATE_ID");
    ids.add(definition.specialistId);
    specialists.push(definition);
  }
  specialists.sort((a, b) => a.specialistId.localeCompare(b.specialistId));

  return deepFreeze({ schema: SCHEMA, revision, specialists });
}

export function putSpecialistDefinitionV1(input) {
  const record = snapshotRecord(input, PUT_KEYS, "SPECIALIST_PUT_INVALID");
  const registry = normalizeSpecialistRegistryV1(record.registry);
  const expectedRevision = boundedInteger(
    record.expectedRevision,
    "SPECIALIST_EXPECTED_REVISION_INVALID",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (expectedRevision !== registry.revision) fail("SPECIALIST_REGISTRY_REVISION_CONFLICT");
  const definition = normalizeDefinition(record.definition);

  const existing = registry.specialists.find((item) => item.specialistId === definition.specialistId);
  if (existing && sameDefinition(existing, definition)) return registry;
  if (!existing && registry.specialists.length >= MAX_SPECIALISTS) fail("SPECIALIST_REGISTRY_LIMIT");

  const next = registry.specialists.filter((item) => item.specialistId !== definition.specialistId);
  next.push(definition);
  next.sort((a, b) => a.specialistId.localeCompare(b.specialistId));

  return deepFreeze({
    schema: SCHEMA,
    revision: registry.revision + 1,
    specialists: next,
  });
}

function exactOptionalFilter(value, code) {
  if (value === undefined || value === null) return null;
  return canonicalStringArray(value, code, MAX_SPECIALISTS);
}

export function selectSpecialistCandidatesV1(input) {
  const record = snapshotRecord(input, SELECT_KEYS, "SPECIALIST_SELECTION_INVALID");
  const registry = normalizeSpecialistRegistryV1(record.registry);
  const taskKind = exactString(record.taskKind, "SPECIALIST_SELECTION_TASK_KIND_INVALID");
  const requiredCapabilityIds = canonicalStringArray(
    record.requiredCapabilityIds,
    "SPECIALIST_SELECTION_CAPABILITIES",
    MAX_CAPABILITIES,
  );
  const allowedSpecialistIds = exactOptionalFilter(record.allowedSpecialistIds, "SPECIALIST_SELECTION_ALLOWED_IDS");
  const allowedProviderIds = exactOptionalFilter(record.allowedProviderIds, "SPECIALIST_SELECTION_ALLOWED_PROVIDERS");
  const specialistAllow = allowedSpecialistIds ? new Set(allowedSpecialistIds) : null;
  const providerAllow = allowedProviderIds ? new Set(allowedProviderIds) : null;

  const candidates = registry.specialists
    .filter((definition) => definition.enabled)
    .filter((definition) => definition.taskKinds.includes(taskKind))
    .filter((definition) => requiredCapabilityIds.every((capabilityId) => definition.capabilityIds.includes(capabilityId)))
    .filter((definition) => specialistAllow === null || specialistAllow.has(definition.specialistId))
    .filter((definition) => providerAllow === null || providerAllow.has(definition.providerId))
    .sort((a, b) => b.priority - a.priority || a.specialistId.localeCompare(b.specialistId))
    .map((definition) => deepFreeze({
      specialistId: definition.specialistId,
      providerId: definition.providerId,
      label: definition.label,
      priority: definition.priority,
      maxConcurrentAssignments: definition.maxConcurrentAssignments,
      capabilityIds: definition.capabilityIds,
      taskKinds: definition.taskKinds,
    }));

  return deepFreeze({
    schema: SELECTION_SCHEMA,
    registryRevision: registry.revision,
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
