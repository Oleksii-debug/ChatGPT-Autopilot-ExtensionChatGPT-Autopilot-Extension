import {
  BenchmarkEvaluationStatus,
  evaluateBenchmarkRunV1,
} from './benchmark-evaluation.js';
import { deriveAiRouteQualitySubjectRevisionIdV1 } from './ai-route-quality-governor.js';

export const AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_VERSION = 1;
export const MAX_AI_ROUTE_QUALITY_RECORDS = 256;
export const MAX_AI_ROUTE_QUALITY_RECORDS_PER_ROUTE = 16;
export const MAX_AI_ROUTE_QUALITY_READ_ROUTES = 32;

export const AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_AUTHORITY = Object.freeze({
  appendOnlyEvidenceHistory: true,
  benchmarkExecutionAuthorized: false,
  artifactStoreAuthorized: false,
  routeSelectionAuthorized: false,
  dispatchAuthorized: false,
  providerAuthorized: false,
  policyAuthorized: false,
  budgetAuthorized: false,
  schedulerAuthorized: false,
  recoveryAuthorized: false,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REGISTRY_KEYS = new Set(['schemaVersion', 'revision', 'records']);
const RECORD_KEYS = new Set([
  'schemaVersion',
  'routeId',
  'routeRevisionId',
  'runId',
  'suiteId',
  'suiteRevisionId',
  'completedAt',
  'registeredAt',
  'maxAgeMs',
  'status',
  'caseCount',
  'passedCaseCount',
  'failedCaseCount',
  'evaluationRequest',
]);
const PUT_KEYS = new Set(['route', 'benchmarkRequest', 'registeredAt']);
const BINDING_KEYS = new Set(['routeId', 'evaluationRequest', 'maxAgeMs']);
const READ_KEYS = new Set(['routeIds']);
const STATUSES = new Set(Object.values(BenchmarkEvaluationStatus));
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_STRING_CHARS = 2_000_000;
const MAX_OBJECT_KEYS = 512;

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  const seen = new Set();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
    seen.add(key);
  }
  for (const key of allowed) {
    if (!seen.has(key)) throw new Error(label + ' is missing field: ' + key);
  }
  return out;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' has invalid length');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.size || keys.some(key => typeof key !== 'string' || !expected.has(key))) {
    throw new Error(label + ' must be dense and data-only');
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

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(label + ' must be an exact integer in range');
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(label + ' must be canonical ISO-8601 UTC');
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotJsonData(value, label) {
  const state = { nodes: 0, stringChars: 0 };

  const visit = (item, path, depth) => {
    state.nodes += 1;
    if (state.nodes > MAX_JSON_NODES) throw new Error(label + ' exceeds JSON node limit');
    if (depth > MAX_JSON_DEPTH) throw new Error(label + ' exceeds JSON depth limit');

    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      state.stringChars += item.length;
      if (state.stringChars > MAX_JSON_STRING_CHARS) {
        throw new Error(label + ' exceeds JSON string-size limit');
      }
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) {
        throw new Error(path + ' must use exact finite non-negative-zero JSON number representation');
      }
      return item;
    }
    if (typeof item !== 'object') {
      throw new Error(path + ' contains a non-JSON value');
    }

    if (Array.isArray(item)) {
      const values = denseArray(item, path, MAX_JSON_NODES);
      return values.map((child, index) => visit(child, path + '[' + index + ']', depth + 1));
    }

    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(path + ' must contain plain JSON objects only');
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_OBJECT_KEYS) throw new Error(path + ' has too many object fields');
    if (keys.some(key => typeof key !== 'string')) throw new Error(path + ' contains symbol fields');
    const names = keys.sort();
    const out = Object.create(null);
    for (const key of names) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(path + '.' + key + ' must be an enumerable own data property');
      }
      out[key] = visit(descriptor.value, path + '.' + key, depth + 1);
    }
    return out;
  };

  return deepFreeze(visit(value, label, 0));
}

function normalizeSummary(raw, evaluation, label) {
  if (raw.status !== evaluation.status || typeof raw.status !== 'string' || !STATUSES.has(raw.status)) {
    throw new Error(label + ' status does not match evaluated benchmark');
  }
  const caseCount = exactInteger(raw.caseCount, label + '.caseCount');
  const passedCaseCount = exactInteger(raw.passedCaseCount, label + '.passedCaseCount');
  const failedCaseCount = exactInteger(raw.failedCaseCount, label + '.failedCaseCount');
  if (caseCount !== evaluation.caseCount
      || passedCaseCount !== evaluation.passedCaseCount
      || failedCaseCount !== evaluation.failedCaseCount) {
    throw new Error(label + ' counts do not match evaluated benchmark');
  }
  return { caseCount, passedCaseCount, failedCaseCount };
}

