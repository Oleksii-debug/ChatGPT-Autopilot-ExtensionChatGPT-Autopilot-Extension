import { reconcileAlarm, reconcileStateForStartup, suspendActiveSessionsWhenExecutionUnavailable } from './recovery.js';
import { OperationPhase, RunState, TabStrategy } from './schema.js';
import { appendLog } from './logger.js';
import { appendDiagnostic } from './diagnostics.js';
import { orderedSessionIdsForFairness } from './scheduler-fairness.js';

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

const SHARED_URL_SESSION_RETRY_CODES = new Set([
  'TAB_NAVIGATION_TIMEOUT',
  'TAB_UNAVAILABLE_DURING_READINESS_CHECK',
  'CHATGPT_PAGE_UNAVAILABLE',
  'INTERACTION_RECEIVER_RESTORE_FAILED',
  'INTERACTION_RECEIVER_STILL_MISSING',
  'INTERACTION_RECEIVER_LOST_DURING_UI_READINESS',
]);

const DEAD_OWNED_TAB_CODES = new Set([
  'TAB_UNAVAILABLE_DURING_READINESS_CHECK',
  'TAB_NOT_FOUND',
  'TAB_NAVIGATION_TIMEOUT',
  'TAB_NAVIGATION_URL_MISMATCH',
  'INTERACTION_RECEIVER_RESTORE_FAILED',
  'INTERACTION_RECEIVER_STILL_MISSING',
  'INTERACTION_RECEIVER_LOST_DURING_UI_READINESS',
]);
const SAFE_PRE_SUBMIT_PHASES = new Set([
  OperationPhase.CHECKING,
  OperationPhase.READY,
  OperationPhase.INSERTING,
  OperationPhase.INSERTED,
  OperationPhase.PRE_SEND_WAIT,
]);

const POST_SUBMIT_EVIDENCE_PRESERVE_CODES = new Set([
  'TAB_NAVIGATION_TIMEOUT',
  'TAB_NAVIGATION_URL_MISMATCH',
  'INTERACTION_RECEIVER_RESTORE_FAILED',
  'INTERACTION_RECEIVER_STILL_MISSING',
  'INTERACTION_RECEIVER_LOST_DURING_UI_READINESS',
]);
const workerHintKey = sessionId => `__session_worker__:${sessionId}`;

export const DEFAULT_MAX_CONCURRENT_SESSION_OPERATIONS = 10;
export const MAX_CONCURRENT_SESSION_OPERATIONS = 32;

