import {
  CapabilityPathKind,
  ProviderHealthStatus,
  normalizeProviderReadinessV1,
} from './capability-discovery.js';
import {
  OPENHANDS_CODING_PROVIDER_ID,
  normalizeOpenHandsCodingSpecialistConfigV1,
} from './coding-specialist-provider.js';

export const OPENHANDS_SPECIALIST_READINESS_VERSION = 1;

const FACTORY_KEYS = new Set(['config', 'client', 'maxAgeMs', 'now']);
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'registryId',
  'registryRevision',
  'specialistId',
  'providerId',
  'definitionRevision',
  'executionPlane',
  'requestedToolIds',
  'asOf',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_TOOL_IDS = 128;
const DEFAULT_MAX_AGE_MS = 15_000;
const MAX_MAX_AGE_MS = 5 * 60_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
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
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || Object.is(length, -0) || length < 0 || length > max) {
    throw new Error(label + ' has invalid length');
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array fields');
    }
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

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function integer(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)
      || value < min || value > max) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function clockMs(now) {
  const value = now();
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)
      || value < 0 || value > MAX_DATE_MS) {
    throw new Error('OpenHands readiness clock returned an invalid time');
  }
  return value;
}

function toolIds(value) {
  const out = denseArray(value, 'requestedToolIds', MAX_TOOL_IDS)
    .map((item, index) => id(item, 'requestedToolIds[' + index + ']'));
  if (new Set(out).size !== out.length) throw new Error('requestedToolIds contains duplicate identity');
  return Object.freeze([...out]);
}

function ownErrorCode(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return '';
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return '';
  return ID.test(descriptor.value) ? descriptor.value : '';
}

function classifyProbeFailure(error) {
  const code = ownErrorCode(error);
  if (code === 'OPENHANDS_TRANSPORT_FAILURE'
      || code === 'OPENHANDS_REQUEST_TIMEOUT'
      || code === 'OPENHANDS_SERVER_IDENTITY_MISMATCH'
      || code === 'OPENHANDS_SERVER_VERSION_MISMATCH'
      || /^OPENHANDS_HTTP_[0-9]{3}$/u.test(code)) {
    return Object.freeze({
      health: ProviderHealthStatus.UNAVAILABLE,
      reasonCode: code,
      installed: code !== 'OPENHANDS_TRANSPORT_FAILURE',
    });
  }
  return Object.freeze({
    health: ProviderHealthStatus.UNKNOWN,
    reasonCode: 'OPENHANDS_PROBE_UNKNOWN',
    installed: true,
  });
}

function readinessState({ health, installed, latencyMs, reasonCode }) {
  return normalizeProviderReadinessV1({
    schemaVersion: 1,
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    toolId: '',
    health,
    installationRequired: true,
    installed,
    authenticationRequired: false,
    authenticated: true,
    pathKind: CapabilityPathKind.API,
    latencyMs,
    reasonCode,
  });
}

/**
 * Builds one immutable #454-compatible binding backed by the merged OpenHands
 * provider's harmless live server identity/version probe.
 *
 * The adapter never creates or resumes a conversation and never calls execute.
 * It grants no provider, policy, scheduling, recovery, credential, completion,
 * verification or capacity authority.
 */
export function createOpenHandsSpecialistReadinessBindingV1(input = {}) {
  const raw = record(input, FACTORY_KEYS, 'OpenHands specialist readiness binding options');
  const config = normalizeOpenHandsCodingSpecialistConfigV1(raw.config);
  const client = raw.client;
  if (!client || (typeof client !== 'object' && typeof client !== 'function')
      || typeof client.probe !== 'function') {
    throw new Error('OpenHands specialist readiness requires a client with probe()');
  }
  const maxAgeMs = raw.maxAgeMs === undefined
    ? DEFAULT_MAX_AGE_MS
    : integer(raw.maxAgeMs, 'maxAgeMs', 1, MAX_MAX_AGE_MS);
  const now = raw.now === undefined ? () => Date.now() : raw.now;
  if (typeof now !== 'function') throw new Error('now must be a function');

  const resolveReadiness = async requestInput => {
    const request = record(requestInput, REQUEST_KEYS, 'OpenHands readiness resolution request');
    if (request.schemaVersion !== OPENHANDS_SPECIALIST_READINESS_VERSION) {
      throw new Error('OpenHands readiness resolution schemaVersion must be numeric 1');
    }
    id(request.registryId, 'registryId');
    integer(request.registryRevision, 'registryRevision', 1, Number.MAX_SAFE_INTEGER);
    id(request.specialistId, 'specialistId');
    if (id(request.providerId, 'providerId') !== OPENHANDS_CODING_PROVIDER_ID) {
      throw new Error('OpenHands readiness request targets another provider');
    }
    integer(request.definitionRevision, 'definitionRevision', 1, Number.MAX_SAFE_INTEGER);
    id(request.executionPlane, 'executionPlane');
    toolIds(request.requestedToolIds);
    timestamp(request.asOf, 'asOf');

    const startedAt = clockMs(now);
    let classification = Object.freeze({
      health: ProviderHealthStatus.READY,
      reasonCode: 'OPENHANDS_PROBE_READY',
      installed: true,
    });
    try {
      await client.probe(Object.freeze({
        config,
        conversationId: '',
      }));
    } catch (error) {
      classification = classifyProbeFailure(error);
    }
    const observedAtMs = clockMs(now);
    if (observedAtMs < startedAt) throw new Error('OpenHands readiness clock moved backwards');
    const latencyMs = observedAtMs - startedAt;
    if (latencyMs > 10 * 60_000) throw new Error('OpenHands readiness probe exceeded latency bound');

    const state = readinessState({
      health: classification.health,
      installed: classification.installed,
      latencyMs,
      reasonCode: classification.reasonCode,
    });
    return Object.freeze({
      observedAt: new Date(observedAtMs).toISOString(),
      providerStates: Object.freeze([state]),
    });
  };

  return Object.freeze({
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    maxAgeMs,
    resolveReadiness,
  });
}

export { DEFAULT_MAX_AGE_MS, MAX_MAX_AGE_MS };
