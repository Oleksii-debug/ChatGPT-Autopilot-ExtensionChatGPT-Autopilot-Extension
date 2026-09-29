import { normalizeTrustedOutcomeVerificationRecordV1 } from './outcome-verification-bridge.js';

export const TRUSTED_OUTCOME_VERIFICATION_LEDGER_VERSION = 1;
export const MAX_TRUSTED_OUTCOME_VERIFICATION_RECORDS = 2048;

const LOOKUP_KEYS = new Set([
  'contractId',
  'contractRevision',
  'verifierPlanId',
  'criterionId',
  'verificationId',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function plainDataRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
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

function denseDataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(`${label} exceeds the bounded record limit`);
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-index array property`);
    }
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data array`);
    }
    return descriptor.value;
  });
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must be an exact id`);
  }
  return value;
}

function exactRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive exact integer`);
  }
  return value;
}

function sameCanonicalValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameCanonicalValue(left[index], right[index])) return false;
    }
    return true;
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index] || !sameCanonicalValue(left[key], right[key])) return false;
  }
  return true;
}

export function createTrustedOutcomeVerificationLedgerV1() {
  return Object.freeze({
    schemaVersion: TRUSTED_OUTCOME_VERIFICATION_LEDGER_VERSION,
    revision: 0,
    records: Object.freeze([]),
  });
}

export function normalizeTrustedOutcomeVerificationLedgerV1(input = createTrustedOutcomeVerificationLedgerV1()) {
  const raw = plainDataRecord(input, 'TrustedOutcomeVerificationLedgerV1');
  const keys = Object.keys(raw);
  const expectedKeys = ['schemaVersion', 'revision', 'records'];
  if (keys.length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(raw, key))) {
    throw new Error('TrustedOutcomeVerificationLedgerV1 must contain the exact canonical fields');
  }
  if (raw.schemaVersion !== TRUSTED_OUTCOME_VERIFICATION_LEDGER_VERSION) {
    throw new Error('Unsupported TrustedOutcomeVerificationLedgerV1 schemaVersion');
  }
  const records = denseDataArray(
    raw.records,
    'TrustedOutcomeVerificationLedgerV1 records',
    MAX_TRUSTED_OUTCOME_VERIFICATION_RECORDS,
  ).map(normalizeTrustedOutcomeVerificationRecordV1);
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0 || raw.revision !== records.length) {
    throw new Error('TrustedOutcomeVerificationLedgerV1 revision must equal append-only record count');
  }

  const recordIds = new Map();
  const verificationIds = new Map();
  for (const record of records) {
    if (recordIds.has(record.recordId)) {
      throw new Error('Trusted Outcome verification ledger contains duplicate recordId: ' + record.recordId);
    }
    recordIds.set(record.recordId, record);
    const verificationId = record.verification.verificationId;
    if (verificationIds.has(verificationId)) {
      throw new Error('Trusted Outcome verification ledger contains rebound verificationId: ' + verificationId);
    }
    verificationIds.set(verificationId, record);
  }
  return Object.freeze({
    schemaVersion: TRUSTED_OUTCOME_VERIFICATION_LEDGER_VERSION,
    revision: records.length,
    records: Object.freeze(records),
  });
}

function ledgerFromState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Trusted Outcome verification state must be an object');
  }
  const prototype = Object.getPrototypeOf(state);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Trusted Outcome verification state must be a plain object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    state,
    'trustedOutcomeVerificationLedger',
  );
  if (!descriptor) return createTrustedOutcomeVerificationLedgerV1();
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(
      'trustedOutcomeVerificationLedger must be an enumerable own data property',
    );
  }
  if (descriptor.value === undefined) {
    throw new Error('trustedOutcomeVerificationLedger cannot be undefined when present');
  }
  return normalizeTrustedOutcomeVerificationLedgerV1(descriptor.value);
}

export function validateTrustedOutcomeVerificationLedgerStateV1(state) {
  ledgerFromState(state);
  return state;
}

export function appendTrustedOutcomeVerificationRecordV1(state, input) {
  const current = ledgerFromState(state);
  const record = normalizeTrustedOutcomeVerificationRecordV1(input);
  const byRecordId = current.records.find(item => item.recordId === record.recordId);
  const byVerificationId = current.records.find(
    item => item.verification.verificationId === record.verification.verificationId,
  );
  if (byRecordId || byVerificationId) {
    if (byRecordId
        && byVerificationId === byRecordId
        && sameCanonicalValue(byRecordId, record)) {
      return byRecordId;
    }
    if (byRecordId) {
      throw new Error('Trusted Outcome verification recordId cannot be rebound');
    }
    throw new Error('Trusted Outcome verification verificationId cannot be rebound');
  }
  if (current.records.length >= MAX_TRUSTED_OUTCOME_VERIFICATION_RECORDS) {
    throw new Error('Trusted Outcome verification ledger record limit exceeded');
  }
  const next = normalizeTrustedOutcomeVerificationLedgerV1({
    schemaVersion: TRUSTED_OUTCOME_VERIFICATION_LEDGER_VERSION,
    revision: current.revision + 1,
    records: [...current.records, record],
  });
  state.trustedOutcomeVerificationLedger = structuredClone(next);
  return next.records[next.records.length - 1];
}

function normalizeLookup(input) {
  const raw = plainDataRecord(input, 'Trusted Outcome verification lookup');
  for (const key of Object.keys(raw)) {
    if (!LOOKUP_KEYS.has(key)) {
      throw new Error('Trusted Outcome verification lookup contains unknown field: ' + key);
    }
  }
  for (const key of LOOKUP_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error('Trusted Outcome verification lookup is missing field: ' + key);
    }
  }
  return Object.freeze({
    contractId: exactId(raw.contractId, 'trusted lookup contractId'),
    contractRevision: exactRevision(raw.contractRevision, 'trusted lookup contractRevision'),
    verifierPlanId: exactId(raw.verifierPlanId, 'trusted lookup verifierPlanId'),
    criterionId: exactId(raw.criterionId, 'trusted lookup criterionId'),
    verificationId: exactId(raw.verificationId, 'trusted lookup verificationId'),
  });
}

export function resolveTrustedOutcomeVerificationRecordV1(state, input = {}) {
  const lookup = normalizeLookup(input);
  const ledger = ledgerFromState(state);
  const record = ledger.records.find(
    item => item.verification.verificationId === lookup.verificationId,
  );
  if (!record) return null;
  if (record.contractId !== lookup.contractId
      || record.contractRevision !== lookup.contractRevision
      || record.verifierPlanId !== lookup.verifierPlanId
      || record.criterion.criterionId !== lookup.criterionId) {
    throw new Error('Trusted Outcome verification lookup binding mismatch');
  }
  return record;
}
