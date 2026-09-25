/**
 * Bounded specialist assignments are an execution contract, not a scheduler.
 * A caller persists the returned assignments in the existing durable control
 * plane and wakes reconciliation from real completion events.
 */
export const SPECIALIST_ASSIGNMENT_VERSION = 1;

export const SpecialistAssignmentState = Object.freeze({
  READY: 'READY',
  LEASED: 'LEASED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

const STATES = new Set(Object.values(SpecialistAssignmentState));
const TERMINAL = new Set([SpecialistAssignmentState.COMPLETED, SpecialistAssignmentState.FAILED, SpecialistAssignmentState.CANCELLED]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function exact(value, keys, label) { for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${label} contains unknown field: ${key}`); }
function id(value, label, optional = false) { if (optional && (value == null || value === '')) return ''; const out = String(value ?? '').trim(); if (!ID.test(out)) throw new Error(`${label} is invalid`); return out; }
function text(value, label, max = 8000) { const out = typeof value === 'string' ? value.trim() : ''; if (!out || out.length > max) throw new Error(`${label} is invalid`); return out; }
function timestamp(value, label) { if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error(`${label} must be a timestamp`); const ms = Date.parse(value); if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error(`${label} must use canonical ISO-8601 UTC representation`); return value; }
function integer(value, label, min, max) { const out = Number(value); if (!Number.isInteger(out) || out < min || out > max) throw new Error(`${label} is invalid`); return out; }
function ids(value, label, max = 128) { if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`); const out = value.map((item, index) => id(item, `${label}[${index}]`)); if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`); return out; }
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); }

const KEYS = new Set(['schemaVersion', 'agentId', 'parentAgentId', 'jobId', 'purpose', 'specialistId', 'requestedCapabilityIds', 'ownershipKey', 'depth', 'priority', 'state', 'leaseId', 'leaseExpiresAt', 'deadlineAt', 'resultArtifactIds', 'updatedAt']);

export function normalizeSpecialistAssignmentV1(raw) {
  object(raw, 'SpecialistAssignmentV1'); exact(raw, KEYS, 'SpecialistAssignmentV1');
  if (Number(raw.schemaVersion) !== SPECIALIST_ASSIGNMENT_VERSION) throw new Error('Unsupported SpecialistAssignmentV1 schemaVersion');
  const depth = integer(raw.depth, 'Specialist assignment depth', 1, 8);
  const parentAgentId = id(raw.parentAgentId, 'Specialist assignment parentAgentId', depth === 1);
  if (depth > 1 && !parentAgentId) throw new Error('Nested specialist assignment requires parentAgentId');
  const state = String(raw.state || '').toUpperCase();
  if (!STATES.has(state)) throw new Error('Specialist assignment state is invalid');
  const leaseId = id(raw.leaseId, 'Specialist assignment leaseId', true);
  const leaseExpiresAt = raw.leaseExpiresAt == null || raw.leaseExpiresAt === '' ? '' : timestamp(raw.leaseExpiresAt, 'Specialist assignment leaseExpiresAt');
  if (state === SpecialistAssignmentState.LEASED && (!leaseId || !leaseExpiresAt)) throw new Error('Leased specialist assignment requires lease');
  if (state !== SpecialistAssignmentState.LEASED && (leaseId || leaseExpiresAt)) throw new Error('Only leased specialist assignment may hold a lease');
  return freeze({
    schemaVersion: SPECIALIST_ASSIGNMENT_VERSION,
    agentId: id(raw.agentId, 'Specialist assignment agentId'),
    parentAgentId,
    jobId: id(raw.jobId, 'Specialist assignment jobId'),
    purpose: text(raw.purpose, 'Specialist assignment purpose', 50_000),
    specialistId: id(raw.specialistId, 'Specialist assignment specialistId'),
    requestedCapabilityIds: ids(raw.requestedCapabilityIds, 'Specialist assignment requestedCapabilityIds'),
    ownershipKey: id(raw.ownershipKey, 'Specialist assignment ownershipKey'),
    depth,
    priority: integer(raw.priority, 'Specialist assignment priority', 0, 1_000_000),
    state,
    leaseId,
    leaseExpiresAt,
    deadlineAt: timestamp(raw.deadlineAt, 'Specialist assignment deadlineAt'),
    resultArtifactIds: ids(raw.resultArtifactIds || [], 'Specialist assignment resultArtifactIds'),
    updatedAt: timestamp(raw.updatedAt, 'Specialist assignment updatedAt'),
  });
}

/** Claims at most the existing control plane's free capacity.  It deliberately
 * does not create timers, retries, or a second execution loop. */
export function claimEligibleSpecialistAssignmentsV1(rawAssignments, {
  now = new Date().toISOString(), maxDepth = 2, maxChildrenPerAgent = 4, availableSlots = 0, leaseSeconds = 900,
} = {}) {
  if (!Array.isArray(rawAssignments) || rawAssignments.length > 256) throw new Error('Specialist assignments must be a bounded array');
  const at = timestamp(now, 'now');
  const nowMs = Date.parse(at);
  const assignments = rawAssignments.map(normalizeSpecialistAssignmentV1).map(item => structuredClone(item));
  if (new Set(assignments.map(item => item.agentId)).size !== assignments.length) throw new Error('Specialist assignments contain duplicate agentId');
  const children = new Map();
  for (const item of assignments) if (item.parentAgentId) children.set(item.parentAgentId, (children.get(item.parentAgentId) || 0) + 1);
  for (const [parent, count] of children) if (count > maxChildrenPerAgent) throw new Error(`Specialist assignment child limit exceeded for ${parent}`);
  const slots = integer(availableSlots, 'Specialist availableSlots', 0, 256);
  const maxAllowedDepth = integer(maxDepth, 'Specialist maxDepth', 1, 8);
  const seconds = integer(leaseSeconds, 'Specialist leaseSeconds', 1, 86_400);
  const candidates = assignments.filter(item => !TERMINAL.has(item.state) && item.depth <= maxAllowedDepth && item.deadlineAt > at && (
    item.state === SpecialistAssignmentState.READY || (item.state === SpecialistAssignmentState.LEASED && Date.parse(item.leaseExpiresAt) <= nowMs)
  )).sort((a, b) => b.priority - a.priority || a.updatedAt.localeCompare(b.updatedAt) || a.agentId.localeCompare(b.agentId));
  const claimedIds = new Set(candidates.slice(0, slots).map(item => item.agentId));
  const leaseExpiresAt = new Date(nowMs + seconds * 1000).toISOString();
  const claimed = [];
  for (const item of assignments) {
    if (!claimedIds.has(item.agentId)) continue;
    item.state = SpecialistAssignmentState.LEASED;
    item.leaseId = `lease:${item.agentId}:${nowMs}`;
    item.leaseExpiresAt = leaseExpiresAt;
    item.updatedAt = at;
    claimed.push(item.agentId);
  }
  return freeze({ assignments: assignments.map(normalizeSpecialistAssignmentV1), claimed });
}
