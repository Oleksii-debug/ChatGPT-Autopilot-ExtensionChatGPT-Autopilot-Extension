import { AgentExecutionPlane } from './agent-plan.js';
import { normalizeSpecialistHandoffV1 } from './universal-agent-contracts.js';

export const SPECIALIST_REGISTRY_VERSION = 1;
export const SPECIALIST_DEFINITION_VERSION = 1;
export const SPECIALIST_SELECTION_VERSION = 1;
export const SPECIALIST_REGISTRY_MUTATION_VERSION = 1;

export const SpecialistRegistryMutationKind = Object.freeze({
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const PLANES = new Set(Object.values(AgentExecutionPlane));
const DEF_KEYS = new Set(['schemaVersion','specialistId','providerId','label','description','executionPlane','capabilityIds','toolIds','resultContractId','enabled','definitionRevision']);
const REG_KEYS = new Set(['schemaVersion','registryId','revision','definitions']);
const DISC_KEYS = new Set(['registry','requiredCapabilityIds','requiredToolIds','parentCapabilityIds','parentToolIds','executionPlanes']);
const SEL_KEYS = new Set(['schemaVersion','registryId','registryRevision','specialistId','providerId','definitionRevision','executionPlane','requestedCapabilityIds','grantedToolIds','resultContractId']);
const BIND_KEYS = new Set(['registry','selection','handoff','parentCapabilityIds','parentToolIds']);
const MUTATION_KEYS = new Set([
  'registry', 'registryId', 'expectedRegistryRevision', 'kind',
  'definition', 'specialistId', 'expectedDefinitionRevision',
]);
const MUTATION_KINDS = new Set(Object.values(SpecialistRegistryMutationKind));

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

function denseArray(value, label, max, min = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error(label + ' must be a canonical array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) throw new Error(label + ' has invalid length');
  const expected = new Set(['length', ...Array.from({length}, (_, index) => String(index))]);
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

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(label + ' must use exact canonical identity representation');
  return value;
}
function text(value, label, max, optional = false) {
  if ((value === undefined || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max || value.includes('\0')) throw new Error(label + ' must be exact bounded text');
  return value;
}
function integer(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) throw new Error(label + ' is invalid');
  return value;
}
function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}
function nextRevision(value, label) {
  if (value >= Number.MAX_SAFE_INTEGER) throw new Error(label + ' cannot advance beyond MAX_SAFE_INTEGER');
  return value + 1;
}
function plane(value, label) {
  if (typeof value !== 'string' || !PLANES.has(value)) throw new Error(label + ' is invalid');
  return value;
}
function ids(value, label, max, min = 0) {
  const out = denseArray(value, label, max, min).map((item, index) => id(item, label + '[' + index + ']'));
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicate identity');
  return Object.freeze([...out].sort(compareId));
}
function planes(value) {
  const out = denseArray(value, 'executionPlanes', PLANES.size, 1).map((item, index) => plane(item, 'executionPlanes[' + index + ']'));
  if (new Set(out).size !== out.length) throw new Error('executionPlanes contains duplicate execution plane');
  return Object.freeze([...out].sort(compareId));
}
function subset(requested, allowed, label) {
  const set = new Set(allowed);
  const missing = requested.filter(item => !set.has(item));
  if (missing.length) throw new Error(label + ' exceeds parent or specialist authority: ' + missing.join(', '));
}
function compareId(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function same(left, right) { return left.length === right.length && left.every((item, index) => item === right[index]); }
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function normalizeSpecialistDefinitionV1(input) {
  const raw = record(input, DEF_KEYS, 'SpecialistDefinitionV1');
  if (raw.schemaVersion !== SPECIALIST_DEFINITION_VERSION) throw new Error('SpecialistDefinitionV1.schemaVersion must be numeric 1');
  return freeze({
    schemaVersion: 1,
    specialistId: id(raw.specialistId, 'specialistId'),
    providerId: id(raw.providerId, 'providerId'),
    label: text(raw.label, 'label', 300),
    description: text(raw.description, 'description', 4000, true),
    executionPlane: plane(raw.executionPlane, 'executionPlane'),
    capabilityIds: ids(raw.capabilityIds, 'capabilityIds', 64, 1),
    toolIds: ids(raw.toolIds, 'toolIds', 128),
    resultContractId: id(raw.resultContractId, 'resultContractId'),
    enabled: bool(raw.enabled, 'enabled'),
    definitionRevision: integer(raw.definitionRevision, 'definitionRevision'),
  });
}

export function normalizeSpecialistRegistryV1(input) {
  const raw = record(input, REG_KEYS, 'SpecialistRegistryV1');
  if (raw.schemaVersion !== SPECIALIST_REGISTRY_VERSION) throw new Error('SpecialistRegistryV1.schemaVersion must be numeric 1');
  const definitions = denseArray(raw.definitions, 'definitions', 128).map(normalizeSpecialistDefinitionV1)
    .sort((left, right) => compareId(left.specialistId, right.specialistId));
  if (new Set(definitions.map(item => item.specialistId)).size !== definitions.length) throw new Error('SpecialistRegistryV1 contains duplicate specialistId');
  return freeze({schemaVersion:1, registryId:id(raw.registryId,'registryId'), revision:integer(raw.revision,'registry revision'), definitions});
}

export function normalizeSpecialistSelectionV1(input) {
  const raw = record(input, SEL_KEYS, 'SpecialistSelectionV1');
  if (raw.schemaVersion !== SPECIALIST_SELECTION_VERSION) throw new Error('SpecialistSelectionV1.schemaVersion must be numeric 1');
  return freeze({
    schemaVersion:1,
    registryId:id(raw.registryId,'registryId'),
    registryRevision:integer(raw.registryRevision,'registryRevision'),
    specialistId:id(raw.specialistId,'specialistId'),
    providerId:id(raw.providerId,'providerId'),
    definitionRevision:integer(raw.definitionRevision,'definitionRevision'),
    executionPlane:plane(raw.executionPlane,'executionPlane'),
    requestedCapabilityIds:ids(raw.requestedCapabilityIds,'requestedCapabilityIds',64,1),
    grantedToolIds:ids(raw.grantedToolIds,'grantedToolIds',128),
    resultContractId:id(raw.resultContractId,'resultContractId'),
  });
}

function selection(registry, definition, requestedCapabilities, requestedTools) {
  return normalizeSpecialistSelectionV1({
    schemaVersion:1, registryId:registry.registryId, registryRevision:registry.revision,
    specialistId:definition.specialistId, providerId:definition.providerId,
    definitionRevision:definition.definitionRevision, executionPlane:definition.executionPlane,
    requestedCapabilityIds:requestedCapabilities, grantedToolIds:requestedTools,
    resultContractId:definition.resultContractId,
  });
}

export function discoverSpecialistsV1(input = {}) {
  const raw = record(input, DISC_KEYS, 'Specialist discovery request');
  const registry = normalizeSpecialistRegistryV1(raw.registry);
  const required = ids(raw.requiredCapabilityIds, 'requiredCapabilityIds', 64, 1);
  const requiredTools = ids(raw.requiredToolIds, 'requiredToolIds', 128);
  const parentCapabilities = ids(raw.parentCapabilityIds, 'parentCapabilityIds', 64);
  const parentTools = ids(raw.parentToolIds, 'parentToolIds', 128);
  subset(required, parentCapabilities, 'Requested specialist capabilities');
  subset(requiredTools, parentTools, 'Requested specialist tools');
  const allowedPlanes = new Set(raw.executionPlanes === undefined ? [...PLANES] : planes(raw.executionPlanes));
  const specialists = registry.definitions
    .filter(item => item.enabled && allowedPlanes.has(item.executionPlane))
    .filter(item => required.every(capabilityId => item.capabilityIds.includes(capabilityId)))
    .filter(item => requiredTools.every(toolId => item.toolIds.includes(toolId)))
    .map(item => selection(registry, item, required, requiredTools));
  return freeze({schemaVersion:1, registryId:registry.registryId, registryRevision:registry.revision, requestedCapabilityIds:required, requestedToolIds:requiredTools, specialists});
}

export function bindSpecialistHandoffToRegistryV1(input = {}) {
  const raw = record(input, BIND_KEYS, 'Specialist handoff registry binding request');
  const registry = normalizeSpecialistRegistryV1(raw.registry);
  const selected = normalizeSpecialistSelectionV1(raw.selection);
  const handoff = normalizeSpecialistHandoffV1(raw.handoff);
  const parentCapabilities = ids(raw.parentCapabilityIds, 'parentCapabilityIds', 64);
  const parentTools = ids(raw.parentToolIds, 'parentToolIds', 128);
  const definition = registry.definitions.find(item => item.specialistId === selected.specialistId);
  if (selected.registryId !== registry.registryId || selected.registryRevision !== registry.revision) throw new Error('Specialist selection registry identity or revision drifted');
  if (!definition || !definition.enabled) throw new Error('Selected specialist is missing or disabled');
  if (selected.providerId !== definition.providerId || selected.definitionRevision !== definition.definitionRevision || selected.executionPlane !== definition.executionPlane || selected.resultContractId !== definition.resultContractId) {
    throw new Error('Specialist selection drifted from current registry definition');
  }
  subset(selected.grantedToolIds, parentTools, 'Selected child tools');
  subset(selected.grantedToolIds, definition.toolIds, 'Selected child tools');
  if (handoff.specialistId !== selected.specialistId) throw new Error('Specialist handoff does not match selected specialist identity');
  subset(handoff.requestedCapabilityIds, parentCapabilities, 'Specialist handoff capabilities');
  subset(handoff.requestedCapabilityIds, definition.capabilityIds, 'Specialist handoff capabilities');
  if (!same(Object.freeze([...handoff.requestedCapabilityIds].sort(compareId)), selected.requestedCapabilityIds)) throw new Error('Specialist handoff capability scope changed after selection');
  return freeze({
    schemaVersion:1, registryId:registry.registryId, registryRevision:registry.revision,
    selection:selected, handoff,
    childContext:{goal:handoff.goal, artifactRefs:handoff.artifactRefs, credentialRefs:handoff.credentialRefs, parentInvocationId:handoff.parentInvocationId},
    childScope:{capabilityIds:selected.requestedCapabilityIds, toolIds:selected.grantedToolIds},
    authority:{executionAuthorized:false,policyAuthorized:false,schedulingAuthorized:false,recoveryAuthorized:false,credentialAuthorized:false,completionAuthorized:false,verificationAuthorized:false},
  });
}


/**
 * Builds the next canonical SpecialistRegistry snapshot under exact
 * compare-and-swap guards. Persistence remains owned by the caller's existing
 * durable store/update authority.
 */
export function proposeSpecialistRegistryMutationV1(input = {}) {
  const raw = record(input, MUTATION_KEYS, 'Specialist registry mutation request');
  const registry = normalizeSpecialistRegistryV1(raw.registry);
  const registryId = id(raw.registryId, 'registryId');
  if (registryId !== registry.registryId) throw new Error('Specialist registry identity does not match mutation target');
  const expectedRegistryRevision = integer(raw.expectedRegistryRevision, 'expectedRegistryRevision');
  if (expectedRegistryRevision !== registry.revision) throw new Error('Specialist registry revision drifted before mutation');
  if (typeof raw.kind !== 'string' || !MUTATION_KINDS.has(raw.kind)) {
    throw new Error('Specialist registry mutation kind is invalid');
  }

  const nextRegistryRevision = nextRevision(registry.revision, 'Specialist registry revision');
  let nextDefinitions;
  let specialistId;
  let previousDefinitionRevision = 0;
  let nextDefinitionRevision = 0;

  if (raw.kind === SpecialistRegistryMutationKind.CREATE) {
    if (!Object.hasOwn(raw, 'definition')) throw new Error('CREATE mutation requires definition');
    if (Object.hasOwn(raw, 'specialistId') || Object.hasOwn(raw, 'expectedDefinitionRevision')) {
      throw new Error('CREATE mutation must not supply existing-definition identity');
    }
    const definition = normalizeSpecialistDefinitionV1(raw.definition);
    specialistId = definition.specialistId;
    if (definition.definitionRevision !== 1) throw new Error('CREATE mutation requires definitionRevision 1');
    if (registry.definitions.some(item => item.specialistId === specialistId)) {
      throw new Error('CREATE mutation target already exists');
    }
    nextDefinitionRevision = 1;
    nextDefinitions = [...registry.definitions, definition];
  } else if (raw.kind === SpecialistRegistryMutationKind.UPDATE) {
    if (!Object.hasOwn(raw, 'definition')
        || !Object.hasOwn(raw, 'specialistId')
        || !Object.hasOwn(raw, 'expectedDefinitionRevision')) {
      throw new Error('UPDATE mutation requires specialistId, definition and expectedDefinitionRevision');
    }
    specialistId = id(raw.specialistId, 'specialistId');
    const definition = normalizeSpecialistDefinitionV1(raw.definition);
    if (definition.specialistId !== specialistId) {
      throw new Error('UPDATE mutation definition identity does not match target');
    }
    const current = registry.definitions.find(item => item.specialistId === specialistId);
    if (!current) throw new Error('UPDATE mutation target does not exist');
    const expectedDefinitionRevision = integer(raw.expectedDefinitionRevision, 'expectedDefinitionRevision');
    if (expectedDefinitionRevision !== current.definitionRevision) {
      throw new Error('Specialist definition revision drifted before update');
    }
    previousDefinitionRevision = current.definitionRevision;
    nextDefinitionRevision = nextRevision(current.definitionRevision, 'Specialist definition revision');
    if (definition.definitionRevision !== nextDefinitionRevision) {
      throw new Error('UPDATE mutation must increment definitionRevision exactly once');
    }
    nextDefinitions = registry.definitions.map(item => item.specialistId === specialistId ? definition : item);
  } else {
    if (!Object.hasOwn(raw, 'specialistId') || !Object.hasOwn(raw, 'expectedDefinitionRevision')) {
      throw new Error('DELETE mutation requires specialistId and expectedDefinitionRevision');
    }
    if (Object.hasOwn(raw, 'definition')) throw new Error('DELETE mutation must not supply definition');
    specialistId = id(raw.specialistId, 'specialistId');
    const current = registry.definitions.find(item => item.specialistId === specialistId);
    if (!current) throw new Error('DELETE mutation target does not exist');
    const expectedDefinitionRevision = integer(raw.expectedDefinitionRevision, 'expectedDefinitionRevision');
    if (expectedDefinitionRevision !== current.definitionRevision) {
      throw new Error('Specialist definition revision drifted before delete');
    }
    previousDefinitionRevision = current.definitionRevision;
    nextDefinitions = registry.definitions.filter(item => item.specialistId !== specialistId);
  }

  const nextRegistry = normalizeSpecialistRegistryV1({
    schemaVersion: SPECIALIST_REGISTRY_VERSION,
    registryId: registry.registryId,
    revision: nextRegistryRevision,
    definitions: nextDefinitions,
  });

  return freeze({
    schemaVersion: SPECIALIST_REGISTRY_MUTATION_VERSION,
    kind: raw.kind,
    registryId: registry.registryId,
    previousRegistryRevision: registry.revision,
    nextRegistryRevision,
    specialistId,
    previousDefinitionRevision,
    nextDefinitionRevision,
    nextRegistry,
    authority: {
      persistenceAuthorized: false,
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
