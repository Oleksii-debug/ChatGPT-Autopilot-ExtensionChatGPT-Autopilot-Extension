import {
  EventTriggerKind,
  normalizeEventTriggerDefinitionV1,
} from './event-trigger-contract.js';
import {
  admitEventTriggerObservationV1,
} from './event-trigger-runtime.js';

export const WEBHOOK_EVENT_TRIGGER_ADAPTER_VERSION = 1;

export const WebhookVerificationStatus = Object.freeze({
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_DELIVERY_AGE_SECONDS = 7 * 24 * 60 * 60;

const REQUEST_KEYS = new Set([
  'bindingId',
  'bindingRevision',
  'deliveryId',
  'admittedAt',
]);

const DEPENDENCY_KEYS = new Set([
  'resolveTriggerDefinition',
  'resolveWebhookBinding',
  'resolveVerifiedWebhookDelivery',
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
  'verificationProfileId',
  'maxDeliveryAgeSeconds',
  'createdAt',
]);

const DELIVERY_KEYS = new Set([
  'schemaVersion',
  'bindingId',
  'bindingRevision',
  'deliveryId',
  'providerEventId',
  'verificationProfileId',
  'verificationStatus',
  'payloadArtifactRef',
  'receivedAt',
  'verifiedAt',
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

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
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

function normalizeRequest(value) {
  const raw = strictRecord(value, 'Webhook trigger adapter request', REQUEST_KEYS);
  return {
    bindingId: exactId(raw.bindingId, 'Webhook trigger bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'Webhook trigger bindingRevision'),
    deliveryId: exactId(raw.deliveryId, 'Webhook deliveryId'),
    admittedAt: canonicalTimestamp(raw.admittedAt, 'Webhook admittedAt'),
  };
}

function normalizeDependencies(value) {
  const raw = strictRecord(value, 'Webhook trigger adapter dependencies', DEPENDENCY_KEYS);
  for (const key of DEPENDENCY_KEYS) {
    if (typeof raw[key] !== 'function') {
      throw new Error(`Webhook trigger adapter requires ${key}`);
    }
  }
  return raw;
}

export function normalizeWebhookBindingV1(value) {
  const raw = strictRecord(value, 'WebhookBindingV1', BINDING_KEYS);
  if (raw.schemaVersion !== WEBHOOK_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported WebhookBindingV1 schemaVersion');
  }
  return deepFreeze({
    schemaVersion: WEBHOOK_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'WebhookBindingV1 bindingId'),
    bindingRevision: positiveInteger(raw.bindingRevision, 'WebhookBindingV1 bindingRevision'),
    triggerId: exactId(raw.triggerId, 'WebhookBindingV1 triggerId'),
    triggerRevision: positiveInteger(raw.triggerRevision, 'WebhookBindingV1 triggerRevision'),
    providerId: exactId(raw.providerId, 'WebhookBindingV1 providerId'),
    sourceBindingId: exactId(raw.sourceBindingId, 'WebhookBindingV1 sourceBindingId'),
    verificationProfileId: exactId(
      raw.verificationProfileId,
      'WebhookBindingV1 verificationProfileId',
    ),
    maxDeliveryAgeSeconds: boundedPositiveInteger(
      raw.maxDeliveryAgeSeconds,
      'WebhookBindingV1 maxDeliveryAgeSeconds',
      MAX_DELIVERY_AGE_SECONDS,
    ),
    createdAt: canonicalTimestamp(raw.createdAt, 'WebhookBindingV1 createdAt'),
  });
}

export function normalizeVerifiedWebhookDeliveryV1(value) {
  const raw = strictRecord(value, 'VerifiedWebhookDeliveryV1', DELIVERY_KEYS);
  if (raw.schemaVersion !== WEBHOOK_EVENT_TRIGGER_ADAPTER_VERSION) {
    throw new Error('Unsupported VerifiedWebhookDeliveryV1 schemaVersion');
  }
  if (!Object.values(WebhookVerificationStatus).includes(raw.verificationStatus)) {
    throw new Error('VerifiedWebhookDeliveryV1 verificationStatus is invalid');
  }

  const receivedAt = canonicalTimestamp(raw.receivedAt, 'VerifiedWebhookDeliveryV1 receivedAt');
  const verifiedAt = canonicalTimestamp(raw.verifiedAt, 'VerifiedWebhookDeliveryV1 verifiedAt');
  if (verifiedAt < receivedAt) {
    throw new Error('Webhook verification cannot predate receipt');
  }

  return deepFreeze({
    schemaVersion: WEBHOOK_EVENT_TRIGGER_ADAPTER_VERSION,
    bindingId: exactId(raw.bindingId, 'VerifiedWebhookDeliveryV1 bindingId'),
    bindingRevision: positiveInteger(
      raw.bindingRevision,
      'VerifiedWebhookDeliveryV1 bindingRevision',
    ),
    deliveryId: exactId(raw.deliveryId, 'VerifiedWebhookDeliveryV1 deliveryId'),
    providerEventId: exactId(
      raw.providerEventId,
      'VerifiedWebhookDeliveryV1 providerEventId',
    ),
    verificationProfileId: exactId(
      raw.verificationProfileId,
      'VerifiedWebhookDeliveryV1 verificationProfileId',
    ),
    verificationStatus: raw.verificationStatus,
    payloadArtifactRef: raw.payloadArtifactRef,
    receivedAt,
    verifiedAt,
  });
}

function assertBindingMatchesRequest(binding, request) {
  if (binding.bindingId !== request.bindingId
      || binding.bindingRevision !== request.bindingRevision) {
    throw new Error('Resolved webhook binding does not match requested binding revision');
  }
}

function assertTriggerMatchesBinding(trigger, binding) {
  if (trigger.kind !== EventTriggerKind.WEBHOOK) {
    throw new Error('Webhook binding must resolve a WEBHOOK trigger');
  }
  for (const key of [
    'triggerId',
    'triggerRevision',
    'providerId',
    'sourceBindingId',
  ]) {
    if (trigger[key] !== binding[key]) {
      throw new Error(`Webhook binding ${key} does not match trusted trigger definition`);
    }
  }
  if (binding.createdAt < trigger.createdAt) {
    throw new Error('Webhook binding cannot predate its trusted trigger definition');
  }
}

function assertDeliveryMatchesBinding(delivery, binding, request) {
  if (delivery.bindingId !== binding.bindingId
      || delivery.bindingRevision !== binding.bindingRevision
      || delivery.deliveryId !== request.deliveryId) {
    throw new Error('Resolved webhook delivery does not match requested binding/delivery identity');
  }
  if (delivery.verificationProfileId !== binding.verificationProfileId) {
    throw new Error('Webhook delivery verification profile does not match trusted binding');
  }
  if (delivery.verificationStatus !== WebhookVerificationStatus.VERIFIED) {
    throw new Error('Webhook delivery is not cryptographically verified');
  }
  if (delivery.receivedAt < binding.createdAt) {
    throw new Error('Webhook delivery predates trusted binding');
  }
}

function assertFreshDelivery(binding, delivery, admittedAt) {
  if (admittedAt < delivery.verifiedAt) {
    throw new Error('Webhook admission predates trusted verification');
  }
  const ageMillis = Date.parse(admittedAt) - Date.parse(delivery.receivedAt);
  if (ageMillis > binding.maxDeliveryAgeSeconds * 1000) {
    throw new Error('Webhook delivery is stale for configured binding window');
  }
}

/**
 * Provider-specific, non-authorizing webhook ingress adapter.
 *
 * The network listener and signature/credential machinery stay outside this
 * module. This adapter accepts only exact evidence returned by trusted
 * resolvers, binds it to the canonical webhook trigger revision, and delegates
 * occurrence/dedup/material-conflict handling to EventTriggerRuntimeV1.
 */
export async function admitVerifiedWebhookDeliveryV1(value, dependencies) {
  const request = normalizeRequest(value);
  const deps = normalizeDependencies(dependencies);

  const binding = normalizeWebhookBindingV1(
    await deps.resolveWebhookBinding({
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

  const delivery = normalizeVerifiedWebhookDeliveryV1(
    await deps.resolveVerifiedWebhookDelivery({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      deliveryId: request.deliveryId,
    }),
  );
  assertDeliveryMatchesBinding(delivery, binding, request);
  assertFreshDelivery(binding, delivery, request.admittedAt);

  const observation = {
    schemaVersion: WEBHOOK_EVENT_TRIGGER_ADAPTER_VERSION,
    observationId: delivery.deliveryId,
    triggerId: trigger.triggerId,
    triggerRevision: trigger.triggerRevision,
    providerId: trigger.providerId,
    sourceBindingId: trigger.sourceBindingId,
    sourceEventId: delivery.providerEventId,
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
          throw new Error('Webhook runtime requested unexpected trigger identity');
        }
        return trigger;
      },
      admitCanonicalOccurrence: deps.admitCanonicalOccurrence,
    },
  );

  return deepFreeze({
    ...runtime,
    webhookBindingId: binding.bindingId,
    webhookBindingRevision: binding.bindingRevision,
    webhookDeliveryId: delivery.deliveryId,
    webhookVerificationProfileId: binding.verificationProfileId,
    webhookVerified: true,
    webhookDeliveryFresh: true,
    providerNetworkAuthority: false,
    signatureMaterialPersisted: false,
    credentialMaterialPersisted: false,
  });
}
