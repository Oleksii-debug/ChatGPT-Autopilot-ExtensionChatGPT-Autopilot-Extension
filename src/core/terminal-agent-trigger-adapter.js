import { createSha256FingerprintV1 } from './fingerprint.js';
import {
  EventTriggerKind,
  normalizeEventTriggerDefinitionV1,
  normalizeEventTriggerObservationV1,
} from './event-trigger-contract.js';
import { OrchestrationTerminalStatus } from './orchestration-hierarchy.js';

export const TERMINAL_AGENT_TRIGGER_VERSION = 1;
export const TERMINAL_AGENT_PROVIDER_ID = 'internal/orchestration-hierarchy';
export const TERMINAL_AGENT_PAYLOAD_KIND = 'orchestration-terminal-event';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const TERMINAL_STATUSES = new Set(Object.values(OrchestrationTerminalStatus));
const REQUEST_KEYS = new Set(['trigger', 'terminalIdentity', 'payloadArtifactRef', 'observedAt']);
const IDENTITY_KEYS = new Set(['graphId', 'controlEpoch', 'nodeId', 'generation', 'activationId']);
const FACT_KEYS = new Set([
  'graphId', 'controlEpoch', 'nodeId', 'generation', 'activationId', 'status', 'terminalAt',
]);
const DEPENDENCY_KEYS = new Set(['resolveTerminalActivation']);

function strictRecord(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(value); }
  catch { throw new Error(`${label} must be a plain object`); }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeIdentity(value) {
  const raw = strictRecord(value, 'TerminalAgentIdentityV1', IDENTITY_KEYS);
  return freezeDeep({
    graphId: exactId(raw.graphId, 'TerminalAgentIdentityV1 graphId'),
    controlEpoch: positiveInteger(raw.controlEpoch, 'TerminalAgentIdentityV1 controlEpoch'),
    nodeId: exactId(raw.nodeId, 'TerminalAgentIdentityV1 nodeId'),
    generation: positiveInteger(raw.generation, 'TerminalAgentIdentityV1 generation'),
    activationId: exactId(raw.activationId, 'TerminalAgentIdentityV1 activationId'),
  });
}

function normalizeFact(value) {
  const raw = strictRecord(value, 'TrustedTerminalAgentFactV1', FACT_KEYS);
  if (typeof raw.status !== 'string' || !TERMINAL_STATUSES.has(raw.status)) {
    throw new Error('TrustedTerminalAgentFactV1 status is invalid');
  }
  return freezeDeep({
    graphId: exactId(raw.graphId, 'TrustedTerminalAgentFactV1 graphId'),
    controlEpoch: positiveInteger(raw.controlEpoch, 'TrustedTerminalAgentFactV1 controlEpoch'),
    nodeId: exactId(raw.nodeId, 'TrustedTerminalAgentFactV1 nodeId'),
    generation: positiveInteger(raw.generation, 'TrustedTerminalAgentFactV1 generation'),
    activationId: exactId(raw.activationId, 'TrustedTerminalAgentFactV1 activationId'),
    status: raw.status,
    terminalAt: canonicalTimestamp(raw.terminalAt, 'TrustedTerminalAgentFactV1 terminalAt'),
  });
}

function assertFactIdentity(identity, fact) {
  for (const key of ['graphId', 'controlEpoch', 'nodeId', 'generation', 'activationId']) {
    if (!Object.is(identity[key], fact[key])) {
      throw new Error(`Trusted terminal fact ${key} does not match requested terminal identity`);
    }
  }
}

function canonicalTerminalMaterial(fact) {
  return JSON.stringify([
    'chatgpt-autopilot-terminal-agent-event-v1',
    fact.graphId,
    fact.controlEpoch,
    fact.nodeId,
    fact.generation,
    fact.activationId,
    fact.status,
    fact.terminalAt,
  ]);
}

async function sha256Hex(material) {
  const fingerprint = await createSha256FingerprintV1(material);
  return fingerprint.slice('sha256:'.length);
}

export async function createTerminalAgentSourceBindingIdV1(value) {
  const raw = strictRecord(value, 'TerminalAgentSourceBindingV1', new Set(['graphId', 'nodeId']));
  const graphId = exactId(raw.graphId, 'TerminalAgentSourceBindingV1 graphId');
  const nodeId = exactId(raw.nodeId, 'TerminalAgentSourceBindingV1 nodeId');
  const fingerprint = await createSha256FingerprintV1(JSON.stringify([
    'chatgpt-autopilot-terminal-agent-source-binding-v1',
    graphId,
    nodeId,
  ]));
  return `terminal-binding:${fingerprint.slice('sha256:'.length)}`;
}

