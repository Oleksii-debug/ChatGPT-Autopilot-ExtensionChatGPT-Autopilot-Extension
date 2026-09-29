import { normalizeOutcomeContractV1 } from './outcome-contract.js';
import { normalizeSpecialistSelectionV1 } from './specialist-registry.js';

export const SPECIALIST_OUTCOME_CONTRACT_ADMISSION_VERSION = 1;

const INPUT_KEYS = new Set(['projectId', 'selection']);
const DEPENDENCY_KEYS = new Set(['resolveCurrentOutcomeContract']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_CANONICAL_BINDING_CHARS = 12_000_000;

function snapshot(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
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
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function requireOwn(record, key, label) {
  if (!Object.hasOwn(record, key)) throw new Error(label + ' requires ' + key);
  return record[key];
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

async function sha256Binding(value, label) {
  const canonical = JSON.stringify(value);
  if (!canonical || canonical.length > MAX_CANONICAL_BINDING_CHARS) {
    throw new Error(label + ' exceeds canonical binding bound');
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error(label + ' requires WebCrypto SHA-256 support');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return 'sha256:' + hex;
}

function selectionProjection(selection) {
  return [
    selection.schemaVersion,
    selection.registryId,
    selection.registryRevision,
    selection.registryBindingKey,
    selection.specialistId,
    selection.providerId,
    selection.definitionRevision,
    selection.executionPlane,
    selection.requestedCapabilityIds,
    selection.grantedToolIds,
    selection.resultContractId,
  ];
}

/**
 * Freezes the mutable Specialist resultContractId reference to one exact
 * canonical OutcomeContract revision at admission time.
 *
 * The resolver is injected deliberately: persistence/currentness authority
 * remains with the canonical OutcomeContract control plane. This adapter
 * creates provenance only and grants no execution, verification or completion
 * authority.
 */
export async function prepareSpecialistOutcomeContractAdmissionV1(input = {}, dependencies = {}) {
  const raw = snapshot(input, INPUT_KEYS, 'Specialist OutcomeContract admission request');
  const deps = snapshot(dependencies, DEPENDENCY_KEYS, 'Specialist OutcomeContract admission dependencies');
  const projectId = exactId(
    requireOwn(raw, 'projectId', 'Specialist OutcomeContract admission request'),
    'projectId',
  );
  const selection = normalizeSpecialistSelectionV1(
    requireOwn(raw, 'selection', 'Specialist OutcomeContract admission request'),
  );
  const resolver = requireOwn(
    deps,
    'resolveCurrentOutcomeContract',
    'Specialist OutcomeContract admission dependencies',
  );
  if (typeof resolver !== 'function') {
    throw new Error('resolveCurrentOutcomeContract must be a trusted resolver function');
  }

  // All caller-controlled admission data is normalized/frozen before the
  // resolver can cross an asynchronous boundary.
  const lookup = freeze({
    projectId,
    contractId: selection.resultContractId,
  });
  const resolved = await resolver(lookup);
  const contract = normalizeOutcomeContractV1(resolved);
  if (contract.projectId !== projectId) {
    throw new Error('Resolved OutcomeContract project identity does not match Specialist admission');
  }
  if (contract.contractId !== selection.resultContractId) {
    throw new Error('Resolved OutcomeContract identity does not match Specialist resultContractId');
  }
  if (!Number.isSafeInteger(contract.revision)
      || Object.is(contract.revision, -0)
      || contract.revision < 1) {
    throw new Error('Resolved OutcomeContract revision is not a positive exact integer');
  }

  const outcomeContractBindingKey = await sha256Binding(
    contract,
    'Resolved OutcomeContract',
  );
  const bindingKey = await sha256Binding([
    SPECIALIST_OUTCOME_CONTRACT_ADMISSION_VERSION,
    projectId,
    selectionProjection(selection),
    contract.contractId,
    contract.revision,
    outcomeContractBindingKey,
  ], 'Specialist OutcomeContract admission');

  return freeze({
    schemaVersion: SPECIALIST_OUTCOME_CONTRACT_ADMISSION_VERSION,
    projectId,
    registryId: selection.registryId,
    registryRevision: selection.registryRevision,
    registryBindingKey: selection.registryBindingKey,
    specialistId: selection.specialistId,
    providerId: selection.providerId,
    definitionRevision: selection.definitionRevision,
    executionPlane: selection.executionPlane,
    requestedCapabilityIds: selection.requestedCapabilityIds,
    grantedToolIds: selection.grantedToolIds,
    resultContractId: contract.contractId,
    resultContractRevision: contract.revision,
    outcomeContractBindingKey,
    bindingKey,
    executionAuthorized: false,
    verificationAuthorized: false,
    completionAuthorized: false,
  });
}
