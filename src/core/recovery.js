import { OperationPhase, RunState } from './schema.js';
export const ALARM_NAME = 'autopilot-core-wake';
export const EXECUTION_UNAVAILABLE_MESSAGE = 'Automatic execution is not available until the durable send runner is installed.';

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
    if (session.runState === RunState.RUNNING) session.runState = RunState.RECOVERING;
    if (session.operation?.phase === OperationPhase.SUBMITTING) { session.operation.phase = OperationPhase.AMBIGUOUS; session.runState = RunState.RECOVERING; }
  }
  const lease = state.sendArbiter.lease;
  if (lease && lease.expiresAt <= now) state.sendArbiter.lease = null;
  return state;
}
export function computeNextWake(state, now = Date.now()) {
  let earliest = Infinity;
  for (const s of Object.values(state.sessionsById)) {
    if (s.runState !== RunState.RUNNING && s.runState !== RunState.RECOVERING) continue;
    const phase = s.operation?.phase;
    if (phase === OperationPhase.MANUAL_REVIEW) continue;
    if (phase === OperationPhase.PRE_SEND_WAIT) {
      const taskRetryAfter = s.tasksById?.[s.operation?.taskId]?.retryAfterAt || 0;
      earliest = Math.min(
        earliest,
        Math.max(now, s.operation.preSendDeadline || now, taskRetryAfter),
      );
      continue;
    }
    if (phase === OperationPhase.AMBIGUOUS) {
      earliest = Math.min(earliest, now);
      continue;
    }
    earliest = Math.min(earliest, Math.max(now, s.nextAllowedSendAt || now));
    for (const t of Object.values(s.tasksById)) if (t.retryAfterAt > now) earliest = Math.min(earliest, t.retryAfterAt);
  }
  return earliest < Infinity ? earliest : null;
}
export async function reconcileAlarm(chromeApi, state, now = Date.now()) {
  const wakeAt = computeNextWake(state, now);
  await chromeApi.alarms.clear(ALARM_NAME);
  if (wakeAt != null) await chromeApi.alarms.create(ALARM_NAME, { when: Math.max(now + 500, wakeAt) });
  return wakeAt;
}
