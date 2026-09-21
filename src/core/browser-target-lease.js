const LEASE_VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function requiredId(value, label) {
  const out = String(value ?? '').trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function iso(value, label) {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

export function normalizeBrowserTargetLeaseV1(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('BrowserTargetLeaseV1 must be an object');
  const allowed = new Set(['schemaVersion', 'targetId', 'ownerInvocationId', 'leaseId', 'acquiredAt', 'expiresAt']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`BrowserTargetLeaseV1 contains unknown field: ${key}`);
  if (Number(input.schemaVersion) !== LEASE_VERSION) throw new Error('Unsupported BrowserTargetLeaseV1 schemaVersion');
  const acquiredAt = iso(input.acquiredAt, 'acquiredAt');
  const expiresAt = iso(input.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) throw new Error('expiresAt must be after acquiredAt');
  return Object.freeze({
    schemaVersion: LEASE_VERSION,
    targetId: requiredId(input.targetId, 'targetId'),
    ownerInvocationId: requiredId(input.ownerInvocationId, 'ownerInvocationId'),
    leaseId: requiredId(input.leaseId, 'leaseId'),
    acquiredAt,
    expiresAt,
  });
}

export function acquireBrowserTargetLeaseV1({ current = null, targetId, ownerInvocationId, leaseId, now, ttlMs = 30_000 } = {}) {
  const nowIso = iso(now, 'now');
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) throw new Error('ttlMs is invalid');
  const existing = current ? normalizeBrowserTargetLeaseV1(current) : null;
  if (existing && existing.targetId === String(targetId).trim() && Date.parse(existing.expiresAt) > Date.parse(nowIso)) {
    if (existing.ownerInvocationId !== String(ownerInvocationId).trim()) {
      return Object.freeze({ status: 'CONFLICT', lease: existing });
    }
    return Object.freeze({ status: 'HELD', lease: existing });
  }
  const lease = normalizeBrowserTargetLeaseV1({
    schemaVersion: LEASE_VERSION,
    targetId,
    ownerInvocationId,
    leaseId,
    acquiredAt: nowIso,
    expiresAt: new Date(Date.parse(nowIso) + ttlMs).toISOString(),
  });
  return Object.freeze({ status: existing ? 'REACQUIRED' : 'ACQUIRED', lease });
}

export function releaseBrowserTargetLeaseV1(current, { ownerInvocationId, leaseId } = {}) {
  const lease = normalizeBrowserTargetLeaseV1(current);
  if (lease.ownerInvocationId !== String(ownerInvocationId ?? '').trim() || lease.leaseId !== String(leaseId ?? '').trim()) {
    return Object.freeze({ status: 'NOT_OWNER', lease });
  }
  return Object.freeze({ status: 'RELEASED', lease: null });
}
