import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextWake } from '../src/core/recovery.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../src/core/schema.js';

function scheduledSession(id, calendarSchedule) {
  const task = createTask({ id: `${id}-t1`, url: `https://chatgpt.com/c/${id}` });
  const session = createSession({ id, name: id, tasks: [task], sharedPrompt: 'continue', now: 1 });
  session.runState = RunState.RUNNING;
  session.calendarSchedule = calendarSchedule;
  session.calendarRuntime = {};
  return session;
}

function stateWith(session) {
  const state = createEmptyState(1);
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  return state;
}

const utc = value => Date.parse(value);

test('future calendar occurrence owns canonical wake instead of runnable task scheduler', () => {
  const session = scheduledSession('future', {
    kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'OFF', date: '2026-09-21', time: '09:00',
  });
  const now = utc('2026-09-21T08:00:00Z');
  assert.equal(computeNextWake(stateWith(session), now), utc('2026-09-21T09:00:00Z'));
  assert.deepEqual(session.calendarRuntime, {}, 'wake calculation must not mutate durable calendar state');
});

test('due calendar occurrence wakes immediately through autopilot core wake', () => {
  const session = scheduledSession('due', {
    kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'OFF', date: '2026-09-21', time: '09:00',
  });
  const now = utc('2026-09-21T09:00:00Z');
  assert.equal(computeNextWake(stateWith(session), now), now);
});

test('catch-up OFF missed admission is observational during wake calculation', () => {
  const session = scheduledSession('missed', {
    kind: 'EXPLICIT', timeZone: 'UTC', catchUp: 'OFF', occurrences: [
      { date: '2026-09-21', time: '07:00' },
      { date: '2026-09-21', time: '12:00' },
    ],
  });
  const now = utc('2026-09-21T08:00:00Z');
  assert.equal(computeNextWake(stateWith(session), now), now);
  assert.deepEqual(session.calendarRuntime, {}, 'MISSED_SKIPPED persistence belongs to runtime admission, not wake projection');
});

test('unresolved ambiguous effect remains immediately recoverable despite future calendar occurrence', () => {
  const session = scheduledSession('ambiguous', {
    kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'OFF', date: '2026-09-22', time: '09:00',
  });
  session.operation = {
    operationId: 'op-1', sessionId: session.id, taskId: 'ambiguous-t1', phase: OperationPhase.AMBIGUOUS,
    submitStartedAt: utc('2026-09-21T07:59:00Z'), updatedAt: utc('2026-09-21T07:59:00Z'),
  };
  session.tasksById['ambiguous-t1'].retryAfterAt = 0;
  const now = utc('2026-09-21T08:00:00Z');
  assert.equal(computeNextWake(stateWith(session), now), now, 'calendar must not hide exact-effect reconciliation');
});
