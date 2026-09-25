const LEASE_VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function plainRecord(value, label) {
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
    if (typeof key !== 'string') {
      throw new Error(`${label} must not contain symbol fields`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
  }
}

function requiredId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function iso(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a timestamp`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  const canonical = new Date(ms).toISOString();
  if (value !== canonical) {
    throw new Error(`${label} must be an exact canonical UTC timestamp`);
  }
  return value;
}

export function normalizeBrowserTargetLeaseV1(input) {
  const raw = plainRecord(input, 'BrowserTargetLeaseV1');
  const allowed = new Set(['schemaVersion', 'targetId', 'ownerInvocationId', 'leaseId', 'acquiredAt', 'expiresAt']);
  exactKeys(raw, allowed, 'BrowserTargetLeaseV1');
  if (raw.schemaVersion !== LEASE_VERSION) throw new Error('Unsupported BrowserTargetLeaseV1 schemaVersion');
  const acquiredAt = iso(raw.acquiredAt, 'acquiredAt');
  const expiresAt = iso(raw.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) throw new Error('expiresAt must be after acquiredAt');
  return Object.freeze({
    schemaVersion: LEASE_VERSION,
    targetId: requiredId(raw.targetId, 'targetId'),
    ownerInvocationId: requiredId(raw.ownerInvocationId, 'ownerInvocationId'),
    leaseId: requiredId(raw.leaseId, 'leaseId'),
    acquiredAt,
    expiresAt,
  });
}

export function acquireBrowserTargetLeaseV1({ current = null, targetId, ownerInvocationId, leaseId, now, ttlMs = 30_000 } = {}) {
  const nowIso = iso(now, 'now');
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) throw new Error('ttlMs is invalid');
  const requestedTargetId = requiredId(targetId, 'targetId');
  const requestedOwnerInvocationId = requiredId(ownerInvocationId, 'ownerInvocationId');
  const requestedLeaseId = requiredId(leaseId, 'leaseId');
  const existing = current ? normalizeBrowserTargetLeaseV1(current) : null;
  if (existing && Date.parse(existing.expiresAt) > Date.parse(nowIso)) {
    if (existing.targetId !== requestedTargetId) {
      return Object.freeze({ status: 'CONFLICT', lease: existing });
    }
    if (existing.ownerInvocationId !== requestedOwnerInvocationId) {
      return Object.freeze({ status: 'CONFLICT', lease: existing });
    }
    return Object.freeze({ status: 'HELD', lease: existing });
  }
  const lease = normalizeBrowserTargetLeaseV1({
    schemaVersion: LEASE_VERSION,
    targetId: requestedTargetId,
    ownerInvocationId: requestedOwnerInvocationId,
    leaseId: requestedLeaseId,
    acquiredAt: nowIso,
    expiresAt: new Date(Date.parse(nowIso) + ttlMs).toISOString(),
  });
  return Object.freeze({ status: existing ? 'REACQUIRED' : 'ACQUIRED', lease });
}

export function releaseBrowserTargetLeaseV1(current, { ownerInvocationId, leaseId } = {}) {
  const lease = normalizeBrowserTargetLeaseV1(current);
  const requestedOwnerInvocationId = requiredId(ownerInvocationId, 'ownerInvocationId');
  const requestedLeaseId = requiredId(leaseId, 'leaseId');
  if (lease.ownerInvocationId !== requestedOwnerInvocationId || lease.leaseId !== requestedLeaseId) {
    return Object.freeze({ status: 'NOT_OWNER', lease });
  }
  return Object.freeze({ status: 'RELEASED', lease: null });
}
