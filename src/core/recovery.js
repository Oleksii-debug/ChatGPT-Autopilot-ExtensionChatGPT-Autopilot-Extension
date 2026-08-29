import { OperationPhase, RunState } from './schema.js';
import { selectNextTask } from './scheduler.js';

export const ALARM_NAME = 'autopilot-core-wake';
export const EXECUTION_UNAVAILABLE_MESSAGE = 'Automatic execution is not available until the durable send runner is installed.';

const INTERRUPTED_PRE_SUBMIT_PHASES = new Set([
  OperationPhase.CHECKING,
  OperationPhase.READY,
  OperationPhase.INSERTING,
]);

export function resetInterruptedPreSubmitOperation(session, now = Date.now()) {
  const operation = session?.operation;
  if (!operation || !INTERRUPTED_PRE_SUBMIT_PHASES.has(operation.phase)) return false;

  const retryAt = now + Math.max(1000, session.retryBackoffMs || 30000);
  const task = session.tasksById?.[operation.taskId];
  if (task) task.retryAfterAt = Math.max(task.retryAfterAt || 0, retryAt);

  // These phases are all strictly before durable SUBMITTING. Clearing only this
  // transient checkpoint cannot authorize a Send. The next normal cycle repeats
  // CHECK_ONLY and idempotent INSERT_ONLY; an already-present exact prompt is
  // re-proven by Interaction, while unrelated composer content still fails closed.
  session.operation = null;
  session.lastActionAt = now;
  session.updatedAt = now;
  return true;
}

export function suspendActiveSessionsWhenExecutionUnavailable(state, now = Date.now()) {
  for (const session of Object.values(state.sessionsById)) {
    if (session.runState !== RunState.RUNNING && session.runState !== RunState.RECOVERING) continue;
    session.runState = RunState.PAUSED;
    session.pausedByRuntimeGate = true;
    session.lastError = EXECUTION_UNAVAILABLE_MESSAGE;
    session.lastActionAt = now;
    session.updatedAt = now;
  }
  return state;
}

export function reconcileStateForStartup(state, now = Date.now()) {
  for (const session of Object.values(state.sessionsById)) {
    const wasActive = session.runState === RunState.RUNNING || session.runState === RunState.RECOVERING;
    if (session.runState === RunState.RUNNING) session.runState = RunState.RECOVERING;

    if (resetInterruptedPreSubmitOperation(session, now)) continue;

    if (session.operation?.phase === OperationPhase.SUBMITTING) {
      session.operation.phase = OperationPhase.AMBIGUOUS;
      if (wasActive) session.runState = RunState.RECOVERING;
    }
  }
  const lease = state.sendArbiter.lease;
  if (lease && lease.expiresAt <= now) state.sendArbiter.lease = null;
  return state;
}

function schedulerWakeForSession(session, now) {
  const decision = selectNextTask(session, now);
  switch (decision.kind) {
    case 'TASK':
    case 'COMPLETE':
      return now;
    case 'COOLDOWN':
    case 'WAIT':
      return Math.max(now, decision.wakeAt);
    default:
      return null;
  }
}

export function computeNextWake(state, now = Date.now()) {
  let earliest = Infinity;
  const activeLeaseUntil = state.sendArbiter?.lease?.expiresAt > now
    ? state.sendArbiter.lease.expiresAt
    : 0;
  const profileSendBarrier = Math.max(
    state.sendArbiter?.profileNextAllowedSendAt || 0,
    activeLeaseUntil,
  );

  for (const session of Object.values(state.sessionsById)) {
    if (session.runState !== RunState.RUNNING && session.runState !== RunState.RECOVERING) continue;
    const phase = session.operation?.phase;
    if (phase === OperationPhase.MANUAL_REVIEW) continue;

    if (phase === OperationPhase.PRE_SEND_WAIT) {
      const taskRetryAfter = session.tasksById?.[session.operation?.taskId]?.retryAfterAt || 0;
      earliest = Math.min(
        earliest,
        Math.max(
          now,
          session.operation.preSendDeadline || now,
          taskRetryAfter,
          profileSendBarrier,
        ),
      );
      continue;
    }

    if (phase === OperationPhase.AMBIGUOUS) {
      const taskRetryAfter = session.tasksById?.[session.operation?.taskId]?.retryAfterAt || 0;
      earliest = Math.min(earliest, Math.max(now, taskRetryAfter));
      continue;
    }

    const schedulerWake = schedulerWakeForSession(session, now);
    if (schedulerWake != null) earliest = Math.min(earliest, schedulerWake);
  }

  return earliest < Infinity ? earliest : null;
}

export async function reconcileAlarm(chromeApi, state, now = Date.now()) {
  const wakeAt = computeNextWake(state, now);
  await chromeApi.alarms.clear(ALARM_NAME);
  if (wakeAt != null) await chromeApi.alarms.create(ALARM_NAME, { when: Math.max(now + 500, wakeAt) });
  return wakeAt;
}
