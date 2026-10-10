import {
  CapabilityPathReadiness,
  ProviderHealthStatus,
  normalizeProviderReadinessV1,
} from './capability-discovery.js';
import { normalizeSpecialistSelectionV1 } from './specialist-registry.js';

export const SPECIALIST_PROVIDER_READINESS_VERSION = 1;

export const SpecialistProviderReadinessSource = Object.freeze({
  TOOL_SPECIFIC: 'TOOL_SPECIFIC',
  PROVIDER_WIDE: 'PROVIDER_WIDE',
  MISSING: 'MISSING',
});

const REQUEST_KEYS = new Set(['selection', 'providerStates']);
const MAX_PROVIDER_STATES = 512;
const EXECUTABLE = new Set([
  CapabilityPathReadiness.READY,
  CapabilityPathReadiness.DEGRADED,
]);
const READINESS_RANK = Object.freeze({
  [CapabilityPathReadiness.READY]: 0,
  [CapabilityPathReadiness.DEGRADED]: 1,
  [CapabilityPathReadiness.NEEDS_AUTH]: 2,
  [CapabilityPathReadiness.NEEDS_INSTALL]: 3,
  [CapabilityPathReadiness.NEEDS_HEALTH_CHECK]: 4,
  [CapabilityPathReadiness.UNAVAILABLE]: 5,
});

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

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function readinessFor(state) {
  if (!state) return CapabilityPathReadiness.NEEDS_HEALTH_CHECK;
  if (state.health === ProviderHealthStatus.UNAVAILABLE) {
    return CapabilityPathReadiness.UNAVAILABLE;
  }
  if (state.installationRequired && !state.installed) {
    return CapabilityPathReadiness.NEEDS_INSTALL;
  }
  if (state.authenticationRequired && !state.authenticated) {
    return CapabilityPathReadiness.NEEDS_AUTH;
  }
  if (state.health === ProviderHealthStatus.UNKNOWN) {
    return CapabilityPathReadiness.NEEDS_HEALTH_CHECK;
  }
  if (state.health === ProviderHealthStatus.DEGRADED) {
    return CapabilityPathReadiness.DEGRADED;
  }
  return CapabilityPathReadiness.READY;
}

function identity(providerId, toolId) {
  return providerId + '\u0000' + toolId;
}

function worstReadiness(checks) {
  let worst = CapabilityPathReadiness.READY;
  for (const check of checks) {
    if (READINESS_RANK[check.readiness] > READINESS_RANK[worst]) {
      worst = check.readiness;
    }
  }
  return worst;
}

/**
 * Deterministically binds one exact SpecialistSelectionV1 to existing
 * ProviderReadinessV1 facts. This is a read-only operational projection:
 * it does not probe a provider, establish freshness/trust, reserve capacity,
 * grant policy, or authorize execution.
 */
export function inspectSpecialistProviderReadinessV1(input = {}) {
  const raw = record(input, REQUEST_KEYS, 'Specialist provider readiness request');
  const selection = normalizeSpecialistSelectionV1(raw.selection);
  const states = denseArray(raw.providerStates === undefined ? [] : raw.providerStates, 'providerStates', MAX_PROVIDER_STATES)
    .map(normalizeProviderReadinessV1);

  const byIdentity = new Map();
  for (const state of states) {
    const key = identity(state.providerId, state.toolId);
    if (byIdentity.has(key)) {
      throw new Error('providerStates contain duplicate provider/tool readiness identity');
    }
    byIdentity.set(key, state);
  }

  const providerWide = byIdentity.get(identity(selection.providerId, '')) ?? null;
  const requiredToolIds = Object.freeze([...selection.grantedToolIds]);
  const scopes = requiredToolIds.length ? requiredToolIds : [''];
  const checks = scopes.map(toolId => {
    const toolSpecific = toolId
      ? byIdentity.get(identity(selection.providerId, toolId)) ?? null
      : null;
    const state = toolSpecific || providerWide;
    const source = toolSpecific
      ? SpecialistProviderReadinessSource.TOOL_SPECIFIC
      : providerWide
        ? SpecialistProviderReadinessSource.PROVIDER_WIDE
        : SpecialistProviderReadinessSource.MISSING;
    return freeze({
      providerId: selection.providerId,
      toolId,
      source,
      readiness: readinessFor(state),
      providerReadiness: state,
    });
  });

  const readiness = worstReadiness(checks);
  const executable = checks.every(check => EXECUTABLE.has(check.readiness));

  return freeze({
    schemaVersion: SPECIALIST_PROVIDER_READINESS_VERSION,
    registryId: selection.registryId,
    registryRevision: selection.registryRevision,
    specialistId: selection.specialistId,
    providerId: selection.providerId,
    definitionRevision: selection.definitionRevision,
    executionPlane: selection.executionPlane,
    requiredToolIds,
    readiness,
    executable,
    checks,
    requiresFreshTrustedResolution: true,
    authority: {
      providerExecutionAuthorized: false,
      toolExecutionAuthorized: false,
      policyAuthorized: false,
      schedulingAuthorized: false,
      recoveryAuthorized: false,
      credentialAuthorized: false,
      completionAuthorized: false,
      verificationAuthorized: false,
      capacityReserved: false,
    },
  });
}
