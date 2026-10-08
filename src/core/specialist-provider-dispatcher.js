import { normalizeSpecialistSelectionV1 } from './specialist-registry.js';
import { normalizeSpecialistHandoffV1, normalizeArtifactRefV1 } from './universal-agent-contracts.js';
import { normalizeExecutionOwnershipV1, ExecutionOwnershipState } from './execution-plane-ownership.js';

export const SPECIALIST_PROVIDER_DISPATCHER_VERSION = 1;

const OPTIONS_KEYS = new Set(['bindings', 'now']);
const BINDING_KEYS = new Set(['providerId', 'execute']);
const REQUEST_KEYS = new Set(['selection', 'handoff', 'executionOwnership', 'leaseId', 'readiness']);
const RESULT_KEYS = new Set(['providerReceiptId', 'observedAt', 'resultArtifactRefs']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain data object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain data object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`${label} contains unknown field: ${String(key)}`);
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function array(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) {
    throw new Error(`${label} must be a bounded canonical array`);
  }
  // Inspect descriptors before reading any element. Array#map reads accessors
  // and silently skips holes, which is unsafe for untrusted provider data.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(`${label} must be a bounded canonical array`);
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) throw new Error(`${label} contains non-canonical array fields`);
  }
  const output = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    output[index] = descriptor.value;
  }
  return output;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error(`${label} must be a canonical timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error(`${label} must be a canonical timestamp`);
  return { value, ms };
}

function clock(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new Error('Specialist dispatcher clock returned an invalid time');
  return value;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function readiness(input, selection, ownership, nowMs) {
  const raw = record(input, new Set([
    'schemaVersion', 'registryId', 'registryRevision', 'specialistId', 'providerId',
    'definitionRevision', 'executionPlane', 'observedAt', 'resolvedAt', 'ageMs',
    'maxAgeMs', 'readiness', 'executable', 'inspection', 'trustedResolverInvoked',
    'callerReadinessAccepted', 'authority',
  ]), 'Specialist readiness result');
  if (raw.trustedResolverInvoked !== true || raw.callerReadinessAccepted !== false || raw.executable !== true) {
    throw new Error('Provider dispatch requires fresh executable trusted readiness');
  }
  for (const key of ['registryId', 'specialistId', 'providerId', 'executionPlane']) {
    if (raw[key] !== selection[key]) throw new Error(`Specialist readiness ${key} does not match selection`);
  }
  if (raw.registryRevision !== selection.registryRevision || raw.definitionRevision !== selection.definitionRevision) {
    throw new Error('Specialist readiness revision does not match selection');
  }
  const observed = timestamp(raw.observedAt, 'readiness.observedAt');
  const resolved = timestamp(raw.resolvedAt, 'readiness.resolvedAt');
  // The durable readiness record is a historical observation, never a clock
  // override. Revalidate its complete chronology at the physical effect edge.
  if (observed.ms > resolved.ms || resolved.ms > nowMs) {
    throw new Error('Specialist readiness chronology is invalid at provider dispatch');
  }
  if (!Number.isSafeInteger(raw.ageMs) || raw.ageMs < 0
      || raw.ageMs !== resolved.ms - observed.ms) {
    throw new Error('Specialist readiness observation age is inconsistent');
  }
  // The canonical trusted resolver caps a readiness observation at five minutes.
  // Persisted/caller-shaped evidence cannot enlarge that validity window.
  if (!Number.isSafeInteger(raw.maxAgeMs) || raw.maxAgeMs < 1
      || raw.maxAgeMs > 5 * 60_000 || nowMs - observed.ms > raw.maxAgeMs) {
    throw new Error('Specialist readiness is stale at provider dispatch');
  }
  if (ownership.policyEnvelopeId === '') throw new Error('Provider dispatch requires policy envelope authority');
  return freeze(structuredClone(raw));
}

export class SpecialistProviderDispatcherV1 {
  #bindings;
  #now;

  constructor(input = {}) {
    const raw = record(input, OPTIONS_KEYS, 'Specialist provider dispatcher options');
    const bindings = array(raw.bindings === undefined ? [] : raw.bindings, 'bindings', 128).map((item, index) => {
      const entry = record(item, BINDING_KEYS, `bindings[${index}]`);
      const providerId = id(entry.providerId, `bindings[${index}].providerId`);
      if (typeof entry.execute !== 'function') throw new Error(`bindings[${index}].execute must be a function`);
      return Object.freeze({ providerId, execute: entry.execute });
    });
    if (new Set(bindings.map(item => item.providerId)).size !== bindings.length) throw new Error('bindings contain duplicate providerId');
    const now = raw.now === undefined ? () => Date.now() : raw.now;
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.#bindings = new Map(bindings.map(item => [item.providerId, item]));
    this.#now = now;
    Object.freeze(this);
  }

  listProviderIds() { return Object.freeze([...this.#bindings.keys()].sort()); }

  async execute(input = {}) {
    const raw = record(input, REQUEST_KEYS, 'Specialist provider dispatch request');
    const selection = normalizeSpecialistSelectionV1(raw.selection);
    const handoff = normalizeSpecialistHandoffV1(raw.handoff);
    const ownership = normalizeExecutionOwnershipV1(raw.executionOwnership);
    const leaseId = id(raw.leaseId, 'leaseId');
    if (handoff.specialistId !== selection.specialistId) throw new Error('Specialist handoff does not match selected provider');
    if (ownership.state !== ExecutionOwnershipState.OWNED || ownership.leaseId !== leaseId) {
      throw new Error('Provider dispatch requires the current canonical execution lease');
    }
    if (ownership.ownerId === '' || ownership.ownerPlane !== selection.executionPlane) {
      throw new Error('Provider dispatch execution owner does not match Specialist selection');
    }
    const startedAtMs = clock(this.#now);
    if (Date.parse(ownership.leaseUntil) <= startedAtMs) throw new Error('Specialist execution lease expired before provider dispatch');
    const trustedReadiness = readiness(raw.readiness, selection, ownership, startedAtMs);
    const binding = this.#bindings.get(selection.providerId);
    if (!binding) throw new Error('No trusted execution binding is configured for selected Specialist provider');
    const request = freeze({
      schemaVersion: SPECIALIST_PROVIDER_DISPATCHER_VERSION,
      selection,
      handoff,
      execution: {
        taskId: ownership.taskId,
        planId: ownership.planId,
        nodeId: ownership.nodeId,
        effectId: ownership.effectId,
        policyEnvelopeId: ownership.policyEnvelopeId,
        executionId: leaseId,
        leaseUntil: ownership.leaseUntil,
      },
      readiness: trustedReadiness,
      dispatchedAt: new Date(startedAtMs).toISOString(),
    });
    const rawResult = await binding.execute(request);
    const completedAtMs = clock(this.#now);
    if (completedAtMs < startedAtMs) throw new Error('Specialist dispatcher clock moved backwards');
    const result = record(rawResult, RESULT_KEYS, 'Specialist provider result');
    const observed = timestamp(result.observedAt, 'provider result observedAt');
    if (observed.ms < startedAtMs || observed.ms > completedAtMs) throw new Error('Specialist provider result chronology is invalid');
    const refs = array(result.resultArtifactRefs, 'resultArtifactRefs', 64).map(normalizeArtifactRefV1);
    if (!refs.length) throw new Error('Specialist provider result requires artifact evidence');
    if (new Set(refs.map(item => item.artifactId)).size !== refs.length) throw new Error('Specialist provider result contains duplicate artifactId');
    for (const ref of refs) {
      if (!ref.sha256) throw new Error(`Specialist result artifact requires sha256: ${ref.artifactId}`);
      const created = timestamp(ref.createdAt, `artifact ${ref.artifactId} createdAt`);
      if (created.ms < startedAtMs || created.ms > observed.ms) throw new Error(`Specialist result artifact chronology is invalid: ${ref.artifactId}`);
      if (ref.producerInvocationId !== leaseId) throw new Error(`Specialist result artifact producer does not match execution lease: ${ref.artifactId}`);
    }
    return freeze({
      schemaVersion: SPECIALIST_PROVIDER_DISPATCHER_VERSION,
      providerId: selection.providerId,
      specialistId: selection.specialistId,
      providerReceiptId: id(result.providerReceiptId, 'providerReceiptId'),
      effectId: ownership.effectId,
      executionId: leaseId,
      observedAt: observed.value,
      completedAt: new Date(completedAtMs).toISOString(),
      resultArtifactRefs: refs,
      trustedDispatcherInvoked: true,
      callerResultAccepted: false,
      completionAuthorized: false,
      verificationRequired: true,
    });
  }
}