function normalizeStoredRecord(input, index) {
  const label = 'AiRouteQualityEvidenceRecordV1[' + index + ']';
  const raw = record(input, RECORD_KEYS, label);
  if (raw.schemaVersion !== AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_VERSION) {
    throw new Error('Unsupported ' + label + ' schemaVersion');
  }
  const evaluationRequest = snapshotJsonData(raw.evaluationRequest, label + '.evaluationRequest');
  const evaluation = evaluateBenchmarkRunV1(evaluationRequest);
  const routeId = exactId(raw.routeId, label + '.routeId');
  const routeRevisionId = exactId(raw.routeRevisionId, label + '.routeRevisionId');
  const runId = exactId(raw.runId, label + '.runId');
  const suiteId = exactId(raw.suiteId, label + '.suiteId');
  const suiteRevisionId = exactId(raw.suiteRevisionId, label + '.suiteRevisionId');
  const completedAt = exactTimestamp(raw.completedAt, label + '.completedAt');
  const registeredAt = exactTimestamp(raw.registeredAt, label + '.registeredAt');
  const maxAgeMs = exactInteger(raw.maxAgeMs, label + '.maxAgeMs', { min:1, max:31_536_000_000 });
  const summary = normalizeSummary(raw, evaluation, label);

  if (routeId !== evaluation.subjectId
      || routeRevisionId !== evaluation.subjectRevisionId
      || runId !== evaluation.runId
      || suiteId !== evaluation.suiteId
      || suiteRevisionId !== evaluation.suiteRevisionId
      || completedAt !== evaluation.completedAt) {
    throw new Error(label + ' identity does not match evaluated benchmark');
  }
  if (Date.parse(registeredAt) < Date.parse(completedAt)) {
    throw new Error(label + ' registeredAt cannot predate benchmark completion');
  }

  return deepFreeze({
    schemaVersion: AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_VERSION,
    routeId,
    routeRevisionId,
    runId,
    suiteId,
    suiteRevisionId,
    completedAt,
    registeredAt,
    maxAgeMs,
    status:evaluation.status,
    caseCount:summary.caseCount,
    passedCaseCount:summary.passedCaseCount,
    failedCaseCount:summary.failedCaseCount,
    evaluationRequest,
  });
}

export function createAiRouteQualityEvidenceRegistryV1() {
  return deepFreeze({
    schemaVersion: AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_VERSION,
    revision:0,
    records:[],
  });
}

export function normalizeAiRouteQualityEvidenceRegistryV1(input) {
  const raw = record(input, REGISTRY_KEYS, 'AiRouteQualityEvidenceRegistryV1');
  if (raw.schemaVersion !== AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_VERSION) {
    throw new Error('Unsupported AiRouteQualityEvidenceRegistryV1 schemaVersion');
  }
  const records = denseArray(
    raw.records,
    'AiRouteQualityEvidenceRegistryV1.records',
    MAX_AI_ROUTE_QUALITY_RECORDS,
  ).map((item, index) => normalizeStoredRecord(item, index));
  const revision = exactInteger(raw.revision, 'AiRouteQualityEvidenceRegistryV1.revision');
  if (revision !== records.length) {
    throw new Error('AiRouteQualityEvidenceRegistryV1 revision must equal append-only record count');
  }

  const runIds = new Set();
  const routeCounts = new Map();
  let previousRegisteredAt = -1;
  for (const item of records) {
    if (runIds.has(item.runId)) {
      throw new Error('AiRouteQualityEvidenceRegistryV1 contains duplicate runId: ' + item.runId);
    }
    runIds.add(item.runId);
    const nextCount = (routeCounts.get(item.routeId) || 0) + 1;
    if (nextCount > MAX_AI_ROUTE_QUALITY_RECORDS_PER_ROUTE) {
      throw new Error('AI route quality history limit exceeded for route: ' + item.routeId);
    }
    routeCounts.set(item.routeId, nextCount);
    const registeredAt = Date.parse(item.registeredAt);
    if (registeredAt < previousRegisteredAt) {
      throw new Error('AiRouteQualityEvidenceRegistryV1 registeredAt chronology cannot regress');
    }
    previousRegisteredAt = registeredAt;
  }

  return deepFreeze({
    schemaVersion:AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_VERSION,
    revision,
    records,
  });
}

function canonicalSignature(value) {
  return JSON.stringify(value);
}

