import assert from 'node:assert/strict';
import test from 'node:test';
import { runRuntimeCycle } from '../src/core/runtime-execution.js';
import { calendarAdmissionForSession } from '../src/core/calendar-runtime.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState, validateState } from '../src/core/schema.js';
import { InteractionResult } from '../src/shared/protocol.js';

class MemoryRepository {
  constructor(state) { this.state = structuredClone(state); this.queue = Promise.resolve(); }
  async load() { return structuredClone(this.state); }
  update(mutator) {
    const work = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const next = await mutator(draft) || draft;
      next.revision = Number(this.state.revision || 0) + 1;
      validateState(next);
      this.state = structuredClone(next);
      return structuredClone(next);
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
}

const utc = value => Date.parse(value);
const chromeApi = { alarms: { async create() {}, async clear() { return true; } } };

function scheduledState(schedule) {
  const state = createEmptyState(1);
  const task = createTask({ id: 'task', url: 'https://chatgpt.com/' });
  const session = createSession({ id: 'scheduled', name: 'scheduled', tasks: [task], sharedPrompt: 'hello', now: 1 });
  session.runState = RunState.RUNNING;
  session.calendarSchedule = schedule;
  session.calendarRuntime = {};
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  return state;
}

test('runtime admission waits for a future calendar occurrence without invoking executor', async () => {
  const now = utc('2026-09-24T08:00:00Z');
  const repo = new MemoryRepository(scheduledState({ kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'OFF', date: '2026-09-24', time: '09:00' }));
  let calls = 0;
  const cycle = await runRuntimeCycle({ repository: repo, chromeApi, executionAvailable: true, now: () => now, executor: { async runSessionOnce() { calls += 1; return { kind: 'UNEXPECTED' }; } } });
  assert.equal(calls, 0);
  assert.deepEqual(cycle.outcomes, [{ sessionId: 'scheduled', result: { kind: 'CALENDAR_WAIT', wakeAt: utc('2026-09-24T09:00:00Z') } }]);
});

test('due calendar occurrence is durably admitted before executor work begins', async () => {
  const now = utc('2026-09-24T09:00:00Z');
  const repo = new MemoryRepository(scheduledState({ kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'OFF', date: '2026-09-24', time: '09:00' }));
  let activeAtExecution = null;
  await runRuntimeCycle({ repository: repo, chromeApi, executionAvailable: true, now: () => now, executor: {
    async runSessionOnce() {
      activeAtExecution = (await repo.load()).sessionsById.scheduled.calendarRuntime.activeOccurrence;
      return { kind: 'WAIT' };
    },
  } });
  assert.equal(activeAtExecution.scheduledAt, now);
  assert.equal(activeAtExecution.catchUp, false);
});

test('verified scheduled send commits its occurrence and clears pending admission', async () => {
  const now = utc('2026-09-24T09:00:00Z');
  const repo = new MemoryRepository(scheduledState({ kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'OFF', date: '2026-09-24', time: '09:00' }));
  await runRuntimeCycle({ repository: repo, chromeApi, executionAvailable: true, now: () => now, executor: {
    async runSessionOnce() {
      await repo.update(draft => {
        const session = draft.sessionsById.scheduled;
        const occurrence = session.calendarRuntime.activeOccurrence;
        session.operation = {
          operationId: 'op', sessionId: session.id, taskId: 'task', promptFingerprint: 'fp', phase: OperationPhase.SENT_VERIFIED,
          targetUrl: session.tasksById.task.normalizedUrl, createdAt: now, updatedAt: now, preSendDeadline: 0, submitStartedAt: now,
          verificationDeadline: 0, calendarOccurrence: { ...occurrence },
        };
        return draft;
      });
      return { kind: 'SENT', result: { status: InteractionResult.SENT_VERIFIED } };
    },
  } });
  const after = (await repo.load()).sessionsById.scheduled;
  assert.equal(after.calendarRuntime.activeOccurrence, undefined);
  assert.equal(after.calendarRuntime.lastOccurrence.state, 'COMPLETED');
  assert.equal(after.calendarRuntime.committedOccurrenceIds.length, 1);
});

test('restart reconciles a verified bound operation before admitting another effect', async () => {
  const now = utc('2026-09-24T09:01:00Z');
  const state = scheduledState({ kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'OFF', date: '2026-09-24', time: '09:00' });
  const session = state.sessionsById.scheduled;
  const occurrence = calendarAdmissionForSession(session, utc('2026-09-24T09:00:00Z')).occurrence;
  session.calendarRuntime.activeOccurrence = { ...occurrence };
  session.operation = {
    operationId: 'op', sessionId: session.id, taskId: 'task', promptFingerprint: 'fp', phase: OperationPhase.SENT_VERIFIED,
    targetUrl: session.tasksById.task.normalizedUrl, createdAt: now, updatedAt: now, preSendDeadline: 0, submitStartedAt: now,
    verificationDeadline: 0, calendarOccurrence: { ...occurrence },
  };
  const repo = new MemoryRepository(state);
  let calls = 0;
  const cycle = await runRuntimeCycle({ repository: repo, chromeApi, executionAvailable: true, now: () => now, executor: { async runSessionOnce() { calls += 1; return { kind: 'UNEXPECTED' }; } } });
  assert.equal(calls, 0);
  assert.equal(cycle.outcomes[0].result.kind, 'CALENDAR_EXHAUSTED');
  const after = (await repo.load()).sessionsById.scheduled;
  assert.equal(after.calendarRuntime.activeOccurrence, undefined);
  assert.equal(after.calendarRuntime.lastOccurrence.state, 'COMPLETED');
});

test('calendar gating never blocks an unresolved recovery operation', async () => {
  const now = utc('2026-09-24T08:00:00Z');
  const state = scheduledState({ kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'OFF', date: '2026-09-24', time: '09:00' });
  const session = state.sessionsById.scheduled;
  session.operation = {
    operationId: 'op', sessionId: session.id, taskId: 'task', promptFingerprint: 'fp', phase: OperationPhase.AMBIGUOUS,
    targetUrl: session.tasksById.task.normalizedUrl, createdAt: now, updatedAt: now, preSendDeadline: 0, submitStartedAt: now,
    verificationDeadline: now + 1000,
  };
  const repo = new MemoryRepository(state);
  let calls = 0;
  await runRuntimeCycle({ repository: repo, chromeApi, executionAvailable: true, now: () => now, executor: { async runSessionOnce() { calls += 1; return { kind: 'WAIT_RECOVERY' }; } } });
  assert.equal(calls, 1);
});
