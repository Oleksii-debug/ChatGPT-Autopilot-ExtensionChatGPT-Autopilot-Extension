import {
  ProviderHealthStatus,
  normalizeProviderReadinessV1,
} from './capability-discovery.js';

export const ProviderCanaryContractVersion = 1;

export const ProviderCanaryProbeKind = Object.freeze({
  CHATGPT_STATE_DETECT: 'CHATGPT_STATE_DETECT',
  GITHUB_READ: 'GITHUB_READ',
  DRIVE_METADATA_READ: 'DRIVE_METADATA_READ',
  MCP_HANDSHAKE: 'MCP_HANDSHAKE',
  NATIVE_HEALTH: 'NATIVE_HEALTH',
  UIA_ENUMERATE: 'UIA_ENUMERATE',
  CLOUD_CHECKPOINT_READ: 'CLOUD_CHECKPOINT_READ',
  GENERIC_READINESS: 'GENERIC_READINESS',
});

export const ProviderCanaryObservationStatus = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  TIMEOUT: 'TIMEOUT',
  UNAVAILABLE: 'UNAVAILABLE',
});

const PROBE_KINDS = new Set(Object.values(ProviderCanaryProbeKind));
const OBSERVATION_STATUSES = new Set(Object.values(ProviderCanaryObservationStatus));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_DEFINITIONS = 128;
const MAX_OBSERVATIONS = 2048;
const MAX_LATENCY_MS = 10 * 60_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_COUNT = 100;

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field`);
    }
  }
}

function version(value, label) {
  if (value !== ProviderCanaryContractVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return ProviderCanaryContractVersion;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be an exact lowercase SHA-256 digest`);
  }
  return value;
}

