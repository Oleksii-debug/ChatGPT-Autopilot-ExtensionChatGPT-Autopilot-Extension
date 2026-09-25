import { createSha256FingerprintV1 } from './fingerprint.js';
import {
  EventTriggerKind,
  normalizeEventTriggerDefinitionV1,
} from './event-trigger-contract.js';
import { admitEventTriggerObservationV1 } from './event-trigger-runtime.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const API_EVENT_TRIGGER_ADAPTER_VERSION = 1;

export const ApiResourceChangeKind = Object.freeze({
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  DELETED: 'DELETED',
});

const CHANGE_KINDS = new Set(Object.values(ApiResourceChangeKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const OPAQUE = /^[\x21-\x7e]{1,2048}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const REQUEST_KEYS = new Set(['bindingId', 'bindingRevision', 'changeId', 'admittedAt']);
const DEPENDENCY_KEYS = new Set([
  'resolveTriggerDefinition',
  'resolveApiMonitorBinding',
  'resolveApiResourceChange',
  'admitCanonicalOccurrence',
]);
const BINDING_KEYS = new Set([
  'schemaVersion', 'bindingId', 'bindingRevision', 'triggerId', 'triggerRevision',
  'providerId', 'sourceBindingId', 'monitorId', 'resourceId',
  'maxChangeAgeSeconds', 'createdAt',
]);
const CHANGE_KEYS = new Set([
  'schemaVersion', 'bindingId', 'bindingRevision', 'monitorId', 'resourceId',
  'changeId', 'changeKind', 'previousVersion', 'currentVersion',
  'evidenceArtifactRef', 'observedAt',
]);
const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);

function record(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  let proto;
  try { proto = Object.getPrototypeOf(value); }
  catch { throw new Error(label + ' must be a plain object'); }
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' field ' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function requireKeys(raw, keys, label) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(label + '.' + key + ' is required');
    }
  }
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactOpaque(value, label, optional = false) {
  if (optional && (value === '' || value === null || value === undefined)) return '';
  if (typeof value !== 'string'
      || value !== value.trim()
      || !OPAQUE.test(value)) {
    throw new Error(label + ' must be bounded canonical opaque text');
  }
  return value;
}

function positiveInt(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(label + ' must be a positive safe integer');
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function artifactRef(value) {
  const label = 'ApiResourceChangeV1 evidenceArtifactRef';
  const raw = record(value, label, ARTIFACT_KEYS);
  requireKeys(raw, ARTIFACT_KEYS, label);
  if (raw.schemaVersion !== API_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error(label + ' schemaVersion must be numeric 1');
  }
  if (raw.kind !== 'api-change-evidence') {
    throw new Error(label + ' kind must be api-change-evidence');
  }
  if (raw.mediaType !== 'application/json') {
    throw new Error(label + ' mediaType must be application/json');
  }
  exactId(raw.artifactId, label + ' artifactId');
  if (typeof raw.uri !== 'string'
      || raw.uri !== raw.uri.trim()
      || !raw.uri.startsWith('artifact://')
      || raw.uri.length > 4096) {
    throw new Error(label + ' uri must be an opaque artifact:// URI');
  }
  if (typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
    throw new Error(label + ' sha256 must be canonical lowercase SHA-256');
  }
  if (!Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 1) {
    throw new Error(label + ' requires non-empty integer sizeBytes');
  }
  timestamp(raw.createdAt, label + ' createdAt');
  if (raw.producerInvocationId != null && raw.producerInvocationId !== '') {
    exactId(raw.producerInvocationId, label + ' producerInvocationId');
  }
  if (typeof raw.sensitive !== 'boolean') {
    throw new Error(label + ' sensitive must be explicit boolean');
  }
  return normalizeArtifactRefV1(raw);
}

function normalizeRequest(value) {
  const raw = record(value, 'API trigger adapter request', REQUEST_KEYS);
  requireKeys(raw, REQUEST_KEYS, 'API trigger adapter request');
  return {
    bindingId: exactId(raw.bindingId, 'API trigger bindingId'),
    bindingRevision: positiveInt(raw.bindingRevision, 'API trigger bindingRevision'),
    changeId: exactOpaque(raw.changeId, 'API changeId'),
    admittedAt: timestamp(raw.admittedAt, 'API admittedAt'),
  };
}

function normalizeDependencies(value) {
  const raw = record(value, 'API trigger adapter dependencies', DEPENDENCY_KEYS);
  requireKeys(raw, DEPENDENCY_KEYS, 'API trigger adapter dependencies');
  for (const key of DEPENDENCY_KEYS) {
    if (typeof raw[key] !== 'function') {
      throw new Error('API trigger adapter requires ' + key);
    }
  }
  return raw;
}

export function normalizeApiMonitorBindingV1(value) {
  const raw = record(value, 'ApiMonitorBindingV1', BINDING_KEYS);
  requireKeys(raw, BINDING_KEYS, 'ApiMonitorBindingV1');
  if (raw.schemaVersion !== API_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported ApiMonitorBindingV1 schemaVersion');
  }
  const maxChangeAgeSeconds = positiveInt(raw.maxChangeAgeSeconds, 'ApiMonitorBindingV1 maxChangeAgeSeconds');
  if (maxChangeAgeSeconds > MAX_AGE_SECONDS) {
    throw new Error('ApiMonitorBindingV1 maxChangeAgeSeconds exceeds supported maximum');
  }
  return freezeDeep({
    schemaVersion: API_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'ApiMonitorBindingV1 bindingId'),
    bindingRevision: positiveInt(raw.bindingRevision, 'ApiMonitorBindingV1 bindingRevision'),
    triggerId: exactId(raw.triggerId, 'ApiMonitorBindingV1 triggerId'),
    triggerRevision: positiveInt(raw.triggerRevision, 'ApiMonitorBindingV1 triggerRevision'),
    providerId: exactId(raw.providerId, 'ApiMonitorBindingV1 providerId'),
    sourceBindingId: exactId(raw.sourceBindingId, 'ApiMonitorBindingV1 sourceBindingId'),
    monitorId: exactId(raw.monitorId, 'ApiMonitorBindingV1 monitorId'),
    resourceId: exactId(raw.resourceId, 'ApiMonitorBindingV1 resourceId'),
    maxChangeAgeSeconds,
    createdAt: timestamp(raw.createdAt, 'ApiMonitorBindingV1 createdAt'),
  });
}

