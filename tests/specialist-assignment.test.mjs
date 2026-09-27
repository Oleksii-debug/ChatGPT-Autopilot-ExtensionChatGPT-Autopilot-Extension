import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpecialistAssignmentState,
  claimEligibleSpecialistAssignmentsV1,
  normalizeSpecialistAssignmentV1,
} from '../src/core/specialist-assignment.js';

const AT = '2026-09-23T12:00:00.000Z';

function assignment(overrides = {}) {
  return {
    schemaVersion: 1,
    agentId: 'child-1',
    parentAgentId: 'parent-1',
    jobId: 'job-1',
    purpose: 'Inspect one bounded project slice.',
    specialistId: 'coding-specialist',
    requestedCapabilityIds: ['workspace.read'],
    ownershipKey: 'repo:main',
    depth: 2,
    priority: 5,
    state: 'READY',
    leaseId: '',
    leaseExpiresAt: '',
    deadlineAt: '2026-09-23T13:00:00.000Z',
    resultArtifactIds: [],
    updatedAt: AT,
    ...overrides,
  };
}

test('Specialist assignments bind child identity, explicit capability scope, depth and deadline', () => {
  const value = normalizeSpecialistAssignmentV1(assignment());
  assert.equal(value.state, SpecialistAssignmentState.READY);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.requestedCapabilityIds));
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ depth: 3, parentAgentId: '' })),
    /parentAgentId/,
  );
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ unrestrictedCapabilities: true })),
    /unknown field/,
  );
});

test('Specialist assignment timestamps require exact canonical spelling without caller coercion', () => {
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ deadlineAt: '2026-09-23T13:00:00Z' })),
    /canonical ISO-8601 UTC representation/,
  );
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ updatedAt: '2026-09-23T14:00:00.000+02:00' })),
    /canonical ISO-8601 UTC representation/,
  );

  let coercions = 0;
  const coerciveNow = { toString() { coercions += 1; return AT; } };
  assert.throws(
    () => claimEligibleSpecialistAssignmentsV1(
      [assignment()],
      { now: coerciveNow, availableSlots: 1 },
    ),
    /now must be a timestamp/,
  );
  assert.equal(coercions, 0, 'timestamp validation must not coerce caller-owned objects');
});

test('Specialist claiming is completion-driven, capacity-bounded and recovers only expired leases', () => {
  const result = claimEligibleSpecialistAssignmentsV1([
    assignment({ agentId: 'low', priority: 1 }),
    assignment({ agentId: 'high', priority: 9 }),
    assignment({
      agentId: 'expired',
      priority: 5,
      state: 'LEASED',
      leaseId: 'lease:old',
      leaseExpiresAt: '2026-09-23T11:59:00.000Z',
    }),
  ], { now: AT, availableSlots: 2, leaseSeconds: 60 });

  assert.deepEqual(result.claimed, ['high', 'expired']);
  assert.equal(result.assignments.find(item => item.agentId === 'high').state, 'LEASED');
  assert.equal(result.assignments.find(item => item.agentId === 'low').state, 'READY');
  assert.throws(
    () => claimEligibleSpecialistAssignmentsV1([
      assignment(),
      assignment({ agentId: 'child-2' }),
      assignment({ agentId: 'child-3' }),
      assignment({ agentId: 'child-4' }),
      assignment({ agentId: 'child-5' }),
    ], { now: AT, maxChildrenPerAgent: 4 }),
    /child limit/,
  );
});

test('durable specialist identities, states and integers reject coercion and canonical aliases', () => {
  let coercions = 0;
  const coerciveId = {
    toString() {
      coercions += 1;
      return 'child-1';
    },
  };
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ agentId: coerciveId })),
    /agentId is invalid/,
  );
  assert.equal(coercions, 0, 'identity validation must not execute caller toString');

  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ agentId: ' child-1 ' })),
    /agentId is invalid/,
  );
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ schemaVersion: '1' })),
    /schemaVersion/,
  );
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ depth: '2' })),
    /depth is invalid/,
  );
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ priority: -0 })),
    /priority is invalid/,
  );
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ state: 'ready' })),
    /state is invalid/,
  );
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ state: ' READY ' })),
    /state is invalid/,
  );
});

test('assignment admission rejects accessors, hidden fields, symbols and exotic prototypes before reads', () => {
  let reads = 0;
  const accessor = assignment();
  Object.defineProperty(accessor, 'agentId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'child-1';
    },
  });
  assert.throws(
    () => normalizeSpecialistAssignmentV1(accessor),
    /agentId must be an enumerable own data property/,
  );
  assert.equal(reads, 0);

  const hidden = assignment();
  Object.defineProperty(hidden, 'hiddenAuthority', {
    enumerable: false,
    value: true,
  });
  assert.throws(
    () => normalizeSpecialistAssignmentV1(hidden),
    /unknown field: hiddenAuthority/,
  );

  const symbolic = assignment();
  symbolic[Symbol('authority')] = true;
  assert.throws(
    () => normalizeSpecialistAssignmentV1(symbolic),
    /unknown field: Symbol\(authority\)/,
  );

  const exotic = Object.assign(Object.create({ inheritedAuthority: true }), assignment());
  assert.throws(
    () => normalizeSpecialistAssignmentV1(exotic),
    /plain data object/,
  );
});

