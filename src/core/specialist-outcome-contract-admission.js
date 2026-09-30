import { normalizeOutcomeContractV1 } from './outcome-contract.js';
import { normalizeSpecialistSelectionV1 } from './specialist-registry.js';

export const SPECIALIST_OUTCOME_CONTRACT_ADMISSION_VERSION = 1;

const PREPARE_INPUT_KEYS = new Set(['projectId', 'selection']);
const PREPARE_DEPENDENCY_KEYS = new Set(['resolveCurrentOutcomeContract']);
const VERIFY_INPUT_KEYS = new Set(['admission', 'selection']);
const VERIFY_DEPENDENCY_KEYS = new Set(['resolveCanonicalOutcomeContract']);
const ADMISSION_KEYS = new Set([
  'schemaVersion',
  'projectId',
  'registryId',
  'registryRevision',
  'registryBindingKey',
  'specialistId',
  'providerId',
  'definitionRevision',
  'executionPlane',
  'requestedCapabilityIds',
  'grantedToolIds',
  'resultContractId',
  'resultContractRevision',
  'outcomeContractBindingKey',
  'bindingKey',
  'executionAuthorized',
  'verificationAuthorized',
  'completionAuthorized',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
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

function exactPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw new Error(label + ' must be a positive exact integer');
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(label + ' must be an exact SHA-256 binding');
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

function admissionSelection(admission) {
  return normalizeSpecialistSelectionV1({
    schemaVersion: 1,
    registryId: admission.registryId,
    registryRevision: admission.registryRevision,
    registryBindingKey: admission.registryBindingKey,
    specialistId: admission.specialistId,
    providerId: admission.providerId,
    definitionRevision: admission.definitionRevision,
    executionPlane: admission.executionPlane,
    requestedCapabilityIds: admission.requestedCapabilityIds,
    grantedToolIds: admission.grantedToolIds,
    resultContractId: admission.resultContractId,
  });
}

function sameProjection(left, right) {
  return JSON.stringify(selectionProjection(left)) === JSON.stringify(selectionProjection(right));
}

async function admissionBindingKey(projectId, selection, contractId, contractRevision, outcomeContractBindingKey) {
  return sha256Binding([
    SPECIALIST_OUTCOME_CONTRACT_ADMISSION_VERSION,
    projectId,
    selectionProjection(selection),
    contractId,
    contractRevision,
    outcomeContractBindingKey,
  ], 'Specialist OutcomeContract admission');
}

export function normalizeSpecialistOutcomeContractAdmissionV1(input) {
  const raw = snapshot(input, ADMISSION_KEYS, 'Specialist OutcomeContract admission');
  for (const key of ADMISSION_KEYS) requireOwn(raw, key, 'Specialist OutcomeContract admission');
  if (raw.schemaVersion !== SPECIALIST_OUTCOME_CONTRACT_ADMISSION_VERSION) {
    throw new Error('Specialist OutcomeContract admission schemaVersion must be numeric 1');
  }
  const projectId = exactId(raw.projectId, 'projectId');
  const selection = admissionSelection(raw);
  const resultContractRevision = exactPositiveInteger(raw.resultContractRevision, 'resultContractRevision');
  const outcomeContractBindingKey = exactSha256(raw.outcomeContractBindingKey, 'outcomeContractBindingKey');
  const bindingKey = exactSha256(raw.bindingKey, 'bindingKey');
  if (raw.executionAuthorized !== false
      || raw.verificationAuthorized !== false
      || raw.completionAuthorized !== false) {
    throw new Error('Specialist OutcomeContract admission cannot grant authority');
  }
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
    resultContractId: selection.resultContractId,
    resultContractRevision,
    outcomeContractBindingKey,
    bindingKey,
    executionAuthorized: false,
    verificationAuthorized: false,
    completionAuthorized: false,
  });
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
  const raw = snapshot(input, PREPARE_INPUT_KEYS, 'Specialist OutcomeContract admission request');
  const deps = snapshot(
    dependencies,
    PREPARE_DEPENDENCY_KEYS,
    'Specialist OutcomeContract admission dependencies',
  );
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
  const resultContractRevision = exactPositiveInteger(contract.revision, 'Resolved OutcomeContract revision');
  const outcomeContractBindingKey = await sha256Binding(contract, 'Resolved OutcomeContract');
  const bindingKey = await admissionBindingKey(
    projectId,
    selection,
    contract.contractId,
    resultContractRevision,
    outcomeContractBindingKey,
  );

  return normalizeSpecialistOutcomeContractAdmissionV1({
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
    resultContractRevision,
    outcomeContractBindingKey,
    bindingKey,
    executionAuthorized: false,
    verificationAuthorized: false,
    completionAuthorized: false,
  });
}

/**
 * Revalidates persisted admission provenance after restart/recovery using the
 * canonical immutable historical OutcomeContract resolver. This does not
 * decide verification or completion; it only proves the persisted admission
 * still names the exact selection and contract semantics admitted earlier.
 */
export async function verifySpecialistOutcomeContractAdmissionV1(input = {}, dependencies = {}) {
  const raw = snapshot(input, VERIFY_INPUT_KEYS, 'Specialist OutcomeContract verification request');
  const deps = snapshot(
    dependencies,
    VERIFY_DEPENDENCY_KEYS,
    'Specialist OutcomeContract verification dependencies',
  );
  const admission = normalizeSpecialistOutcomeContractAdmissionV1(
    requireOwn(raw, 'admission', 'Specialist OutcomeContract verification request'),
  );
  const selection = normalizeSpecialistSelectionV1(
    requireOwn(raw, 'selection', 'Specialist OutcomeContract verification request'),
  );
  const admittedSelection = admissionSelection(admission);
  if (!sameProjection(selection, admittedSelection)) {
    throw new Error('Specialist selection drifted from persisted OutcomeContract admission');
  }
  const resolver = requireOwn(
    deps,
    'resolveCanonicalOutcomeContract',
    'Specialist OutcomeContract verification dependencies',
  );
  if (typeof resolver !== 'function') {
    throw new Error('resolveCanonicalOutcomeContract must be a trusted resolver function');
  }

  const lookup = freeze({
    contractId: admission.resultContractId,
    contractRevision: admission.resultContractRevision,
  });
  const resolved = await resolver(lookup);
  const contract = normalizeOutcomeContractV1(resolved);
  if (contract.projectId !== admission.projectId
      || contract.contractId !== admission.resultContractId
      || contract.revision !== admission.resultContractRevision) {
    throw new Error('Canonical OutcomeContract drifted from persisted Specialist admission identity');
  }
  const outcomeContractBindingKey = await sha256Binding(contract, 'Canonical OutcomeContract');
  if (outcomeContractBindingKey !== admission.outcomeContractBindingKey) {
    throw new Error('Canonical OutcomeContract semantics drifted from persisted Specialist admission');
  }
  const bindingKey = await admissionBindingKey(
    admission.projectId,
    selection,
    admission.resultContractId,
    admission.resultContractRevision,
    outcomeContractBindingKey,
  );
  if (bindingKey !== admission.bindingKey) {
    throw new Error('Persisted Specialist OutcomeContract admission binding is invalid');
  }
  return admission;
}
