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

test('BrowserTargetLease serializes conflicting invocation ownership', () => {
  const first = acquireBrowserTargetLeaseV1({ targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:1', now: NOW });
  assert.equal(first.status, 'ACQUIRED');
  const conflict = acquireBrowserTargetLeaseV1({ current: first.lease, targetId: 'page:1', ownerInvocationId: 'inv:2', leaseId: 'lease:2', now: '2026-09-21T02:16:01Z' });
  assert.equal(conflict.status, 'CONFLICT');
  assert.equal(conflict.lease.ownerInvocationId, 'inv:1');
});

test('BrowserTargetLease preserves a live target when another target is requested', () => {
  const first = acquireBrowserTargetLeaseV1({ targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:1', now: NOW });
  const conflict = acquireBrowserTargetLeaseV1({ current: first.lease, targetId: 'page:2', ownerInvocationId: 'inv:1', leaseId: 'lease:2', now: '2026-09-21T02:16:01Z' });
  assert.equal(conflict.status, 'CONFLICT');
  assert.deepEqual(conflict.lease, first.lease);
  assert.equal(conflict.lease.targetId, 'page:1');
  assert.equal(conflict.lease.leaseId, 'lease:1');
});

test('BrowserTargetLease survives restart as data and only expires deterministically', () => {
  const first = acquireBrowserTargetLeaseV1({ targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:1', now: NOW, ttlMs: 2_000 });
  const restored = JSON.parse(JSON.stringify(first.lease));
  const held = acquireBrowserTargetLeaseV1({ current: restored, targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'ignored', now: '2026-09-21T02:16:01Z' });
  assert.equal(held.status, 'HELD');
  assert.equal(held.lease.leaseId, 'lease:1');
  const reacquired = acquireBrowserTargetLeaseV1({ current: restored, targetId: 'page:1', ownerInvocationId: 'inv:2', leaseId: 'lease:2', now: '2026-09-21T02:16:02Z' });
  assert.equal(reacquired.status, 'REACQUIRED');
  assert.equal(reacquired.lease.ownerInvocationId, 'inv:2');
});

test('BrowserTargetLease release is owner-and-token scoped', () => {
  const first = acquireBrowserTargetLeaseV1({ targetId: 'page:1', ownerInvocationId: 'inv:1', leaseId: 'lease:1', now: NOW });
  assert.equal(releaseBrowserTargetLeaseV1(first.lease, { ownerInvocationId: 'inv:2', leaseId: 'lease:1' }).status, 'NOT_OWNER');
  assert.equal(releaseBrowserTargetLeaseV1(first.lease, { ownerInvocationId: 'inv:1', leaseId: 'lease:1' }).status, 'RELEASED');
});