function runtimeConcurrency(state) {
  const raw = Number(state?.profile?.maxConcurrentSessionOperations);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_CONCURRENT_SESSION_OPERATIONS;
  return Math.max(1, Math.min(MAX_CONCURRENT_SESSION_OPERATIONS, Math.floor(raw)));
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const RETIRE_RETRY_MIN_MS = 1000;
const RETIRE_RETRY_MAX_MS = 60000;

function retirementRetryDelay(attempts) {
  const exponent = Math.max(0, Math.min(6, Number(attempts || 1) - 1));
  return Math.min(RETIRE_RETRY_MAX_MS, RETIRE_RETRY_MIN_MS * (2 ** exponent));
}

async function retryPendingOwnedTabRetirements(repository, chromeApi, now) {
  const snapshot = await repository.load();
  const targets = Object.entries(snapshot.tabHintsByTaskId || {})
    .filter(([, hint]) => hint?.retirePending === true
      && hint?.ownedByExtension === true
      && Number.isInteger(hint?.tabId)
      && Number(hint?.retireRetryAt || 0) <= now)
    .map(([hintKey, hint]) => ({ hintKey, sessionId: hint.sessionId, tabId: hint.tabId }));

  for (const target of targets) {
    let retired = false;
    try {
      await chromeApi.tabs?.remove?.(target.tabId);
      retired = true;
    } catch (_) {
      try {
        await chromeApi.tabs?.get?.(target.tabId);
      } catch {
        retired = true;
      }
    }

    await repository.update(draft => {
      const hint = draft.tabHintsByTaskId?.[target.hintKey];
      if (!hint || hint.sessionId !== target.sessionId || hint.tabId !== target.tabId
          || hint.retirePending !== true || hint.ownedByExtension !== true) return draft;
      if (retired) {
        delete draft.tabHintsByTaskId[target.hintKey];
        appendDiagnostic(draft, {
          event: 'ОЧІКУВАНУ_ВЛАСНУ_ВКЛАДКУ_ЗАКРИТО',
          sessionId: target.sessionId,
          taskId: target.hintKey,
          tabId: target.tabId,
          message: 'Відкладене фізичне закриття підтверджено; durable ownership прибрано.',
        }, { at: now });
      } else {
        const attempts = Number(hint.retireAttempts || 0) + 1;
        hint.retireAttempts = attempts;
        hint.retireRetryAt = now + retirementRetryDelay(attempts);
        appendDiagnostic(draft, {
          event: 'ЗАКРИТТЯ_ВЛАСНОЇ_ВКЛАДКИ_ПОВТОРИТЬСЯ',
          sessionId: target.sessionId,
          taskId: target.hintKey,
          tabId: target.tabId,
          message: `Chrome ще не закрив власну вкладку; наступна спроба запланована з backoff. Спроба ${attempts}.`,
        }, { at: now });
      }
      return draft;
    });
  }
}


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
    if (session.urlMode === 'shared' && SHARED_URL_SESSION_RETRY_CODES.has(diagnosticCode)) {
      for (const candidateId of session.taskOrder || []) {
        const candidate = session.tasksById?.[candidateId];
        if (!candidate?.enabled || candidate.manualReviewReason) continue;
        candidate.retryAfterAt = Math.max(candidate.retryAfterAt || 0, retryAt);
      }
    }
    if (DEAD_OWNED_TAB_CODES.has(diagnosticCode)
        && session.operation?.taskId === taskId
        && Number(session.operation.submitStartedAt || 0) <= 0
        && SAFE_PRE_SUBMIT_PHASES.has(session.operation.phase)) {
      session.operation.phase = OperationPhase.FAILED_SAFE;
      session.operation.updatedAt = now;
    }
    session.lastError = `${RUNTIME_RETRY_MESSAGE} Diagnostic: ${diagnosticCode}.`;
    session.lastActionAt = now;
    session.updatedAt = now;
    appendLog(draft, sessionId, `Runtime retry scheduled [${diagnosticCode}]`, {
      at: now,
      level: 'WARN',
    });
    appendDiagnostic(draft, {
      event: 'ПОВТОРНУ_СПРОБУ_ЗАПЛАНОВАНО',
      sessionId,
      taskId,
      mode: error?.autopilotMode,
      phase: session.operation?.phase,
      code: diagnosticCode,
      message: session.lastError,
      promptFingerprint: session.operation?.promptFingerprint,
    }, { at: now });
    return draft;
  });
  return diagnosticCode;
}

async function resetDeadOwnedTab(repository, chromeApi, sessionId, diagnosticCode, now) {
  if (!DEAD_OWNED_TAB_CODES.has(diagnosticCode)) return false;
  let tabId = null;
  let taskId = null;
  let hintKey = null;
  let shouldClose = false;
  let preservedPostSubmitEvidence = false;
  await repository.update(draft => {
    const session = draft.sessionsById?.[sessionId];
    if (!session) return draft;
    taskId = session.operation?.taskId || session.taskOrder?.[session.currentTaskIndex] || null;
    const unresolvedPostSubmitEvidence = session.operation?.taskId === taskId
      && [OperationPhase.SUBMITTING, OperationPhase.AMBIGUOUS].includes(session.operation?.phase)
      && Number(session.operation?.submitStartedAt || 0) > 0;
    if (unresolvedPostSubmitEvidence && POST_SUBMIT_EVIDENCE_PRESERVE_CODES.has(diagnosticCode)) {
      preservedPostSubmitEvidence = true;
      appendDiagnostic(draft, {
        event: 'ДОКАЗОВУ_ВКЛАДКУ_ПІСЛЯ_SEND_ЗБЕРЕЖЕНО',
        sessionId,
        taskId,
        code: diagnosticCode,
        message: 'Після фізичної спроби Send транспортна/навігаційна помилка не є доказом смерті вкладки; ownership збережено до bounded recovery.',
      }, { at: now });
      return draft;
    }
    if ((session.tabStrategy === TabStrategy.OPEN_CLOSE_PER_TASK
        || session.tabStrategy === TabStrategy.KEEP_TASK_TABS_OPEN) && taskId) hintKey = taskId;
    else if (session.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION) hintKey = workerHintKey(sessionId);
    else return draft;
    const hint = draft.tabHintsByTaskId?.[hintKey];
    if (!hint || hint.sessionId !== sessionId || hint.tabId == null) return draft;
    tabId = hint.tabId;
    // OPEN_CLOSE tabs have always been extension-created, including persisted
    // hints from releases before ownedByExtension was explicit. Worker tabs may
    // be adopted user tabs, so close only when provenance is explicit.
    shouldClose = session.tabStrategy === TabStrategy.OPEN_CLOSE_PER_TASK
      || hint.ownedByExtension === true;
    if (!shouldClose) {
      delete draft.tabHintsByTaskId[hintKey];
      appendDiagnostic(draft, {
        event: 'МЕРТВУ_ПРИВЯЗКУ_ВКЛАДКИ_СКИНУТО_БЕЗ_ЗАКРИТТЯ',
        sessionId,
        taskId,
        tabId,
        code: diagnosticCode,
        message: 'Прив’язку до чужої/успадкованої worker-вкладки скинуто без фізичного закриття.',
      }, { at: now });
      return draft;
    }
    hint.ownedByExtension = true;
    hint.retirePending = true;
    appendDiagnostic(draft, {
      event: 'МЕРТВУ_РОБОЧУ_ВКЛАДКУ_ПОЗНАЧЕНО_ДЛЯ_ЗАКРИТТЯ',
      sessionId,
      taskId,
      tabId,
      code: diagnosticCode,
      message: 'Власну робочу вкладку буде забуто лише після підтвердженого фізичного закриття.',
    }, { at: now });
    return draft;
  });
  if (preservedPostSubmitEvidence) return false;
  if (tabId == null || !shouldClose) return tabId != null;

  let closed = false;
  try {
    await chromeApi.tabs?.remove?.(tabId);
    closed = true;
  } catch (_) {
    try {
      await chromeApi.tabs?.get?.(tabId);
    } catch {
      closed = true;
    }
  }
  if (!closed) return false;

  await repository.update(draft => {
    const hint = draft.tabHintsByTaskId?.[hintKey];
    if (hint?.sessionId === sessionId && hint?.tabId === tabId) {
      delete draft.tabHintsByTaskId[hintKey];
    }
    appendDiagnostic(draft, {
      event: 'МЕРТВУ_РОБОЧУ_ВКЛАДКУ_ЗАКРИТО',
      sessionId,
      taskId,
      tabId,
      code: diagnosticCode,
      message: 'Власну робочу вкладку підтверджено закритою; наступний цикл може створити чисту вкладку.',
    }, { at: now });
    return draft;
  });
  return true;
}

