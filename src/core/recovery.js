import { OperationPhase, RunState, TabStrategy } from './schema.js';
import { selectNextTask } from './scheduler.js';
import { CalendarOccurrenceState, calendarAdmissionForSession } from './calendar-runtime.js';

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

export function healUnattendedManualHolds(session, now = Date.now(), { resumeMachinePause = true } = {}) {
  if (!session || session.retryPolicy === 'manual') return false;

  let changed = false;
  const operation = session.operation;
  const operationTask = operation?.taskId ? session.tasksById?.[operation.taskId] : null;
  const hadMachineHold = operation?.phase === OperationPhase.MANUAL_REVIEW
    || Object.values(session.tasksById || {}).some(task => task?.manualReviewReason || task?.status === 'MANUAL_REVIEW');
  if (!hadMachineHold) return false;

  const retryDelay = Math.max(1000, session.retryBackoffMs || 30000);
  for (const task of Object.values(session.tasksById || {})) {
    if (!task) continue;
    if (task.manualReviewReason) {
      task.manualReviewReason = '';
      changed = true;
    }
    if (task.status === 'MANUAL_REVIEW') {
      task.status = 'RETRY_WAIT';
      task.retryAfterAt = Math.max(task.retryAfterAt || 0, now + retryDelay);
      changed = true;
    }
  }

  if (operation?.phase === OperationPhase.MANUAL_REVIEW) {
    if (Number(operation.submitStartedAt || 0) > 0) {
      operation.phase = OperationPhase.AMBIGUOUS;
      if (operationTask) {
        operationTask.status = 'SUBMISSION_UNCERTAIN';
        operationTask.retryAfterAt = Math.max(operationTask.retryAfterAt || 0, now);
      }
    } else {
      operation.phase = OperationPhase.FAILED_SAFE;
      if (operationTask) {
        operationTask.status = 'RETRY_WAIT';
        operationTask.retryAfterAt = Math.max(operationTask.retryAfterAt || 0, now + retryDelay);
      }
    }
    operation.updatedAt = now;
    changed = true;
  }

  if (changed) {
    if (resumeMachinePause && session.runState === RunState.PAUSED && !session.pausedByMaster) {
      session.runState = operation?.phase === OperationPhase.AMBIGUOUS ? RunState.RECOVERING : RunState.RUNNING;
    } else if (session.runState === RunState.RUNNING && operation?.phase === OperationPhase.AMBIGUOUS) {
      session.runState = RunState.RECOVERING;
    }
    session.lastError = 'Legacy manual hold converted to unattended automatic recovery.';
    session.lastActionAt = now;
    session.updatedAt = now;
  }
  return changed;
}

function hasDurableNativePreEffectFocusLease(state, session) {
  const operation = session?.operation;
  if (operation?.phase !== OperationPhase.SUBMITTING || operation.nativeSubmitDispatched === true) return false;

  const previousTabId = Number(operation.previousSendTabId || 0);
  const previousWindowId = Number(operation.previousSendWindowId || 0);
  if (!Number.isInteger(previousTabId) || previousTabId <= 0
      || !Number.isInteger(previousWindowId) || previousWindowId <= 0) return false;

  const hintKey = session.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION
    ? `__session_worker__:${session.id}`
    : operation.taskId;
  const ownedTabId = Number(state.tabHintsByTaskId?.[hintKey]?.tabId || 0);
  return Number.isInteger(ownedTabId) && ownedTabId > 0 && ownedTabId !== previousTabId;
}

