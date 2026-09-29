import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextWake } from '../src/core/recovery.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../src/core/schema.js';
import { pauseSession, resumeSession, stopSession } from '../src/core/state-machine.js';

function scheduledState() {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const state = createEmptyState(now);
  const session = createSession({
    id: 'calendar-control',
    name: 'Calendar control',
    tasks: [createTask({ id: 'task', url: 'https://chatgpt.com/' })],
    sharedPrompt: 'hello',
    now,
  });
  session.calendarSchedule = {
    kind: 'WEEKLY',
    startDate: '2026-09-21',
    weekdays: [1, 3],
    times: ['09:00:00'],
    timeZone: 'UTC',
    catchUp: 'ON',
  };
  session.calendarRuntime = {};
  session.runState = RunState.RUNNING;
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  return { state, session, now };
}

test('owner Pause and Stop dominate a due catch-up backlog without consuming occurrence state', () => {
  const { state, session, now } = scheduledState();
  assert.equal(computeNextWake(state, now), now, 'running missed backlog is immediately wakeable');
  const before = structuredClone(session.calendarRuntime);

  pauseSession(session, now + 1);
  assert.equal(computeNextWake(state, now + 1), null);
  assert.deepEqual(session.calendarRuntime, before);

  resumeSession(session, now + 2);
  assert.equal(computeNextWake(state, now + 2), now + 2);
  assert.deepEqual(session.calendarRuntime, before);

  stopSession(session, now + 3);
  assert.equal(computeNextWake(state, now + 3), null);
  assert.deepEqual(session.calendarRuntime, before);
});

test('ambiguous effect recovery remains wakeable ahead of future calendar occurrence', () => {
  const { state, session, now } = scheduledState();
  session.calendarSchedule = {
    kind: 'ONE_TIME',
    date: '2026-10-01',
    time: '09:00:00',
    timeZone: 'UTC',
    catchUp: 'OFF',
  };
  session.runState = RunState.RECOVERING;
  session.operation = {
    operationId: 'op',
    sessionId: session.id,
    taskId: 'task',
    promptFingerprint: 'fp',
    promptText: 'hello',
    phase: OperationPhase.AMBIGUOUS,
    targetUrl: 'https://chatgpt.com/',
    createdAt: now - 100,
    updatedAt: now - 100,
    preSendDeadline: 0,
    submitStartedAt: now - 50,
    verificationDeadline: now + 1000,
  };
  session.tasksById.task.retryAfterAt = now + 500;

  assert.equal(computeNextWake(state, now), now + 500);
});
