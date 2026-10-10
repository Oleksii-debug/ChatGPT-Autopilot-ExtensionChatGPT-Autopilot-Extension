import { normalizeProviderReadinessV1 } from './capability-discovery.js';
import { normalizeSpecialistSelectionV1 } from './specialist-registry.js';
import { inspectSpecialistProviderReadinessV1 } from './specialist-provider-readiness.js';

export const SPECIALIST_PROVIDER_READINESS_RESOLVER_VERSION = 1;

const RESOLVER_KEYS = new Set(['bindings', 'now']);
const BINDING_KEYS = new Set(['providerId', 'maxAgeMs', 'resolveReadiness']);
const RESULT_KEYS = new Set(['observedAt', 'providerStates']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_BINDINGS = 128;
const MAX_PROVIDER_STATES = 129;
const MAX_AGE_MS = 5 * 60_000;
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
    // Provider-owned Proxy traps may contain credentials or private data.
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
  return Object.freeze({ value, ms });
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function binding(input, index) {
  const raw = record(input, BINDING_KEYS, `bindings[${index}]`);
  const providerId = id(raw.providerId, `bindings[${index}].providerId`);
  const maxAgeMs = integer(raw.maxAgeMs, `bindings[${index}].maxAgeMs`, 1, MAX_AGE_MS);
  if (typeof raw.resolveReadiness !== 'function') {
    throw new Error(`bindings[${index}].resolveReadiness must be a function`);
  }
  return Object.freeze({ providerId, maxAgeMs, resolveReadiness: raw.resolveReadiness });
}

function resolutionRequest(selection, asOf) {
  return freeze({
    schemaVersion: SPECIALIST_PROVIDER_READINESS_RESOLVER_VERSION,
    registryId: selection.registryId,
    registryRevision: selection.registryRevision,
    specialistId: selection.specialistId,
    providerId: selection.providerId,
    definitionRevision: selection.definitionRevision,
    executionPlane: selection.executionPlane,
    requestedCapabilityIds: [...selection.requestedCapabilityIds],
    requestedToolIds: [...selection.grantedToolIds],
    asOf,
  });
}

function validateResolvedStates(rawStates, selection) {
  const selectedTools = new Set(selection.grantedToolIds);
  return denseArray(rawStates, 'providerStates', MAX_PROVIDER_STATES).map((rawState, index) => {
    let state;
    try {
      state = normalizeProviderReadinessV1(rawState);
    } catch {
      // Nested state belongs to the provider, not to the trusted caller.
      throw new Error(`providerStates[${index}] is not canonical provider evidence`);
    }
    if (state.providerId !== selection.providerId) {
      throw new Error(`providerStates[${index}] does not belong to selected provider`);
    }
    if (state.toolId && !selectedTools.has(state.toolId)) {
      throw new Error(`providerStates[${index}] is outside selected tool scope`);
    }
    return state;
  });
}

/**
 * Owner-constructed, in-memory binding from a Specialist provider identity to
 * the provider-specific function that can resolve fresh readiness facts.
 *
 * This class is deliberately not a provider store, execution router, policy
 * engine, scheduler, or credential authority. Resolver bindings are immutable
 * after construction. Caller commands can supply only SpecialistSelectionV1;
 * readiness facts always come from the injected provider resolver.
 */
export class SpecialistProviderReadinessResolverV1 {
  #bindings;
  #now;
  #selectionByReadiness = new WeakMap();

  constructor(input = {}) {
    const raw = record(input, RESOLVER_KEYS, 'Specialist provider readiness resolver options');
    const bindings = denseArray(raw.bindings === undefined ? [] : raw.bindings, 'bindings', MAX_BINDINGS)
      .map(binding);
    if (new Set(bindings.map(item => item.providerId)).size !== bindings.length) {
      throw new Error('bindings contain duplicate providerId');
    }
    const now = raw.now === undefined ? () => Date.now() : raw.now;
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.#bindings = new Map(bindings.map(item => [item.providerId, item]));
    this.#now = now;
    Object.freeze(this);
  }

  listProviderIds() {
    return Object.freeze([...this.#bindings.keys()].sort());
  }

  async resolve(selectionInput) {
    const selection = normalizeSpecialistSelectionV1(selectionInput);
    const bound = this.#bindings.get(selection.providerId);
    if (!bound) throw new Error('No trusted readiness resolver is bound for selected provider');

    const startedAtMs = this.#now();
    if (typeof startedAtMs !== 'number' || !Number.isSafeInteger(startedAtMs)
        || Object.is(startedAtMs, -0) || startedAtMs < 0 || startedAtMs > MAX_DATE_MS) {
      throw new Error('Trusted readiness resolver clock returned an invalid time');
    }
    const asOf = new Date(startedAtMs).toISOString();
    const request = resolutionRequest(selection, asOf);
    let rawResult;
    try {
      rawResult = await bound.resolveReadiness(request);
    } catch {
      // A provider failure is not trustworthy diagnostic text.
      throw new Error('Trusted readiness provider resolution failed');
    }

    const resolvedAtMs = this.#now();
    if (typeof resolvedAtMs !== 'number' || !Number.isSafeInteger(resolvedAtMs)
        || Object.is(resolvedAtMs, -0) || resolvedAtMs < 0 || resolvedAtMs > MAX_DATE_MS) {
      throw new Error('Trusted readiness resolver clock returned an invalid time');
    }
    if (resolvedAtMs < startedAtMs) {
      throw new Error('Trusted readiness resolver clock moved backwards');
    }

    const result = record(rawResult, RESULT_KEYS, 'Provider readiness resolver result');
    const observed = timestamp(result.observedAt, 'observedAt');
    if (observed.ms > resolvedAtMs) throw new Error('Provider readiness observation is from the future');
    const ageMs = resolvedAtMs - observed.ms;
    if (ageMs > bound.maxAgeMs) throw new Error('Provider readiness observation is stale');

    const providerStates = validateResolvedStates(result.providerStates, selection);
    const inspection = inspectSpecialistProviderReadinessV1({ selection, providerStates });

    const canonicalReadiness = freeze({
      schemaVersion: SPECIALIST_PROVIDER_READINESS_RESOLVER_VERSION,
      registryId: selection.registryId,
      registryRevision: selection.registryRevision,
      specialistId: selection.specialistId,
      providerId: selection.providerId,
      definitionRevision: selection.definitionRevision,
      executionPlane: selection.executionPlane,
      observedAt: observed.value,
      resolvedAt: new Date(resolvedAtMs).toISOString(),
      ageMs,
      maxAgeMs: bound.maxAgeMs,
      readiness: inspection.readiness,
      executable: inspection.executable,
      inspection,
      trustedResolverInvoked: true,
      callerReadinessAccepted: false,
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
    this.#selectionByReadiness.set(canonicalReadiness, selection);
    return canonicalReadiness;
  }

  /**
   * Re-probe the very same trusted selection to exclude provider-readiness
   * drift at the serialized durable admission boundary. Opaque caller
   * readiness objects cannot impersonate an owner-issued observation.
   */
  async assertCurrent(readiness) {
    if (!readiness || typeof readiness !== 'object') {
      throw new Error('Trusted readiness observation is required');
    }
    const selection = this.#selectionByReadiness.get(readiness);
    if (!selection) throw new Error('Readiness observation lacks trusted resolver provenance');
    const current = await this.resolve(selection);
    // A later trusted re-probe cannot move causally behind the original
    // observation. Equal facts after a wall-clock rollback are not proof
    // of renewed provider readiness; require monotonic fresh evidence.
    // These timestamps are canonical ISO-8601 UTC, so lexical order is exact.
    if (current.resolvedAt < readiness.resolvedAt
        || current.observedAt < readiness.observedAt) {
      throw new Error('Trusted provider readiness revalidation moved backwards');
    }
    if (!current.executable || current.readiness !== readiness.readiness
        || current.providerId !== readiness.providerId
        || current.registryRevision !== readiness.registryRevision
        || current.definitionRevision !== readiness.definitionRevision
        || JSON.stringify(current.inspection) !== JSON.stringify(readiness.inspection)) {
      throw new Error('Provider readiness changed since its trusted observation');
    }
    return true;
  }
}

export { MAX_BINDINGS, MAX_PROVIDER_STATES, MAX_AGE_MS };
