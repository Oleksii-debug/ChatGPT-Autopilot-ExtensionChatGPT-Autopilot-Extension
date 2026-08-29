import { OperationPhase, RunState } from './schema.js';
export const ALARM_NAME = 'autopilot-core-wake';
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
