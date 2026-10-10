import {
  CapabilityPathKind,
  ProviderHealthStatus,
  normalizeProviderReadinessV1,
} from './capability-discovery.js';
import {
  OPENHANDS_CODING_PROVIDER_ID,
  OPENHANDS_CODING_SPECIALIST_ID,
  normalizeOpenHandsCodingSpecialistConfigV1,
} from './coding-specialist-provider.js';

export const OPENHANDS_SPECIALIST_READINESS_VERSION = 1;

const FACTORY_KEYS = new Set(['config', 'client', 'maxAgeMs', 'now']);
const PROBE_KEYS = new Set(['config', 'client', 'now']);
const PROBE_RECEIPT_KEYS = new Set(['serverTitle', 'serverVersion']);
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'registryId',
  'registryRevision',
  'specialistId',
  'providerId',
  'definitionRevision',
  'executionPlane',
  'requestedCapabilityIds',
  'requestedToolIds',
  'asOf',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_CAPABILITY_IDS = 64;
const MAX_TOOL_IDS = 128;
const DEFAULT_MAX_AGE_MS = 15_000;
const MAX_MAX_AGE_MS = 5 * 60_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  let proto;
  let descriptors;
  try {
    proto = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    // Never surface a lower-trust Proxy trap's diagnostic or private data.
    throw new Error(label + ' cannot be inspected safely');
  }
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field');
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
  let isArray;
  let proto;
  let descriptors;
  try {
    isArray = Array.isArray(value);
    proto = isArray ? Object.getPrototypeOf(value) : null;
    descriptors = isArray ? Object.getOwnPropertyDescriptors(value) : null;
  } catch {
    throw new Error(label + ' cannot be inspected safely');
  }
  if (!isArray || proto !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
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

function exactIds(value, label, max) {
  const out = denseArray(value, label, max)
    .map((item, index) => id(item, label + '[' + index + ']'));
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicate identity');
  return Object.freeze([...out].sort());
}

function capabilityIds(value) {
  return exactIds(value, 'requestedCapabilityIds', MAX_CAPABILITY_IDS);
}

function toolIds(value) {
  return exactIds(value, 'requestedToolIds', MAX_TOOL_IDS);
}

function sameIds(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function ownErrorCode(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return '';
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  } catch {
    // An external provider may reject with a hostile Proxy. Its diagnostics
    // are not a source of authority and must never escape readiness probing.
    return '';
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return '';
  return ID.test(descriptor.value) ? descriptor.value : '';
}

function checkedProbeMethod(client) {
  if (!client || (typeof client !== 'object' && typeof client !== 'function')) {
    throw new Error('OpenHands specialist readiness requires a client with probe()');
  }
  // Inspect data descriptors only; never execute an untrusted accessor while
  // deciding whether the provider is admissible. Real class prototype methods
  // and fixture clients with own data methods are both supported.
  let cursor = client;
  try {
    for (let depth = 0; depth < 8 && cursor
        && cursor !== Object.prototype && cursor !== Function.prototype; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, 'probe');
      if (descriptor) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
          throw new Error('unsafe probe descriptor');
        }
        return descriptor.value;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {
    throw new Error('OpenHands specialist readiness client cannot be inspected safely');
  }
  throw new Error('OpenHands specialist readiness requires a client with probe()');
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

function requireVerifiedProbeReceipt(probeResult, config) {
  // Both owner preview and executable binding must enforce identical evidence.
  // A fulfilled promise (including a no-op mock) never proves provider health.
  const receipt = record(probeResult, PROBE_RECEIPT_KEYS, 'OpenHands readiness probe receipt');
  if (receipt.serverTitle !== 'OpenHands Agent Server') {
    const mismatch = new Error('OpenHands probe server identity mismatch');
    mismatch.code = 'OPENHANDS_SERVER_IDENTITY_MISMATCH';
    throw mismatch;
  }
  if (receipt.serverVersion !== config.agentServerVersion) {
    const mismatch = new Error('OpenHands probe server version mismatch');
    mismatch.code = 'OPENHANDS_SERVER_VERSION_MISMATCH';
    throw mismatch;
  }
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

export async function probeOpenHandsSpecialistProviderConfigV1(input = {}) {
  const raw = record(input, PROBE_KEYS, 'OpenHands specialist provider probe options');
  const config = normalizeOpenHandsCodingSpecialistConfigV1(raw.config);
  const client = raw.client;
  const probe = checkedProbeMethod(client);
  const now = raw.now === undefined ? () => Date.now() : raw.now;
  if (typeof now !== 'function') throw new Error('now must be a function');

  const startedAt = clockMs(now);
  let classification = Object.freeze({
    health: ProviderHealthStatus.READY,
    reasonCode: 'OPENHANDS_PROBE_READY',
    installed: true,
  });
  try {
    // A resolved injected probe is not proof that the admitted OpenHands
    // service was observed. Only a descriptor-safe exact server receipt may
    // promote readiness; a no-op or forged success remains non-executable.
    const probeResult = await probe.call(client, Object.freeze({ config, conversationId: '' }));
    requireVerifiedProbeReceipt(probeResult, config);
  } catch (error) {
    classification = classifyProbeFailure(error);
  }
  const observedAtMs = clockMs(now);
  if (observedAtMs < startedAt) throw new Error('OpenHands readiness clock moved backwards');
  const latencyMs = observedAtMs - startedAt;
  if (latencyMs > 10 * 60_000) throw new Error('OpenHands readiness probe exceeded latency bound');
  const providerState = readinessState({
    health: classification.health,
    installed: classification.installed,
    latencyMs,
    reasonCode: classification.reasonCode,
  });
  return Object.freeze({
    schemaVersion: OPENHANDS_SPECIALIST_READINESS_VERSION,
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    observedAt: new Date(observedAtMs).toISOString(),
    providerState,
    authority: Object.freeze({
      providerExecutionAuthorized: false,
      toolExecutionAuthorized: false,
      policyAuthorized: false,
      schedulingAuthorized: false,
      recoveryAuthorized: false,
      credentialAuthorized: false,
      completionAuthorized: false,
      verificationAuthorized: false,
      capacityReserved: false,
    }),
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
  const probe = checkedProbeMethod(client);
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
    if (id(request.specialistId, 'specialistId') !== OPENHANDS_CODING_SPECIALIST_ID) {
      throw new Error('OpenHands readiness request targets another specialist');
    }
    if (id(request.providerId, 'providerId') !== OPENHANDS_CODING_PROVIDER_ID) {
      throw new Error('OpenHands readiness request targets another provider');
    }
    integer(request.definitionRevision, 'definitionRevision', 1, Number.MAX_SAFE_INTEGER);
    if (id(request.executionPlane, 'executionPlane') !== 'LOCAL') {
      throw new Error('OpenHands coding readiness requires LOCAL execution plane');
    }
    const requestedCapabilities = capabilityIds(request.requestedCapabilityIds);
    if (!sameIds(requestedCapabilities, config.qualifiedCapabilityIds)) {
      throw new Error('OpenHands readiness request capability scope does not match qualified profile');
    }
    toolIds(request.requestedToolIds);
    timestamp(request.asOf, 'asOf');

    const startedAt = clockMs(now);
    let classification = Object.freeze({
      health: ProviderHealthStatus.READY,
      reasonCode: 'OPENHANDS_PROBE_READY',
      installed: true,
    });
    try {
      const probeResult = await probe.call(client, Object.freeze({
        config,
        conversationId: '',
      }));
      requireVerifiedProbeReceipt(probeResult, config);
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
