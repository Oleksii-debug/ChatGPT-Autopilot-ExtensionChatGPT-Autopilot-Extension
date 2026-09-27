import { AiRouteRole } from './ai-route-pool.js';

export const AI_ROUTE_QUALITY_EVIDENCE_RESOLVER_VERSION = 1;

export const AI_ROUTE_QUALITY_EVIDENCE_RESOLVER_AUTHORITY = Object.freeze({
  readOnly: true,
  evidenceLookupAuthorized: true,
  benchmarkExecutionAuthorized: false,
  qualityStoreAuthorized: false,
  routeSelectionAuthorized: false,
  dispatchAuthorized: false,
  policyAuthorized: false,
  providerAuthorized: false,
  budgetAuthorized: false,
  schedulerAuthorized: false,
  recoveryAuthorized: false,
});

const LOOKUP_KEYS = new Set(['routeIds', 'role', 'requiresVision']);
const FACTORY_KEYS = new Set(['readBenchmarkRequests']);
const BINDING_KEYS = new Set(['routeId', 'evaluationRequest', 'maxAgeMs']);
const ROLES = new Set(Object.values(AiRouteRole));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_ROUTES = 32;

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

function denseArray(value, label, max = MAX_ROUTES) {
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

function canonicalId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function normalizeAiRouteQualityEvidenceLookupV1(input) {
  const raw = record(input, LOOKUP_KEYS, 'AiRouteQualityEvidenceLookupV1');
  const routeIds = denseArray(raw.routeIds, 'AiRouteQualityEvidenceLookupV1.routeIds')
    .map((value, index) => canonicalId(value, 'AiRouteQualityEvidenceLookupV1.routeIds[' + index + ']'));
  if (!routeIds.length) throw new Error('AiRouteQualityEvidenceLookupV1.routeIds must not be empty');
  if (new Set(routeIds).size !== routeIds.length) {
    throw new Error('AiRouteQualityEvidenceLookupV1.routeIds contains duplicates');
  }
  if (typeof raw.role !== 'string' || !ROLES.has(raw.role)) {
    throw new Error('AiRouteQualityEvidenceLookupV1.role is invalid');
  }
  if (typeof raw.requiresVision !== 'boolean') {
    throw new Error('AiRouteQualityEvidenceLookupV1.requiresVision must be boolean');
  }
  return freeze({
    routeIds,
    role: raw.role,
    requiresVision: raw.requiresVision,
  });
}

function snapshotScopedBenchmarkRequests(value, requestedRouteIds) {
  const items = denseArray(value, 'AI route quality benchmark reader result');
  const allowed = new Set(requestedRouteIds);
  const seen = new Set();
  const out = [];
  for (let index = 0; index < items.length; index += 1) {
    const raw = record(
      items[index],
      BINDING_KEYS,
      'AI route quality benchmark reader result[' + index + ']',
    );
    for (const requiredKey of BINDING_KEYS) {
      if (!Object.hasOwn(raw, requiredKey)) {
        throw new Error(
          'AI route quality benchmark reader result[' + index + '] is missing field: ' + requiredKey,
        );
      }
    }
    const routeId = canonicalId(
      raw.routeId,
      'AI route quality benchmark reader result[' + index + '].routeId',
    );
    if (!allowed.has(routeId)) {
      throw new Error('AI route quality benchmark reader returned unrequested routeId: ' + routeId);
    }
    if (seen.has(routeId)) {
      throw new Error('AI route quality benchmark reader returned duplicate routeId: ' + routeId);
    }
    seen.add(routeId);
    out.push(Object.freeze({
      routeId,
      evaluationRequest: raw.evaluationRequest,
      maxAgeMs: raw.maxAgeMs,
    }));
  }
  return Object.freeze(out);
}

export function createAiRouteQualityEvidenceResolverV1(options) {
  const raw = record(options, FACTORY_KEYS, 'AiRouteQualityEvidenceResolverV1 options');
  if (typeof raw.readBenchmarkRequests !== 'function') {
    throw new Error('AiRouteQualityEvidenceResolverV1 readBenchmarkRequests must be a function');
  }
  const reader = raw.readBenchmarkRequests;

  const resolve = async (input) => {
    const lookup = normalizeAiRouteQualityEvidenceLookupV1(input);
    const readerRequest = Object.freeze({
      routeIds: lookup.routeIds,
    });
    const rawResult = await reader(readerRequest);
    return snapshotScopedBenchmarkRequests(rawResult, lookup.routeIds);
  };

  Object.defineProperty(resolve, 'authority', {
    value: AI_ROUTE_QUALITY_EVIDENCE_RESOLVER_AUTHORITY,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return Object.freeze(resolve);
}