async function persistRuntimeOutcome(repository, sessionId, result, now) {
  await repository.update(draft => {
    const session = draft.sessionsById?.[sessionId];
    if (!session) return draft;
    const taskId = session.operation?.taskId
      || session.taskOrder?.[session.currentTaskIndex]
      || null;
    const wakeDescription = Number.isFinite(result?.wakeAt)
      ? ` Наступна перевірка не раніше ${new Date(result.wakeAt).toISOString()}.`
      : '';
    appendDiagnostic(draft, {
      event: 'ЦИКЛ_ВИКОНАННЯ_ЗАВЕРШЕНО',
      sessionId,
      taskId,
      phase: session.operation?.phase,
      runState: session.runState,
      status: result?.status,
      code: result?.diagnosticCode || result?.kind,
      message: result?.kind
        ? `Результат циклу: ${result.kind}.${wakeDescription}`
        : 'Цикл завершено без деталізованого результату.',
      promptFingerprint: session.operation?.promptFingerprint,
    }, { at: now });
    return draft;
  });
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

  // Cleanup obligations are independent of RunState. In particular, an owner
  // may Stop the final active Session exactly when Chrome transiently refuses
  // tabs.remove. Retry those durable obligations before scheduling/executing
  // new browser work so stopped Sessions cannot strand extension-owned tabs.
  await retryPendingOwnedTabRetirements(repository, chromeApi, now());

  const outcomes = [];
  if (executionAvailable) {
    const orderedIds = orderedSessionIdsForFairness(state);
    const concurrentOutcomes = await mapWithConcurrency(
      orderedIds,
      runtimeConcurrency(state),
      async sessionId => {
        const live = await repository.load();
        const session = live.sessionsById?.[sessionId];
        if (!session || !ACTIVE_STATES.has(session.runState)) return null;
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
          await persistRuntimeOutcome(repository, sessionId, result, now());
          return { sessionId, result };
        } catch (error) {
          const message = error?.message || '';
          if (message === PROFILE_BUSY_MESSAGE) {
            const result = { kind: 'PROFILE_BUSY' };
            await persistRuntimeOutcome(repository, sessionId, result, now());
            return { sessionId, result };
          }
          const failureNow = now();
          const diagnosticCode = await persistRuntimeFailure(repository, sessionId, error, failureNow);
          await resetDeadOwnedTab(repository, chromeApi, sessionId, diagnosticCode, failureNow);
          const result = { kind: 'TEMPORARY_RUNTIME_ERROR', diagnosticCode };
          await persistRuntimeOutcome(repository, sessionId, result, now());
          return { sessionId, result };
        }
      },
    );
    outcomes.push(...concurrentOutcomes.filter(Boolean));
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