function exactEnum(value, allowed, label) {
  if (typeof value !== 'string' || value !== value.trim() || !allowed.has(value)) {
    throw new Error(`${label} must use exact canonical enum representation`);
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function dataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) {
      throw new Error(`${label} contains non-index array data`);
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} entries must be enumerable own data properties`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const DEFINITION_KEYS = new Set([
  'schemaVersion',
  'definitionRevisionId',
  'definitionSha256',
  'canaryId',
  'providerId',
  'capabilityId',
  'probeKind',
  'critical',
  'maxLatencyMs',
  'maxObservationAgeMs',
  'requiredPasses',
  'failureThreshold',
]);

export function normalizeProviderCanaryDefinitionV1(input) {
  const raw = plain(input, 'ProviderCanaryDefinitionV1');
  exactKeys(raw, DEFINITION_KEYS, 'ProviderCanaryDefinitionV1');
  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'ProviderCanaryDefinitionV1'),
    definitionRevisionId: exactId(raw.definitionRevisionId, 'definitionRevisionId'),
    definitionSha256: digest(raw.definitionSha256, 'definitionSha256'),
    canaryId: exactId(raw.canaryId, 'canaryId'),
    providerId: exactId(raw.providerId, 'providerId'),
    capabilityId: exactId(raw.capabilityId, 'capabilityId'),
    probeKind: exactEnum(raw.probeKind, PROBE_KINDS, 'probeKind'),
    critical: bool(raw.critical, 'critical'),
    maxLatencyMs: integer(raw.maxLatencyMs, 'maxLatencyMs', 1, MAX_LATENCY_MS),
    maxObservationAgeMs: integer(
      raw.maxObservationAgeMs,
      'maxObservationAgeMs',
      1,
      MAX_AGE_MS,
    ),
    requiredPasses: integer(raw.requiredPasses, 'requiredPasses', 1, MAX_COUNT),
    failureThreshold: integer(raw.failureThreshold, 'failureThreshold', 1, MAX_COUNT),
  });
}

const OBSERVATION_KEYS = new Set([
  'schemaVersion',
  'definitionRevisionId',
  'definitionSha256',
  'observationId',
  'canaryId',
  'providerId',
  'capabilityId',
  'status',
  'latencyMs',
  'observedAt',
  'evidenceId',
]);

export function normalizeProviderCanaryObservationV1(input) {
  const raw = plain(input, 'ProviderCanaryObservationV1');
  exactKeys(raw, OBSERVATION_KEYS, 'ProviderCanaryObservationV1');
  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'ProviderCanaryObservationV1'),
    definitionRevisionId: exactId(raw.definitionRevisionId, 'definitionRevisionId'),
    definitionSha256: digest(raw.definitionSha256, 'definitionSha256'),
    observationId: exactId(raw.observationId, 'observationId'),
    canaryId: exactId(raw.canaryId, 'canaryId'),
    providerId: exactId(raw.providerId, 'providerId'),
    capabilityId: exactId(raw.capabilityId, 'capabilityId'),
    status: exactEnum(raw.status, OBSERVATION_STATUSES, 'status'),
    latencyMs: integer(raw.latencyMs, 'latencyMs', 0, MAX_LATENCY_MS),
    observedAt: canonicalTimestamp(raw.observedAt, 'observedAt'),
    evidenceId: exactId(raw.evidenceId, 'evidenceId'),
  });
}

function normalizeDefinitions(value) {
  const definitions = dataArray(value, 'definitions', MAX_DEFINITIONS)
    .map(normalizeProviderCanaryDefinitionV1)
    .sort((a, b) => asciiCompare(a.canaryId, b.canaryId));
  const ids = new Set();
  for (const definition of definitions) {
    if (ids.has(definition.canaryId)) throw new Error('definitions contains duplicate canaryId');
    ids.add(definition.canaryId);
  }
  return definitions;
}

function normalizeObservations(value) {
  const observations = dataArray(value, 'observations', MAX_OBSERVATIONS)
    .map(normalizeProviderCanaryObservationV1)
    .sort((a, b) => {
      const time = Date.parse(a.observedAt) - Date.parse(b.observedAt);
      return time || asciiCompare(a.observationId, b.observationId);
    });
  const ids = new Set();
  for (const observation of observations) {
    if (ids.has(observation.observationId)) {
      throw new Error('observations contains duplicate observationId');
    }
    ids.add(observation.observationId);
  }
  return observations;
}

const PLAN_KEYS = new Set(['schemaVersion', 'asOf', 'definitions']);

export function buildProviderCanaryProbePlanV1(input) {
  const raw = plain(input, 'ProviderCanaryProbePlanRequestV1');
  exactKeys(raw, PLAN_KEYS, 'ProviderCanaryProbePlanRequestV1');
  version(raw.schemaVersion, 'ProviderCanaryProbePlanRequestV1');
  const asOf = canonicalTimestamp(raw.asOf, 'asOf');
  const definitions = normalizeDefinitions(raw.definitions);
  return deepFreeze({
    schemaVersion: ProviderCanaryContractVersion,
    asOf,
    probes: definitions.map(definition => deepFreeze({
      definitionRevisionId: definition.definitionRevisionId,
      definitionSha256: definition.definitionSha256,
      canaryId: definition.canaryId,
      providerId: definition.providerId,
      capabilityId: definition.capabilityId,
      probeKind: definition.probeKind,
      readOnly: true,
      destructiveAllowed: false,
      economicallyConsequentialAllowed: false,
      executionAuthorized: false,
      requiresPolicyDecision: true,
    })),
    executionAuthorized: false,
  });
}

function effectivePass(observation, definition) {
  return observation.status === ProviderCanaryObservationStatus.PASS
    && observation.latencyMs <= definition.maxLatencyMs;
}

function evaluateCanary(definition, observations, asOfMs) {
  const matching = observations.filter(observation =>
    observation.canaryId === definition.canaryId
      && observation.providerId === definition.providerId
      && observation.capabilityId === definition.capabilityId
      && observation.definitionRevisionId === definition.definitionRevisionId
      && observation.definitionSha256 === definition.definitionSha256);

  for (const observation of observations) {
    if (observation.canaryId !== definition.canaryId) continue;
    if (observation.providerId !== definition.providerId
        || observation.capabilityId !== definition.capabilityId) {
      throw new Error(`observation ${observation.observationId} identity does not match canary definition`);
    }
    if (observation.definitionRevisionId !== definition.definitionRevisionId
        || observation.definitionSha256 !== definition.definitionSha256) {
      throw new Error(`observation ${observation.observationId} definition identity does not match canary definition`);
    }
  }

  const fresh = matching
    .filter(observation => {
      const observedMs = Date.parse(observation.observedAt);
      if (observedMs > asOfMs) {
        throw new Error(`observation ${observation.observationId} is from the future`);
      }
      return asOfMs - observedMs <= definition.maxObservationAgeMs;
    })
    .sort((a, b) => {
      const time = Date.parse(b.observedAt) - Date.parse(a.observedAt);
      return time || asciiCompare(b.observationId, a.observationId);
    });

  if (!fresh.length) {
    return deepFreeze({
      definitionRevisionId: definition.definitionRevisionId,
      definitionSha256: definition.definitionSha256,
      canaryId: definition.canaryId,
      capabilityId: definition.capabilityId,
      critical: definition.critical,
      health: ProviderHealthStatus.UNKNOWN,
      reasonCode: 'CANARY_NO_FRESH_EVIDENCE',
      latestObservationId: '',
      latestEvidenceId: '',
      latestLatencyMs: 0,
      freshObservationCount: 0,
      consecutiveFailureCount: 0,
      passCount: 0,
    });
  }

  let consecutiveFailureCount = 0;
  for (const observation of fresh) {
    if (effectivePass(observation, definition)) break;
    consecutiveFailureCount += 1;
  }
  const passCount = fresh.filter(observation => effectivePass(observation, definition)).length;
  const latest = fresh[0];

  let health;
  let reasonCode;
  if (consecutiveFailureCount >= definition.failureThreshold) {
    health = ProviderHealthStatus.UNAVAILABLE;
    reasonCode = 'CANARY_FAILURE_THRESHOLD';
  } else if (!effectivePass(latest, definition)) {
    health = ProviderHealthStatus.DEGRADED;
    reasonCode = latest.status === ProviderCanaryObservationStatus.PASS
      ? 'CANARY_LATENCY_DEGRADED'
      : 'CANARY_TRANSIENT_FAILURE';
  } else if (passCount < definition.requiredPasses) {
    health = ProviderHealthStatus.DEGRADED;
    reasonCode = 'CANARY_INSUFFICIENT_PASSES';
  } else {
    health = ProviderHealthStatus.READY;
    reasonCode = 'CANARY_READY';
  }

  return deepFreeze({
    definitionRevisionId: definition.definitionRevisionId,
    definitionSha256: definition.definitionSha256,
    canaryId: definition.canaryId,
    capabilityId: definition.capabilityId,
    critical: definition.critical,
    health,
    reasonCode,
    latestObservationId: latest.observationId,
    latestEvidenceId: latest.evidenceId,
    latestLatencyMs: latest.latencyMs,
    freshObservationCount: fresh.length,
    consecutiveFailureCount,
    passCount,
  });
}

function aggregateHealth(evaluations) {
  const critical = evaluations.filter(item => item.critical);
  const relevant = critical.length ? critical : evaluations;
  if (!relevant.length) return ProviderHealthStatus.UNKNOWN;
  if (relevant.some(item => item.health === ProviderHealthStatus.UNAVAILABLE)) {
    return ProviderHealthStatus.UNAVAILABLE;
  }
  if (relevant.some(item => item.health === ProviderHealthStatus.UNKNOWN)) {
    return ProviderHealthStatus.UNKNOWN;
  }
  if (relevant.some(item => item.health === ProviderHealthStatus.DEGRADED)) {
    return ProviderHealthStatus.DEGRADED;
  }
  return ProviderHealthStatus.READY;
}

function aggregateReason(health) {
  return {
    [ProviderHealthStatus.READY]: 'CANARY_NETWORK_READY',
    [ProviderHealthStatus.DEGRADED]: 'CANARY_NETWORK_DEGRADED',
    [ProviderHealthStatus.UNAVAILABLE]: 'CANARY_NETWORK_UNAVAILABLE',
    [ProviderHealthStatus.UNKNOWN]: 'CANARY_NETWORK_UNKNOWN',
  }[health];
}

const EVALUATE_KEYS = new Set([
  'schemaVersion',
  'asOf',
  'currentReadiness',
  'definitions',
  'observations',
]);

export function evaluateProviderCanariesV1(input) {
  const raw = plain(input, 'ProviderCanaryEvaluationRequestV1');
  exactKeys(raw, EVALUATE_KEYS, 'ProviderCanaryEvaluationRequestV1');
  version(raw.schemaVersion, 'ProviderCanaryEvaluationRequestV1');
  const asOf = canonicalTimestamp(raw.asOf, 'asOf');
  const asOfMs = Date.parse(asOf);
  const currentReadiness = normalizeProviderReadinessV1(raw.currentReadiness);
  const definitions = normalizeDefinitions(raw.definitions);
  const observations = normalizeObservations(raw.observations);

  for (const definition of definitions) {
    if (definition.providerId !== currentReadiness.providerId) {
      throw new Error(`canary ${definition.canaryId} providerId does not match currentReadiness`);
    }
  }

  const knownCanaryIds = new Set(definitions.map(definition => definition.canaryId));
  for (const observation of observations) {
    if (!knownCanaryIds.has(observation.canaryId)) {
      throw new Error(`observation ${observation.observationId} references unknown canaryId`);
    }
  }

  const evaluations = definitions.map(definition =>
    evaluateCanary(definition, observations, asOfMs));
  const health = aggregateHealth(evaluations);
  const relevant = evaluations.filter(item => item.critical).length
    ? evaluations.filter(item => item.critical)
    : evaluations;
  const latencyMs = relevant.length
    ? Math.max(...relevant.map(item => item.latestLatencyMs))
    : 0;

  const recommendedProviderReadiness = normalizeProviderReadinessV1({
    schemaVersion: currentReadiness.schemaVersion,
    providerId: currentReadiness.providerId,
    toolId: currentReadiness.toolId,
    health,
    installationRequired: currentReadiness.installationRequired,
    installed: currentReadiness.installed,
    authenticationRequired: currentReadiness.authenticationRequired,
    authenticated: currentReadiness.authenticated,
    pathKind: currentReadiness.pathKind,
    latencyMs,
    reasonCode: aggregateReason(health),
  });

  const unavailableOrUnknown = health === ProviderHealthStatus.UNAVAILABLE
    || health === ProviderHealthStatus.UNKNOWN;
  const degraded = health === ProviderHealthStatus.DEGRADED;

  return deepFreeze({
    schemaVersion: ProviderCanaryContractVersion,
    providerId: currentReadiness.providerId,
    asOf,
    health,
    evaluations,
    recommendedProviderReadiness,
    recommendations: {
      removeFromCriticalRoutingSuggested: unavailableOrUnknown,
      activateFallbackSuggested: unavailableOrUnknown || degraded,
      repairTaskSuggested: unavailableOrUnknown || degraded,
      blockConsequentialWorkSuggested: unavailableOrUnknown,
      actionAuthorized: false,
    },
    readinessUpdateAuthorized: false,
    executionAuthorized: false,
  });
}
