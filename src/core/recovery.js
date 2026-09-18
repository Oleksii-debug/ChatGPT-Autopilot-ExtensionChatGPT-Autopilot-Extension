import { OperationPhase, RunState } from './schema.js';
import { selectNextTask } from './scheduler.js';
import {
  createModuleSessionView,
  ensureSessionModuleState,
  listExecutionModuleIds,
} from './module-workspaces.js';

export const ALARM_NAME = 'autopilot-core-wake';
export const EXECUTION_UNAVAILABLE_MESSAGE = 'Automatic execution is not available until the durable send runner is installed.';

const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);

export function suspendActiveSessionsWhenExecutionUnavailable(state, now = Date.now()) {
  for (const session of Object.values(state.sessionsById)) {
    if (!ACTIVE_STATES.has(session.runState)) continue;
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
    ensureSessionModuleState(session);
    const wasActive = ACTIVE_STATES.has(session.runState);
    if (session.runState === RunState.RUNNING) session.runState = RunState.RECOVERING;
    for (const moduleId of listExecutionModuleIds(session, { includeDisabledWithOperation: true })) {
      const view = createModuleSessionView(session, moduleId);
      if (!view?.operation) continue;
      if (view.operation.phase === OperationPhase.SUBMITTING) {
        view.operation.phase = OperationPhase.AMBIGUOUS;
        view.operation.updatedAt = now;
        if (wasActive && ACTIVE_STATES.has(session.runState)) view.runState = RunState.RECOVERING;
      }
    }
  }
  const lease = state.sendArbiter.lease;
  if (lease && lease.expiresAt <= now) state.sendArbiter.lease = null;
  return state;
}

function schedulerWakeForModule(view, now) {
  const decision = selectNextTask(view, now);
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

function operationWakeForModule(view, now, profileSendBarrier) {
  const phase = view.operation?.phase;
  if (phase === OperationPhase.MANUAL_REVIEW) return null;
  if (phase === OperationPhase.PRE_SEND_WAIT) {
    const taskRetryAfter = view.tasksById?.[view.operation?.taskId]?.retryAfterAt || 0;
    return Math.max(
      now,
      view.operation.preSendDeadline || now,
      taskRetryAfter,
      profileSendBarrier,
    );
  }
  if (phase === OperationPhase.AMBIGUOUS) {
    const taskRetryAfter = view.tasksById?.[view.operation?.taskId]?.retryAfterAt || 0;
    return Math.max(now, taskRetryAfter);
  }
  return null;
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
    if (!ACTIVE_STATES.has(session.runState)) continue;
    ensureSessionModuleState(session);
    for (const moduleId of listExecutionModuleIds(session, { includeDisabledWithOperation: true })) {
      const view = createModuleSessionView(session, moduleId);
      if (!view || !ACTIVE_STATES.has(view.runState)) continue;
      const operationWake = operationWakeForModule(view, now, profileSendBarrier);
      if (operationWake != null) {
        earliest = Math.min(earliest, operationWake);
        continue;
      }
      const schedulerWake = schedulerWakeForModule(view, now);
      if (schedulerWake != null) earliest = Math.min(earliest, schedulerWake);
    }
  }

  return earliest < Infinity ? earliest : null;
}

export async function reconcileAlarm(chromeApi, state, now = Date.now()) {
  const wakeAt = computeNextWake(state, now);
  if (wakeAt == null) {
    await chromeApi.alarms.clear(ALARM_NAME);
    return null;
  }
  await chromeApi.alarms.create(ALARM_NAME, { when: Math.max(now + 500, wakeAt) });
  return wakeAt;
}
