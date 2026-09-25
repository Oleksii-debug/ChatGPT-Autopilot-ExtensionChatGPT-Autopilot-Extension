import { createSha256FingerprintV1 } from './fingerprint.js';
import {
  EventTriggerKind,
  normalizeEventTriggerDefinitionV1,
} from './event-trigger-contract.js';
import {
  admitEventTriggerObservationV1,
} from './event-trigger-runtime.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const DRIVE_EVENT_TRIGGER_ADAPTER_VERSION = 1;

export const DriveChangeKind = Object.freeze({
  FILE_ADDED: 'FILE_ADDED',
  FILE_CHANGED: 'FILE_CHANGED',
  FILE_REMOVED: 'FILE_REMOVED',
  DRIVE_CHANGED: 'DRIVE_CHANGED',
  DRIVE_REMOVED: 'DRIVE_REMOVED',
});

const CHANGE_KINDS = new Set(Object.values(DriveChangeKind));
const FILE_CHANGE_KINDS = new Set([
  DriveChangeKind.FILE_ADDED,
  DriveChangeKind.FILE_CHANGED,
  DriveChangeKind.FILE_REMOVED,
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const TOKEN = /^[\x21-\x7e]{1,512}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CHANGE_AGE_SECONDS = 7 * 24 * 60 * 60;

const REQUEST_KEYS = new Set([
  'bindingId',
  'bindingRevision',
  'changeToken',
  'admittedAt',
]);
const DEPENDENCY_KEYS = new Set([
  'resolveTriggerDefinition',
  'resolveDriveWatchBinding',
  'resolveDriveChange',
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
  'resourceId',
  'driveScopeId',
  'maxChangeAgeSeconds',
  'createdAt',
]);
const CHANGE_KEYS = new Set([
  'schemaVersion',
  'bindingId',
  'bindingRevision',
  'watchId',
  'resourceId',
  'driveScopeId',
  'changeToken',
  'changeKind',
  'fileId',
  'evidenceArtifactRef',
  'observedAt',
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
    throw new Error(`${label} must be a plain object`);
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new Error(`${label} must be a plain object`);
  }
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
      throw new Error(`${label} field ${String(key)} must be an enumerable own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function requireKeys(raw, required, label) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
}

function exactId(value, label, { optional = false } = {}) {
  if (optional && (value === '' || value === null || value === undefined)) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactOpaqueToken(value, label) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || !TOKEN.test(value)
      || /[\\"']/u.test(value)) {
    throw new Error(`${label} must be bounded opaque ASCII without quotes`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedPositiveInteger(value, label, max) {
  const out = positiveInteger(value, label);
  if (out > max) throw new Error(`${label} exceeds supported maximum`);
  return out;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} must be a canonical timestamp`);
  const canonical = new Date(millis).toISOString();
  if (canonical !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return canonical;
}

function compareTimestamp(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return leftMs < rightMs ? -1 : leftMs > rightMs ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeEvidenceArtifactRef(value) {
  const raw = strictRecord(
    value,
    'DriveChangeV1 evidenceArtifactRef',
    ARTIFACT_KEYS,
  );
  requireKeys(raw, ARTIFACT_KEYS, 'DriveChangeV1 evidenceArtifactRef');

  if (raw.schemaVersion !== DRIVE_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('DriveChangeV1 evidenceArtifactRef schemaVersion must be numeric 1');
  }
  if (raw.kind !== 'drive-change-evidence') {
    throw new Error('DriveChangeV1 evidenceArtifactRef kind must be drive-change-evidence');
  }
  if (raw.mediaType !== 'application/json') {
    throw new Error('DriveChangeV1 evidenceArtifactRef mediaType must be application/json');
  }
  if (typeof raw.uri !== 'string'
      || raw.uri !== raw.uri.trim()
      || !raw.uri.startsWith('artifact://')
      || raw.uri.length > 4096) {
    throw new Error('DriveChangeV1 evidenceArtifactRef uri must be an opaque artifact:// URI');
  }
  exactId(raw.artifactId, 'DriveChangeV1 evidenceArtifactRef artifactId');
  if (typeof raw.sha256 !== 'string'
      || raw.sha256 !== raw.sha256.trim()
      || !SHA256.test(raw.sha256)) {
    throw new Error('DriveChangeV1 evidenceArtifactRef sha256 must be canonical lowercase SHA-256');
  }
  if (!Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 1) {
    throw new Error('DriveChangeV1 evidenceArtifactRef requires non-empty integer sizeBytes');
  }
  canonicalTimestamp(raw.createdAt, 'DriveChangeV1 evidenceArtifactRef createdAt');
  if (raw.producerInvocationId != null && raw.producerInvocationId !== '') {
    exactId(raw.producerInvocationId, 'DriveChangeV1 evidenceArtifactRef producerInvocationId');
  }
  if (raw.sensitive !== true) {
    throw new Error('DriveChangeV1 evidenceArtifactRef sensitive must be true');
  }

  return normalizeArtifactRefV1(raw);
}

function normalizeRequest(value) {
  const raw = strictRecord(value, 'Drive trigger adapter request', REQUEST_KEYS);
  requireKeys(raw, REQUEST_KEYS, 'Drive trigger adapter request');
  return {
    bindingId: exactId(raw.bindingId, 'Drive trigger bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'Drive trigger bindingRevision'),
    changeToken: exactOpaqueToken(raw.changeToken, 'Drive changeToken'),
    admittedAt: canonicalTimestamp(raw.admittedAt, 'Drive admittedAt'),
  };
}

function normalizeDependencies(value) {
  const raw = strictRecord(value, 'Drive trigger adapter dependencies', DEPENDENCY_KEYS);
  requireKeys(raw, DEPENDENCY_KEYS, 'Drive trigger adapter dependencies');
  for (const key of DEPENDENCY_KEYS) {
    if (typeof raw[key] !== 'function') {
      throw new Error(`Drive trigger adapter requires ${key}`);
    }
  }
  return raw;
}

export function normalizeDriveWatchBindingV1(value) {
  const raw = strictRecord(value, 'DriveWatchBindingV1', BINDING_KEYS);
  requireKeys(raw, BINDING_KEYS, 'DriveWatchBindingV1');
  if (raw.schemaVersion !== DRIVE_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported DriveWatchBindingV1 schemaVersion');
  }
  return deepFreeze({
    schemaVersion: DRIVE_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'DriveWatchBindingV1 bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'DriveWatchBindingV1 bindingRevision'),
    triggerId: exactId(raw.triggerId, 'DriveWatchBindingV1 triggerId'),
    triggerRevision: positiveInteger(raw.triggerRevision, 'DriveWatchBindingV1 triggerRevision'),
    providerId: exactId(raw.providerId, 'DriveWatchBindingV1 providerId'),
    sourceBindingId: exactId(raw.sourceBindingId, 'DriveWatchBindingV1 sourceBindingId'),
    watchId: exactId(raw.watchId, 'DriveWatchBindingV1 watchId'),
    resourceId: exactId(raw.resourceId, 'DriveWatchBindingV1 resourceId'),
    driveScopeId: exactId(raw.driveScopeId, 'DriveWatchBindingV1 driveScopeId'),
    maxChangeAgeSeconds: boundedPositiveInteger(
      raw.maxChangeAgeSeconds,
      'DriveWatchBindingV1 maxChangeAgeSeconds',
      MAX_CHANGE_AGE_SECONDS,
    ),
    createdAt: canonicalTimestamp(raw.createdAt, 'DriveWatchBindingV1 createdAt'),
  });
}

export function normalizeDriveChangeV1(value) {
  const raw = strictRecord(value, 'DriveChangeV1', CHANGE_KEYS);
  requireKeys(raw, CHANGE_KEYS, 'DriveChangeV1');
  if (raw.schemaVersion !== DRIVE_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported DriveChangeV1 schemaVersion');
  }
  if (typeof raw.changeKind !== 'string' || !CHANGE_KINDS.has(raw.changeKind)) {
    throw new Error('DriveChangeV1 changeKind is invalid');
  }

  const fileId = exactId(raw.fileId, 'DriveChangeV1 fileId', { optional: true });
  if (FILE_CHANGE_KINDS.has(raw.changeKind) && !fileId) {
    throw new Error('DriveChangeV1 file change requires fileId');
  }
  if (!FILE_CHANGE_KINDS.has(raw.changeKind) && fileId) {
    throw new Error('DriveChangeV1 drive-level change must not carry fileId');
  }

  const evidenceArtifactRef = normalizeEvidenceArtifactRef(raw.evidenceArtifactRef);
  const observedAt = canonicalTimestamp(raw.observedAt, 'DriveChangeV1 observedAt');
  if (compareTimestamp(evidenceArtifactRef.createdAt, observedAt) > 0) {
    throw new Error('DriveChangeV1 evidence artifact cannot postdate observation');
  }

  return deepFreeze({
    schemaVersion: DRIVE_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'DriveChangeV1 bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'DriveChangeV1 bindingRevision'),
    watchId: exactId(raw.watchId, 'DriveChangeV1 watchId'),
    resourceId: exactId(raw.resourceId, 'DriveChangeV1 resourceId'),
    driveScopeId: exactId(raw.driveScopeId, 'DriveChangeV1 driveScopeId'),
    changeToken: exactOpaqueToken(raw.changeToken, 'DriveChangeV1 changeToken'),
    changeKind: raw.changeKind,
    fileId,
    evidenceArtifactRef,
    observedAt,
  });
}

function assertBindingMatchesRequest(binding, request) {
  if (binding.bindingId !== request.bindingId
      || binding.bindingRevision !== request.bindingRevision) {
    throw new Error('Resolved Drive binding does not match requested binding revision');
  }
}

function assertTriggerMatchesBinding(trigger, binding) {
  if (trigger.kind !== EventTriggerKind.DRIVE) {
    throw new Error('Drive binding must resolve a DRIVE trigger');
  }
  for (const key of ['triggerId', 'triggerRevision', 'providerId', 'sourceBindingId']) {
    if (trigger[key] !== binding[key]) {
      throw new Error(`Drive binding ${key} does not match trusted trigger definition`);
    }
  }
  if (compareTimestamp(binding.createdAt, trigger.createdAt) < 0) {
    throw new Error('Drive binding cannot predate its trusted trigger definition');
  }
}

function assertChangeMatchesBinding(change, binding, request) {
  for (const key of [
    'bindingId',
    'bindingRevision',
    'watchId',
    'resourceId',
    'driveScopeId',
  ]) {
    if (change[key] !== binding[key]) {
      throw new Error(`Resolved Drive change ${key} does not match trusted binding`);
    }
  }
  if (change.changeToken !== request.changeToken) {
    throw new Error('Resolved Drive change does not match requested changeToken');
  }
  if (compareTimestamp(change.observedAt, binding.createdAt) < 0) {
    throw new Error('Drive change predates trusted binding');
  }
}

function assertFreshChange(binding, change, admittedAt) {
  if (compareTimestamp(admittedAt, change.observedAt) < 0) {
    throw new Error('Drive admission predates trusted change observation');
  }
  const ageMillis = Date.parse(admittedAt) - Date.parse(change.observedAt);
  if (ageMillis > binding.maxChangeAgeSeconds * 1000) {
    throw new Error('Drive change is stale for configured binding window');
  }
}

async function sourceEventIdFor(binding, change) {
  const fingerprint = await createSha256FingerprintV1(JSON.stringify([
    'chatgpt-autopilot-drive-change-event-v1',
    binding.providerId,
    binding.sourceBindingId,
    binding.watchId,
    binding.resourceId,
    binding.driveScopeId,
    change.changeToken,
  ]));
  return `drive:${fingerprint.slice('sha256:'.length)}`;
}

/**
 * Trusted Google Drive change-feed evidence -> canonical EventTrigger runtime.
 *
 * Network/watch callbacks, OAuth, page-token persistence, changes.list polling,
 * and Google Workspace provider behavior stay outside this module. The caller
 * supplies only an opaque requested change token. Trusted dependencies resolve
 * the exact watch binding and normalized change material before canonical
 * scheduler admission.
 */
export async function admitDriveChangeV1(value, dependencies) {
  const request = normalizeRequest(value);
  const deps = normalizeDependencies(dependencies);

  const binding = normalizeDriveWatchBindingV1(
    await deps.resolveDriveWatchBinding({
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

  const change = normalizeDriveChangeV1(
    await deps.resolveDriveChange({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      changeToken: request.changeToken,
    }),
  );
  assertChangeMatchesBinding(change, binding, request);
  assertFreshChange(binding, change, request.admittedAt);

  const sourceEventId = await sourceEventIdFor(binding, change);
  const observation = {
    schemaVersion: DRIVE_EVENT_TRIGGER_ADAPTER_VERSION,
    observationId: sourceEventId,
    triggerId: trigger.triggerId,
    triggerRevision: trigger.triggerRevision,
    providerId: trigger.providerId,
    sourceBindingId: trigger.sourceBindingId,
    sourceEventId,
    payloadArtifactRef: change.evidenceArtifactRef,
    observedAt: change.observedAt,
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
          throw new Error('Drive runtime requested unexpected trigger identity');
        }
        return trigger;
      },
      admitCanonicalOccurrence: deps.admitCanonicalOccurrence,
    },
  );

  return deepFreeze({
    ...runtime,
    driveBindingId: binding.bindingId,
    driveBindingRevision: binding.bindingRevision,
    driveWatchId: binding.watchId,
    driveResourceId: binding.resourceId,
    driveScopeId: binding.driveScopeId,
    driveChangeToken: change.changeToken,
    driveChangeKind: change.changeKind,
    driveFileId: change.fileId,
    driveChangeFresh: true,
    providerNetworkAuthority: false,
    watchAuthority: false,
    changeFeedCursorAuthority: false,
    credentialMaterialPersisted: false,
    rawDrivePathPersisted: false,
  });
}
