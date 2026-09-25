import {
  EventTriggerKind,
  normalizeEventTriggerDefinitionV1,
} from './event-trigger-contract.js';
import {
  admitEventTriggerObservationV1,
} from './event-trigger-runtime.js';

export const GITHUB_EVENT_TRIGGER_ADAPTER_VERSION = 1;

export const GitHubDeliveryVerificationStatus = Object.freeze({
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,99}$/u;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const MAX_EVENT_NAMES = 64;
const MAX_DELIVERY_AGE_SECONDS = 7 * 24 * 60 * 60;

const REQUEST_KEYS = new Set([
  'bindingId',
  'bindingRevision',
  'deliveryId',
  'admittedAt',
]);

const DEPENDENCY_KEYS = new Set([
  'resolveTriggerDefinition',
  'resolveGitHubEventBinding',
  'resolveVerifiedGitHubDelivery',
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
  'repositoryFullName',
  'hookId',
  'verificationProfileId',
  'allowedEventNames',
  'maxDeliveryAgeSeconds',
  'createdAt',
]);

const DELIVERY_KEYS = new Set([
  'schemaVersion',
  'bindingId',
  'bindingRevision',
  'deliveryId',
  'repositoryFullName',
  'hookId',
  'eventName',
  'verificationProfileId',
  'verificationStatus',
  'payloadArtifactRef',
  'receivedAt',
  'verifiedAt',
]);

const PAYLOAD_ARTIFACT_KEYS = new Set([
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
      throw new Error(`${label} field ${key} must be an enumerable own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function strictArray(value, label, max = MAX_EVENT_NAMES) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 1
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a non-empty bounded plain array`);
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

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactRepository(value, label) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || value.length > 201
      || !REPOSITORY.test(value)) {
    throw new Error(`${label} must be an exact repository full name`);
  }
  return value;
}

function eventName(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !EVENT_NAME.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function eventNames(value) {
  const raw = strictArray(value, 'GitHubEventBindingV1 allowedEventNames');
  const normalized = raw.map((item, index) => eventName(
    item,
    `GitHubEventBindingV1 allowedEventNames[${index}]`,
  ));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('GitHubEventBindingV1 allowedEventNames contains duplicates');
  }
  return Object.freeze(normalized);
}

function snapshotPayloadArtifactRef(value) {
  const raw = strictRecord(
    value,
    'VerifiedGitHubDeliveryV1 payloadArtifactRef',
    PAYLOAD_ARTIFACT_KEYS,
  );
  return Object.freeze({ ...raw });
}

function normalizeRequest(value) {
  const raw = strictRecord(value, 'GitHub trigger adapter request', REQUEST_KEYS);
  return Object.freeze({
    bindingId: exactId(raw.bindingId, 'GitHub trigger bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'GitHub trigger bindingRevision'),
    deliveryId: exactId(raw.deliveryId, 'GitHub deliveryId'),
    admittedAt: canonicalTimestamp(raw.admittedAt, 'GitHub admittedAt'),
  });
}

function normalizeDependencies(value) {
  const raw = strictRecord(value, 'GitHub trigger adapter dependencies', DEPENDENCY_KEYS);
  for (const key of DEPENDENCY_KEYS) {
    if (typeof raw[key] !== 'function') {
      throw new Error(`GitHub trigger adapter requires ${key}`);
    }
  }
  return raw;
}

export function normalizeGitHubEventBindingV1(value) {
  const raw = strictRecord(value, 'GitHubEventBindingV1', BINDING_KEYS);
  if (raw.schemaVersion !== GITHUB_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported GitHubEventBindingV1 schemaVersion');
  }
  return deepFreeze({
    schemaVersion: GITHUB_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'GitHubEventBindingV1 bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'GitHubEventBindingV1 bindingRevision'),
    triggerId: exactId(raw.triggerId, 'GitHubEventBindingV1 triggerId'),
    triggerRevision: positiveInteger(raw.triggerRevision, 'GitHubEventBindingV1 triggerRevision'),
    providerId: exactId(raw.providerId, 'GitHubEventBindingV1 providerId'),
    sourceBindingId: exactId(raw.sourceBindingId, 'GitHubEventBindingV1 sourceBindingId'),
    repositoryFullName: exactRepository(
      raw.repositoryFullName,
      'GitHubEventBindingV1 repositoryFullName',
    ),
    hookId: positiveInteger(raw.hookId, 'GitHubEventBindingV1 hookId'),
    verificationProfileId: exactId(
      raw.verificationProfileId,
      'GitHubEventBindingV1 verificationProfileId',
    ),
    allowedEventNames: eventNames(raw.allowedEventNames),
    maxDeliveryAgeSeconds: boundedPositiveInteger(
      raw.maxDeliveryAgeSeconds,
      'GitHubEventBindingV1 maxDeliveryAgeSeconds',
      MAX_DELIVERY_AGE_SECONDS,
    ),
    createdAt: canonicalTimestamp(raw.createdAt, 'GitHubEventBindingV1 createdAt'),
  });
}

function normalizeVerifiedGitHubDelivery(value) {
  const raw = strictRecord(value, 'VerifiedGitHubDeliveryV1', DELIVERY_KEYS);
  if (raw.schemaVersion !== GITHUB_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported VerifiedGitHubDeliveryV1 schemaVersion');
  }
  if (!Object.values(GitHubDeliveryVerificationStatus).includes(raw.verificationStatus)) {
    throw new Error('VerifiedGitHubDeliveryV1 verificationStatus is invalid');
  }
  const receivedAt = canonicalTimestamp(
    raw.receivedAt,
    'VerifiedGitHubDeliveryV1 receivedAt',
  );
  const verifiedAt = canonicalTimestamp(
    raw.verifiedAt,
    'VerifiedGitHubDeliveryV1 verifiedAt',
  );
  if (verifiedAt < receivedAt) {
    throw new Error('GitHub delivery verification cannot predate receipt');
  }
  return Object.freeze({
    schemaVersion: GITHUB_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'VerifiedGitHubDeliveryV1 bindingId'),
    bindingRevision: positiveInteger(
      raw.bindingRevision,
      'VerifiedGitHubDeliveryV1 bindingRevision',
    ),
    deliveryId: exactId(raw.deliveryId, 'VerifiedGitHubDeliveryV1 deliveryId'),
    repositoryFullName: exactRepository(
      raw.repositoryFullName,
      'VerifiedGitHubDeliveryV1 repositoryFullName',
    ),
    hookId: positiveInteger(raw.hookId, 'VerifiedGitHubDeliveryV1 hookId'),
    eventName: eventName(raw.eventName, 'VerifiedGitHubDeliveryV1 eventName'),
    verificationProfileId: exactId(
      raw.verificationProfileId,
      'VerifiedGitHubDeliveryV1 verificationProfileId',
    ),
    verificationStatus: raw.verificationStatus,
    payloadArtifactRef: snapshotPayloadArtifactRef(raw.payloadArtifactRef),
    receivedAt,
    verifiedAt,
  });
}

function assertBindingMatchesRequest(binding, request) {
  if (binding.bindingId !== request.bindingId
      || binding.bindingRevision !== request.bindingRevision) {
    throw new Error('Resolved GitHub event binding does not match requested binding revision');
  }
}

function assertTriggerMatchesBinding(trigger, binding) {
  if (trigger.kind !== EventTriggerKind.GITHUB) {
    throw new Error('GitHub event binding must resolve a GITHUB trigger');
  }
  for (const key of [
    'triggerId',
    'triggerRevision',
    'providerId',
    'sourceBindingId',
  ]) {
    if (trigger[key] !== binding[key]) {
      throw new Error(`GitHub event binding ${key} does not match trusted trigger definition`);
    }
  }
  if (binding.createdAt < trigger.createdAt) {
    throw new Error('GitHub event binding cannot predate its trusted trigger definition');
  }
}

function assertDeliveryMatchesBinding(delivery, binding, request) {
  if (delivery.bindingId !== binding.bindingId
      || delivery.bindingRevision !== binding.bindingRevision
      || delivery.deliveryId !== request.deliveryId) {
    throw new Error('Resolved GitHub delivery does not match requested binding/delivery identity');
  }
  if (delivery.repositoryFullName !== binding.repositoryFullName) {
    throw new Error('GitHub delivery repository does not match trusted binding');
  }
  if (delivery.hookId !== binding.hookId) {
    throw new Error('GitHub delivery hookId does not match trusted binding');
  }
  if (!binding.allowedEventNames.includes(delivery.eventName)) {
    throw new Error('GitHub delivery event is not allowed by trusted binding');
  }
  if (delivery.verificationProfileId !== binding.verificationProfileId) {
    throw new Error('GitHub delivery verification profile does not match trusted binding');
  }
  if (delivery.verificationStatus !== GitHubDeliveryVerificationStatus.VERIFIED) {
    throw new Error('GitHub delivery is not cryptographically verified');
  }
  if (delivery.receivedAt < binding.createdAt) {
    throw new Error('GitHub delivery predates trusted binding');
  }
}

function assertFreshDelivery(binding, delivery, admittedAt) {
  if (admittedAt < delivery.verifiedAt) {
    throw new Error('GitHub admission predates trusted verification');
  }
  const ageMillis = Date.parse(admittedAt) - Date.parse(delivery.receivedAt);
  if (ageMillis > binding.maxDeliveryAgeSeconds * 1000) {
    throw new Error('GitHub delivery is stale for configured binding window');
  }
}

/**
 * Provider-specific, non-authorizing GitHub webhook ingress adapter.
 *
 * HMAC verification and secret handling remain upstream. The adapter resolves
 * only trusted verification evidence, binds the official delivery identity,
 * event name, repository and hook to one GITHUB trigger revision, and then
 * delegates dedup/material-conflict/scheduler semantics to EventTriggerRuntime.
 */
export async function admitVerifiedGitHubDeliveryV1(value, dependencies) {
  const request = normalizeRequest(value);
  const deps = normalizeDependencies(dependencies);

  const binding = normalizeGitHubEventBindingV1(
    await deps.resolveGitHubEventBinding({
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

  const delivery = normalizeVerifiedGitHubDelivery(
    await deps.resolveVerifiedGitHubDelivery({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      deliveryId: request.deliveryId,
    }),
  );
  assertDeliveryMatchesBinding(delivery, binding, request);
  assertFreshDelivery(binding, delivery, request.admittedAt);

  const observation = {
    schemaVersion: GITHUB_EVENT_TRIGGER_ADAPTER_VERSION,
    observationId: delivery.deliveryId,
    triggerId: trigger.triggerId,
    triggerRevision: trigger.triggerRevision,
    providerId: trigger.providerId,
    sourceBindingId: trigger.sourceBindingId,
    sourceEventId: delivery.deliveryId,
    payloadArtifactRef: delivery.payloadArtifactRef,
    observedAt: delivery.receivedAt,
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
          throw new Error('GitHub runtime requested unexpected trigger identity');
        }
        return trigger;
      },
      admitCanonicalOccurrence: deps.admitCanonicalOccurrence,
    },
  );

  return deepFreeze({
    ...runtime,
    githubBindingId: binding.bindingId,
    githubBindingRevision: binding.bindingRevision,
    githubDeliveryId: delivery.deliveryId,
    githubRepositoryFullName: binding.repositoryFullName,
    githubHookId: binding.hookId,
    githubEventName: delivery.eventName,
    githubVerificationProfileId: binding.verificationProfileId,
    githubSignatureVerified: true,
    githubDeliveryFresh: true,
    providerNetworkAuthority: false,
    signatureMaterialPersisted: false,
    credentialMaterialPersisted: false,
  });
}
