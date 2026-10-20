import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireBrowserTargetLeaseV1, normalizeBrowserTargetLeaseV1, releaseBrowserTargetLeaseV1 } from '../src/core/browser-target-lease.js';

const NOW = '2026-09-21T02:16:00.000Z';
const VALID = Object.freeze({
  schemaVersion: 1,
  targetId: 'page:1',
  ownerInvocationId: 'inv:1',
  leaseId: 'lease:1',
  acquiredAt: NOW,
  expiresAt: '2026-09-21T02:16:30.000Z',
});

test('BrowserTargetLease rejects every required field independently and unknown fields fail closed', () => {
  for (const field of ['targetId', 'ownerInvocationId', 'leaseId', 'acquiredAt', 'expiresAt']) {
    const malformed = { ...VALID };
    delete malformed[field];
    assert.throws(() => normalizeBrowserTargetLeaseV1(malformed), new RegExp(field));
  }
  assert.throws(() => normalizeBrowserTargetLeaseV1({ ...VALID, unexpected: true }), /unknown field: unexpected/);
  assert.throws(() => normalizeBrowserTargetLeaseV1({ ...VALID, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => normalizeBrowserTargetLeaseV1({ ...VALID, expiresAt: NOW }), /expiresAt must be after acquiredAt/);
  assert.throws(() => acquireBrowserTargetLeaseV1({ targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:1', now: NOW, ttlMs: 999 }), /ttlMs/);
});

test('BrowserTargetLease rejects representation aliases and coercion at the authority boundary', () => {
  assert.throws(() => normalizeBrowserTargetLeaseV1({ ...VALID, schemaVersion: '1' }), /schemaVersion/);
  assert.throws(() => normalizeBrowserTargetLeaseV1({ ...VALID, targetId: ' page:1' }), /targetId/);
  assert.throws(() => normalizeBrowserTargetLeaseV1({ ...VALID, ownerInvocationId: 'inv:1 ' }), /ownerInvocationId/);
  assert.throws(() => normalizeBrowserTargetLeaseV1({ ...VALID, acquiredAt: '2026-09-21T02:16:00Z' }), /exact canonical UTC/);
  assert.throws(() => normalizeBrowserTargetLeaseV1({
    ...VALID,
    acquiredAt: '2026-09-21T04:16:00.000+02:00',
  }), /exact canonical UTC/);

  let coerces = 0;
  const coerciveOwner = {
    toString() {
      coerces += 1;
      return 'inv:1';
    },
  };
  assert.throws(() => acquireBrowserTargetLeaseV1({
    targetId: 'page:1',
    ownerInvocationId: coerciveOwner,
    leaseId: 'lease:1',
    now: NOW,
  }), /ownerInvocationId/);
  assert.equal(coerces, 0);

  const lease = acquireBrowserTargetLeaseV1({
    targetId: 'page:1',
    ownerInvocationId: 'inv:1',
    leaseId: 'lease:1',
    now: NOW,
  }).lease;
  assert.throws(
    () => releaseBrowserTargetLeaseV1(lease, { ownerInvocationId: ' inv:1', leaseId: 'lease:1' }),
    /ownerInvocationId/,
  );
  assert.throws(
    () => releaseBrowserTargetLeaseV1(lease, { ownerInvocationId: 'inv:1', leaseId: { toString: () => 'lease:1' } }),
    /leaseId/,
  );
});

test('BrowserTargetLease request wrappers snapshot data before reading authority fields', () => {
  let acquireReads = 0;
  const acquireRequest = {
    targetId: 'page:1',
    ownerInvocationId: 'inv:1',
    leaseId: 'lease:1',
    now: NOW,
  };
  Object.defineProperty(acquireRequest, 'ownerInvocationId', {
    enumerable: true,
    configurable: true,
    get() {
      acquireReads += 1;
      return 'inv:1';
    },
  });
  assert.throws(
    () => acquireBrowserTargetLeaseV1(acquireRequest),
    /enumerable data property/,
  );
  assert.equal(acquireReads, 0);

  const lease = acquireBrowserTargetLeaseV1({
    targetId: 'page:1',
    ownerInvocationId: 'inv:1',
    leaseId: 'lease:1',
    now: NOW,
  }).lease;

  let releaseReads = 0;
  const releaseRequest = { ownerInvocationId: 'inv:1', leaseId: 'lease:1' };
  Object.defineProperty(releaseRequest, 'leaseId', {
    enumerable: true,
    configurable: true,
    get() {
      releaseReads += 1;
      return 'lease:1';
    },
  });
  assert.throws(
    () => releaseBrowserTargetLeaseV1(lease, releaseRequest),
    /enumerable data property/,
  );
  assert.equal(releaseReads, 0);

  assert.throws(
    () => acquireBrowserTargetLeaseV1({
      targetId: 'page:1',
      ownerInvocationId: 'inv:1',
      leaseId: 'lease:1',
      now: NOW,
      unexpected: true,
    }),
    /unknown field: unexpected/,
  );
  assert.throws(
    () => releaseBrowserTargetLeaseV1(lease, {
      ownerInvocationId: 'inv:1',
      leaseId: 'lease:1',
      unexpected: true,
    }),
    /unknown field: unexpected/,
  );

  for (const invalidCurrent of [undefined, false, 0, '']) {
    assert.throws(
      () => acquireBrowserTargetLeaseV1({
        current: invalidCurrent,
        targetId: 'page:1',
        ownerInvocationId: 'inv:2',
        leaseId: 'lease:2',
        now: '2026-09-21T02:16:01.000Z',
      }),
      /BrowserTargetLeaseV1 must be a plain object/,
    );
  }
});

test('BrowserTargetLease snapshots plain authority data without executing accessors', () => {
  let reads = 0;
  const accessor = { ...VALID };
  Object.defineProperty(accessor, 'targetId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'page:1';
    },
  });
  assert.throws(() => normalizeBrowserTargetLeaseV1(accessor), /enumerable data property/);
  assert.equal(reads, 0);

  const symbolic = { ...VALID };
  symbolic[Symbol('authority')] = 'page:forged';
  assert.throws(() => normalizeBrowserTargetLeaseV1(symbolic), /symbol fields/);

  const inherited = Object.create({ targetId: 'page:forged' });
  Object.assign(inherited, VALID);
  assert.throws(() => normalizeBrowserTargetLeaseV1(inherited), /plain object/);

  const nullPrototype = Object.assign(Object.create(null), VALID);
  assert.deepEqual(normalizeBrowserTargetLeaseV1(nullPrototype), VALID);
});

test('BrowserTargetLease serializes conflicting invocation ownership', () => {
  const first = acquireBrowserTargetLeaseV1({ targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:1', now: NOW });
  assert.equal(first.status, 'ACQUIRED');
  const conflict = acquireBrowserTargetLeaseV1({ current: first.lease, targetId: 'page:1', ownerInvocationId: 'inv:2', leaseId: 'lease:2', now: '2026-09-21T02:16:01.000Z' });
  assert.equal(conflict.status, 'CONFLICT');
  assert.equal(conflict.lease, null);
});

test('BrowserTargetLease preserves a live target when another target is requested', () => {
  const first = acquireBrowserTargetLeaseV1({ targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:1', now: NOW });
  const conflict = acquireBrowserTargetLeaseV1({ current: first.lease, targetId: 'page:2', ownerInvocationId: 'inv:1', leaseId: 'lease:2', now: '2026-09-21T02:16:01.000Z' });
  assert.equal(conflict.status, 'CONFLICT');
  assert.equal(conflict.lease, null);
  assert.equal(first.lease.targetId, 'page:1');
  assert.equal(first.lease.leaseId, 'lease:1');
});

test('BrowserTargetLease survives restart as data and only expires deterministically', () => {
  const first = acquireBrowserTargetLeaseV1({ targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:1', now: NOW, ttlMs: 2_000 });
  const restored = JSON.parse(JSON.stringify(first.lease));
  const wrongToken = acquireBrowserTargetLeaseV1({ current: restored, targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:wrong', now: '2026-09-21T02:16:01.000Z' });
  assert.equal(wrongToken.status, 'CONFLICT');
  assert.equal(wrongToken.lease, null);
  const held = acquireBrowserTargetLeaseV1({ current: restored, targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:1', now: '2026-09-21T02:16:01.000Z' });
  assert.equal(held.status, 'HELD');
  assert.equal(held.lease.leaseId, 'lease:1');
  const reacquired = acquireBrowserTargetLeaseV1({ current: restored, targetId: 'page:1', ownerInvocationId: 'inv:2', leaseId: 'lease:2', now: '2026-09-21T02:16:02.000Z' });
  assert.equal(reacquired.status, 'REACQUIRED');
  assert.equal(reacquired.lease.ownerInvocationId, 'inv:2');
});

test('BrowserTargetLease release is owner-and-token scoped without credential disclosure', () => {
  const first = acquireBrowserTargetLeaseV1({ targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:1', now: NOW });
  const wrongOwner = releaseBrowserTargetLeaseV1(first.lease, { ownerInvocationId: 'inv:2', leaseId: 'lease:1' });
  assert.equal(wrongOwner.status, 'NOT_OWNER');
  assert.equal(wrongOwner.lease, null);
  const wrongToken = releaseBrowserTargetLeaseV1(first.lease, { ownerInvocationId: 'inv:1', leaseId: 'lease:2' });
  assert.equal(wrongToken.status, 'NOT_OWNER');
  assert.equal(wrongToken.lease, null);
  assert.equal(releaseBrowserTargetLeaseV1(first.lease, { ownerInvocationId: 'inv:1', leaseId: 'lease:1' }).status, 'RELEASED');
});