export async function createTerminalAgentPayloadDescriptorV1(value) {
  const fact = normalizeFact(value);
  const materialUtf8 = canonicalTerminalMaterial(fact);
  return freezeDeep({
    schemaVersion: TERMINAL_AGENT_TRIGGER_VERSION,
    materialUtf8,
    sha256: await sha256Hex(materialUtf8),
    sizeBytes: new TextEncoder().encode(materialUtf8).byteLength,
  });
}

function normalizeDependencies(value) {
  const raw = strictRecord(value, 'Terminal agent trigger dependencies', DEPENDENCY_KEYS);
  if (typeof raw.resolveTerminalActivation !== 'function') {
    throw new Error('Terminal agent trigger requires trusted resolveTerminalActivation');
  }
  return raw;
}

export async function createTerminalAgentTriggerObservationV1(value, dependencies) {
  const request = strictRecord(value, 'Terminal agent trigger request', REQUEST_KEYS);
  const deps = normalizeDependencies(dependencies);
  const trigger = normalizeEventTriggerDefinitionV1(request.trigger);
  if (trigger.kind !== EventTriggerKind.TERMINAL_AGENT) {
    throw new Error('Terminal agent trigger requires TERMINAL_AGENT kind');
  }
  if (trigger.providerId !== TERMINAL_AGENT_PROVIDER_ID) {
    throw new Error('Terminal agent trigger providerId does not match canonical orchestration provider');
  }

  const identity = normalizeIdentity(request.terminalIdentity);
  const expectedBindingId = await createTerminalAgentSourceBindingIdV1({
    graphId: identity.graphId,
    nodeId: identity.nodeId,
  });
  if (trigger.sourceBindingId !== expectedBindingId) {
    throw new Error('Terminal agent trigger sourceBindingId does not match graph/node identity');
  }

  const fact = normalizeFact(await deps.resolveTerminalActivation(identity));
  assertFactIdentity(identity, fact);
  const observedAt = canonicalTimestamp(request.observedAt, 'Terminal agent trigger observedAt');
  const terminalMillis = Date.parse(fact.terminalAt);
  const observedMillis = Date.parse(observedAt);
  if (terminalMillis < Date.parse(trigger.createdAt)) {
    throw new Error('Trusted terminal fact predates trigger definition');
  }
  if (observedMillis < terminalMillis) {
    throw new Error('Terminal agent observation predates trusted terminal fact');
  }

  const descriptor = await createTerminalAgentPayloadDescriptorV1(fact);
  const materialFingerprint = await createSha256FingerprintV1(descriptor.materialUtf8);
  const digest = materialFingerprint.slice('sha256:'.length);
  const payloadArtifactRef = request.payloadArtifactRef;
  const sourceEventId = `terminal-event:${digest}`;
  const observationId = `terminal-observation:${digest}`;

  const observation = normalizeEventTriggerObservationV1({
    schemaVersion: TERMINAL_AGENT_TRIGGER_VERSION,
    observationId,
    triggerId: trigger.triggerId,
    triggerRevision: trigger.triggerRevision,
    providerId: trigger.providerId,
    sourceBindingId: trigger.sourceBindingId,
    sourceEventId,
    payloadArtifactRef,
    observedAt,
  });

  if (observation.payloadArtifactRef.kind !== TERMINAL_AGENT_PAYLOAD_KIND) {
    throw new Error('Terminal agent payload artifact kind is invalid');
  }
  if (observation.payloadArtifactRef.mediaType !== 'application/json') {
    throw new Error('Terminal agent payload artifact mediaType must be application/json');
  }
  if (observation.payloadArtifactRef.sensitive !== false) {
    throw new Error('Terminal agent payload artifact must contain only non-sensitive terminal identity material');
  }
  if (observation.payloadArtifactRef.sha256 !== descriptor.sha256
      || observation.payloadArtifactRef.sizeBytes !== descriptor.sizeBytes) {
    throw new Error('Terminal agent payload artifact does not match canonical terminal fact bytes');
  }
  const artifactCreatedMillis = Date.parse(observation.payloadArtifactRef.createdAt);
  if (artifactCreatedMillis < terminalMillis || artifactCreatedMillis > observedMillis) {
    throw new Error('Terminal agent payload artifact is outside terminal/observation chronology');
  }

  return observation;
}
