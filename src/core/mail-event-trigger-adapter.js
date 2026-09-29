import {
  EventTriggerKind,
  normalizeEventTriggerDefinitionV1,
} from './event-trigger-contract.js';
import {
  admitEventTriggerObservationV1,
} from './event-trigger-runtime.js';
import { createSha256FingerprintV1 } from './fingerprint.js';

export const MAIL_EVENT_TRIGGER_ADAPTER_VERSION = 1;

export const MailChangeKind = Object.freeze({
  MESSAGE_ADDED: 'MESSAGE_ADDED',
  MESSAGE_DELETED: 'MESSAGE_DELETED',
  LABEL_ADDED: 'LABEL_ADDED',
  LABEL_REMOVED: 'LABEL_REMOVED',
});

const CHANGE_KINDS = new Set(Object.values(MailChangeKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const HISTORY_ID = /^(?:0|[1-9][0-9]{0,39})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CHANGE_KINDS = CHANGE_KINDS.size;
const MAX_OBSERVATION_AGE_SECONDS = 7 * 24 * 60 * 60;

const REQUEST_KEYS = new Set([
  'bindingId',
  'bindingRevision',
  'changeId',
  'admittedAt',
]);

const DEPENDENCY_KEYS = new Set([
  'resolveTriggerDefinition',
  'resolveMailEventBinding',
  'resolveTrustedMailChange',
  'admitCanonicalOccurrence',
]);

const BINDING_KEYS = new Set([
  'schemaVersion',
  'bindingId',
  'bindingRevision',
  'triggerId',
  'triggerRevision',
  'providerId',
  'sourceBindingId',
  'mailboxId',
  'watchId',
  'allowedChangeKinds',
  'maxObservationAgeSeconds',
  'createdAt',
]);

const CHANGE_KEYS = new Set([
  'schemaVersion',
  'bindingId',
  'bindingRevision',
  'changeId',
  'mailboxId',
  'watchId',
  'historyId',
  'changeKind',
  'messageId',
  'threadId',
  'evidenceArtifactRef',
  'observedAt',
  'recordedAt',
]);

const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactId',
  'kind',
  'uri',
  'mediaType',
  'sha256',
  'sizeBytes',
  'createdAt',
  'producerInvocationId',
  'sensitive',
]);

function strictRecord(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(label + ' must expose stable data descriptors');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' field ' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > max) {
    throw new Error(label + ' must be a non-empty bounded plain array');
  }
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains an invalid array property');
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor?.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' contains invalid array data');
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' must not be sparse');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function opaqueMailboxId(value, label) {
  const out = exactId(value, label);
  if (out.includes('@')) {
    throw new Error(label + ' must be an opaque non-email identifier');
  }
  return out;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw new Error(label + ' must be a positive integer');
  }
  return value;
}