export function normalizeApiResourceChangeV1(value) {
  const raw = record(value, 'ApiResourceChangeV1', CHANGE_KEYS);
  requireKeys(raw, CHANGE_KEYS, 'ApiResourceChangeV1');
  if (raw.schemaVersion !== API_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported ApiResourceChangeV1 schemaVersion');
  }
  if (typeof raw.changeKind !== 'string' || !CHANGE_KINDS.has(raw.changeKind)) {
    throw new Error('ApiResourceChangeV1 changeKind is invalid');
  }

  const previousVersion = exactOpaque(raw.previousVersion, 'ApiResourceChangeV1 previousVersion', true);
  const currentVersion = exactOpaque(raw.currentVersion, 'ApiResourceChangeV1 currentVersion', true);
  if (raw.changeKind === ApiResourceChangeKind.CREATED) {
    if (previousVersion || !currentVersion) {
      throw new Error('ApiResourceChangeV1 CREATED requires empty previousVersion and non-empty currentVersion');
    }
  } else if (raw.changeKind === ApiResourceChangeKind.UPDATED) {
    if (!previousVersion || !currentVersion || previousVersion === currentVersion) {
      throw new Error('ApiResourceChangeV1 UPDATED requires distinct non-empty versions');
    }
  } else if (!previousVersion || currentVersion) {
    throw new Error('ApiResourceChangeV1 DELETED requires non-empty previousVersion and empty currentVersion');
  }

  const evidenceArtifactRef = artifactRef(raw.evidenceArtifactRef);
  const observedAt = timestamp(raw.observedAt, 'ApiResourceChangeV1 observedAt');
  if (evidenceArtifactRef.createdAt > observedAt) {
    throw new Error('ApiResourceChangeV1 evidence artifact cannot postdate observation');
  }

  return freezeDeep({
    schemaVersion: API_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'ApiResourceChangeV1 bindingId'),
    bindingRevision: positiveInt(raw.bindingRevision, 'ApiResourceChangeV1 bindingRevision'),
    monitorId: exactId(raw.monitorId, 'ApiResourceChangeV1 monitorId'),
    resourceId: exactId(raw.resourceId, 'ApiResourceChangeV1 resourceId'),
    changeId: exactOpaque(raw.changeId, 'ApiResourceChangeV1 changeId'),
    changeKind: raw.changeKind,
    previousVersion,
    currentVersion,
    evidenceArtifactRef,
    observedAt,
  });
}

