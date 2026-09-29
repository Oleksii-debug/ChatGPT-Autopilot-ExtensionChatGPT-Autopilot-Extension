import {
  normalizeTrustedExecutionVerificationRecordV1,
} from './execution-plane-ownership.js';

export const TRUSTED_EXECUTION_VERIFICATION_LEDGER_STORAGE_KEY =
  'autopilotTrustedExecutionVerificationLedger';
export const TRUSTED_EXECUTION_VERIFICATION_LEDGER_VERSION = 1;
export const MAX_TRUSTED_EXECUTION_VERIFICATION_RECORDS = 512;

const LOOKUP_KEYS = new Set([
  'taskId',
  'planId',
  'nodeId',
  'effectId',
  'policyEnvelopeId',
  'executionId',
  'verificationId',
  'expectedOutcome',
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const OUTCOMES = new Set(['EFFECT_VERIFIED', 'NO_EFFECT_VERIFIED']);

function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${String(key)} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  for (const key of allowed) {
    if (!Object.hasOwn(out, key)) {
      throw new Error(`${label} is missing field: ${key}`);
    }
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function exactRevision(value) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error('Trusted execution verification ledger revision is invalid');
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function denseRecords(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('Trusted execution verification ledger records must be a bounded plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length)
      || length < 0
      || length > MAX_TRUSTED_EXECUTION_VERIFICATION_RECORDS) {
    throw new Error('Trusted execution verification ledger record count is invalid');
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error('Trusted execution verification ledger records contain non-canonical fields');
    }
  }
  const records = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Trusted execution verification ledger records must be dense data entries');
    }
    records[index] = assertIntrinsicRecordChronology(
      normalizeTrustedExecutionVerificationRecordV1(descriptor.value),
    );
  }
  return records;
}