test('capability and result identity arrays are dense data-only arrays', () => {
  let reads = 0;
  const accessorIds = ['workspace.read'];
  Object.defineProperty(accessorIds, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'workspace.read';
    },
  });
  assert.throws(
    () => normalizeSpecialistAssignmentV1(
      assignment({ requestedCapabilityIds: accessorIds }),
    ),
    /requestedCapabilityIds\[0\] must be an enumerable own data property/,
  );
  assert.equal(reads, 0);

  const sparse = new Array(2);
  sparse[1] = 'artifact:one';
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ resultArtifactIds: sparse })),
    /resultArtifactIds\[0\] must be an enumerable own data property/,
  );

  const extra = ['workspace.read'];
  extra.extraAuthority = true;
  assert.throws(
    () => normalizeSpecialistAssignmentV1(assignment({ requestedCapabilityIds: extra })),
    /non-canonical array fields/,
  );

  const duplicate = ['workspace.read', 'workspace.read'];
  assert.throws(
    () => normalizeSpecialistAssignmentV1(
      assignment({ requestedCapabilityIds: duplicate }),
    ),
    /contains duplicates/,
  );
});

test('claim boundary snapshots options and assignment arrays before property reads', () => {
  let optionReads = 0;
  const options = { now: AT, availableSlots: 1 };
  Object.defineProperty(options, 'availableSlots', {
    enumerable: true,
    configurable: true,
    get() {
      optionReads += 1;
      return 1;
    },
  });
  assert.throws(
    () => claimEligibleSpecialistAssignmentsV1([assignment()], options),
    /availableSlots must be an enumerable own data property/,
  );
  assert.equal(optionReads, 0);

  let assignmentReads = 0;
  const proxiedAssignments = new Proxy([assignment()], {
    get(target, property, receiver) {
      assignmentReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const claimed = claimEligibleSpecialistAssignmentsV1(
    proxiedAssignments,
    { now: AT, availableSlots: 1 },
  );
  assert.deepEqual(claimed.claimed, ['child-1']);
  assert.equal(assignmentReads, 0, 'assignment array property get traps must not execute');

  assert.throws(
    () => claimEligibleSpecialistAssignmentsV1(
      [assignment()],
      { now: AT, availableSlots: -0 },
    ),
    /availableSlots is invalid/,
  );

  const unknown = { now: AT };
  Object.defineProperty(unknown, 'hiddenBypass', {
    enumerable: false,
    value: 1,
  });
  assert.throws(
    () => claimEligibleSpecialistAssignmentsV1([assignment()], unknown),
    /unknown field: hiddenBypass/,
  );
});

test('claim assignment list rejects sparse and decorated arrays before normalization', () => {
  const sparse = new Array(2);
  sparse[1] = assignment();
  assert.throws(
    () => claimEligibleSpecialistAssignmentsV1(sparse, { now: AT }),
    /Specialist assignments\[0\] must be an enumerable own data property/,
  );

  const decorated = [assignment()];
  decorated.authorizationGranted = true;
  assert.throws(
    () => claimEligibleSpecialistAssignmentsV1(decorated, { now: AT }),
    /non-canonical array fields/,
  );
});

test('null-prototype assignment and claim option records remain portable', () => {
  const raw = Object.assign(Object.create(null), assignment());
  const normalized = normalizeSpecialistAssignmentV1(raw);
  assert.equal(normalized.agentId, 'child-1');

  const options = Object.assign(Object.create(null), {
    now: AT,
    availableSlots: 1,
    maxDepth: 2,
    maxChildrenPerAgent: 4,
    leaseSeconds: 60,
  });
  const claimed = claimEligibleSpecialistAssignmentsV1([raw], options);
  assert.deepEqual(claimed.claimed, ['child-1']);
  assert.equal(claimed.assignments[0].state, 'LEASED');
});

test('zero child capacity remains valid but numeric aliases fail closed', () => {
  assert.throws(
    () => claimEligibleSpecialistAssignmentsV1(
      [assignment()],
      { now: AT, maxChildrenPerAgent: 0 },
    ),
    /child limit/,
  );
  assert.throws(
    () => claimEligibleSpecialistAssignmentsV1(
      [assignment()],
      { now: AT, maxChildrenPerAgent: '0' },
    ),
    /maxChildrenPerAgent is invalid/,
  );
});

test('claim ordering has an exact locale-independent identity tie-break', () => {
  const result = claimEligibleSpecialistAssignmentsV1([
    assignment({ agentId: 'child-b', priority: 5 }),
    assignment({ agentId: 'child-A', priority: 5 }),
    assignment({ agentId: 'child-a', priority: 5 }),
  ], { now: AT, availableSlots: 1, leaseSeconds: 60 });

  assert.deepEqual(result.claimed, ['child-A']);
});