function assertBindingRequest(binding, request) {
  if (binding.bindingId !== request.bindingId || binding.bindingRevision !== request.bindingRevision) {
    throw new Error('Resolved API binding does not match requested binding revision');
  }
}

function assertTriggerBinding(trigger, binding) {
  if (trigger.kind !== EventTriggerKind.API) throw new Error('API binding must resolve an API trigger');
  for (const key of ['triggerId', 'triggerRevision', 'providerId', 'sourceBindingId']) {
    if (trigger[key] !== binding[key]) {
      throw new Error('API binding ' + key + ' does not match trusted trigger definition');
    }
  }
  if (binding.createdAt < trigger.createdAt) {
    throw new Error('API binding cannot predate its trusted trigger definition');
  }
}

function assertChangeBinding(change, binding, request) {
  for (const key of ['bindingId', 'bindingRevision', 'monitorId', 'resourceId']) {
    if (change[key] !== binding[key]) {
      throw new Error('Resolved API change ' + key + ' does not match trusted binding');
    }
  }
  if (change.changeId !== request.changeId) {
    throw new Error('Resolved API change does not match requested changeId');
  }
  if (change.observedAt < binding.createdAt) {
    throw new Error('API change predates trusted binding');
  }
}

function assertFresh(binding, change, admittedAt) {
  if (admittedAt < change.observedAt) {
    throw new Error('API admission predates trusted change observation');
  }
  if (Date.parse(admittedAt) - Date.parse(change.observedAt) > binding.maxChangeAgeSeconds * 1000) {
    throw new Error('API change is stale for configured binding window');
  }
}

async function sourceEventIdFor(binding, change) {
  const fingerprint = await createSha256FingerprintV1(JSON.stringify([
    'chatgpt-autopilot-api-resource-change-event-v1',
    binding.providerId,
    binding.sourceBindingId,
    binding.monitorId,
    binding.resourceId,
    change.changeId,
  ]));
  return 'api:' + fingerprint.slice('sha256:'.length);
}

export async function admitApiResourceChangeV1(value, dependencies) {
  const request = normalizeRequest(value);
  const deps = normalizeDependencies(dependencies);

  const binding = normalizeApiMonitorBindingV1(await deps.resolveApiMonitorBinding({
    bindingId: request.bindingId,
    bindingRevision: request.bindingRevision,
  }));
  assertBindingRequest(binding, request);

  const trigger = normalizeEventTriggerDefinitionV1(await deps.resolveTriggerDefinition({
    triggerId: binding.triggerId,
    triggerRevision: binding.triggerRevision,
  }));
  assertTriggerBinding(trigger, binding);

  const change = normalizeApiResourceChangeV1(await deps.resolveApiResourceChange({
    bindingId: binding.bindingId,
    bindingRevision: binding.bindingRevision,
    changeId: request.changeId,
  }));
  assertChangeBinding(change, binding, request);
  assertFresh(binding, change, request.admittedAt);

  const sourceEventId = await sourceEventIdFor(binding, change);
  const runtime = await admitEventTriggerObservationV1(
    {
      trigger,
      observation: {
        schemaVersion: API_EVENT_TRIGGER_ADAPTER_VERSION,
        observationId: sourceEventId,
        triggerId: trigger.triggerId,
        triggerRevision: trigger.triggerRevision,
        providerId: trigger.providerId,
        sourceBindingId: trigger.sourceBindingId,
        sourceEventId,
        payloadArtifactRef: change.evidenceArtifactRef,
        observedAt: change.observedAt,
      },
      admittedAt: request.admittedAt,
    },
    {
      resolveTriggerDefinition: async ({ triggerId, triggerRevision }) => {
        if (triggerId !== trigger.triggerId || triggerRevision !== trigger.triggerRevision) {
          throw new Error('API runtime requested unexpected trigger identity');
        }
        return trigger;
      },
      admitCanonicalOccurrence: deps.admitCanonicalOccurrence,
    },
  );

  return freezeDeep({
    ...runtime,
    apiBindingId: binding.bindingId,
    apiBindingRevision: binding.bindingRevision,
    apiMonitorId: binding.monitorId,
    apiResourceId: binding.resourceId,
    apiChangeId: change.changeId,
    apiChangeKind: change.changeKind,
    apiPreviousVersion: change.previousVersion,
    apiCurrentVersion: change.currentVersion,
    apiChangeFresh: true,
    providerNetworkAuthority: false,
    pollingAuthority: false,
    credentialMaterialPersisted: false,
    endpointMaterialPersisted: false,
  });
}
