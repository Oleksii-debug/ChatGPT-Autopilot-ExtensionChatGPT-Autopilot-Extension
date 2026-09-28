import { normalizeAiRouterSettings } from './ai-orchestrator.js';
import { evaluateBenchmarkRunV1 } from './benchmark-evaluation.js';
import {
  createAiRouteQualityEvidenceRegistryV1,
  normalizeAiRouteQualityEvidenceRegistryV1,
  putAiRouteQualityEvidenceRecordV1,
} from './ai-route-quality-evidence-registry.js';

export const AI_ROUTE_QUALITY_CORE_EVIDENCE_ADMISSION_VERSION = 1;

export const AI_ROUTE_QUALITY_CORE_EVIDENCE_ADMISSION_AUTHORITY = Object.freeze({
  canonicalCoreStateMutationAuthorized: true,
  evidenceAppendAuthorized: true,
  trustedBenchmarkEvidenceResolveAuthorized: true,
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
const FACTORY_KEYS = new Set(['repository', 'resolveTrustedBenchmarkRequest']);
const REQUEST_KEYS = new Set(['routeId', 'runId']);
const BINDING_KEYS = new Set(['routeId', 'maxAgeMs', 'evaluationRequest']);

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

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalRegistryFromState(state) {
  const persisted = state?.profile?.aiRouteQualityEvidenceRegistry;
  return persisted === undefined
    ? createAiRouteQualityEvidenceRegistryV1()
    : normalizeAiRouteQualityEvidenceRegistryV1(persisted);
}

function routeFromState(state, routeId) {
  const router = normalizeAiRouterSettings(state?.profile?.aiRouter || {});
  const route = router.routes.find(item => item.routeId === routeId);
  if (!route) throw new Error('Current canonical AI route does not exist: ' + routeId);
  return route;
}

function exactTrustedBinding(value, routeId, runId) {
  const raw = record(
    value,
    BINDING_KEYS,
    'TrustedAiRouteQualityBenchmarkRequestV1',
  );
  const resolvedRouteId = exactId(
    raw.routeId,
    'TrustedAiRouteQualityBenchmarkRequestV1.routeId',
  );
  if (resolvedRouteId !== routeId) {
    throw new Error('Trusted AI route-quality benchmark routeId mismatch');
  }

  const evaluation = evaluateBenchmarkRunV1(raw.evaluationRequest);
  if (evaluation.subjectId !== routeId) {
    throw new Error('Trusted AI route-quality benchmark subjectId mismatch');
  }
  if (evaluation.runId !== runId) {
    throw new Error('Trusted AI route-quality benchmark runId mismatch');
  }

  return Object.freeze({
    routeId: resolvedRouteId,
    maxAgeMs: raw.maxAgeMs,
    evaluationRequest: raw.evaluationRequest,
  });
}

/**
 * Owner-only admission boundary for trusted route-quality benchmark evidence.
 *
 * Callers can name only the expected route/run identity. They cannot submit a
 * TrustedBenchmarkExecutionV1, evidence artifacts, maxAgeMs, route bytes, or
 * registration time. Those values must come from the owner-injected trusted
 * resolver. The current route is re-read inside StorageRepository.update and
 * #479 revalidates the exact route revision before append.
 */
export function createAiRouteQualityCoreEvidenceAdmissionV1(options) {
  const raw = record(
    options,
    FACTORY_KEYS,
    'AiRouteQualityCoreEvidenceAdmissionV1 options',
  );
  const repository = raw.repository;
  if (!repository || typeof repository.update !== 'function') {
    throw new Error('AiRouteQualityCoreEvidenceAdmissionV1 repository.update must be a function');
  }
  const resolveTrustedBenchmarkRequest = raw.resolveTrustedBenchmarkRequest;
  if (typeof resolveTrustedBenchmarkRequest !== 'function') {
    throw new Error(
      'AiRouteQualityCoreEvidenceAdmissionV1 resolveTrustedBenchmarkRequest must be a function',
    );
  }

  const admit = async input => {
    const request = record(
      input,
      REQUEST_KEYS,
      'AdmitAiRouteQualityCoreEvidenceV1 request',
    );
    const routeId = exactId(request.routeId, 'AdmitAiRouteQualityCoreEvidenceV1.routeId');
    const runId = exactId(request.runId, 'AdmitAiRouteQualityCoreEvidenceV1.runId');

    const trustedRequest = Object.freeze({ routeId, runId });
    const binding = exactTrustedBinding(
      await resolveTrustedBenchmarkRequest(trustedRequest),
      routeId,
      runId,
    );

    const registeredAt = new Date(Date.now()).toISOString();
    const savedState = await repository.update(async draft => {
      const route = routeFromState(draft, routeId);
      const currentRegistry = canonicalRegistryFromState(draft);
      const nextRegistry = await putAiRouteQualityEvidenceRecordV1(currentRegistry, {
        route,
        benchmarkRequest: binding,
        registeredAt,
      });
      const admitted = nextRegistry.records.find(item => item.runId === runId);
      if (!admitted || admitted.routeId !== routeId) {
        throw new Error('Trusted AI route-quality benchmark was not admitted under requested identity');
      }
      draft.profile.aiRouteQualityEvidenceRegistry = structuredClone(nextRegistry);
      return draft;
    });

    const registry = canonicalRegistryFromState(savedState);
    const admitted = registry.records.find(item => item.runId === runId);
    if (!admitted || admitted.routeId !== routeId) {
      throw new Error('Persisted AI route-quality evidence receipt is inconsistent');
    }

    return deepFreeze({
      schemaVersion: AI_ROUTE_QUALITY_CORE_EVIDENCE_ADMISSION_VERSION,
      routeId: admitted.routeId,
      routeRevisionId: admitted.routeRevisionId,
      runId: admitted.runId,
      status: admitted.status,
      caseCount: admitted.caseCount,
      passedCaseCount: admitted.passedCaseCount,
      failedCaseCount: admitted.failedCaseCount,
      completedAt: admitted.completedAt,
      registeredAt: admitted.registeredAt,
      registryRevision: registry.revision,
      coreStateRevision: savedState.revision,
    });
  };

  Object.defineProperty(admit, 'authority', {
    value: AI_ROUTE_QUALITY_CORE_EVIDENCE_ADMISSION_AUTHORITY,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return Object.freeze(admit);
}
