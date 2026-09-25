import { createSha256FingerprintV1 } from './fingerprint.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const EVENT_TRIGGER_VERSION = 1;

export const EventTriggerKind = Object.freeze({
  CALENDAR: 'CALENDAR',
  WEBHOOK: 'WEBHOOK',
  GITHUB: 'GITHUB',
  MAIL: 'MAIL',
  DRIVE: 'DRIVE',
  FILE: 'FILE',
  SITE: 'SITE',
  API: 'API',
  TERMINAL_AGENT: 'TERMINAL_AGENT',
});

export const EventTriggerAdmissionStatus = Object.freeze({
  READY_FOR_SCHEDULER: 'READY_FOR_SCHEDULER',
  DISABLED: 'DISABLED',
});

const KINDS = new Set(Object.values(EventTriggerKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CAPABILITIES = 128;
const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);
const TRIGGER_KEYS = new Set([
  'schemaVersion', 'triggerId', 'triggerRevision', 'agentId', 'jobId', 'kind',
  'providerId', 'sourceBindingId', 'requiredCapabilityIds', 'enabled', 'createdAt',
]);
const OBSERVATION_KEYS = new Set([
  'schemaVersion', 'observationId', 'triggerId', 'triggerRevision', 'providerId',
  'sourceBindingId', 'sourceEventId', 'payloadArtifactRef', 'observedAt',
]);
const ADMISSION_KEYS = new Set(['trigger', 'observation', 'admittedAt']);
const ADMISSION_DEPENDENCY_KEYS = new Set(['resolveTriggerDefinition']);

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
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function strictArray(value, label, max = MAX_CAPABILITIES) {
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
  const out = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains an invalid array property`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
      throw new Error(`${label} contains an invalid array index`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function exactVersion(value, label) {
  if (value !== EVENT_TRIGGER_VERSION) throw new Error(`Unsupported ${label} schemaVersion`);
  return value;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} must be a canonical timestamp`);
  const canonical = new Date(millis).toISOString();
  if (value !== canonical) throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  return canonical;
}