function assertIntrinsicRecordChronology(record) {
  const verifiedAt = Date.parse(record.verification.verifiedAt);
  const recordedAt = Date.parse(record.recordedAt);
  const validThrough = Date.parse(record.validThrough);
  if (recordedAt < verifiedAt) {
    throw new Error('Trusted execution verification record predates its verification');
  }
  if (validThrough < recordedAt) {
    throw new Error('Trusted execution verification record validity interval is invalid');
  }
  for (const artifact of record.evidenceArtifacts) {
    if (Date.parse(artifact.createdAt) > verifiedAt) {
      throw new Error(
        `Trusted execution verification evidence postdates verification: ${artifact.artifactId}`,
      );
    }
  }
  return record;
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function sameCanonicalRecord(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function exactLookup(input) {
  const raw = snapshotRecord(
    input,
    LOOKUP_KEYS,
    'Trusted execution verification ledger lookup',
  );
  const expectedOutcome = raw.expectedOutcome;
  if (typeof expectedOutcome !== 'string'
      || expectedOutcome !== expectedOutcome.trim()
      || !OUTCOMES.has(expectedOutcome)) {
    throw new Error('expectedOutcome is invalid');
  }
  return deepFreeze({
    taskId: exactId(raw.taskId, 'taskId'),
    planId: exactId(raw.planId, 'planId'),
    nodeId: exactId(raw.nodeId, 'nodeId'),
    effectId: exactId(raw.effectId, 'effectId'),
    policyEnvelopeId: exactId(raw.policyEnvelopeId, 'policyEnvelopeId'),
    executionId: exactId(raw.executionId, 'executionId'),
    verificationId: exactId(raw.verificationId, 'verificationId'),
    expectedOutcome,
  });
}

function recordMatchesLookup(record, lookup) {
  return record.taskId === lookup.taskId
    && record.planId === lookup.planId
    && record.nodeId === lookup.nodeId
    && record.effectId === lookup.effectId
    && record.policyEnvelopeId === lookup.policyEnvelopeId
    && record.executionId === lookup.executionId
    && record.verification.verificationId === lookup.verificationId
    && record.outcome === lookup.expectedOutcome;
}

export function createTrustedExecutionVerificationLedgerV1() {
  return deepFreeze({
    schemaVersion: TRUSTED_EXECUTION_VERIFICATION_LEDGER_VERSION,
    revision: 0,
    records: [],
  });
}

export function normalizeTrustedExecutionVerificationLedgerV1(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Trusted execution verification ledger must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Trusted execution verification ledger must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set(['schemaVersion', 'revision', 'records']);
  const raw = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`Trusted execution verification ledger contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(
        `Trusted execution verification ledger.${String(key)} must be an enumerable own data property`,
      );
    }
    raw[key] = descriptor.value;
  }
  for (const key of allowed) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error(`Trusted execution verification ledger is missing field: ${key}`);
    }
  }
  if (raw.schemaVersion !== TRUSTED_EXECUTION_VERIFICATION_LEDGER_VERSION) {
    throw new Error('Unsupported trusted execution verification ledger schemaVersion');
  }
  const records = denseRecords(raw.records);
  const recordIds = new Set();
  const verificationIds = new Set();
  const executionVerificationKeys = new Set();
  for (const record of records) {
    if (recordIds.has(record.recordId)) {
      throw new Error(`Duplicate trusted execution verification recordId: ${record.recordId}`);
    }
    recordIds.add(record.recordId);
    const verificationId = record.verification.verificationId;
    if (verificationIds.has(verificationId)) {
      throw new Error(
        `Duplicate trusted execution verification verificationId: ${verificationId}`,
      );
    }
    verificationIds.add(verificationId);
    const bindingKey = [
      record.taskId,
      record.planId,
      record.nodeId,
      record.effectId,
      record.policyEnvelopeId,
      record.executionId,
      verificationId,
    ].join('\u001f');
    if (executionVerificationKeys.has(bindingKey)) {
      throw new Error('Duplicate trusted execution verification binding');
    }
    executionVerificationKeys.add(bindingKey);
  }
  return deepFreeze({
    schemaVersion: TRUSTED_EXECUTION_VERIFICATION_LEDGER_VERSION,
    revision: exactRevision(raw.revision),
    records,
  });
}

export function appendTrustedExecutionVerificationRecordV1(ledgerInput, recordInput) {
  const ledger = normalizeTrustedExecutionVerificationLedgerV1(ledgerInput);
  const canonicalInputLedger = Object.isFrozen(ledgerInput) ? ledgerInput : null;
  const record = assertIntrinsicRecordChronology(
    normalizeTrustedExecutionVerificationRecordV1(recordInput),
  );

  const byRecordId = ledger.records.find(item => item.recordId === record.recordId);
  if (byRecordId) {
    if (!sameCanonicalRecord(byRecordId, record)) {
      throw new Error('Trusted execution verification recordId is append-only and cannot be rewritten');
    }
    return canonicalInputLedger || ledger;
  }

  const verificationId = record.verification.verificationId;
  const byVerificationId = ledger.records.find(
    item => item.verification.verificationId === verificationId,
  );
  if (byVerificationId) {
    if (!sameCanonicalRecord(byVerificationId, record)) {
      throw new Error(
        'Trusted execution verification verificationId is append-only and cannot be rebound',
      );
    }
    return canonicalInputLedger || ledger;
  }

  if (ledger.records.length >= MAX_TRUSTED_EXECUTION_VERIFICATION_RECORDS) {
    throw new Error('Trusted execution verification ledger is full');
  }
  if (ledger.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Trusted execution verification ledger revision is exhausted');
  }

  return normalizeTrustedExecutionVerificationLedgerV1({
    schemaVersion: TRUSTED_EXECUTION_VERIFICATION_LEDGER_VERSION,
    revision: ledger.revision + 1,
    records: [...ledger.records, record],
  });
}

export function resolveTrustedExecutionVerificationRecordV1(ledgerInput, lookupInput) {
  const ledger = normalizeTrustedExecutionVerificationLedgerV1(ledgerInput);
  const lookup = exactLookup(lookupInput);
  const matches = ledger.records.filter(record => recordMatchesLookup(record, lookup));
  if (matches.length > 1) {
    throw new Error('Trusted execution verification ledger contains ambiguous matching records');
  }
  return matches.length === 1 ? matches[0] : null;
}

export class TrustedExecutionVerificationLedgerRepository {
  constructor(chromeApi, {
    storageKey = TRUSTED_EXECUTION_VERIFICATION_LEDGER_STORAGE_KEY,
  } = {}) {
    if (!chromeApi?.storage?.local
        || typeof chromeApi.storage.local.get !== 'function'
        || typeof chromeApi.storage.local.set !== 'function') {
      throw new Error('Trusted execution verification ledger requires chrome.storage.local');
    }
    this.chrome = chromeApi;
    this.storageKey = exactId(storageKey, 'storageKey');
    this.updateQueue = Promise.resolve();
  }

  async load() {
    const stored = await this.chrome.storage.local.get(this.storageKey);
    const raw = stored?.[this.storageKey];
    return raw === undefined
      ? createTrustedExecutionVerificationLedgerV1()
      : normalizeTrustedExecutionVerificationLedgerV1(raw);
  }

  async save(ledgerInput) {
    const ledger = normalizeTrustedExecutionVerificationLedgerV1(ledgerInput);
    await this.chrome.storage.local.set({
      [this.storageKey]: structuredClone(ledger),
    });
    return ledger;
  }

  append(recordInput) {
    const operation = this.updateQueue.then(async () => {
      const current = await this.load();
      const next = appendTrustedExecutionVerificationRecordV1(current, recordInput);
      if (next !== current) await this.save(next);
      return next;
    });
    this.updateQueue = operation.catch(() => undefined);
    return operation;
  }

  async resolve(lookupInput) {
    const ledger = await this.load();
    return resolveTrustedExecutionVerificationRecordV1(ledger, lookupInput);
  }

  resolver() {
    return lookup => this.resolve(lookup);
  }
}