export async function putAiRouteQualityEvidenceRecordV1(registryInput, input) {
  const registry = normalizeAiRouteQualityEvidenceRegistryV1(registryInput);
  const raw = record(input, PUT_KEYS, 'PutAiRouteQualityEvidenceRecordV1 request');
  const binding = record(raw.benchmarkRequest, BINDING_KEYS, 'PutAiRouteQualityEvidenceRecordV1 benchmarkRequest');
  const routeId = exactId(binding.routeId, 'PutAiRouteQualityEvidenceRecordV1 routeId');
  const maxAgeMs = exactInteger(
    binding.maxAgeMs,
    'PutAiRouteQualityEvidenceRecordV1 maxAgeMs',
    { min:1, max:31_536_000_000 },
  );
  const evaluationRequest = snapshotJsonData(
    binding.evaluationRequest,
    'PutAiRouteQualityEvidenceRecordV1 evaluationRequest',
  );
  const evaluation = evaluateBenchmarkRunV1(evaluationRequest);
  const routeRevisionId = await deriveAiRouteQualitySubjectRevisionIdV1(raw.route);
  const registeredAt = exactTimestamp(raw.registeredAt, 'PutAiRouteQualityEvidenceRecordV1 registeredAt');

  if (routeId !== evaluation.subjectId) {
    throw new Error('Route-quality benchmark subjectId does not match routeId');
  }
  if (routeRevisionId !== evaluation.subjectRevisionId) {
    throw new Error('Route-quality benchmark subjectRevisionId does not match current route configuration');
  }
  if (Date.parse(registeredAt) < Date.parse(evaluation.completedAt)) {
    throw new Error('Route-quality evidence registration cannot predate benchmark completion');
  }

  const nextRecord = deepFreeze({
    schemaVersion:AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_VERSION,
    routeId,
    routeRevisionId,
    runId:evaluation.runId,
    suiteId:evaluation.suiteId,
    suiteRevisionId:evaluation.suiteRevisionId,
    completedAt:evaluation.completedAt,
    registeredAt,
    maxAgeMs,
    status:evaluation.status,
    caseCount:evaluation.caseCount,
    passedCaseCount:evaluation.passedCaseCount,
    failedCaseCount:evaluation.failedCaseCount,
    evaluationRequest,
  });

  const existing = registry.records.find(item => item.runId === nextRecord.runId);
  if (existing) {
    if (canonicalSignature(existing) !== canonicalSignature(nextRecord)) {
      throw new Error('Divergent route-quality benchmark runId collision: ' + nextRecord.runId);
    }
    return registry;
  }
  if (registry.records.length >= MAX_AI_ROUTE_QUALITY_RECORDS) {
    throw new Error('AI route quality evidence registry capacity exceeded');
  }
  const routeCount = registry.records.filter(item => item.routeId === routeId).length;
  if (routeCount >= MAX_AI_ROUTE_QUALITY_RECORDS_PER_ROUTE) {
    throw new Error('AI route quality history limit exceeded for route: ' + routeId);
  }
  const last = registry.records.at(-1);
  if (last && Date.parse(registeredAt) < Date.parse(last.registeredAt)) {
    throw new Error('AI route quality evidence registeredAt chronology cannot regress');
  }

  return deepFreeze({
    schemaVersion:AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_VERSION,
    revision:registry.revision + 1,
    records:[...registry.records, nextRecord],
  });
}

function normalizeReadRequest(input) {
  const raw = record(input, READ_KEYS, 'ReadAiRouteQualityEvidenceV1 request');
  const routeIds = denseArray(
    raw.routeIds,
    'ReadAiRouteQualityEvidenceV1 routeIds',
    MAX_AI_ROUTE_QUALITY_READ_ROUTES,
  ).map((value, index) => exactId(value, 'ReadAiRouteQualityEvidenceV1 routeIds[' + index + ']'));
  if (!routeIds.length) throw new Error('ReadAiRouteQualityEvidenceV1 routeIds must not be empty');
  if (new Set(routeIds).size !== routeIds.length) {
    throw new Error('ReadAiRouteQualityEvidenceV1 routeIds contains duplicates');
  }
  return Object.freeze(routeIds);
}

export function readLatestAiRouteQualityBenchmarkRequestsV1(registryInput, input) {
  const registry = normalizeAiRouteQualityEvidenceRegistryV1(registryInput);
  const routeIds = normalizeReadRequest(input);
  const requested = new Set(routeIds);
  const latest = new Map();
  for (const item of registry.records) {
    if (requested.has(item.routeId)) latest.set(item.routeId, item);
  }
  return Object.freeze(routeIds.flatMap(routeId => {
    const item = latest.get(routeId);
    if (!item) return [];
    return [deepFreeze({
      routeId:item.routeId,
      evaluationRequest:item.evaluationRequest,
      maxAgeMs:item.maxAgeMs,
    })];
  }));
}
