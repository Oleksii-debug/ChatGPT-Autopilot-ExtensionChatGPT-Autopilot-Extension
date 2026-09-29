export const SPECIALIST_AUTOMATION_POLICY_VERSION = 1;

const POLICY_KEYS = new Set([
  'schemaVersion',
  'revision',
  'enabled',
  'maxConcurrentHandoffs',
  'updatedAt',
]);

function snapshotExact(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function integer(value, label, min, max) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a timestamp`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

export function normalizeSpecialistAutomationPolicyV1(input) {
  const raw = snapshotExact(input, POLICY_KEYS, 'SpecialistAutomationPolicyV1');
  for (const key of POLICY_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error(`SpecialistAutomationPolicyV1 requires ${key}`);
    }
  }
  if (raw.schemaVersion !== SPECIALIST_AUTOMATION_POLICY_VERSION) {
    throw new Error('Unsupported SpecialistAutomationPolicyV1 schemaVersion');
  }
  if (typeof raw.enabled !== 'boolean') {
    throw new Error('SpecialistAutomationPolicyV1 enabled must be boolean');
  }
  return Object.freeze({
    schemaVersion: SPECIALIST_AUTOMATION_POLICY_VERSION,
    revision: integer(raw.revision, 'Specialist automation policy revision', 1, Number.MAX_SAFE_INTEGER),
    enabled: raw.enabled,
    maxConcurrentHandoffs: integer(
      raw.maxConcurrentHandoffs,
      'Specialist automation policy maxConcurrentHandoffs',
      0,
      256,
    ),
    updatedAt: timestamp(raw.updatedAt, 'Specialist automation policy updatedAt'),
  });
}

export function createSpecialistAutomationPolicyV1({
  revision,
  enabled,
  maxConcurrentHandoffs,
  updatedAt,
} = {}) {
  return normalizeSpecialistAutomationPolicyV1({
    schemaVersion: SPECIALIST_AUTOMATION_POLICY_VERSION,
    revision,
    enabled,
    maxConcurrentHandoffs,
    updatedAt,
  });
}
