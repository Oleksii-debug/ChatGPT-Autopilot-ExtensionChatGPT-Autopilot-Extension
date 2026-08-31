import { reconcileAlarm, reconcileStateForStartup, suspendActiveSessionsWhenExecutionUnavailable } from './recovery.js';
import { OperationPhase, RunState } from './schema.js';
import { appendLog } from './logger.js';

const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);
const PROFILE_BUSY_MESSAGE = 'Profile send arbiter is busy';
const RUNTIME_RETRY_MESSAGE = 'Automatic execution temporarily unavailable; retry scheduled.';
const INSERTION_RECOVERY_MESSAGE = 'Insertion outcome was not confirmed; a safe retry was scheduled.';
const PRE_SUBMIT_RECOVERY_MESSAGE = 'Pre-submit operation was interrupted; a safe retry was scheduled.';
const INTERRUPTED_PRE_SUBMIT_PHASES = new Set([
  OperationPhase.CHECKING,
  OperationPhase.READY,
  OperationPhase.INSERTING,
]);

function runtimeDiagnosticCode(error) {
  const explicit = String(error?.safeDiagnosticCode || '');
  if (/^[A-Z][A-Z0-9_]{2,79}$/.test(explicit)) return explicit;

  const message = String(error?.message || error || '');
  if (/frame with id .* was removed/i.test(message)) return 'INTERACTION_DOCUMENT_CHANGED';
  if (/receiving end does not exist|could not establish connection/i.test(message)) {
    return 'INTERACTION_RECEIVER_MISSING';
  }
  if (/no tab with id|tab .* not found/i.test(message)) return 'TAB_NOT_FOUND';
  if (/extension context invalidated/i.test(message)) return 'EXTENSION_CONTEXT_INVALIDATED';
  return 'RUNTIME_FAILURE_UNCLASSIFIED';
}

function orderedSessionIds(state) {
  const seen = new Set();
  const ids = [];
  for (const id of state.sessionOrder || []) {
    if (!seen.has(id) && state.sessionsById?.[id]) {
      ids.push(id);
      seen.add(id);
    }
  }
  for (const id of Object.keys(state.sessionsById || {})) {
    if (!seen.has(id)) ids.push(id);
  }
  return ids;
}

async function prepareStartupState(repository, executionAvailable, now) {
  return repository.update(draft => {
    reconcileStateForStartup(draft, now());
    if (!executionAvailable) suspendActiveSessionsWhenExecutionUnavailable(draft, now());
    return draft;
  });
}

export async function reconcileRuntimeColdStart({
  repository,
  chromeApi,
  executionAvailable = false,
  now = () => Date.now(),
}) {
  if (!repository || !chromeApi) throw new Error('Runtime cold-start dependencies are required');
  const state = await prepareStartupState(repository, executionAvailable, now);
  const wakeAt = await reconcileAlarm(chromeApi, state, now());
  return { state, wakeAt };
}

async function persistRuntimeFailure(repository, sessionId, error, now) {
  const diagnosticCode = runtimeDiagnosticCode(error);
  await repository.update(draft => {
    const session = draft.sessionsById?.[sessionId];
    if (!session || !ACTIVE_STATES.has(session.runState)) return draft;
    const retryAt = now + Math.max(1000, session.retryBackoffMs || 30000);
    const taskId = error?.autopilotTaskId
      || session.operation?.taskId
      || session.taskOrder?.[session.currentTaskIndex];
    if (taskId && session.tasksById?.[taskId]) {
      session.tasksById[taskId].status = 'RETRY_WAIT';
      session.tasksById[taskId].retryAfterAt = Math.max(
        session.tasksById[taskId].retryAfterAt || 0,
        retryAt,
      );
    }
    session.lastError = `${RUNTIME_RETRY_MESSAGE} Diagnostic: ${diagnosticCode}.`;
    session.lastActionAt = now;
    session.updatedAt = now;
    appendLog(draft, sessionId, `Runtime retry scheduled [${diagnosticCode}]`, {
      at: now,
      level: 'WARN',
    });
    return draft;
  });
  return diagnosticCode;
}

