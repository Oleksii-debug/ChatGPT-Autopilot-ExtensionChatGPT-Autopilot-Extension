import { normalizeOutcomeContractV1 } from './outcome-contract.js';

export const MAX_STORED_OUTCOME_CONTRACTS = 512;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const RESOLVE_KEYS = new Set(['projectId', 'contractId', 'expectedRevision']);
const UPDATE_KEYS = new Set(['projectId', 'contractId', 'expectedRevision', 'contract']);
const DELETE_KEYS = new Set(['projectId', 'contractId', 'expectedRevision']);

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

function required(raw, key, label) {
  if (!Object.hasOwn(raw, key)) throw new Error(`${label} is missing ${key}`);
  return raw[key];
}

function registryInput(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('OutcomeContract state must be an object');
  return state.outcomeContractsById === undefined ? {} : state.outcomeContractsById;
}

export function normalizeOutcomeContractRegistryV1(input = {}) {
  const raw = dataRecord(input, 'OutcomeContract registry');
  const keys = Object.keys(raw);
  if (keys.length > MAX_STORED_OUTCOME_CONTRACTS) throw new Error('OutcomeContract registry limit exceeded');

  const normalized = Object.create(null);
  for (const contractId of keys.sort()) {
    exactId(contractId, 'OutcomeContract registry key');
    const contract = normalizeOutcomeContractV1(raw[contractId]);
    if (!contract.projectId) throw new Error(`Stored OutcomeContract ${contractId} must be project-bound`);
    if (contract.contractId !== contractId) throw new Error(`Stored OutcomeContract key mismatch: ${contractId}`);
    normalized[contractId] = contract;
  }
  return Object.freeze(normalized);
}

export function validateOutcomeContractRegistryV1(input = {}) {
  normalizeOutcomeContractRegistryV1(input);
  return input;
}

function mutableRegistry(state) {
  const normalized = normalizeOutcomeContractRegistryV1(registryInput(state));
  const mutable = {};
  for (const [contractId, contract] of Object.entries(normalized)) {
    Object.defineProperty(mutable, contractId, {
      value: structuredClone(contract),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  state.outcomeContractsById = mutable;
  return mutable;
}

export function listStoredOutcomeContractsV1(state, input = {}) {
  const raw = exactRequest(input, new Set(['projectId']), 'OutcomeContract list request');
  const projectId = exactId(required(raw, 'projectId', 'OutcomeContract list request'), 'projectId');
  const registry = normalizeOutcomeContractRegistryV1(registryInput(state));
  return Object.freeze(Object.values(registry)
    .filter(contract => contract.projectId === projectId)
    .sort((a, b) => a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));
}

export function resolveStoredOutcomeContractV1(state, input = {}) {
  const raw = exactRequest(input, RESOLVE_KEYS, 'OutcomeContract resolve request');
  const projectId = exactId(required(raw, 'projectId', 'OutcomeContract resolve request'), 'projectId');
  const contractId = exactId(required(raw, 'contractId', 'OutcomeContract resolve request'), 'contractId');
  const expectedRevision = exactRevision(required(raw, 'expectedRevision', 'OutcomeContract resolve request'), 'expectedRevision');
  const registry = normalizeOutcomeContractRegistryV1(registryInput(state));
  const contract = registry[contractId];
  if (!contract) throw new Error('OutcomeContract not found');
  if (contract.projectId !== projectId) throw new Error('OutcomeContract project binding mismatch');
  if (contract.revision !== expectedRevision) throw new Error('OutcomeContract revision binding mismatch');
  return contract;
}

export function createStoredOutcomeContractV1(state, input) {
  const contract = normalizeOutcomeContractV1(input);
  if (!contract.projectId) throw new Error('Stored OutcomeContract must be project-bound');
  if (contract.revision !== 1) throw new Error('Stored OutcomeContract creation must start at revision 1');
  const registry = mutableRegistry(state);
  if (Object.hasOwn(registry, contract.contractId)) throw new Error('OutcomeContract already exists');
  if (Object.keys(registry).length >= MAX_STORED_OUTCOME_CONTRACTS) throw new Error('OutcomeContract registry limit exceeded');
  registry[contract.contractId] = structuredClone(contract);
  return normalizeOutcomeContractV1(registry[contract.contractId]);
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

  const registry = mutableRegistry(state);
  registry[contractId] = structuredClone(next);
  return normalizeOutcomeContractV1(registry[contractId]);
}

export function deleteStoredOutcomeContractV1(state, input = {}) {
  const raw = exactRequest(input, DELETE_KEYS, 'OutcomeContract delete request');
  const projectId = exactId(required(raw, 'projectId', 'OutcomeContract delete request'), 'projectId');
  const contractId = exactId(required(raw, 'contractId', 'OutcomeContract delete request'), 'contractId');
  const expectedRevision = exactRevision(required(raw, 'expectedRevision', 'OutcomeContract delete request'), 'expectedRevision');
  const current = resolveStoredOutcomeContractV1(state, { projectId, contractId, expectedRevision });
  const registry = mutableRegistry(state);
  delete registry[contractId];
  return current;
}
