import {
  OPENHANDS_CODING_PROVIDER_ID,
  normalizeOpenHandsCodingSpecialistConfigV1,
} from './coding-specialist-provider.js';

export const SPECIALIST_PROVIDER_CONFIG_VERSION = 1;

export const SpecialistProviderConfigKind = Object.freeze({
  OPENHANDS_AGENT_SERVER: 'OPENHANDS_AGENT_SERVER',
});

const RECORD_KEYS = new Set([
  'schemaVersion',
  'providerId',
  'kind',
  'revision',
  'config',
  'updatedAt',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function positiveRevision(value) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 1) {
    throw new Error('Specialist provider config revision is invalid');
  }
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error('Specialist provider config updatedAt must be canonical UTC');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error('Specialist provider config updatedAt must be canonical UTC');
  }
  return value;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function canonicalSpecialistProviderIdV1(value) {
  return exactId(value, 'providerId');
}

export function normalizeSpecialistProviderConfigV1(input) {
  const raw = record(input, RECORD_KEYS, 'SpecialistProviderConfigV1');
  for (const key of RECORD_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error('SpecialistProviderConfigV1 requires ' + key);
    }
  }
  if (raw.schemaVersion !== SPECIALIST_PROVIDER_CONFIG_VERSION) {
    throw new Error('Unsupported SpecialistProviderConfigV1 schemaVersion');
  }
  const providerId = canonicalSpecialistProviderIdV1(raw.providerId);
  if (raw.kind !== SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER) {
    throw new Error('Unsupported Specialist provider config kind');
  }
  if (providerId !== OPENHANDS_CODING_PROVIDER_ID) {
    throw new Error('OpenHands Specialist provider config has mismatched providerId');
  }
  const config = normalizeOpenHandsCodingSpecialistConfigV1(raw.config);
  return freeze({
    schemaVersion: SPECIALIST_PROVIDER_CONFIG_VERSION,
    providerId,
    kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
    revision: positiveRevision(raw.revision),
    config,
    updatedAt: timestamp(raw.updatedAt),
  });
}

export function createSpecialistProviderConfigV1({
  providerId,
  kind,
  config,
  revision = 1,
  updatedAt,
} = {}) {
  return normalizeSpecialistProviderConfigV1({
    schemaVersion: SPECIALIST_PROVIDER_CONFIG_VERSION,
    providerId,
    kind,
    revision,
    config,
    updatedAt,
  });
}