export function reconcileStateForStartup(state, now = Date.now()) {
  for (const session of Object.values(state.sessionsById)) {
    healUnattendedManualHolds(session, now, { resumeMachinePause: !state.profile?.masterPaused });
    const wasActive = session.runState === RunState.RUNNING || session.runState === RunState.RECOVERING;
    if (session.runState === RunState.RUNNING) session.runState = RunState.RECOVERING;
    if (session.operation?.phase === OperationPhase.SUBMITTING) {
      if (hasDurableNativePreEffectFocusLease(state, session)) {
        // activateOwnedSendTab() persists this focus lease before any debugger
        // attach/native click. If MV3 restarts in this exact window and the
        // native effect checkpoint is still absent, durable state proves that
        // no Send effect crossed the boundary. Settle fail-safe now; the
        // service-worker startup sequence restores owner focus immediately
        // afterwards and a later native-input message is rejected by phase.
        const operation = session.operation;
        const task = session.tasksById?.[operation.taskId];
        const retryDelay = Math.max(1000, session.retryBackoffMs || 30000);
        operation.phase = OperationPhase.FAILED_SAFE;
        operation.submitStartedAt = 0;
        operation.verificationDeadline = 0;
        operation.updatedAt = now;
        if (task) {
          task.status = 'RETRY_WAIT';
          task.retryAfterAt = Math.max(task.retryAfterAt || 0, now + retryDelay);
        }
        session.lastError = 'Native Send was interrupted before the effect boundary; a safe retry was scheduled.';
        session.lastActionAt = now;
        session.updatedAt = now;
        if (wasActive) session.runState = RunState.RECOVERING;
      } else {
        // Once the native effect checkpoint exists, or when this is not the
        // exact native focus-lease path, restart cannot prove zero effect.
        // Preserve the no-blind-resend invariant.
        session.operation.phase = OperationPhase.AMBIGUOUS;
        if (wasActive) session.runState = RunState.RECOVERING;
      }
    }
  }
  state.sendArbiter.lease = null;
  state.sendArbiter.profileNextAllowedSendAt = 0;
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

function calendarWakeForSession(session, now) {
  if (!session.calendarSchedule) return null;
  // Wake calculation must be observational. catch-up OFF admission can durably
  // reconcile missed occurrences, so evaluate a clone and leave persistence to
  // the runtime admission path.
  const admission = calendarAdmissionForSession(structuredClone(session), now);
  switch (admission.kind) {
    case CalendarOccurrenceState.WAITING:
      return Math.max(now, admission.wakeAt);
    case CalendarOccurrenceState.DUE:
    case CalendarOccurrenceState.MISSED_WAITING_CATCHUP:
    case CalendarOccurrenceState.MISSED_SKIPPED:
      return now;
    case 'EXHAUSTED':
      return null;
    default:
      return null;
  }
}

export function computeNextWake(state, now = Date.now()) {
  let earliest = Infinity;
  let retirementEarliest = Infinity;

  for (const hint of Object.values(state.tabHintsByTaskId || {})) {
    if (hint?.retirePending !== true || hint?.ownedByExtension !== true || !Number.isInteger(hint?.tabId)) continue;
    retirementEarliest = Math.min(retirementEarliest, Math.max(now, Number(hint.retireRetryAt || 0) || now));
  }

  for (const session of Object.values(state.sessionsById)) {
    for (const binding of session.drivePromptSources?.bindings || []) {
      if (binding?.enabled !== true || !binding.fileId) continue;
      const rawNextCheckAt = Number(binding.nextCheckAt || 0);
      const nextCheckAt = Number.isFinite(rawNextCheckAt) ? rawNextCheckAt : 0;
      earliest = Math.min(earliest, Math.max(now, nextCheckAt));
    }

    if (session.runState !== RunState.RUNNING && session.runState !== RunState.RECOVERING) continue;
    const phase = session.operation?.phase;
    if (phase === OperationPhase.MANUAL_REVIEW) continue;

    // An already-started effect/recovery obligation must reconcile regardless
    // of the next calendar occurrence. Calendar gates only admission of new
    // work; it must never hide AMBIGUOUS or pre-send durable evidence.
    if (phase === OperationPhase.PRE_SEND_WAIT) {
      const taskRetryAfter = session.tasksById?.[session.operation?.taskId]?.retryAfterAt || 0;
      earliest = Math.min(earliest, Math.max(now, session.operation.preSendDeadline || now, taskRetryAfter));
      continue;
    }

    if (phase === OperationPhase.AMBIGUOUS) {
      const taskRetryAfter = session.tasksById?.[session.operation?.taskId]?.retryAfterAt || 0;
      earliest = Math.min(earliest, Math.max(now, taskRetryAfter));
      continue;
    }

    const calendarWake = calendarWakeForSession(session, now);
    if (session.calendarSchedule) {
      if (calendarWake != null) earliest = Math.min(earliest, calendarWake);
      continue;
    }

    const schedulerWake = schedulerWakeForSession(session, now);
    if (schedulerWake != null) earliest = Math.min(earliest, schedulerWake);
  }

  const profileRateLimitUntil = Number(state.profile?.rateLimitUntil || 0);
  if (earliest < Infinity && profileRateLimitUntil > now) earliest = Math.max(earliest, profileRateLimitUntil);
  const wakeAt = Math.min(earliest, retirementEarliest);
  return wakeAt < Infinity ? wakeAt : null;
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
