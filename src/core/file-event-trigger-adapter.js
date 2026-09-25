import {
  EventTriggerKind,
  normalizeEventTriggerDefinitionV1,
} from './event-trigger-contract.js';
import {
  admitEventTriggerObservationV1,
} from './event-trigger-runtime.js';

export const FILE_EVENT_TRIGGER_ADAPTER_VERSION = 1;

export const FileChangeKind = Object.freeze({
  CREATED: 'CREATED',
  MODIFIED: 'MODIFIED',
  DELETED: 'DELETED',
  RENAMED: 'RENAMED',
});

const CHANGE_KINDS = new Set(Object.values(FileChangeKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
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
  'resolveFileEventBinding',
  'resolveTrustedFileChange',
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
  'watchId',
  'scopeId',
  'allowedChangeKinds',
  'maxObservationAgeSeconds',
  'createdAt',
]);

const CHANGE_KEYS = new Set([
  'schemaVersion',
  'bindingId',
  'bindingRevision',
  'changeId',
  'watchId',
  'scopeId',
  'changeKind',
  'subjectId',
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
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new Error(label + ' must be a plain object');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' field ' + key + ' must be an enumerable own data property');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
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
  const raw = denseArray(
    value,
    'FileEventBindingV1 allowedChangeKinds',
    MAX_CHANGE_KINDS,
  );
  const out = raw.map((item, index) => normalizeChangeKind(
    item,
    'FileEventBindingV1 allowedChangeKinds[' + index + ']',
  ));
  if (new Set(out).size !== out.length) {
    throw new Error('FileEventBindingV1 allowedChangeKinds contains duplicates');
  }
  return Object.freeze(out);
}

function snapshotEvidenceArtifactRef(value) {
  const raw = strictRecord(
    value,
    'TrustedFileChangeV1 evidenceArtifactRef',
    ARTIFACT_KEYS,
  );
  if (raw.kind !== 'file-change-event') {
    throw new Error('TrustedFileChangeV1 evidenceArtifactRef kind must be file-change-event');
  }
  if (raw.mediaType !== 'application/json') {
    throw new Error('TrustedFileChangeV1 evidenceArtifactRef mediaType must be application/json');
  }
  if (raw.sensitive !== false) {
    throw new Error('TrustedFileChangeV1 evidenceArtifactRef must be non-sensitive metadata evidence');
  }
  if (typeof raw.uri !== 'string'
      || raw.uri !== raw.uri.trim()
      || !raw.uri.startsWith('artifact://')
      || raw.uri.length > 4096) {
    throw new Error('TrustedFileChangeV1 evidenceArtifactRef uri must be an opaque artifact URI');
  }
  return Object.freeze({ ...raw });
}

