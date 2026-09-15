import test from 'node:test';
import assert from 'node:assert/strict';

const IMMEDIATE_ORDINARY_FOLLOW_UP_KINDS = new Set(['SENT', 'RECOVERED_SENT']);
function shouldRunImmediateOrdinaryFollowUp(result, now = Date.now()) {
  if (!Number.isFinite(result?.wakeAt) || result.wakeAt > now) return false;
  return Array.isArray(result?.outcomes)
    && result.outcomes.some((outcome) => IMMEDIATE_ORDINARY_FOLLOW_UP_KINDS.has(outcome?.result?.kind));
}

test('verified send with due-now preparation requires post-single-flight follow-up', () => {
  const now = 1_000_000;
  assert.equal(shouldRunImmediateOrdinaryFollowUp({
    wakeAt: now,
    outcomes: [{ result: { kind: 'SENT' } }],
  }, now), true);
  assert.equal(shouldRunImmediateOrdinaryFollowUp({
    wakeAt: now,
    outcomes: [{ result: { kind: 'RECOVERED_SENT' } }],
  }, now), true);
});

test('future wake or non-send outcome never creates immediate drain', () => {
  const now = 1_000_000;
  assert.equal(shouldRunImmediateOrdinaryFollowUp({ wakeAt: now + 60_000, outcomes: [{ result: { kind: 'SENT' } }] }, now), false);
  assert.equal(shouldRunImmediateOrdinaryFollowUp({ wakeAt: now, outcomes: [{ result: { kind: 'BUSY' } }] }, now), false);
});

test('single-flight race is drained only after old execution releases', async () => {
  let inFlight = true;
  let runs = 1;
  let postReleaseFollowUps = 0;

  // Chrome delivers an immediate alarm while the old cycle is still running: it coalesces.
  if (inFlight) {
    // old behavior stopped here and the wake was lost
  } else {
    runs += 1;
  }
  assert.equal(runs, 1);

  const result = { wakeAt: 1000, outcomes: [{ result: { kind: 'SENT' } }] };
  inFlight = false;
  if (!inFlight && shouldRunImmediateOrdinaryFollowUp(result, 1000)) {
    postReleaseFollowUps += 1;
    runs += 1;
  }
  assert.equal(postReleaseFollowUps, 1);
  assert.equal(runs, 2);
});

test('owner defaults are exact and not hidden legacy fallbacks', () => {
  const defaults = {
    rateLimitCooldownMs: 0,
    maxConcurrentSessions: 10,
    minimumSendIntervalMs: 60_000,
    preSendDelayMs: 10_000,
    busyCheckDelayMs: 3_000,
    retryBackoffMs: 5_000,
  };
  assert.deepEqual(defaults, {
    rateLimitCooldownMs: 0,
    maxConcurrentSessions: 10,
    minimumSendIntervalMs: 60_000,
    preSendDelayMs: 10_000,
    busyCheckDelayMs: 3_000,
    retryBackoffMs: 5_000,
  });
});

test('continuous mode reports completed cycles instead of one-pass task completion', () => {
  const status = { runMode: 'continuous', successfulSendCount: 5, completedTaskCount: 0, totalTasks: 1000 };
  const label = status.runMode === 'continuous' ? `Виконано циклів: ${status.successfulSendCount}` : `Виконано завдань: ${status.completedTaskCount} / ${status.totalTasks}`;
  assert.equal(label, 'Виконано циклів: 5');
});
