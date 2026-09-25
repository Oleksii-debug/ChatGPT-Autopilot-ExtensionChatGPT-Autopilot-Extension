import { ProviderHealthStatus } from './capability-discovery.js';
import { evaluateProviderCanariesV1 } from './provider-canary.js';
import {
  BenchmarkEvaluationStatus,
  evaluateBenchmarkRunV1,
} from './benchmark-evaluation.js';

export const PRODUCT_READINESS_SCHEMA_VERSION = 1;

export const ProductReadinessGateStatus = Object.freeze({
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  UNKNOWN: 'UNKNOWN',
  BLOCKED: 'BLOCKED',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_PROVIDER_CHECKS = 256;
const MAX_BENCHMARK_CHECKS = 256;
const MAX_BENCHMARK_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'evaluationId',
  'subjectId',
  'subjectRevisionId',
  'asOf',
  'providerChecks',
  'benchmarkChecks',
]);

const PROVIDER_CHECK_KEYS = new Set([
  'checkId',
  'required',
  'currentReadiness',
  'definitions',
  'observations',
]);

const BENCHMARK_CHECK_KEYS = new Set([
  'checkId',
  'required',
  'maxAgeMs',
  'suite',
  'run',
  'trustedExecution',
  'trustedEvidenceArtifacts',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain or null-prototype object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' must not contain symbol fields');
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' fields must be enumerable own data properties');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
  }
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(label + ' must be a bounded canonical array');
  }
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array fields');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must be a canonical string identity');
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function integer(value, label, min, max) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(label + ' must be an exact canonical integer in ' + min + '..' + max);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function providerGateStatus(readiness) {
  if (readiness.installationRequired && !readiness.installed) {
    return ['BLOCKED', 'PROVIDER_INSTALL_REQUIRED'];
  }
  if (readiness.authenticationRequired && !readiness.authenticated) {
    return ['BLOCKED', 'PROVIDER_AUTH_REQUIRED'];
  }
  if (readiness.health === ProviderHealthStatus.UNAVAILABLE) {
    return ['BLOCKED', 'PROVIDER_UNAVAILABLE'];
  }
  if (readiness.health === ProviderHealthStatus.UNKNOWN) {
    return ['UNKNOWN', 'PROVIDER_HEALTH_UNKNOWN'];
  }
  if (readiness.health === ProviderHealthStatus.DEGRADED) {
    return ['DEGRADED', 'PROVIDER_DEGRADED'];
  }
  return ['READY', 'PROVIDER_READY'];
}

function normalizeProviderCheck(input, asOf) {
  const raw = record(input, 'ProductReadinessProviderCheckV1');
  exactKeys(raw, PROVIDER_CHECK_KEYS, 'ProductReadinessProviderCheckV1');
  const checkId = id(raw.checkId, 'provider checkId');
  const required = bool(raw.required, 'provider required');
  const evaluation = evaluateProviderCanariesV1({
    schemaVersion: 1,
    asOf,
    currentReadiness: raw.currentReadiness,
    definitions: raw.definitions,
    observations: raw.observations,
  });
  const readiness = evaluation.recommendedProviderReadiness;
  const [gateStatus, reasonCode] = providerGateStatus(readiness);
  const evidenceIds = evaluation.evaluations
    .map(item => item.latestEvidenceId)
    .filter(Boolean)
    .sort(compare);
  return deepFreeze({
    checkId,
    required,
    providerId: evaluation.providerId,
    toolId: readiness.toolId,
    health: readiness.health,
    gateStatus,
    reasonCode,
    canaryCount: evaluation.evaluations.length,
    evidenceIds,
    sourceReasonCode: readiness.reasonCode,
  });
}

function normalizeBenchmarkCheck(input, expectedSubject, asOf) {
  const raw = record(input, 'ProductReadinessBenchmarkCheckV1');
  exactKeys(raw, BENCHMARK_CHECK_KEYS, 'ProductReadinessBenchmarkCheckV1');
  const checkId = id(raw.checkId, 'benchmark checkId');
  const required = bool(raw.required, 'benchmark required');
  const maxAgeMs = integer(
    raw.maxAgeMs,
    'benchmark maxAgeMs',
    1,
    MAX_BENCHMARK_AGE_MS,
  );
  const evaluation = evaluateBenchmarkRunV1({
    suite: raw.suite,
    run: raw.run,
    expectedSubject,
    trustedExecution: raw.trustedExecution,
    trustedEvidenceArtifacts: raw.trustedEvidenceArtifacts,
  });
  const completedMs = Date.parse(evaluation.completedAt);
  const asOfMs = Date.parse(asOf);
  if (completedMs > asOfMs) {
    throw new Error('benchmark evidence occurs after readiness asOf: ' + checkId);
  }
  const ageMs = asOfMs - completedMs;
  let gateStatus;
  let reasonCode;
  if (ageMs > maxAgeMs) {
    gateStatus = ProductReadinessGateStatus.UNKNOWN;
    reasonCode = 'BENCHMARK_STALE';
  } else if (evaluation.status === BenchmarkEvaluationStatus.FAIL) {
    gateStatus = ProductReadinessGateStatus.BLOCKED;
    reasonCode = 'BENCHMARK_FAILED';
  } else {
    gateStatus = ProductReadinessGateStatus.READY;
    reasonCode = 'BENCHMARK_PASSED';
  }
  return deepFreeze({
    checkId,
    required,
    suiteId: evaluation.suiteId,
    suiteRevisionId: evaluation.suiteRevisionId,
    runId: evaluation.runId,
    completedAt: evaluation.completedAt,
    ageMs,
    maxAgeMs,
    evaluationStatus: evaluation.status,
    gateStatus,
    reasonCode,
    caseCount: evaluation.caseCount,
    passedCaseCount: evaluation.passedCaseCount,
    failedCaseCount: evaluation.failedCaseCount,
  });
}

