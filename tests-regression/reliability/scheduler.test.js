import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, createTask, RunMode, RunState } from '../../src/core/schema.js';
import { selectNextTask, advanceAfterBusy, advanceAfterVerifiedSend } from '../../src/core/scheduler.js';

function makeSession({ count = 3, runMode = RunMode.CONTINUOUS, now = 1_000 } = {}) {
  const tasks = Array.from({ length: count }, (_, i) => createTask({ id: `t${i+1}`, url: `https://chatgpt.com/c/${i+1}` }));
  const session = createSession({ id: 's1', name: 'Reliability', tasks, runMode, minimumSendIntervalMs: 120_000, busyCheckDelayMs: 2_000, now });
  session.runState = RunState.RUNNING;
  return session;
}

test('round-robin advances fairly after BUSY without consuming cooldown', () => {
  const s = makeSession({ count: 3 });
  const first = selectNextTask(s, 10_000);
  assert.equal(first.kind, 'TASK');
  assert.equal(first.task.id, 't1');
  advanceAfterBusy(s, first.index, 10_000);
  assert.equal(s.currentTaskIndex, 1);
  assert.equal(s.nextAllowedSendAt, 0);
  const second = selectNextTask(s, 10_001);
  assert.equal(second.task.id, 't2');
});

test('verified send advances exactly once and enforces session cooldown', () => {
  const s = makeSession({ count: 3 });
  const selected = selectNextTask(s, 20_000);
  advanceAfterVerifiedSend(s, selected.index, 20_000);
  assert.equal(s.currentTaskIndex, 1);
  assert.equal(s.nextAllowedSendAt, 140_000);
  assert.deepEqual(selectNextTask(s, 139_999), { kind: 'COOLDOWN', wakeAt: 140_000 });
  const next = selectNextTask(s, 140_000);
  assert.equal(next.kind, 'TASK');
  assert.equal(next.task.id, 't2');
});

test('disabled, manual-review and retry-backoff tasks do not break stable order', () => {
  const s = makeSession({ count: 4 });
  s.tasksById.t1.enabled = false;
  s.tasksById.t2.manualReviewReason = 'unknown-ui';
  s.tasksById.t3.retryAfterAt = 50_000;
  const selected = selectNextTask(s, 40_000);
  assert.equal(selected.kind, 'TASK');
  assert.equal(selected.task.id, 't4');
  assert.equal(selected.index, 3);
});

test('one-pass completes only after every eligible task was verified once', () => {
  const s = makeSession({ count: 2, runMode: RunMode.ONE_PASS });
  let sel = selectNextTask(s, 1_000);
  assert.equal(sel.task.id, 't1');
  advanceAfterVerifiedSend(s, sel.index, 1_000);
  s.nextAllowedSendAt = 0;
  sel = selectNextTask(s, 2_000);
  assert.equal(sel.task.id, 't2');
  advanceAfterVerifiedSend(s, sel.index, 2_000);
  s.nextAllowedSendAt = 0;
  assert.deepEqual(selectNextTask(s, 3_000), { kind: 'COMPLETE' });
});

test('continuous session with all tasks in retry backoff wakes at earliest retry', () => {
  const s = makeSession({ count: 2 });
  s.tasksById.t1.retryAfterAt = 25_000;
  s.tasksById.t2.retryAfterAt = 18_000;
  assert.deepEqual(selectNextTask(s, 10_000), { kind: 'WAIT', wakeAt: 18_000 });
});