function normalizeRequest(value) {
  const raw = strictRecord(value, 'File trigger adapter request', REQUEST_KEYS);
  return Object.freeze({
    bindingId: exactId(raw.bindingId, 'File trigger bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'File trigger bindingRevision'),
    changeId: exactId(raw.changeId, 'File trigger changeId'),
    admittedAt: canonicalTimestamp(raw.admittedAt, 'File trigger admittedAt'),
  });
}

function normalizeDependencies(value) {
  const raw = strictRecord(value, 'File trigger adapter dependencies', DEPENDENCY_KEYS);
  for (const key of DEPENDENCY_KEYS) {
    if (typeof raw[key] !== 'function') {
      throw new Error('File trigger adapter requires ' + key);
    }
  }
  return raw;
}

export function normalizeFileEventBindingV1(value) {
  const raw = strictRecord(value, 'FileEventBindingV1', BINDING_KEYS);
  if (raw.schemaVersion !== FILE_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported FileEventBindingV1 schemaVersion');
  }
  return deepFreeze({
    schemaVersion: FILE_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'FileEventBindingV1 bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'FileEventBindingV1 bindingRevision'),
    triggerId: exactId(raw.triggerId, 'FileEventBindingV1 triggerId'),
    triggerRevision: positiveInteger(raw.triggerRevision, 'FileEventBindingV1 triggerRevision'),
    providerId: exactId(raw.providerId, 'FileEventBindingV1 providerId'),
    sourceBindingId: exactId(raw.sourceBindingId, 'FileEventBindingV1 sourceBindingId'),
    watchId: exactId(raw.watchId, 'FileEventBindingV1 watchId'),
    scopeId: exactId(raw.scopeId, 'FileEventBindingV1 scopeId'),
    allowedChangeKinds: normalizeAllowedChangeKinds(raw.allowedChangeKinds),
    maxObservationAgeSeconds: boundedPositiveInteger(
      raw.maxObservationAgeSeconds,
      'FileEventBindingV1 maxObservationAgeSeconds',
      MAX_OBSERVATION_AGE_SECONDS,
    ),
    createdAt: canonicalTimestamp(raw.createdAt, 'FileEventBindingV1 createdAt'),
  });
}

export function normalizeTrustedFileChangeV1(value) {
  const raw = strictRecord(value, 'TrustedFileChangeV1', CHANGE_KEYS);
  if (raw.schemaVersion !== FILE_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported TrustedFileChangeV1 schemaVersion');
  }
  const observedAt = canonicalTimestamp(raw.observedAt, 'TrustedFileChangeV1 observedAt');
  const recordedAt = canonicalTimestamp(raw.recordedAt, 'TrustedFileChangeV1 recordedAt');
  if (timestampMillis(recordedAt, 'TrustedFileChangeV1 recordedAt')
      < timestampMillis(observedAt, 'TrustedFileChangeV1 observedAt')) {
    throw new Error('Trusted file change record cannot predate provider observation');
  }

  const evidenceArtifactRef = snapshotEvidenceArtifactRef(raw.evidenceArtifactRef);
  const artifactCreatedAt = timestampMillis(
    evidenceArtifactRef.createdAt,
    'TrustedFileChangeV1 evidenceArtifactRef createdAt',
  );
  if (artifactCreatedAt < timestampMillis(observedAt, 'TrustedFileChangeV1 observedAt')
      || artifactCreatedAt > timestampMillis(recordedAt, 'TrustedFileChangeV1 recordedAt')) {
    throw new Error('Trusted file change evidence artifact is outside observation/record chronology');
  }

  return deepFreeze({
    schemaVersion: FILE_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'TrustedFileChangeV1 bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'TrustedFileChangeV1 bindingRevision'),
    changeId: exactId(raw.changeId, 'TrustedFileChangeV1 changeId'),
    watchId: exactId(raw.watchId, 'TrustedFileChangeV1 watchId'),
    scopeId: exactId(raw.scopeId, 'TrustedFileChangeV1 scopeId'),
    changeKind: normalizeChangeKind(raw.changeKind, 'TrustedFileChangeV1 changeKind'),
    subjectId: exactId(raw.subjectId, 'TrustedFileChangeV1 subjectId'),
    evidenceArtifactRef,
    observedAt,
    recordedAt,
  });
}

function assertBindingMatchesRequest(binding, request) {
  if (binding.bindingId !== request.bindingId
      || binding.bindingRevision !== request.bindingRevision) {
    throw new Error('Resolved file event binding does not match requested binding revision');
  }
}

function assertTriggerMatchesBinding(trigger, binding) {
  if (trigger.kind !== EventTriggerKind.FILE) {
    throw new Error('File event binding must resolve a FILE trigger');
  }
  for (const key of ['triggerId', 'triggerRevision', 'providerId', 'sourceBindingId']) {
    if (trigger[key] !== binding[key]) {
      throw new Error('File event binding ' + key + ' does not match trusted trigger definition');
    }
  }
  if (timestampMillis(binding.createdAt, 'FileEventBindingV1 createdAt')
      < timestampMillis(trigger.createdAt, 'EventTriggerDefinitionV1 createdAt')) {
    throw new Error('File event binding cannot predate its trusted trigger definition');
  }
}

function assertChangeMatchesBinding(change, binding, request) {
  if (change.bindingId !== binding.bindingId
      || change.bindingRevision !== binding.bindingRevision
      || change.changeId !== request.changeId) {
    throw new Error('Resolved file change does not match requested binding/change identity');
  }
  if (change.watchId !== binding.watchId) {
    throw new Error('Trusted file change watchId does not match binding');
  }
  if (change.scopeId !== binding.scopeId) {
    throw new Error('Trusted file change scopeId does not match binding');
  }
  if (!binding.allowedChangeKinds.includes(change.changeKind)) {
    throw new Error('Trusted file change kind is not allowed by binding');
  }
  if (timestampMillis(change.observedAt, 'TrustedFileChangeV1 observedAt')
      < timestampMillis(binding.createdAt, 'FileEventBindingV1 createdAt')) {
    throw new Error('Trusted file change predates binding');
  }
}

function assertFreshChange(binding, change, admittedAt) {
  const admittedAtMillis = timestampMillis(admittedAt, 'File trigger admittedAt');
  const recordedAtMillis = timestampMillis(change.recordedAt, 'TrustedFileChangeV1 recordedAt');
  if (admittedAtMillis < recordedAtMillis) {
    throw new Error('File trigger admission predates trusted file change record');
  }
  const ageMillis = admittedAtMillis
    - timestampMillis(change.observedAt, 'TrustedFileChangeV1 observedAt');
  if (ageMillis > binding.maxObservationAgeSeconds * 1000) {
    throw new Error('Trusted file change is stale for configured binding window');
  }
}

/**
 * Thin trusted file-change ingress adapter.
 *
 * File watching, filesystem scope enforcement, path resolution, content access,
 * Native Companion transport and evidence materialization remain upstream.
 * This adapter accepts only exact opaque identities plus an immutable metadata
 * ArtifactRef from trusted resolvers and delegates occurrence/dedup/material
 * conflict and work admission to the canonical EventTrigger runtime.
 */
export async function admitTrustedFileChangeV1(value, dependencies) {
  const request = normalizeRequest(value);
  const deps = normalizeDependencies(dependencies);

  const binding = normalizeFileEventBindingV1(
    await deps.resolveFileEventBinding({
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

  const change = normalizeTrustedFileChangeV1(
    await deps.resolveTrustedFileChange({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      changeId: request.changeId,
    }),
  );
  assertChangeMatchesBinding(change, binding, request);
  assertFreshChange(binding, change, request.admittedAt);

  const observation = {
    schemaVersion: FILE_EVENT_TRIGGER_ADAPTER_VERSION,
    observationId: change.changeId,
    triggerId: trigger.triggerId,
    triggerRevision: trigger.triggerRevision,
    providerId: trigger.providerId,
    sourceBindingId: trigger.sourceBindingId,
    sourceEventId: change.changeId,
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
          throw new Error('File event runtime requested unexpected trigger identity');
        }
        return trigger;
      },
      admitCanonicalOccurrence: deps.admitCanonicalOccurrence,
    },
  );

  return deepFreeze({
    ...runtime,
    fileBindingId: binding.bindingId,
    fileBindingRevision: binding.bindingRevision,
    fileWatchId: binding.watchId,
    fileScopeId: binding.scopeId,
    fileChangeId: change.changeId,
    fileChangeKind: change.changeKind,
    fileSubjectId: change.subjectId,
    fileObservedAt: change.observedAt,
    fileRecordedAt: change.recordedAt,
    trustedProviderObservationBound: true,
    fileWatchAuthority: false,
    filesystemAuthority: false,
    rawPathPersisted: false,
    fileContentPersisted: false,
    providerNetworkAuthority: false,
  });
}
