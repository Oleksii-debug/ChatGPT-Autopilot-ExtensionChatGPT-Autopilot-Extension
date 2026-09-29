import {
  createAiRouteQualityEvidenceRegistryV1,
  normalizeAiRouteQualityEvidenceRegistryV1,
  readLatestAiRouteQualityBenchmarkRequestsV1,
} from './ai-route-quality-evidence-registry.js';

export const AI_ROUTE_QUALITY_CORE_EVIDENCE_READER_VERSION = 1;

export const AI_ROUTE_QUALITY_CORE_EVIDENCE_READER_AUTHORITY = Object.freeze({
  readOnly: true,
  canonicalCoreStateReadAuthorized: true,
  evidenceLookupAuthorized: true,
  evidenceAppendAuthorized: false,
  benchmarkExecutionAuthorized: false,
  routeSelectionAuthorized: false,
  dispatchAuthorized: false,
  providerAuthorized: false,
  policyAuthorized: false,
  budgetAuthorized: false,
  schedulerAuthorized: false,
  recoveryAuthorized: false,
});

const FACTORY_KEYS = new Set(['repository']);

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

/**
 * Read-only bridge from the canonical Core StorageRepository to the validated
 * route-quality evidence registry. It intentionally owns no append authority:
 * benchmark evidence must be produced and admitted by a separately trusted
 * execution/evidence authority before it can appear in Core state.
 */
export function createAiRouteQualityCoreEvidenceReaderV1(options) {
  const raw = record(options, FACTORY_KEYS, 'AiRouteQualityCoreEvidenceReaderV1 options');
  const repository = raw.repository;
  if (!repository || typeof repository.load !== 'function') {
    throw new Error('AiRouteQualityCoreEvidenceReaderV1 repository.load must be a function');
  }

  const readBenchmarkRequests = async ({ routeIds } = {}) => {
    const state = await repository.load();
    const persisted = state?.profile?.aiRouteQualityEvidenceRegistry;
    const registry = persisted === undefined
      ? createAiRouteQualityEvidenceRegistryV1()
      : normalizeAiRouteQualityEvidenceRegistryV1(persisted);
    return readLatestAiRouteQualityBenchmarkRequestsV1(registry, { routeIds });
  };

  Object.defineProperty(readBenchmarkRequests, 'authority', {
    value: AI_ROUTE_QUALITY_CORE_EVIDENCE_READER_AUTHORITY,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return Object.freeze(readBenchmarkRequests);
}
