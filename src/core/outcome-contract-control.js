import { normalizeOutcomeContractV1 } from './outcome-contract.js';

export const MAX_STORED_OUTCOME_CONTRACTS = 512;
export const MAX_OUTCOME_CONTRACT_REVISIONS = 256;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const RESOLVE_KEYS = new Set(['projectId', 'contractId', 'expectedRevision']);
const CURRENT_RESOLVE_KEYS = new Set(['projectId', 'contractId']);
const TRUSTED_RESOLVE_KEYS = new Set(['contractId', 'contractRevision']);
const UPDATE_KEYS = new Set(['projectId', 'contractId', 'expectedRevision', 'contract']);
const DELETE_KEYS = new Set(['projectId', 'contractId', 'expectedRevision']);
const ENTRY_KEYS = new Set(['projectId', 'latestRevision', 'deleted', 'revisionsByNumber']);

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must be an exact id`);
  }
  return value;
}

function exactRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive exact integer`);
  return value;
}

function dataRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains an invalid field`);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactRequest(value, allowedKeys, label) {
  const raw = dataRecord(value, label);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
  return raw;
}

function exactEntry(value, label) {
  const raw = dataRecord(value, label);
  const keys = Object.keys(raw);
  if (keys.length !== ENTRY_KEYS.size || keys.some(key => !ENTRY_KEYS.has(key))) {
    throw new Error(`${label} must contain the exact canonical fields`);
  }
  return raw;
}

function required(raw, key, label) {
  if (!Object.hasOwn(raw, key)) throw new Error(`${label} is missing ${key}`);
  return raw[key];
}

function registryInput(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('OutcomeContract state must be an object');
  }
  const prototype = Object.getPrototypeOf(state);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('OutcomeContract state must be a plain object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(state, 'outcomeContractsById');
  if (!descriptor) return {};
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new Error('outcomeContractsById must be an enumerable own data property');
  }
  if (descriptor.value === undefined) {
    throw new Error('outcomeContractsById cannot be undefined when present');
  }
  return descriptor.value;
}

function normalizeRegistryEntry(contractId, input) {
  const raw = exactEntry(input, `OutcomeContract registry entry ${contractId}`);
  const projectId = exactId(raw.projectId, 'OutcomeContract registry projectId');
  const latestRevision = exactRevision(raw.latestRevision, 'OutcomeContract registry latestRevision');
  if (typeof raw.deleted !== 'boolean') throw new Error('OutcomeContract registry deleted must be boolean');

  const revisionsRaw = dataRecord(raw.revisionsByNumber, `OutcomeContract revisions ${contractId}`);
  const revisionKeys = Object.keys(revisionsRaw);
  if (revisionKeys.length < 1 || revisionKeys.length > MAX_OUTCOME_CONTRACT_REVISIONS) {
    throw new Error('OutcomeContract revision history limit exceeded');
  }
  if (latestRevision > MAX_OUTCOME_CONTRACT_REVISIONS) {
    throw new Error('OutcomeContract latestRevision exceeds revision history limit');
  }
  if (revisionKeys.length !== latestRevision) {
    throw new Error('OutcomeContract revision history must be contiguous');
  }

  const revisionsByNumber = Object.create(null);
  let createdAt = '';
  for (let revision = 1; revision <= latestRevision; revision += 1) {
    const key = String(revision);
    if (!Object.hasOwn(revisionsRaw, key)) throw new Error('OutcomeContract revision history must be contiguous');
    const contract = normalizeOutcomeContractV1(revisionsRaw[key]);
    if (contract.contractId !== contractId) throw new Error(`Stored OutcomeContract key mismatch: ${contractId}`);
    if (!contract.projectId || contract.projectId !== projectId) {
      throw new Error(`Stored OutcomeContract ${contractId} project binding mismatch`);
    }
    if (contract.revision !== revision) throw new Error(`Stored OutcomeContract ${contractId} revision key mismatch`);
    if (!createdAt) createdAt = contract.createdAt;
    if (contract.createdAt !== createdAt) throw new Error('OutcomeContract createdAt is immutable across revisions');
    revisionsByNumber[key] = contract;
  }

  for (const key of revisionKeys) {
    if (!/^[1-9][0-9]*$/u.test(key) || Number(key) > latestRevision) {
      throw new Error('OutcomeContract revision history contains a non-canonical revision key');
    }
  }

  return Object.freeze({
    projectId,
    latestRevision,
    deleted: raw.deleted,
    revisionsByNumber: Object.freeze(revisionsByNumber),
  });
}

export function normalizeOutcomeContractRegistryV1(input = {}) {
  const raw = dataRecord(input, 'OutcomeContract registry');
  const keys = Object.keys(raw);
  if (keys.length > MAX_STORED_OUTCOME_CONTRACTS) throw new Error('OutcomeContract registry limit exceeded');

  const normalized = Object.create(null);
  for (const contractId of keys.sort()) {
    exactId(contractId, 'OutcomeContract registry key');
    normalized[contractId] = normalizeRegistryEntry(contractId, raw[contractId]);
  }
  return Object.freeze(normalized);
}

export function validateOutcomeContractRegistryV1(input = {}) {
  normalizeOutcomeContractRegistryV1(input);
  return input;
}

export function validateOutcomeContractRegistryStateV1(state) {
  normalizeOutcomeContractRegistryV1(registryInput(state));
  return state;
}

function mutableRegistry(state) {
  const normalized = normalizeOutcomeContractRegistryV1(registryInput(state));
  const mutable = Object.create(null);
  for (const [contractId, entry] of Object.entries(normalized)) {
    Object.defineProperty(mutable, contractId, {
      value: structuredClone(entry),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  state.outcomeContractsById = mutable;
  return mutable;
}

function requireRegistryEntry(registry, contractId) {
  const entry = registry[contractId];
  if (!entry) throw new Error('OutcomeContract not found');
  return entry;
}

function latestContract(entry) {
  return entry.revisionsByNumber[String(entry.latestRevision)];
}

export function listStoredOutcomeContractsV1(state, input = {}) {
  const raw = exactRequest(input, new Set(['projectId']), 'OutcomeContract list request');
  const projectId = exactId(required(raw, 'projectId', 'OutcomeContract list request'), 'projectId');
  const registry = normalizeOutcomeContractRegistryV1(registryInput(state));
  return Object.freeze(Object.entries(registry)
    .filter(([, entry]) => entry.projectId === projectId && !entry.deleted)
    .map(([, entry]) => latestContract(entry))
    .sort((a, b) => a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));
}

export function resolveStoredOutcomeContractV1(state, input = {}) {
  const raw = exactRequest(input, RESOLVE_KEYS, 'OutcomeContract resolve request');
  const projectId = exactId(required(raw, 'projectId', 'OutcomeContract resolve request'), 'projectId');
  const contractId = exactId(required(raw, 'contractId', 'OutcomeContract resolve request'), 'contractId');
  const expectedRevision = exactRevision(required(raw, 'expectedRevision', 'OutcomeContract resolve request'), 'expectedRevision');
  const registry = normalizeOutcomeContractRegistryV1(registryInput(state));
  const entry = requireRegistryEntry(registry, contractId);
  if (entry.projectId !== projectId) throw new Error('OutcomeContract project binding mismatch');
  if (entry.deleted) throw new Error('OutcomeContract is deleted');
  if (entry.latestRevision !== expectedRevision) throw new Error('OutcomeContract revision binding mismatch');
  return latestContract(entry);
}

export function resolveCurrentStoredOutcomeContractV1(state, input = {}) {
  const raw = exactRequest(input, CURRENT_RESOLVE_KEYS, 'Current OutcomeContract resolve request');
  const projectId = exactId(required(raw, 'projectId', 'Current OutcomeContract resolve request'), 'projectId');
  const contractId = exactId(required(raw, 'contractId', 'Current OutcomeContract resolve request'), 'contractId');
  const registry = normalizeOutcomeContractRegistryV1(registryInput(state));
  const entry = requireRegistryEntry(registry, contractId);
  if (entry.projectId !== projectId) throw new Error('OutcomeContract project binding mismatch');
  if (entry.deleted) throw new Error('OutcomeContract is deleted');
  return latestContract(entry);
}

export function resolveCanonicalStoredOutcomeContractV1(state, input = {}) {
  const raw = exactRequest(input, TRUSTED_RESOLVE_KEYS, 'Canonical OutcomeContract resolve request');
  const contractId = exactId(required(raw, 'contractId', 'Canonical OutcomeContract resolve request'), 'contractId');
  const contractRevision = exactRevision(
    required(raw, 'contractRevision', 'Canonical OutcomeContract resolve request'),
    'contractRevision',
  );
  const registry = normalizeOutcomeContractRegistryV1(registryInput(state));
  const entry = registry[contractId];
  if (!entry) return null;
  const contract = entry.revisionsByNumber[String(contractRevision)];
  if (!contract) throw new Error('OutcomeContract revision binding mismatch');
  return contract;
}

export function createStoredOutcomeContractV1(state, input) {
  const contract = normalizeOutcomeContractV1(input);
  if (!contract.projectId) throw new Error('Stored OutcomeContract must be project-bound');
  if (contract.revision !== 1) throw new Error('Stored OutcomeContract creation must start at revision 1');
  const registry = mutableRegistry(state);
  if (Object.hasOwn(registry, contract.contractId)) throw new Error('OutcomeContract already exists');
  if (Object.keys(registry).length >= MAX_STORED_OUTCOME_CONTRACTS) throw new Error('OutcomeContract registry limit exceeded');
  registry[contract.contractId] = {
    projectId: contract.projectId,
    latestRevision: 1,
    deleted: false,
    revisionsByNumber: { 1: structuredClone(contract) },
  };
  return normalizeOutcomeContractV1(registry[contract.contractId].revisionsByNumber['1']);
}

export function updateStoredOutcomeContractV1(state, input = {}) {
  const raw = exactRequest(input, UPDATE_KEYS, 'OutcomeContract update request');
  const projectId = exactId(required(raw, 'projectId', 'OutcomeContract update request'), 'projectId');
  const contractId = exactId(required(raw, 'contractId', 'OutcomeContract update request'), 'contractId');
  const expectedRevision = exactRevision(required(raw, 'expectedRevision', 'OutcomeContract update request'), 'expectedRevision');
  const next = normalizeOutcomeContractV1(required(raw, 'contract', 'OutcomeContract update request'));
  const current = resolveStoredOutcomeContractV1(state, { projectId, contractId, expectedRevision });

  if (next.contractId !== contractId) throw new Error('OutcomeContract contractId is immutable');
  if (next.projectId !== projectId) throw new Error('OutcomeContract projectId is immutable');
  if (next.createdAt !== current.createdAt) throw new Error('OutcomeContract createdAt is immutable');
  if (next.revision !== expectedRevision + 1) throw new Error('OutcomeContract update must advance revision by exactly one');
  if (next.revision > MAX_OUTCOME_CONTRACT_REVISIONS) throw new Error('OutcomeContract revision history limit exceeded');

  const registry = mutableRegistry(state);
  const entry = registry[contractId];
  entry.revisionsByNumber[String(next.revision)] = structuredClone(next);
  entry.latestRevision = next.revision;
  return normalizeOutcomeContractV1(entry.revisionsByNumber[String(next.revision)]);
}

export function deleteStoredOutcomeContractV1(state, input = {}) {
  const raw = exactRequest(input, DELETE_KEYS, 'OutcomeContract delete request');
  const projectId = exactId(required(raw, 'projectId', 'OutcomeContract delete request'), 'projectId');
  const contractId = exactId(required(raw, 'contractId', 'OutcomeContract delete request'), 'contractId');
  const expectedRevision = exactRevision(required(raw, 'expectedRevision', 'OutcomeContract delete request'), 'expectedRevision');
  const current = resolveStoredOutcomeContractV1(state, { projectId, contractId, expectedRevision });
  const registry = mutableRegistry(state);
  registry[contractId].deleted = true;
  return current;
}