function overallStatus(requiredChecks) {
  if (requiredChecks.length === 0) return ProductReadinessGateStatus.UNKNOWN;
  if (requiredChecks.some(item => item.gateStatus === ProductReadinessGateStatus.BLOCKED)) {
    return ProductReadinessGateStatus.BLOCKED;
  }
  if (requiredChecks.some(item => item.gateStatus === ProductReadinessGateStatus.UNKNOWN)) {
    return ProductReadinessGateStatus.UNKNOWN;
  }
  if (requiredChecks.some(item => item.gateStatus === ProductReadinessGateStatus.DEGRADED)) {
    return ProductReadinessGateStatus.DEGRADED;
  }
  return ProductReadinessGateStatus.READY;
}

export function buildProductReadinessEvaluationV1(input) {
  const raw = record(input, 'ProductReadinessEvaluationRequestV1');
  exactKeys(raw, REQUEST_KEYS, 'ProductReadinessEvaluationRequestV1');
  if (raw.schemaVersion !== PRODUCT_READINESS_SCHEMA_VERSION) {
    throw new Error('ProductReadinessEvaluationRequestV1 schemaVersion must be numeric 1');
  }

  const evaluationId = id(raw.evaluationId, 'evaluationId');
  const subjectId = id(raw.subjectId, 'subjectId');
  const subjectRevisionId = id(raw.subjectRevisionId, 'subjectRevisionId');
  const asOf = timestamp(raw.asOf, 'asOf');
  const expectedSubject = { subjectId, subjectRevisionId };

  const providerChecks = denseArray(
    raw.providerChecks,
    'providerChecks',
    MAX_PROVIDER_CHECKS,
  ).map(item => normalizeProviderCheck(item, asOf));

  const benchmarkChecks = denseArray(
    raw.benchmarkChecks,
    'benchmarkChecks',
    MAX_BENCHMARK_CHECKS,
  ).map(item => normalizeBenchmarkCheck(item, expectedSubject, asOf));

  const checkIds = new Set();
  for (const check of [...providerChecks, ...benchmarkChecks]) {
    if (checkIds.has(check.checkId)) {
      throw new Error('readiness checks contain duplicate checkId: ' + check.checkId);
    }
    checkIds.add(check.checkId);
  }

  const providerIds = new Set();
  for (const check of providerChecks) {
    if (providerIds.has(check.providerId)) {
      throw new Error('providerChecks contain duplicate providerId: ' + check.providerId);
    }
    providerIds.add(check.providerId);
  }

  const suiteIds = new Set();
  for (const check of benchmarkChecks) {
    if (suiteIds.has(check.suiteId)) {
      throw new Error('benchmarkChecks contain duplicate suiteId: ' + check.suiteId);
    }
    suiteIds.add(check.suiteId);
  }

  providerChecks.sort((a, b) => compare(a.checkId, b.checkId));
  benchmarkChecks.sort((a, b) => compare(a.checkId, b.checkId));

  const allChecks = [...providerChecks, ...benchmarkChecks];
  const requiredChecks = allChecks.filter(item => item.required);
  const status = overallStatus(requiredChecks);

  const requiredReadyCount = requiredChecks
    .filter(item => item.gateStatus === ProductReadinessGateStatus.READY).length;
  const requiredDegradedCount = requiredChecks
    .filter(item => item.gateStatus === ProductReadinessGateStatus.DEGRADED).length;
  const requiredUnknownCount = requiredChecks
    .filter(item => item.gateStatus === ProductReadinessGateStatus.UNKNOWN).length;
  const requiredBlockedCount = requiredChecks
    .filter(item => item.gateStatus === ProductReadinessGateStatus.BLOCKED).length;

  return deepFreeze({
    schemaVersion: PRODUCT_READINESS_SCHEMA_VERSION,
    evaluationId,
    subjectId,
    subjectRevisionId,
    asOf,
    status,
    providerChecks,
    benchmarkChecks,
    summary: {
      checkCount: allChecks.length,
      requiredCheckCount: requiredChecks.length,
      requiredReadyCount,
      requiredDegradedCount,
      requiredUnknownCount,
      requiredBlockedCount,
    },
    readOnly: true,
    advisoryOnly: true,
    executionAuthorized: false,
    policyDecisionAuthorized: false,
    readinessMutationAuthorized: false,
    releaseAuthorized: false,
    requiresIndependentPhysicalAcceptance: true,
  });
}