function idList(value, label) {
  const raw = strictArray(value ?? [], label);
  const out = raw.map((item, index) => exactId(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function snapshotArtifact(value) {
  const label = 'EventTriggerObservationV1 payloadArtifactRef';
  const snapshot = strictRecord(value, label, ARTIFACT_KEYS);
  if (snapshot.schemaVersion !== EVENT_TRIGGER_VERSION) throw new Error(`${label} schemaVersion must be numeric 1`);
  exactId(snapshot.artifactId, `${label} artifactId`);
  exactId(snapshot.kind, `${label} kind`);
  if (typeof snapshot.uri !== 'string' || snapshot.uri !== snapshot.uri.trim() || !snapshot.uri || snapshot.uri.length > 4096) {
    throw new Error(`${label} uri must be canonical bounded text`);
  }
  if (snapshot.mediaType != null && snapshot.mediaType !== '') {
    if (typeof snapshot.mediaType !== 'string' || snapshot.mediaType !== snapshot.mediaType.trim() || snapshot.mediaType.length > 300) {
      throw new Error(`${label} mediaType must be canonical bounded text`);
    }
  }
  if (typeof snapshot.sha256 !== 'string' || snapshot.sha256 !== snapshot.sha256.trim() || !SHA256.test(snapshot.sha256)) {
    throw new Error(`${label} sha256 must be canonical lowercase SHA-256`);
  }
  if (!Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 1) {
    throw new Error(`${label} requires non-empty material with integer sizeBytes`);
  }
  canonicalTimestamp(snapshot.createdAt, `${label} createdAt`);
  if (snapshot.producerInvocationId != null && snapshot.producerInvocationId !== '') {
    exactId(snapshot.producerInvocationId, `${label} producerInvocationId`);
  }
  if (typeof snapshot.sensitive !== 'boolean') throw new Error(`${label} sensitive must be explicit boolean`);
  const artifact = normalizeArtifactRefV1(snapshot);
  if (!artifact.sha256) throw new Error(`${label} requires sha256`);
  return artifact;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function canonicalTriggerDefinition(trigger) {
  return JSON.stringify([
    'chatgpt-autopilot-event-trigger-definition-v1',
    trigger.schemaVersion,
    trigger.triggerId,
    trigger.triggerRevision,
    trigger.agentId,
    trigger.jobId,
    trigger.kind,
    trigger.providerId,
    trigger.sourceBindingId,
    trigger.requiredCapabilityIds,
    trigger.enabled,
    trigger.createdAt,
  ]);
}

async function bindTrustedTriggerDefinition(trigger, { resolveTriggerDefinition } = {}) {
  if (typeof resolveTriggerDefinition !== 'function') {
    throw new Error('Event trigger admission requires a trusted trigger definition resolver');
  }
  const trusted = normalizeEventTriggerDefinitionV1(await resolveTriggerDefinition({
    triggerId: trigger.triggerId,
    triggerRevision: trigger.triggerRevision,
  }));
  if (canonicalTriggerDefinition(trusted) !== canonicalTriggerDefinition(trigger)) {
    throw new Error('Event trigger definition does not match trusted trigger revision');
  }
  const triggerDefinitionFingerprint = await createSha256FingerprintV1(
    canonicalTriggerDefinition(trusted),
  );
  return { triggerDefinitionFingerprint };
}

export function normalizeEventTriggerDefinitionV1(value) {
  const raw = strictRecord(value, 'EventTriggerDefinitionV1', TRIGGER_KEYS);
  exactVersion(raw.schemaVersion, 'EventTriggerDefinitionV1');
  if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) {
    throw new Error('EventTriggerDefinitionV1 kind is invalid');
  }
  const requiredCapabilityIds = idList(raw.requiredCapabilityIds, 'EventTriggerDefinitionV1 requiredCapabilityIds');
  if (!requiredCapabilityIds.length) {
    throw new Error('EventTriggerDefinitionV1 requiredCapabilityIds must not be empty');
  }
  return freezeDeep({
    schemaVersion: EVENT_TRIGGER_VERSION,
    triggerId: exactId(raw.triggerId, 'EventTriggerDefinitionV1 triggerId'),
    triggerRevision: positiveInteger(raw.triggerRevision, 'EventTriggerDefinitionV1 triggerRevision'),
    agentId: exactId(raw.agentId, 'EventTriggerDefinitionV1 agentId'),
    jobId: exactId(raw.jobId, 'EventTriggerDefinitionV1 jobId'),
    kind: raw.kind,
    providerId: exactId(raw.providerId, 'EventTriggerDefinitionV1 providerId'),
    sourceBindingId: exactId(raw.sourceBindingId, 'EventTriggerDefinitionV1 sourceBindingId'),
    requiredCapabilityIds,
    enabled: exactBoolean(raw.enabled, 'EventTriggerDefinitionV1 enabled'),
    createdAt: canonicalTimestamp(raw.createdAt, 'EventTriggerDefinitionV1 createdAt'),
  });
}

export function normalizeEventTriggerObservationV1(value) {
  const raw = strictRecord(value, 'EventTriggerObservationV1', OBSERVATION_KEYS);
  exactVersion(raw.schemaVersion, 'EventTriggerObservationV1');
  const payloadArtifactRef = snapshotArtifact(raw.payloadArtifactRef);
  const observedAt = canonicalTimestamp(raw.observedAt, 'EventTriggerObservationV1 observedAt');
  if (payloadArtifactRef.createdAt > observedAt) {
    throw new Error('EventTriggerObservationV1 payload artifact cannot postdate observation');
  }
  return freezeDeep({
    schemaVersion: EVENT_TRIGGER_VERSION,
    observationId: exactId(raw.observationId, 'EventTriggerObservationV1 observationId'),
    triggerId: exactId(raw.triggerId, 'EventTriggerObservationV1 triggerId'),
    triggerRevision: positiveInteger(raw.triggerRevision, 'EventTriggerObservationV1 triggerRevision'),
    providerId: exactId(raw.providerId, 'EventTriggerObservationV1 providerId'),
    sourceBindingId: exactId(raw.sourceBindingId, 'EventTriggerObservationV1 sourceBindingId'),
    sourceEventId: exactId(raw.sourceEventId, 'EventTriggerObservationV1 sourceEventId'),
    payloadArtifactRef,
    observedAt,
  });
}

async function fingerprints(trigger, observation, triggerDefinitionFingerprint) {
  const sourceIdentityCanonical = JSON.stringify([
    'chatgpt-autopilot-event-trigger-source-v1',
    triggerDefinitionFingerprint,
    trigger.triggerId,
    trigger.triggerRevision,
    trigger.providerId,
    trigger.sourceBindingId,
    observation.sourceEventId,
  ]);
  const materialCanonical = JSON.stringify([
    'chatgpt-autopilot-event-trigger-material-v1',
    triggerDefinitionFingerprint,
    trigger.triggerId,
    trigger.triggerRevision,
    trigger.agentId,
    trigger.jobId,
    trigger.kind,
    trigger.providerId,
    trigger.sourceBindingId,
    trigger.requiredCapabilityIds,
    observation.sourceEventId,
    observation.payloadArtifactRef.mediaType,
    observation.payloadArtifactRef.sha256,
    observation.payloadArtifactRef.sizeBytes,
    observation.payloadArtifactRef.sensitive,
  ]);
  const [sourceIdentityFingerprint, materialFingerprint] = await Promise.all([
    createSha256FingerprintV1(sourceIdentityCanonical),
    createSha256FingerprintV1(materialCanonical),
  ]);
  return { sourceIdentityFingerprint, materialFingerprint };
}

export async function createEventTriggerAdmissionV1(value, options = {}) {
  const request = strictRecord(value, 'Event trigger admission request', ADMISSION_KEYS);
  const dependencies = strictRecord(
    options,
    'Event trigger admission dependencies',
    ADMISSION_DEPENDENCY_KEYS,
  );
  const trigger = normalizeEventTriggerDefinitionV1(request.trigger);
  const observation = normalizeEventTriggerObservationV1(request.observation);
  const admittedAt = canonicalTimestamp(request.admittedAt, 'Event trigger admittedAt');

  for (const key of ['triggerId', 'triggerRevision', 'providerId', 'sourceBindingId']) {
    if (observation[key] !== trigger[key]) {
      throw new Error(`Event trigger observation ${key} does not match trigger definition`);
    }
  }
  if (observation.observedAt < trigger.createdAt) {
    throw new Error('Event trigger observation predates trigger definition');
  }
  if (admittedAt < observation.observedAt) {
    throw new Error('Event trigger admission predates observation');
  }

  const { triggerDefinitionFingerprint } = await bindTrustedTriggerDefinition(trigger, dependencies);

  if (!trigger.enabled) {
    return freezeDeep({
      schemaVersion: EVENT_TRIGGER_VERSION,
      status: EventTriggerAdmissionStatus.DISABLED,
      triggerId: trigger.triggerId,
      triggerRevision: trigger.triggerRevision,
      agentId: trigger.agentId,
      jobId: trigger.jobId,
      kind: trigger.kind,
      providerId: trigger.providerId,
      sourceBindingId: trigger.sourceBindingId,
      observationId: observation.observationId,
      sourceEventId: observation.sourceEventId,
      triggerDefinitionFingerprint,
      trustedTriggerDefinitionBound: true,
      advisoryOnly: true,
      executionAuthorized: false,
      policyDecisionGranted: false,
      requiresCanonicalSchedulerAdmission: true,
      requiresCanonicalPolicyDecision: true,
      requiresCanonicalExactEffect: true,
      requiresCanonicalVerification: true,
      admittedAt,
    });
  }

  const { sourceIdentityFingerprint, materialFingerprint } = await fingerprints(
    trigger,
    observation,
    triggerDefinitionFingerprint,
  );
  return freezeDeep({
    schemaVersion: EVENT_TRIGGER_VERSION,
    status: EventTriggerAdmissionStatus.READY_FOR_SCHEDULER,
    triggerId: trigger.triggerId,
    triggerRevision: trigger.triggerRevision,
    agentId: trigger.agentId,
    jobId: trigger.jobId,
    kind: trigger.kind,
    providerId: trigger.providerId,
    sourceBindingId: trigger.sourceBindingId,
    requiredCapabilityIds: trigger.requiredCapabilityIds,
    observationId: observation.observationId,
    sourceEventId: observation.sourceEventId,
    triggerDefinitionFingerprint,
    trustedTriggerDefinitionBound: true,
    sourceIdentityFingerprint,
    materialFingerprint,
    occurrenceId: `event:${sourceIdentityFingerprint.slice('sha256:'.length)}`,
    payloadArtifactId: observation.payloadArtifactRef.artifactId,
    payloadSha256: observation.payloadArtifactRef.sha256,
    observedAt: observation.observedAt,
    advisoryOnly: true,
    executionAuthorized: false,
    policyDecisionGranted: false,
    requiresCanonicalSchedulerAdmission: true,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalExactEffect: true,
    requiresCanonicalVerification: true,
    admittedAt,
  });
}
