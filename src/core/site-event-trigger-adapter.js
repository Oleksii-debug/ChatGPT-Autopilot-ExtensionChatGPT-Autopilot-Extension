import { createSha256FingerprintV1 } from './fingerprint.js';
import {
  EventTriggerKind,
  normalizeEventTriggerDefinitionV1,
} from './event-trigger-contract.js';
import {
  admitEventTriggerObservationV1,
} from './event-trigger-runtime.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const SITE_EVENT_TRIGGER_ADAPTER_VERSION = 1;

export const SiteChangeKind = Object.freeze({
  RESOURCE_CREATED: 'RESOURCE_CREATED',
  RESOURCE_UPDATED: 'RESOURCE_UPDATED',
  RESOURCE_DELETED: 'RESOURCE_DELETED',
  SITE_STATE_CHANGED: 'SITE_STATE_CHANGED',
});

const CHANGE_KINDS = new Set(Object.values(SiteChangeKind));
const RESOURCE_CHANGE_KINDS = new Set([
  SiteChangeKind.RESOURCE_CREATED,
  SiteChangeKind.RESOURCE_UPDATED,
  SiteChangeKind.RESOURCE_DELETED,
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const TOKEN = /^[\x21-\x7e]{1,512}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CHANGE_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_CHANGE_KINDS = 8;

const REQUEST_KEYS = new Set([
  'bindingId',
  'bindingRevision',
  'changeId',
  'admittedAt',
]);
const DEPENDENCY_KEYS = new Set([
  'resolveTriggerDefinition',
  'resolveSiteMonitorBinding',
  'resolveSiteChange',
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
  'monitorId',
  'siteId',
  'resourceScopeId',
  'allowedChangeKinds',
  'maxChangeAgeSeconds',
  'createdAt',
]);
const CHANGE_KEYS = new Set([
  'schemaVersion',
  'bindingId',
  'bindingRevision',
  'monitorId',
  'siteId',
  'resourceScopeId',
  'changeId',
  'changeKind',
  'resourceId',
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

function strictArray(value, label, max = MAX_CHANGE_KINDS) {
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
      || value.includes('\\')
      || value.includes('"')
      || value.includes("'")) {
    throw new Error(`${label} must be bounded opaque ASCII without quotes or backslashes`);
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

function timestampMillis(value, label) {
  return Date.parse(canonicalTimestamp(value, label));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeChangeKinds(value) {
  const raw = strictArray(value, 'SiteMonitorBindingV1 allowedChangeKinds');
  if (!raw.length) {
    throw new Error('SiteMonitorBindingV1 allowedChangeKinds must not be empty');
  }
  const out = raw.map((item, index) => {
    if (typeof item !== 'string' || !CHANGE_KINDS.has(item)) {
      throw new Error(`SiteMonitorBindingV1 allowedChangeKinds[${index}] is invalid`);
    }
    return item;
  });
  if (new Set(out).size !== out.length) {
    throw new Error('SiteMonitorBindingV1 allowedChangeKinds contains duplicates');
  }
  return out;
}

function normalizeEvidenceArtifactRef(value) {
  const label = 'SiteChangeV1 evidenceArtifactRef';
  const raw = strictRecord(value, label, ARTIFACT_KEYS);
  requireKeys(raw, ARTIFACT_KEYS, label);

  if (raw.schemaVersion !== SITE_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error(`${label} schemaVersion must be numeric 1`);
  }
  if (raw.kind !== 'site-change-evidence') {
    throw new Error(`${label} kind must be site-change-evidence`);
  }
  if (raw.mediaType !== 'application/json') {
    throw new Error(`${label} mediaType must be application/json`);
  }
  if (typeof raw.uri !== 'string'
      || raw.uri !== raw.uri.trim()
      || !raw.uri.startsWith('artifact://')
      || raw.uri.length > 4096) {
    throw new Error(`${label} uri must be an opaque artifact:// URI`);
  }
  exactId(raw.artifactId, `${label} artifactId`);
  if (typeof raw.sha256 !== 'string'
      || raw.sha256 !== raw.sha256.trim()
      || !SHA256.test(raw.sha256)) {
    throw new Error(`${label} sha256 must be canonical lowercase SHA-256`);
  }
  if (!Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 1) {
    throw new Error(`${label} requires non-empty integer sizeBytes`);
  }
  canonicalTimestamp(raw.createdAt, `${label} createdAt`);
  if (raw.producerInvocationId != null && raw.producerInvocationId !== '') {
    exactId(raw.producerInvocationId, `${label} producerInvocationId`);
  }
  if (raw.sensitive !== true) {
    throw new Error(`${label} sensitive must be true`);
  }

  return normalizeArtifactRefV1(raw);
}

function normalizeRequest(value) {
  const label = 'Site trigger adapter request';
  const raw = strictRecord(value, label, REQUEST_KEYS);
  requireKeys(raw, REQUEST_KEYS, label);
  return {
    bindingId: exactId(raw.bindingId, 'Site trigger bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'Site trigger bindingRevision'),
    changeId: exactOpaqueToken(raw.changeId, 'Site changeId'),
    admittedAt: canonicalTimestamp(raw.admittedAt, 'Site admittedAt'),
  };
}

function normalizeDependencies(value) {
  const label = 'Site trigger adapter dependencies';
  const raw = strictRecord(value, label, DEPENDENCY_KEYS);
  requireKeys(raw, DEPENDENCY_KEYS, label);
  for (const key of DEPENDENCY_KEYS) {
    if (typeof raw[key] !== 'function') {
      throw new Error(`Site trigger adapter requires ${key}`);
    }
  }
  return raw;
}

export function normalizeSiteMonitorBindingV1(value) {
  const label = 'SiteMonitorBindingV1';
  const raw = strictRecord(value, label, BINDING_KEYS);
  requireKeys(raw, BINDING_KEYS, label);
  if (raw.schemaVersion !== SITE_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported SiteMonitorBindingV1 schemaVersion');
  }
  return deepFreeze({
    schemaVersion: SITE_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'SiteMonitorBindingV1 bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'SiteMonitorBindingV1 bindingRevision'),
    triggerId: exactId(raw.triggerId, 'SiteMonitorBindingV1 triggerId'),
    triggerRevision: positiveInteger(raw.triggerRevision, 'SiteMonitorBindingV1 triggerRevision'),
    providerId: exactId(raw.providerId, 'SiteMonitorBindingV1 providerId'),
    sourceBindingId: exactId(raw.sourceBindingId, 'SiteMonitorBindingV1 sourceBindingId'),
    monitorId: exactId(raw.monitorId, 'SiteMonitorBindingV1 monitorId'),
    siteId: exactId(raw.siteId, 'SiteMonitorBindingV1 siteId'),
    resourceScopeId: exactId(raw.resourceScopeId, 'SiteMonitorBindingV1 resourceScopeId'),
    allowedChangeKinds: normalizeChangeKinds(raw.allowedChangeKinds),
    maxChangeAgeSeconds: boundedPositiveInteger(
      raw.maxChangeAgeSeconds,
      'SiteMonitorBindingV1 maxChangeAgeSeconds',
      MAX_CHANGE_AGE_SECONDS,
    ),
    createdAt: canonicalTimestamp(raw.createdAt, 'SiteMonitorBindingV1 createdAt'),
  });
}

export function normalizeSiteChangeV1(value) {
  const label = 'SiteChangeV1';
  const raw = strictRecord(value, label, CHANGE_KEYS);
  requireKeys(raw, CHANGE_KEYS, label);
  if (raw.schemaVersion !== SITE_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported SiteChangeV1 schemaVersion');
  }
  if (typeof raw.changeKind !== 'string' || !CHANGE_KINDS.has(raw.changeKind)) {
    throw new Error('SiteChangeV1 changeKind is invalid');
  }

  const resourceId = exactId(raw.resourceId, 'SiteChangeV1 resourceId', { optional: true });
  if (RESOURCE_CHANGE_KINDS.has(raw.changeKind) && !resourceId) {
    throw new Error('SiteChangeV1 resource change requires resourceId');
  }
  if (!RESOURCE_CHANGE_KINDS.has(raw.changeKind) && resourceId) {
    throw new Error('SiteChangeV1 site-level change must not carry resourceId');
  }

  const evidenceArtifactRef = normalizeEvidenceArtifactRef(raw.evidenceArtifactRef);
  const observedAt = canonicalTimestamp(raw.observedAt, 'SiteChangeV1 observedAt');
  if (timestampMillis(evidenceArtifactRef.createdAt, 'SiteChangeV1 evidenceArtifactRef createdAt')
      > timestampMillis(observedAt, 'SiteChangeV1 observedAt')) {
    throw new Error('SiteChangeV1 evidence artifact cannot postdate observation');
  }

  return deepFreeze({
    schemaVersion: SITE_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'SiteChangeV1 bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'SiteChangeV1 bindingRevision'),
    monitorId: exactId(raw.monitorId, 'SiteChangeV1 monitorId'),
    siteId: exactId(raw.siteId, 'SiteChangeV1 siteId'),
    resourceScopeId: exactId(raw.resourceScopeId, 'SiteChangeV1 resourceScopeId'),
    changeId: exactOpaqueToken(raw.changeId, 'SiteChangeV1 changeId'),
    changeKind: raw.changeKind,
    resourceId,
    evidenceArtifactRef,
    observedAt,
  });
}

function assertBindingMatchesRequest(binding, request) {
  if (binding.bindingId !== request.bindingId
      || binding.bindingRevision !== request.bindingRevision) {
    throw new Error('Resolved Site binding does not match requested binding revision');
  }
}

function assertTriggerMatchesBinding(trigger, binding) {
  if (trigger.kind !== EventTriggerKind.SITE) {
    throw new Error('Site binding must resolve a SITE trigger');
  }
  for (const key of ['triggerId', 'triggerRevision', 'providerId', 'sourceBindingId']) {
    if (trigger[key] !== binding[key]) {
      throw new Error(`Site binding ${key} does not match trusted trigger definition`);
    }
  }
  if (timestampMillis(binding.createdAt, 'SiteMonitorBindingV1 createdAt')
      < timestampMillis(trigger.createdAt, 'EventTriggerDefinitionV1 createdAt')) {
    throw new Error('Site binding cannot predate its trusted trigger definition');
  }
}

function assertChangeMatchesBinding(change, binding, request) {
  for (const key of [
    'bindingId',
    'bindingRevision',
    'monitorId',
    'siteId',
    'resourceScopeId',
  ]) {
    if (change[key] !== binding[key]) {
      throw new Error(`Resolved Site change ${key} does not match trusted binding`);
    }
  }
  if (change.changeId !== request.changeId) {
    throw new Error('Resolved Site change does not match requested changeId');
  }
  if (!binding.allowedChangeKinds.includes(change.changeKind)) {
    throw new Error('Resolved Site change kind is not allowed by trusted binding');
  }
  if (timestampMillis(change.observedAt, 'SiteChangeV1 observedAt')
      < timestampMillis(binding.createdAt, 'SiteMonitorBindingV1 createdAt')) {
    throw new Error('Site change predates trusted binding');
  }
}

function assertFreshChange(binding, change, admittedAt) {
  const admittedMillis = timestampMillis(admittedAt, 'Site admittedAt');
  const observedMillis = timestampMillis(change.observedAt, 'SiteChangeV1 observedAt');
  if (admittedMillis < observedMillis) {
    throw new Error('Site admission predates trusted change observation');
  }
  if (admittedMillis - observedMillis > binding.maxChangeAgeSeconds * 1000) {
    throw new Error('Site change is stale for configured binding window');
  }
}

async function sourceEventIdFor(binding, change) {
  const fingerprint = await createSha256FingerprintV1(JSON.stringify([
    'chatgpt-autopilot-site-change-event-v1',
    binding.providerId,
    binding.sourceBindingId,
    binding.monitorId,
    binding.siteId,
    binding.resourceScopeId,
    change.changeId,
  ]));
  return `site:${fingerprint.slice('sha256:'.length)}`;
}

/**
 * Trusted site-monitor change evidence -> canonical EventTrigger runtime.
 *
 * Polling/crawling/browser/CMS transport, credential handling, monitor cursor
 * persistence, and site-adapter behavior stay outside this module. The caller
 * supplies only an exact binding revision and opaque monitor-issued change ID.
 */
export async function admitSiteChangeV1(value, dependencies) {
  const request = normalizeRequest(value);
  const deps = normalizeDependencies(dependencies);

  const binding = normalizeSiteMonitorBindingV1(
    await deps.resolveSiteMonitorBinding({
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

  const change = normalizeSiteChangeV1(
    await deps.resolveSiteChange({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      changeId: request.changeId,
    }),
  );
  assertChangeMatchesBinding(change, binding, request);
  assertFreshChange(binding, change, request.admittedAt);

  const sourceEventId = await sourceEventIdFor(binding, change);
  const observation = {
    schemaVersion: SITE_EVENT_TRIGGER_ADAPTER_VERSION,
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
          throw new Error('Site runtime requested unexpected trigger identity');
        }
        return trigger;
      },
      admitCanonicalOccurrence: deps.admitCanonicalOccurrence,
    },
  );

  return deepFreeze({
    ...runtime,
    siteBindingId: binding.bindingId,
    siteBindingRevision: binding.bindingRevision,
    siteMonitorId: binding.monitorId,
    siteId: binding.siteId,
    siteResourceScopeId: binding.resourceScopeId,
    siteChangeId: change.changeId,
    siteChangeKind: change.changeKind,
    siteResourceId: change.resourceId,
    siteChangeFresh: true,
    providerNetworkAuthority: false,
    sitePollingAuthority: false,
    browserAuthority: false,
    cmsAuthority: false,
    credentialMaterialPersisted: false,
    cookieMaterialPersisted: false,
    rawSiteUrlPersisted: false,
    rawSiteContentPersisted: false,
  });
}
