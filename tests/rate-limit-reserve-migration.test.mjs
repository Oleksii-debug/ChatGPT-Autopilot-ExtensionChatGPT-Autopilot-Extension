import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask } from '../src/core/schema.js';
import { migrateState } from '../src/core/storage.js';

test('legacy five-minute system default migrates to zero and clears its active gate', () => {
  const old = createEmptyState(1000);
  delete old.profile.rateLimitReservePolicyVersion;
  old.profile.rateLimitCooldownMs = 300_000;
  old.profile.rateLimitUntil = 301_000;
  const task = createTask({ id:'t1', url:'https://chatgpt.com/' });
  const session = createSession({ id:'s1', name:'session', tasks:[task], sharedPrompt:'hello', now:1000 });
  session.tasksById.t1.status = 'RATE_LIMITED';
  session.tasksById.t1.retryAfterAt = 301_000;
  old.sessionsById.s1 = session;
  old.sessionOrder.push('s1');
  const migrated = migrateState(old, 2000);
  assert.equal(migrated.profile.rateLimitCooldownMs, 0);
  assert.equal(migrated.profile.rateLimitUntil, 0);
  assert.equal(migrated.sessionsById.s1.tasksById.t1.retryAfterAt, 0);
  assert.equal(migrated.sessionsById.s1.tasksById.t1.status, 'RATE_LIMITED');
  assert.equal(migrated.sessionsById.s1.sharedPrompt, 'hello');
  assert.equal(migrateState(migrated, 3000).profile.rateLimitUntil, 0);
});

test('legacy explicitly different reserve remains configured with its active gate', () => {
  const old = createEmptyState(1000);
  delete old.profile.rateLimitReservePolicyVersion;
  old.profile.rateLimitCooldownMs = 600_000;
  old.profile.rateLimitUntil = 601_000;
  const migrated = migrateState(old);
  assert.equal(migrated.profile.rateLimitCooldownMs, 600_000);
  assert.equal(migrated.profile.rateLimitUntil, 601_000);
});