async function failSafeExpiredPreSubmit(repository, sessionId, result, expectedOperation, now) {
  if (result?.kind !== 'OPERATION_IN_PROGRESS'
      || !INTERRUPTED_PRE_SUBMIT_PHASES.has(result.phase)
      || !expectedOperation
      || result.phase !== expectedOperation.phase) {
    return result;
  }

  let reconciled = false;
  let retryAt = 0;
  await repository.update(draft => {
    const session = draft.sessionsById?.[sessionId];
    const operation = session?.operation;
    if (!session
        || !ACTIVE_STATES.has(session.runState)
        || operation?.phase !== expectedOperation.phase
        || operation.operationId !== expectedOperation.operationId) {
      return draft;
    }

    const task = session.tasksById?.[operation.taskId];
    if (!task || (task.retryAfterAt || 0) > now) return draft;

    retryAt = now + Math.max(1000, session.retryBackoffMs || 30000);
    task.retryAfterAt = Math.max(task.retryAfterAt || 0, retryAt);
    task.status = 'RETRY_WAIT';
    operation.phase = OperationPhase.FAILED_SAFE;
    operation.updatedAt = now;
    session.lastError = expectedOperation.phase === OperationPhase.INSERTING
      ? INSERTION_RECOVERY_MESSAGE
      : PRE_SUBMIT_RECOVERY_MESSAGE;
    session.lastActionAt = now;
    session.updatedAt = now;
    reconciled = true;
    return draft;
  });

  if (!reconciled) return result;
  return expectedOperation.phase === OperationPhase.INSERTING
    ? { kind: 'INSERTION_RECOVERY_RETRY', wakeAt: retryAt }
    : { kind: 'PRE_SUBMIT_RECOVERY_RETRY', phase: expectedOperation.phase, wakeAt: retryAt };
}

export async function runRuntimeCycle({
  repository,
  chromeApi,
  executor,
  startup = false,
  executionAvailable = false,
  now = () => Date.now(),
}) {
  if (!repository || !chromeApi || !executor) throw new Error('Runtime dependencies are required');

  const state = startup
    ? await prepareStartupState(repository, executionAvailable, now)
    : await repository.load();

  const outcomes = [];
  if (executionAvailable) {
    for (const sessionId of orderedSessionIds(state)) {
      const live = await repository.load();
      const session = live.sessionsById?.[sessionId];
      if (!session || !ACTIVE_STATES.has(session.runState)) continue;
      const expectedPreSubmitOperation = INTERRUPTED_PRE_SUBMIT_PHASES.has(session.operation?.phase)
        ? { operationId: session.operation.operationId, phase: session.operation.phase }
        : null;
      try {
        const rawResult = await executor.runSessionOnce(sessionId);
        const result = await failSafeExpiredPreSubmit(
          repository,
          sessionId,
          rawResult,
          expectedPreSubmitOperation,
          now(),
        );
        outcomes.push({ sessionId, result });
      } catch (error) {
        const message = error?.message || '';
        if (message === PROFILE_BUSY_MESSAGE) {
          outcomes.push({ sessionId, result: { kind: 'PROFILE_BUSY' } });
          continue;
        }
        const diagnosticCode = await persistRuntimeFailure(repository, sessionId, error, now());
        outcomes.push({ sessionId, result: { kind: 'TEMPORARY_RUNTIME_ERROR', diagnosticCode } });
      }
    }
  }

  const finalState = await repository.load();
  const wakeAt = await reconcileAlarm(chromeApi, finalState, now());
  return { state: finalState, outcomes, wakeAt };
}

export const RuntimeExecutionConstants = Object.freeze({
  RUNTIME_RETRY_MESSAGE,
  INSERTION_RECOVERY_MESSAGE,
  PRE_SUBMIT_RECOVERY_MESSAGE,
});
