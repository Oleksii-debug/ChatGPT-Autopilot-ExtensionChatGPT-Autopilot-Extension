import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPECIALIST_AUTOMATION_POLICY_VERSION,
  createSpecialistAutomationPolicyV1,
  normalizeSpecialistAutomationPolicyV1,
} from '../src/core/specialist-automation-policy.js';

const T0 = '2026-09-29T04:40:00.000Z';

test('Specialist automation policy is exact, bounded, versioned owner data', () => {
  const policy = createSpecialistAutomationPolicyV1({
    revision: 3,
    enabled: true,
    maxConcurrentHandoffs: 7,
    updatedAt: T0,
  });
  assert.deepEqual(policy, {
    schemaVersion: SPECIALIST_AUTOMATION_POLICY_VERSION,
    revision: 3,
    enabled: true,
    maxConcurrentHandoffs: 7,
    updatedAt: T0,
  });
  assert.ok(Object.isFrozen(policy));
  assert.throws(
    () => normalizeSpecialistAutomationPolicyV1({ ...policy, maxConcurrentHandoffs: 257 }),
    /maxConcurrentHandoffs/,
  );
  assert.throws(
    () => normalizeSpecialistAutomationPolicyV1({ ...policy, enabled: 1 }),
    /enabled must be boolean/,
  );
  assert.throws(
    () => normalizeSpecialistAutomationPolicyV1({ ...policy, hidden: true }),
    /unknown field/,
  );
});

test('Specialist automation policy rejects accessor-backed authority without invoking it', () => {
  let reads = 0;
  const hostile = {
    schemaVersion: 1,
    revision: 1,
    enabled: true,
    maxConcurrentHandoffs: 1,
    updatedAt: T0,
  };
  Object.defineProperty(hostile, 'maxConcurrentHandoffs', {
    enumerable: true,
    get() {
      reads += 1;
      return 256;
    },
  });
  assert.throws(
    () => normalizeSpecialistAutomationPolicyV1(hostile),
    /data property/,
  );
  assert.equal(reads, 0);
});