function boundedPositiveInteger(value, label, max) {
  const out = positiveInteger(value, label);
  if (out > max) throw new Error(label + ' exceeds supported maximum');
  return out;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function timestampMillis(value, label) {
  return Date.parse(canonicalTimestamp(value, label));
}

function canonicalHistoryId(value, label) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || !HISTORY_ID.test(value)) {
    throw new Error(label + ' must be a canonical decimal historyId');
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeChangeKind(value, label) {
  if (typeof value !== 'string' || !CHANGE_KINDS.has(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function normalizeAllowedChangeKinds(value) {
  const raw = denseArray(value, 'MailEventBindingV1 allowedChangeKinds', MAX_CHANGE_KINDS);
  const out = raw.map((item, index) => normalizeChangeKind(
    item,
    'MailEventBindingV1 allowedChangeKinds[' + index + ']',
  ));
  if (new Set(out).size !== out.length) {
    throw new Error('MailEventBindingV1 allowedChangeKinds contains duplicates');
  }
  return Object.freeze(out);
}

function snapshotEvidenceArtifactRef(value) {
  const raw = strictRecord(
    value,
    'TrustedMailChangeV1 evidenceArtifactRef',
    ARTIFACT_KEYS,
  );
  if (raw.schemaVersion !== MAIL_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('TrustedMailChangeV1 evidenceArtifactRef schemaVersion must be numeric 1');
  }
  const artifactId = exactId(raw.artifactId, 'TrustedMailChangeV1 evidenceArtifactRef artifactId');
  if (raw.kind !== 'mail-change-event') {
    throw new Error('TrustedMailChangeV1 evidenceArtifactRef kind must be mail-change-event');
  }
  if (raw.mediaType !== 'application/json') {
    throw new Error('TrustedMailChangeV1 evidenceArtifactRef mediaType must be application/json');
  }
  if (raw.sensitive !== true) {
    throw new Error('TrustedMailChangeV1 evidenceArtifactRef must be marked sensitive');
  }
  if (typeof raw.uri !== 'string'
      || raw.uri !== raw.uri.trim()
      || !raw.uri.startsWith('artifact://')
      || raw.uri.length > 4096) {
    throw new Error('TrustedMailChangeV1 evidenceArtifactRef uri must be an opaque artifact URI');
  }
  if (typeof raw.sha256 !== 'string'
      || raw.sha256 !== raw.sha256.trim()
      || !SHA256.test(raw.sha256)) {
    throw new Error('TrustedMailChangeV1 evidenceArtifactRef sha256 must be canonical lowercase SHA-256');
  }
  if (!Number.isSafeInteger(raw.sizeBytes)
      || Object.is(raw.sizeBytes, -0)
      || raw.sizeBytes < 1) {
    throw new Error('TrustedMailChangeV1 evidenceArtifactRef requires non-empty integer sizeBytes');
  }
  const createdAt = canonicalTimestamp(raw.createdAt, 'TrustedMailChangeV1 evidenceArtifactRef createdAt');
  let producerInvocationId = null;
  if (raw.producerInvocationId != null && raw.producerInvocationId !== '') {
    producerInvocationId = exactId(
      raw.producerInvocationId,
      'TrustedMailChangeV1 evidenceArtifactRef producerInvocationId',
    );
  }
  return Object.freeze({
    schemaVersion: MAIL_EVENT_TRIGGER_ADAPTER_VERSION,
    artifactId,
    kind: raw.kind,
    uri: raw.uri,
    mediaType: raw.mediaType,
    sha256: raw.sha256,
    sizeBytes: raw.sizeBytes,
    createdAt,
    producerInvocationId,
    sensitive: true,
  });
}

function normalizeRequest(value) {
  const raw = strictRecord(value, 'Mail trigger adapter request', REQUEST_KEYS);
  return Object.freeze({
    bindingId: exactId(raw.bindingId, 'Mail trigger bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'Mail trigger bindingRevision'),
    changeId: exactId(raw.changeId, 'Mail trigger changeId'),
    admittedAt: canonicalTimestamp(raw.admittedAt, 'Mail trigger admittedAt'),
  });
}

function normalizeDependencies(value) {
  const raw = strictRecord(value, 'Mail trigger adapter dependencies', DEPENDENCY_KEYS);
  for (const key of DEPENDENCY_KEYS) {
    if (typeof raw[key] !== 'function') {
      throw new Error('Mail trigger adapter requires ' + key);
    }
  }
  return raw;
}

export function normalizeMailEventBindingV1(value) {
  const raw = strictRecord(value, 'MailEventBindingV1', BINDING_KEYS);
  if (raw.schemaVersion !== MAIL_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported MailEventBindingV1 schemaVersion');
  }
  return deepFreeze({
    schemaVersion: MAIL_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'MailEventBindingV1 bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'MailEventBindingV1 bindingRevision'),
    triggerId: exactId(raw.triggerId, 'MailEventBindingV1 triggerId'),
    triggerRevision: positiveInteger(raw.triggerRevision, 'MailEventBindingV1 triggerRevision'),
    providerId: exactId(raw.providerId, 'MailEventBindingV1 providerId'),
    sourceBindingId: exactId(raw.sourceBindingId, 'MailEventBindingV1 sourceBindingId'),
    mailboxId: opaqueMailboxId(raw.mailboxId, 'MailEventBindingV1 mailboxId'),
    watchId: exactId(raw.watchId, 'MailEventBindingV1 watchId'),
    allowedChangeKinds: normalizeAllowedChangeKinds(raw.allowedChangeKinds),
    maxObservationAgeSeconds: boundedPositiveInteger(
      raw.maxObservationAgeSeconds,
      'MailEventBindingV1 maxObservationAgeSeconds',
      MAX_OBSERVATION_AGE_SECONDS,
    ),
    createdAt: canonicalTimestamp(raw.createdAt, 'MailEventBindingV1 createdAt'),
  });
}

export function normalizeTrustedMailChangeV1(value) {
  const raw = strictRecord(value, 'TrustedMailChangeV1', CHANGE_KEYS);
  if (raw.schemaVersion !== MAIL_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported TrustedMailChangeV1 schemaVersion');
  }
  const observedAt = canonicalTimestamp(raw.observedAt, 'TrustedMailChangeV1 observedAt');
  const recordedAt = canonicalTimestamp(raw.recordedAt, 'TrustedMailChangeV1 recordedAt');
  if (timestampMillis(recordedAt, 'TrustedMailChangeV1 recordedAt')
      < timestampMillis(observedAt, 'TrustedMailChangeV1 observedAt')) {
    throw new Error('Trusted mail change record cannot predate provider observation');
  }
  const evidenceArtifactRef = snapshotEvidenceArtifactRef(raw.evidenceArtifactRef);
  const artifactCreatedAt = timestampMillis(
    evidenceArtifactRef.createdAt,
    'TrustedMailChangeV1 evidenceArtifactRef createdAt',
  );
  if (artifactCreatedAt < timestampMillis(observedAt, 'TrustedMailChangeV1 observedAt')
      || artifactCreatedAt > timestampMillis(recordedAt, 'TrustedMailChangeV1 recordedAt')) {
    throw new Error('Trusted mail change evidence artifact is outside observation/record chronology');
  }
  return deepFreeze({
    schemaVersion: MAIL_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'TrustedMailChangeV1 bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'TrustedMailChangeV1 bindingRevision'),
    changeId: exactId(raw.changeId, 'TrustedMailChangeV1 changeId'),
    mailboxId: opaqueMailboxId(raw.mailboxId, 'TrustedMailChangeV1 mailboxId'),
    watchId: exactId(raw.watchId, 'TrustedMailChangeV1 watchId'),
    historyId: canonicalHistoryId(raw.historyId, 'TrustedMailChangeV1 historyId'),
    changeKind: normalizeChangeKind(raw.changeKind, 'TrustedMailChangeV1 changeKind'),
    messageId: exactId(raw.messageId, 'TrustedMailChangeV1 messageId'),
    threadId: exactId(raw.threadId, 'TrustedMailChangeV1 threadId'),
    evidenceArtifactRef,
    observedAt,
    recordedAt,
  });
}

function assertBindingMatchesRequest(binding, request) {
  if (binding.bindingId !== request.bindingId
      || binding.bindingRevision !== request.bindingRevision) {
    throw new Error('Resolved mail event binding does not match requested binding revision');
  }
}

function assertTriggerMatchesBinding(trigger, binding) {
  if (trigger.kind !== EventTriggerKind.MAIL) {
    throw new Error('Mail event binding must resolve a MAIL trigger');
  }
  for (const key of ['triggerId', 'triggerRevision', 'providerId', 'sourceBindingId']) {
    if (trigger[key] !== binding[key]) {
      throw new Error('Mail event binding ' + key + ' does not match trusted trigger definition');
    }
  }
  if (timestampMillis(binding.createdAt, 'MailEventBindingV1 createdAt')
      < timestampMillis(trigger.createdAt, 'EventTriggerDefinitionV1 createdAt')) {
    throw new Error('Mail event binding cannot predate its trusted trigger definition');
  }
}

function assertChangeMatchesBinding(change, binding, request) {
  if (change.bindingId !== binding.bindingId
      || change.bindingRevision !== binding.bindingRevision
      || change.changeId !== request.changeId) {
    throw new Error('Resolved mail change does not match requested binding/change identity');
  }
  if (change.mailboxId !== binding.mailboxId) {
    throw new Error('Trusted mail change mailboxId does not match binding');
  }
  if (change.watchId !== binding.watchId) {
    throw new Error('Trusted mail change watchId does not match binding');
  }
  if (!binding.allowedChangeKinds.includes(change.changeKind)) {
    throw new Error('Trusted mail change kind is not allowed by binding');
  }
  if (timestampMillis(change.observedAt, 'TrustedMailChangeV1 observedAt')
      < timestampMillis(binding.createdAt, 'MailEventBindingV1 createdAt')) {
    throw new Error('Trusted mail change predates binding');
  }
}

function assertFreshChange(binding, change, admittedAt) {
  const admittedAtMillis = timestampMillis(admittedAt, 'Mail trigger admittedAt');
  const recordedAtMillis = timestampMillis(change.recordedAt, 'TrustedMailChangeV1 recordedAt');
  if (admittedAtMillis < recordedAtMillis) {
    throw new Error('Mail trigger admission predates trusted mail change record');
  }
  const ageMillis = admittedAtMillis
    - timestampMillis(change.observedAt, 'TrustedMailChangeV1 observedAt');
  if (ageMillis > binding.maxObservationAgeSeconds * 1000) {
    throw new Error('Trusted mail change is stale for configured binding window');
  }
}

async function canonicalMailSourceEventId(trigger, binding, change) {
  const fingerprint = await createSha256FingerprintV1(JSON.stringify([
    'chatgpt-autopilot-mail-event-source-v1',
    trigger.providerId,
    trigger.sourceBindingId,
    binding.mailboxId,
    binding.watchId,
    change.historyId,
    change.changeKind,
    change.messageId,
  ]));
  return 'mail:' + fingerprint.slice('sha256:'.length);
}

/**
 * Thin trusted mail-history ingress adapter.
 *
 * Gmail/other mail provider watch setup, Pub/Sub or webhook transport,
 * history cursor persistence, history.list recovery, credential resolution,
 * message content retrieval and evidence materialization remain upstream.
 * This adapter accepts exact opaque identities plus immutable sensitive metadata
 * evidence and delegates occurrence/dedup/material-conflict and work admission
 * to the canonical EventTrigger runtime.
 */
export async function admitTrustedMailChangeV1(value, dependencies) {
  const request = normalizeRequest(value);
  const deps = normalizeDependencies(dependencies);

  const binding = normalizeMailEventBindingV1(
    await deps.resolveMailEventBinding({
      bindingId: request.bindingId,
      bindingRevision: request.bindingRevision,
    }),
  );
  assertBindingMatchesRequest(binding, request);

  const trigger = normalizeEventTriggerDefinitionV1(
    await deps.resolveTriggerDefinition({
      triggerId: binding.triggerId,
      triggerRevision: binding.triggerRevision,
    }),
  );
  assertTriggerMatchesBinding(trigger, binding);

  const change = normalizeTrustedMailChangeV1(
    await deps.resolveTrustedMailChange({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      changeId: request.changeId,
    }),
  );
  assertChangeMatchesBinding(change, binding, request);
  assertFreshChange(binding, change, request.admittedAt);

  const sourceEventId = await canonicalMailSourceEventId(trigger, binding, change);
  const observation = {
    schemaVersion: MAIL_EVENT_TRIGGER_ADAPTER_VERSION,
    observationId: sourceEventId,
    triggerId: trigger.triggerId,
    triggerRevision: trigger.triggerRevision,
    providerId: trigger.providerId,
    sourceBindingId: trigger.sourceBindingId,
    sourceEventId,
    payloadArtifactRef: change.evidenceArtifactRef,
    observedAt: change.recordedAt,
  };

  const runtime = await admitEventTriggerObservationV1(
    {
      trigger,
      observation,
      admittedAt: request.admittedAt,
    },
    {
      resolveTriggerDefinition: async ({ triggerId, triggerRevision }) => {
        if (triggerId !== trigger.triggerId || triggerRevision !== trigger.triggerRevision) {
          throw new Error('Mail event runtime requested unexpected trigger identity');
        }
        return trigger;
      },
      admitCanonicalOccurrence: deps.admitCanonicalOccurrence,
    },
  );

  return deepFreeze({
    ...runtime,
    mailBindingId: binding.bindingId,
    mailBindingRevision: binding.bindingRevision,
    mailMailboxId: binding.mailboxId,
    mailWatchId: binding.watchId,
    mailChangeId: change.changeId,
    mailHistoryId: change.historyId,
    mailChangeKind: change.changeKind,
    mailMessageId: change.messageId,
    mailThreadId: change.threadId,
    mailObservedAt: change.observedAt,
    mailRecordedAt: change.recordedAt,
    trustedProviderObservationBound: true,
    mailboxAuthority: false,
    mailWatchAuthority: false,
    mailNetworkAuthority: false,
    historyCursorAuthority: false,
    credentialAuthority: false,
    rawEmailAddressPersisted: false,
    mailContentPersisted: false,
  });
}
