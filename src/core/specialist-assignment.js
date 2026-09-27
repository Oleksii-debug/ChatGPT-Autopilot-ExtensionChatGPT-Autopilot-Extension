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
const TERMINAL = new Set([
  SpecialistAssignmentState.COMPLETED,
  SpecialistAssignmentState.FAILED,
  SpecialistAssignmentState.CANCELLED,
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const KEYS = new Set([
  'schemaVersion', 'agentId', 'parentAgentId', 'jobId', 'purpose',
  'specialistId', 'requestedCapabilityIds', 'ownershipKey', 'depth',
  'priority', 'state', 'leaseId', 'leaseExpiresAt', 'deadlineAt',
  'resultArtifactIds', 'updatedAt',
]);
const CLAIM_OPTION_KEYS = new Set([
  'now', 'maxDepth', 'maxChildrenPerAgent', 'availableSlots', 'leaseSeconds',
]);

function record(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || Object.is(length, -0) || length < 0 || length > max) {
    throw new Error(`${label} must be a canonical bounded array`);
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-canonical array fields`);
    }
  }
  const output = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    output[index] = descriptor.value;
  }
  return output;
}

function id(value, label, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function text(value, label, max = 8000) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output || output.length > max) throw new Error(`${label} is invalid`);
  return output;
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

function integer(value, label, min, max) {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < min
    || value > max
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function ids(value, label, max = 128) {
  const input = denseArray(value, label, max);
  const output = input.map((item, index) => id(item, `${label}[${index}]`));
  if (new Set(output).size !== output.length) throw new Error(`${label} contains duplicates`);
  return output;
}

function compareExactText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function normalizeSpecialistAssignmentV1(input) {
  const raw = record(input, KEYS, 'SpecialistAssignmentV1');
  if (raw.schemaVersion !== SPECIALIST_ASSIGNMENT_VERSION) {
    throw new Error('Unsupported SpecialistAssignmentV1 schemaVersion');
  }

  const depth = integer(raw.depth, 'Specialist assignment depth', 1, 8);
  const parentAgentId = id(
    raw.parentAgentId,
    'Specialist assignment parentAgentId',
    depth === 1,
  );
  if (depth > 1 && !parentAgentId) {
    throw new Error('Nested specialist assignment requires parentAgentId');
  }

  if (typeof raw.state !== 'string' || !STATES.has(raw.state)) {
    throw new Error('Specialist assignment state is invalid');
  }
  const state = raw.state;
  const leaseId = id(raw.leaseId, 'Specialist assignment leaseId', true);
  const leaseExpiresAt = raw.leaseExpiresAt === undefined
    || raw.leaseExpiresAt === null
    || raw.leaseExpiresAt === ''
    ? ''
    : timestamp(raw.leaseExpiresAt, 'Specialist assignment leaseExpiresAt');

  if (state === SpecialistAssignmentState.LEASED && (!leaseId || !leaseExpiresAt)) {
    throw new Error('Leased specialist assignment requires lease');
  }
  if (state !== SpecialistAssignmentState.LEASED && (leaseId || leaseExpiresAt)) {
    throw new Error('Only leased specialist assignment may hold a lease');
  }

  const resultArtifactIds = raw.resultArtifactIds === undefined || raw.resultArtifactIds === null
    ? []
    : raw.resultArtifactIds;

  return freeze({
    schemaVersion: SPECIALIST_ASSIGNMENT_VERSION,
    agentId: id(raw.agentId, 'Specialist assignment agentId'),
    parentAgentId,
    jobId: id(raw.jobId, 'Specialist assignment jobId'),
    purpose: text(raw.purpose, 'Specialist assignment purpose', 50_000),
    specialistId: id(raw.specialistId, 'Specialist assignment specialistId'),
    requestedCapabilityIds: ids(
      raw.requestedCapabilityIds,
      'Specialist assignment requestedCapabilityIds',
    ),
    ownershipKey: id(raw.ownershipKey, 'Specialist assignment ownershipKey'),
    depth,
    priority: integer(raw.priority, 'Specialist assignment priority', 0, 1_000_000),
    state,
    leaseId,
    leaseExpiresAt,
    deadlineAt: timestamp(raw.deadlineAt, 'Specialist assignment deadlineAt'),
    resultArtifactIds: ids(resultArtifactIds, 'Specialist assignment resultArtifactIds'),
    updatedAt: timestamp(raw.updatedAt, 'Specialist assignment updatedAt'),
  });
}

/** Claims at most the existing control plane's free capacity.  It deliberately
 * does not create timers, retries, or a second execution loop. */
export function claimEligibleSpecialistAssignmentsV1(rawAssignments, rawOptions = {}) {
  const request = record(rawOptions, CLAIM_OPTION_KEYS, 'Specialist claim options');
  const at = timestamp(
    request.now === undefined ? new Date().toISOString() : request.now,
    'now',
  );
  const maxAllowedDepth = integer(
    request.maxDepth === undefined ? 2 : request.maxDepth,
    'Specialist maxDepth',
    1,
    8,
  );
  const maxChildrenPerAgent = integer(
    request.maxChildrenPerAgent === undefined ? 4 : request.maxChildrenPerAgent,
    'Specialist maxChildrenPerAgent',
    0,
    256,
  );
  const slots = integer(
    request.availableSlots === undefined ? 0 : request.availableSlots,
    'Specialist availableSlots',
    0,
    256,
  );
  const seconds = integer(
    request.leaseSeconds === undefined ? 900 : request.leaseSeconds,
    'Specialist leaseSeconds',
    1,
    86_400,
  );

  const nowMs = Date.parse(at);
  const assignmentInputs = denseArray(rawAssignments, 'Specialist assignments', 256);
  const assignments = assignmentInputs
    .map(normalizeSpecialistAssignmentV1)
    .map(item => structuredClone(item));

  if (new Set(assignments.map(item => item.agentId)).size !== assignments.length) {
    throw new Error('Specialist assignments contain duplicate agentId');
  }

  const children = new Map();
  for (const item of assignments) {
    if (item.parentAgentId) {
      children.set(item.parentAgentId, (children.get(item.parentAgentId) || 0) + 1);
    }
  }
  for (const [parent, count] of children) {
    if (count > maxChildrenPerAgent) {
      throw new Error(`Specialist assignment child limit exceeded for ${parent}`);
    }
  }

  const candidates = assignments
    .filter(item => (
      !TERMINAL.has(item.state)
      && item.depth <= maxAllowedDepth
      && item.deadlineAt > at
      && (
        item.state === SpecialistAssignmentState.READY
        || (
          item.state === SpecialistAssignmentState.LEASED
          && Date.parse(item.leaseExpiresAt) <= nowMs
        )
      )
    ))
    .sort((a, b) => (
      b.priority - a.priority
      || compareExactText(a.updatedAt, b.updatedAt)
      || compareExactText(a.agentId, b.agentId)
    ));

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

  return freeze({
    assignments: assignments.map(normalizeSpecialistAssignmentV1),
    claimed,
  });
}
