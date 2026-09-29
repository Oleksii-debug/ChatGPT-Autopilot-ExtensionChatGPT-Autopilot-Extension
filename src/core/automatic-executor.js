import { releaseSendLease, DEFAULT_PROFILE_SEND_GAP_MS } from './arbiter.js';
import { applyInteractionResult, RATE_LIMIT_BACKOFF_MS } from './execution.js';
import { DurableSubmissionCoordinator } from './runner.js';
import { selectNextTask } from './scheduler.js';
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS, MIN_RATE_LIMIT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS, OperationPhase, PromptMode, RunMode, RunState, TabStrategy, isExclusiveConversationUrl } from './schema.js';
import { restorePendingSendTabs } from './native-input.js';
import { resolveTaskTab } from './tabs.js';
import { InteractionResult } from '../shared/protocol.js';
import { appendDiagnostic } from './diagnostics.js';
import { appendLog } from './logger.js';
import { AgentProviderId } from './capability-registry.js';
import { promptForVerifiedSendOrdinal } from './session-prompt-cadence.js';

const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);
const QUIESCENT_STATES = new Set([RunState.PAUSED, RunState.STOPPED]);
const TERMINAL_OPERATION_PHASES = new Set([
  OperationPhase.NONE,
  OperationPhase.SENT_VERIFIED,
  OperationPhase.FAILED_SAFE,
]);
const INTERRUPTED_PRE_SUBMIT_PHASES = new Set([
  OperationPhase.INSERTED,
]);
const OPEN_CLOSE_TERMINAL_RESULTS = new Set([
  InteractionResult.BUSY,
  InteractionResult.SENT_VERIFIED,
  InteractionResult.TEMPORARY_ERROR,
  InteractionResult.RATE_LIMITED,
]);
const NORMAL_WORK_CONFIRMED_RESULTS = new Set([
  InteractionResult.READY,
  InteractionResult.BUSY,
]);

function requireSession(state, sessionId) {
  const session = state.sessionsById[sessionId];
  if (!session) throw new Error('Session not found');
  return session;
}

function taskIndex(session, taskId) {
  const index = session.taskOrder.indexOf(taskId);
  if (index < 0) throw new Error('Task not found in session');
  return index;
}

export function composePromptForSession(session, task) {
  const primaryPrompt = session.promptMode === PromptMode.UNIQUE ? task.promptOverride : session.sharedPrompt;
  const basePrompt = promptForVerifiedSendOrdinal(session, primaryPrompt);
  const handoff = typeof session.aiCoordinatorHandoff === 'string' ? session.aiCoordinatorHandoff.trim() : '';
  if (!handoff) return basePrompt;
  return `${basePrompt}

===== ЛОКАЛЬНИЙ AI-КООРДИНАТОР: HANDOFF ДЛЯ ЦЬОГО ЗАПУСКУ =====
${handoff}
===== КІНЕЦЬ HANDOFF =====`;
}

function resumeUnlessQuiesced(session, priorRunState) {
  session.runState = QUIESCENT_STATES.has(priorRunState) ? priorRunState : RunState.RUNNING;
}

function matchesOperation(operation, expected, phase) {
  return operation?.phase === phase
    && operation.operationId === expected.operationId
    && operation.taskId === expected.taskId
    && operation.promptFingerprint === expected.promptFingerprint;
}


function exclusiveConversationIdentity(url) {
  try {
    const parsed = new URL(url);
    const id = parsed.pathname.match(/(?:^|\/)c\/([^/]+)/u)?.[1] || '';
    return id ? `${parsed.hostname.toLowerCase()}:${id}` : '';
  } catch {
    return '';
  }
}

function activeConversationHintConflict(state, sessionId, normalizedUrl) {
  const identity = exclusiveConversationIdentity(normalizedUrl);
  if (!identity) return null;
  for (const hint of Object.values(state?.tabHintsByTaskId || {})) {
    if (!hint?.sessionId || hint.sessionId === sessionId) continue;
    const owner = state.sessionsById?.[hint.sessionId];
    if (!owner || !ACTIVE_STATES.has(owner.runState)) continue;
    if (exclusiveConversationIdentity(hint.normalizedUrl || '') === identity) return hint;
  }
  return null;
}

function attachTaskContext(error, taskId, fallbackDiagnosticCode) {
  const value = error instanceof Error ? error : new Error(String(error || 'Task execution failed'));
  if (!value.safeDiagnosticCode) value.safeDiagnosticCode = fallbackDiagnosticCode;
  if (!value.autopilotTaskId) value.autopilotTaskId = taskId;
  return value;
}

export class AutomaticSessionExecutor {
  constructor(repository, chromeApi, transport, {
    now = () => Date.now(),
    cryptoApi = globalThis.crypto,
    profileGapMs = DEFAULT_PROFILE_SEND_GAP_MS,
  } = {}) {
    this.repo = repository;
    this.chrome = chromeApi;
    this.transport = transport;
    this.now = now;
    this.coordinator = new DurableSubmissionCoordinator(repository, { now, cryptoApi, profileGapMs });
    this.tabBindQueues = new Map();
  }

  async bindTaskTab(sessionId, taskId) {
    const initial = await this.repo.load();
    const initialSession = requireSession(initial, sessionId);
    const initialTask = initialSession.tasksById[taskId];
    if (!initialTask) throw new Error('Task not found');
    const conversationIdentity = exclusiveConversationIdentity(initialTask.normalizedUrl);
    const queueKey = conversationIdentity ? `conversation:${conversationIdentity}` : `session:${sessionId}`;
    const prior = this.tabBindQueues.get(queueKey) || Promise.resolve();
    const operation = prior.catch(() => undefined).then(async () => {
      try {
        // Chrome tab I/O must never run while StorageRepository.update owns its
        // serialized state-write queue. Exact /c/<id> conversation ownership is
        // serialized only against that same conversation identity; unrelated tabs
        // still bind in parallel.
        const snapshot = await this.repo.load();
        const session = requireSession(snapshot, sessionId);
        const task = session.tasksById[taskId];
        if (!task) throw new Error('Task not found');
        if (conversationIdentity && exclusiveConversationIdentity(task.normalizedUrl) !== conversationIdentity) {
          const changed = new Error('Task conversation changed during tab binding');
          changed.safeDiagnosticCode = 'TAB_CONVERSATION_CHANGED_DURING_BIND';
          throw changed;
        }
        const conflict = activeConversationHintConflict(snapshot, sessionId, task.normalizedUrl);
        if (conflict) {
          const error = new Error('Another active Session already owns this exact ChatGPT conversation');
          error.safeDiagnosticCode = 'TAB_CONVERSATION_OWNERSHIP_CONFLICT';
          throw error;
        }
        const tab = await resolveTaskTab(this.chrome, snapshot, sessionId, task);
        const hintKey = session.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION
          ? `__session_worker__:${sessionId}`
          : taskId;
        const resolvedHint = snapshot.tabHintsByTaskId?.[hintKey];
        if (!resolvedHint || resolvedHint.tabId !== tab.id || resolvedHint.sessionId !== sessionId) {
          throw new Error('Resolved tab ownership was not recorded in snapshot');
        }

        await this.repo.update(draft => {
          const live = requireSession(draft, sessionId);
          const liveTask = live.tasksById[taskId];
          if (!liveTask) throw new Error('Task not found');
          if (liveTask.normalizedUrl !== task.normalizedUrl) {
            throw new Error('Task target changed during tab binding');
          }
          draft.tabHintsByTaskId[hintKey] = structuredClone(resolvedHint);
          appendDiagnostic(draft, {
            event: 'ВКЛАДКУ_ПІДГОТОВЛЕНО',
            sessionId,
            taskId,
            tabId: tab.id,
            target: liveTask.normalizedUrl || liveTask.url,
            phase: live.operation?.phase,
          }, { at: this.now() });
          return draft;
        });
        return tab;
      } catch (error) {
        throw attachTaskContext(error, taskId, 'TASK_TAB_BIND_FAILED');
      }
    });
    this.tabBindQueues.set(queueKey, operation);
    try {
      return await operation;
    } finally {
      if (this.tabBindQueues.get(queueKey) === operation) this.tabBindQueues.delete(queueKey);
    }
  }

  request(session, task, mode, requestId, promptText) {
    const providerId = session?.orchestrationWorker?.agentProviderId
      || session?.orchestrationCoordinator?.agentProviderId
      || AgentProviderId.CHATGPT_BROWSER;
    return {
      requestId,
      taskId: task.id,
      providerId,
      mode,
      expectedUrl: task.normalizedUrl || task.url,
      promptText,
      recoveryLaunchUrl: mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT'
        ? (session.operation?.launchUrl || '')
        : '',
    };
  }

  async executeInteraction(sessionId, session, task, tabId, mode, requestId, promptText) {
    const request = this.request(session, task, mode, requestId, promptText);
    await this.repo.update(draft => {
      appendDiagnostic(draft, {
        event: 'ЗАПИТ_ДО_СТОРІНКИ',
        sessionId,
        taskId: task.id,
        tabId,
        mode,
        phase: session.operation?.phase,
        target: request.expectedUrl,
      }, { at: this.now() });
      return draft;
    });
    try {
      const result = await this.transport.execute(tabId, request);
      await this.repo.update(draft => {
        appendDiagnostic(draft, {
          event: 'ВІДПОВІДЬ_ВІД_СТОРІНКИ',
          sessionId,
          taskId: task.id,
          tabId,
          mode,
          phase: session.operation?.phase,
          status: result.status,
          code: result.safeDiagnosticCode,
          message: result.safeDiagnosticMessage,
          observed: result.normalizedObservedUrl,
          target: request.expectedUrl,
          promptFingerprint: session.operation?.promptFingerprint,
        }, { at: this.now() });
        return draft;
      });
      return result;
    } catch (error) {
      await this.repo.update(draft => {
        appendDiagnostic(draft, {
          event: 'ПОМІЛКА_ВЗАЄМОДІЇ_ЗІ_СТОРІНКОЮ',
          sessionId,
          taskId: task.id,
          tabId,
          mode,
          phase: session.operation?.phase,
          code: error?.safeDiagnosticCode || 'INTERACTION_FAILURE',
          message: error?.message || error,
          target: request.expectedUrl,
          promptFingerprint: session.operation?.promptFingerprint,
        }, { at: this.now() });
        return draft;
      });
      throw error;
    } finally {
      if (mode === 'SUBMIT_EXISTING') {
        try { await restorePendingSendTabs(this.chrome, this.repo, { sessionId }); }
        catch (_) { /* Cold-start reconciliation retries the durable restoration. */ }
      }
    }
  }

  async closeOpenCloseTabAfterTerminalResult(sessionId, taskId, result) {
    let tabId = null;
    let target = '';
    await this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      const operation = session.operation;
      const operationForTask = operation?.taskId === taskId ? operation : null;
      const unattendedPreSubmitReset = session.retryPolicy !== 'manual'
        && [
          InteractionResult.AUTH_REQUIRED,
          InteractionResult.UNKNOWN_UI,
          InteractionResult.MANUAL_REVIEW_REQUIRED,
        ].includes(result?.status)
        && (!operationForTask || !operationForTask.submitStartedAt);
      if (!OPEN_CLOSE_TERMINAL_RESULTS.has(result?.status) && !unattendedPreSubmitReset) return draft;
      if (session.tabStrategy !== TabStrategy.OPEN_CLOSE_PER_TASK) return draft;
      const task = session.tasksById[taskId];
      const hint = draft.tabHintsByTaskId?.[taskId];
      if (!task || !hint || hint.sessionId !== sessionId
          || hint.kind !== 'TASK' || hint.tabId == null) return draft;
      const unresolvedForTask = operationForTask
        && !TERMINAL_OPERATION_PHASES.has(operationForTask.phase);
      if (unresolvedForTask && result.status !== InteractionResult.SENT_VERIFIED) {
        appendDiagnostic(draft, {
          event: 'ВКЛАДКУ_ЗБЕРЕЖЕНО_ДЛЯ_ВІДНОВЛЕННЯ',
          sessionId,
          taskId,
          tabId: hint.tabId,
          status: result.status,
          phase: operationForTask.phase,
          target: task.normalizedUrl || task.url,
        }, { at: this.now() });
        return draft;
      }
      tabId = hint.tabId;
      target = task.normalizedUrl || task.url;
      appendDiagnostic(draft, {
        event: 'ЗАКРИТТЯ_ВКЛАДКИ_ЗАПЛАНОВАНО',
        sessionId,
        taskId,
        tabId,
        status: result.status,
        target,
      }, { at: this.now() });
      return draft;
    });
    if (tabId == null) return false;
    try {
      await this.chrome.tabs.remove(tabId);
      await this.repo.update(draft => {
        const hint = draft.tabHintsByTaskId?.[taskId];
        if (hint?.sessionId === sessionId && hint?.kind === 'TASK' && hint?.tabId === tabId) {
          delete draft.tabHintsByTaskId[taskId];
        }
        appendDiagnostic(draft, {
          event: 'ВКЛАДКУ_ЗАКРИТО',
          sessionId,
          taskId,
          tabId,
          status: result.status,
          target,
        }, { at: this.now() });
        return draft;
      });
      return true;
    } catch (error) {
      await this.repo.update(draft => {
        // Keep the ownership hint after a failed close and mark it for mandatory
        // retirement. A later cycle must close (or prove absence of) this exact
        // extension-owned tab before it can reuse/open a replacement.
        const hint = draft.tabHintsByTaskId?.[taskId];
        if (hint?.sessionId === sessionId && hint?.kind === 'TASK' && hint?.tabId === tabId) {
          hint.ownedByExtension = true;
          hint.retirePending = true;
        }
        appendDiagnostic(draft, {
          event: 'НЕ_ВДАЛОСЯ_ЗАКРИТИ_ВКЛАДКУ',
          sessionId,
          taskId,
          tabId,
          status: result.status,
          target,
          code: 'TAB_CLOSE_FAILED',
          message: error?.message || error,
        }, { at: this.now() });
        return draft;
      });
      return false;
    }
  }

  async persistVerifiedConversationBinding(sessionId, taskId, tabId, result) {
    if (result?.status !== InteractionResult.SENT_VERIFIED) return { bound: false, url: '' };

    let conversationUrl = typeof result?.normalizedObservedUrl === 'string'
      ? result.normalizedObservedUrl.trim()
      : '';

    if (!isExclusiveConversationUrl(conversationUrl) && Number.isInteger(tabId) && this.chrome?.tabs?.get) {
      try {
        const tab = await this.chrome.tabs.get(tabId);
        if (isExclusiveConversationUrl(tab?.url || '')) conversationUrl = tab.url;
      } catch (_) {
        // Keep the verified Send and fail closed for hierarchy completion if no
        // concrete conversation identity can be proven.
      }
    }

    if (!isExclusiveConversationUrl(conversationUrl)) return { bound: false, url: '' };

    let bound = false;
    await this.repo.update(draft => {
      const live = requireSession(draft, sessionId);
      const task = live.tasksById?.[taskId];
      if (!task || Number(task.lastVerifiedSendAt || 0) <= 0) return draft;
      task.lastConversationUrl = conversationUrl;
      if (Number.isInteger(Number(result?.assistantBaselineCount)) && Number(result.assistantBaselineCount) >= 0) {
        task.lastAssistantBaselineCount = Number(result.assistantBaselineCount);
        task.lastAssistantBaselineKnown = true;
      }
      bound = true;
      return draft;
    });
    return { bound, url: conversationUrl };
  }

  async applyResult(sessionId, taskId, result, promptFingerprint = '') {
    const now = this.now();
    return this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      const rawRateLimitCooldownMs = Number(draft.profile?.rateLimitCooldownMs);
      const rateLimitCooldownMs = Number.isFinite(rawRateLimitCooldownMs)
        ? Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, Math.max(MIN_RATE_LIMIT_COOLDOWN_MS, rawRateLimitCooldownMs))
        : DEFAULT_RATE_LIMIT_COOLDOWN_MS;

      let rateLimitRetryAt = 0;
      let openedNewProfileGate = false;
      if (result?.status === InteractionResult.RATE_LIMITED) {
        const existingGate = Number(draft.profile?.rateLimitUntil || 0);
        if (rateLimitCooldownMs > 0 && existingGate > now) {
          rateLimitRetryAt = existingGate;
        } else if (rateLimitCooldownMs > 0) {
          rateLimitRetryAt = now + rateLimitCooldownMs;
          draft.profile.rateLimitUntil = rateLimitRetryAt;
          openedNewProfileGate = true;
        } else {
          draft.profile.rateLimitUntil = 0;
        }
      }

      applyInteractionResult(session, taskIndex(session, taskId), result, {
        now,
        promptFingerprint,
        rateLimitBackoffMs: rateLimitCooldownMs,
        rateLimitRetryAt,
      });

      if (result?.status === InteractionResult.RATE_LIMITED) {
        session.lastError = rateLimitCooldownMs > 0
          ? 'ChatGPT тимчасово обмежив запити. Робота цього профілю автоматично продовжиться після налаштованої спільної паузи.'
          : 'ChatGPT тимчасово обмежив запити. Резервна пауза профілю вимкнена; застосовано лише технічну затримку повторної перевірки.';
        session.lastActionAt = now;
        session.updatedAt = now;
        appendDiagnostic(draft, {
          event: rateLimitCooldownMs === 0
            ? 'RATE_LIMIT_БЕЗ_РЕЗЕРВНОЇ_ПАУЗИ'
            : openedNewProfileGate
              ? 'ГЛОБАЛЬНА_ПАУЗА_ЧЕРЕЗ_RATE_LIMIT'
              : 'RATE_LIMIT_ВЖЕ_ВРАХОВАНО',
          sessionId,
          taskId,
          status: InteractionResult.RATE_LIMITED,
          code: result.safeDiagnosticCode || 'RATE_LIMITED',
          message: rateLimitCooldownMs === 0
            ? 'Підтверджено обмеження акаунта. Додаткова спільна резервна пауза вимкнена; діє лише технічний retry/backoff.'
            : openedNewProfileGate
              ? `Підтверджено обмеження акаунта. Профіль не створюватиме нових запитів до ${new Date(rateLimitRetryAt).toISOString()}.`
              : `Ще одна паралельна вкладка побачила те саме обмеження. Чинну паузу до ${new Date(rateLimitRetryAt).toISOString()} не продовжено.`,
        }, { at: now });
      }
      return draft;
    });
  }

  async markNormalWorkResumed(sessionId, taskId) {
    let changed = false;
    await this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      const phase = session.operation?.phase || OperationPhase.NONE;
      if (session.runState !== RunState.RECOVERING || !TERMINAL_OPERATION_PHASES.has(phase)) {
        return draft;
      }
      session.runState = RunState.RUNNING;
      session.updatedAt = this.now();
      appendDiagnostic(draft, {
        event: 'ВІДНОВЛЕННЯ_ЗАВЕРШЕНО',
        sessionId,
        taskId,
        runState: RunState.RUNNING,
        phase,
        message: 'Зв’язок із розмовою підтверджено; сеанс повернувся до звичайної роботи.',
      }, { at: this.now() });
      changed = true;
      return draft;
    });
    return changed;
  }

  async settleExpiredOrdinaryAmbiguous(sessionId, task, expectedOperation, result) {
    const now = this.now();
    let settled = false;
    let wakeAt = now + 5000;
    await this.repo.update(draft => {
      const live = requireSession(draft, sessionId);
      const liveOperation = live.operation;
      if (!matchesOperation(liveOperation, expectedOperation, OperationPhase.AMBIGUOUS)) return draft;
      const liveTask = live.tasksById[expectedOperation.taskId];
      if (!liveTask) return draft;

      // At-most-once safety and liveness must both hold. This path deliberately
      // requires no successful tab bind or content-script round trip: persistent
      // navigation/receiver failures must not make the verification window
      // effectively infinite. Once the bounded window is exhausted, never replay
      // the same physical Send; end the operation fail-safe and continue later.
      const cadenceFromSubmit = Number(liveOperation.submitStartedAt || 0)
        + Math.max(1000, live.minimumSendIntervalMs || 120000);
      wakeAt = Math.max(now + 5000, cadenceFromSubmit);
      liveTask.status = 'RETRY_WAIT';
      liveTask.retryAfterAt = Math.max(liveTask.retryAfterAt || 0, wakeAt);
      if (liveOperation.launchUrl) {
        liveTask.url = liveOperation.launchUrl;
        liveTask.normalizedUrl = liveOperation.launchUrl;
        liveOperation.targetUrl = liveOperation.launchUrl;
      }
      liveOperation.phase = OperationPhase.FAILED_SAFE;
      liveOperation.updatedAt = now;
      resumeUnlessQuiesced(live, live.runState);
      live.lastError = `Надсилання не вдалося однозначно підтвердити. Повтор того самого Send не виконувався; новий цикл заплановано без блокування Session. Код: ${result?.safeDiagnosticCode || 'SEND_ACK_TIMEOUT'}.`;
      live.lastActionAt = now;
      live.updatedAt = now;
      releaseSendLease(draft, {
        sessionId,
        operationId: expectedOperation.operationId,
        now,
        profileGapMs: DEFAULT_PROFILE_SEND_GAP_MS,
      });
      appendDiagnostic(draft, {
        event: 'НЕВИЗНАЧЕНЕ_НАДСИЛАННЯ_ЗАВЕРШЕНО_БЕЗ_ПОВТОРУ',
        sessionId,
        taskId: expectedOperation.taskId,
        phase: liveOperation.phase,
        code: result?.safeDiagnosticCode || 'SEND_ACK_TIMEOUT',
        message: live.lastError,
        promptFingerprint: expectedOperation.promptFingerprint,
      }, { at: now });
      settled = true;
      return draft;
    });
    if (!settled) return { kind: 'OPERATION_CHANGED', result };
    await this.closeOpenCloseTabAfterTerminalResult(sessionId, task.id, {
      ...(result || {}),
      status: InteractionResult.TEMPORARY_ERROR,
    });
    return { kind: 'UNCERTAIN_SETTLED_NO_RESEND', wakeAt, result };
  }

  async recoverAmbiguous(sessionId, session) {
    const operation = session.operation;
    const expectedOperation = {
      operationId: operation.operationId,
      taskId: operation.taskId,
      promptFingerprint: operation.promptFingerprint,
    };
    const task = session.tasksById[operation.taskId];
    const beforeVerification = this.now();
    const unattendedRecoveryWindow = Math.max(
      15000,
      Math.min(45000, Math.max(1000, session.retryBackoffMs || 30000) * 2),
    );
    const deadline = operation.verificationDeadline
      || ((operation.submitStartedAt || operation.createdAt || beforeVerification)
        + (session.retryPolicy === 'manual' ? 120000 : unattendedRecoveryWindow));
    const managedNoResend = session.orchestrationCoordinator?.managed === true
      || session.orchestrationWorker?.managed === true
      || session.scenarioWork?.managed === true;

    // Deadline is checked before touching the browser. Otherwise a persistent
    // TAB_NAVIGATION_URL_MISMATCH / missing receiver can throw before the old
    // post-interaction deadline check on every wake and trap an Ordinary Session
    // in AMBIGUOUS forever.
    if (beforeVerification >= deadline
        && session.retryPolicy !== 'manual'
        && !managedNoResend) {
      return this.settleExpiredOrdinaryAmbiguous(sessionId, task, expectedOperation, {
        status: InteractionResult.TEMPORARY_ERROR,
        safeDiagnosticCode: 'RECOVERY_VERIFICATION_DEADLINE_EXPIRED',
      });
    }

    const retryAfterAt = task?.retryAfterAt || 0;
    if (retryAfterAt > beforeVerification) {
      return { kind: 'WAIT_RECOVERY', wakeAt: retryAfterAt };
    }
    const tab = await this.bindTaskTab(sessionId, task.id);
    let result = await this.executeInteraction(
      sessionId,
      session,
      task,
      tab.id,
      'VERIFY_AFTER_UNCERTAIN_SUBMIT',
      operation.operationId,
      operation.promptText,
    );
    const now = this.now();
    // Give late UI acknowledgement a bounded window. Preserve the unresolved
    // operation and expose an explicit recovery action instead of polling forever.
    if (now >= deadline
        && result.status !== InteractionResult.SENT_VERIFIED
        && session.retryPolicy !== 'manual'
        && !managedNoResend) {
      return this.settleExpiredOrdinaryAmbiguous(sessionId, task, expectedOperation, result);
    }

    if (now >= deadline
        && result.status !== InteractionResult.SENT_VERIFIED
        && session.retryPolicy !== 'manual'
        && managedNoResend) {
      let held = false;
      let wakeAt = now + Math.max(5000, session.retryBackoffMs || 30000);
      await this.repo.update(draft => {
        const live = requireSession(draft, sessionId);
        const liveOperation = live.operation;
        if (!matchesOperation(liveOperation, expectedOperation, OperationPhase.AMBIGUOUS)) return draft;
        const liveTask = live.tasksById[expectedOperation.taskId];
        if (!liveTask) return draft;
        wakeAt = now + Math.max(5000, live.retryBackoffMs || 30000);
        liveTask.status = 'SUBMISSION_UNCERTAIN';
        liveTask.retryAfterAt = Math.max(liveTask.retryAfterAt || 0, wakeAt);
        liveOperation.verificationDeadline = wakeAt + Math.max(
          15000,
          Math.min(45000, Math.max(1000, live.retryBackoffMs || 30000) * 2)
        );
        liveOperation.updatedAt = now;
        live.runState = RunState.RECOVERING;
        live.lastError = `Надсилання не підтверджено; повторний Send заборонено, триває перевірка тієї самої керованої операції. Код: ${result.safeDiagnosticCode || 'SEND_ACK_TIMEOUT'}.`;
        live.lastActionAt = now;
        live.updatedAt = now;
        releaseSendLease(draft, {
          sessionId,
          operationId: expectedOperation.operationId,
          now,
          profileGapMs: DEFAULT_PROFILE_SEND_GAP_MS,
        });
        appendDiagnostic(draft, {
          event: 'КЕРОВАНА_СЕСІЯ_УТРИМУЄ_НЕВИЗНАЧЕНЕ_НАДСИЛАННЯ_БЕЗ_ПОВТОРУ',
          sessionId,
          taskId: expectedOperation.taskId,
          phase: liveOperation.phase,
          code: result.safeDiagnosticCode || 'SEND_ACK_TIMEOUT',
          message: live.lastError,
          promptFingerprint: expectedOperation.promptFingerprint,
        }, { at: now });
        held = true;
        return draft;
      });
      if (held) return { kind: 'UNCERTAIN_VERIFY_HOLD', wakeAt, result };
      return { kind: 'OPERATION_CHANGED', result };
    }

    // After a physical Send attempt becomes ambiguous, at-most-once safety wins:
    // every unattended Session remains verification-only. A new Send requires an
    // explicit user resolution; background recovery never abandons the operation.

    if (now >= deadline && result.status !== InteractionResult.SENT_VERIFIED) {
      result = {
        ...result,
        status: InteractionResult.MANUAL_REVIEW_REQUIRED,
        safeDiagnosticCode: 'SEND_ACK_TIMEOUT',
        safeDiagnosticMessage: 'Надсилання не підтверджено. Для політики ручної перевірки потрібне рішення користувача.',
      };
    }
    let reconciled = false;

    if (result.status === InteractionResult.SENT_VERIFIED) {
      await this.repo.update(draft => {
        const live = requireSession(draft, sessionId);
        const priorRunState = live.runState;
        const liveOperation = live.operation;
        if (!matchesOperation(liveOperation, expectedOperation, OperationPhase.AMBIGUOUS)) return draft;
        applyInteractionResult(live, taskIndex(live, expectedOperation.taskId), result, {
          now,
          promptFingerprint: expectedOperation.promptFingerprint,
        });
        releaseSendLease(draft, {
          sessionId,
          operationId: expectedOperation.operationId,
          now,
          profileGapMs: DEFAULT_PROFILE_SEND_GAP_MS,
        });
        resumeUnlessQuiesced(live, priorRunState);
        reconciled = true;
        return draft;
      });
      if (reconciled) await this.closeOpenCloseTabAfterTerminalResult(sessionId, task.id, result);
      return reconciled ? { kind: 'RECOVERED_SENT', result } : { kind: 'OPERATION_CHANGED', result };
    }

    if (result.status === InteractionResult.INSERTED_NOT_SENT) {
      await this.repo.update(draft => {
        const live = requireSession(draft, sessionId);
        const priorRunState = live.runState;
        const liveOperation = live.operation;
        if (!matchesOperation(liveOperation, expectedOperation, OperationPhase.AMBIGUOUS)) return draft;
        liveOperation.phase = OperationPhase.PRE_SEND_WAIT;
        liveOperation.preSendDeadline = now + live.preSendDelayMs;
        liveOperation.updatedAt = now;
        resumeUnlessQuiesced(live, priorRunState);
        releaseSendLease(draft, {
          sessionId,
          operationId: expectedOperation.operationId,
          now,
          profileGapMs: 0,
        });
        reconciled = true;
        return draft;
      });
      return reconciled ? { kind: 'RECOVERED_PENDING', result } : { kind: 'OPERATION_CHANGED', result };
    }

    await this.repo.update(draft => {
      const live = requireSession(draft, sessionId);
      if (!matchesOperation(live.operation, expectedOperation, OperationPhase.AMBIGUOUS)) return draft;
      applyInteractionResult(live, taskIndex(live, expectedOperation.taskId), result, {
        now,
        promptFingerprint: expectedOperation.promptFingerprint,
      });
      reconciled = true;
      return draft;
    });
    if (reconciled) await this.closeOpenCloseTabAfterTerminalResult(sessionId, task.id, result);
    return reconciled ? { kind: 'RECOVERY_HELD', result } : { kind: 'OPERATION_CHANGED', result };
  }

  async recoverInterruptedPreSubmit(sessionId, session) {
    const operation = session.operation;
    const expectedOperation = {
      operationId: operation.operationId,
      taskId: operation.taskId,
      promptFingerprint: operation.promptFingerprint,
      phase: operation.phase,
    };
    const task = session.tasksById[operation.taskId];
    const now = this.now();
    const retryAfterAt = task?.retryAfterAt || 0;
    if (retryAfterAt > now) {
      return {
        kind: 'WAIT_PRE_SUBMIT_RECOVERY',
        phase: operation.phase,
        wakeAt: retryAfterAt,
      };
    }

    let reconciled = false;
    let wakeAt = now + Math.max(1000, session.retryBackoffMs || 30000);
    await this.repo.update(draft => {
      const live = requireSession(draft, sessionId);
      const liveOperation = live.operation;
      if (!matchesOperation(liveOperation, expectedOperation, expectedOperation.phase)) return draft;
      if (!INTERRUPTED_PRE_SUBMIT_PHASES.has(liveOperation.phase)) return draft;
      const liveTask = live.tasksById[expectedOperation.taskId];
      if (!liveTask) return draft;

      wakeAt = now + Math.max(1000, live.retryBackoffMs || 30000);
      liveOperation.phase = OperationPhase.FAILED_SAFE;
      liveOperation.updatedAt = now;
      liveTask.retryAfterAt = Math.max(liveTask.retryAfterAt || 0, wakeAt);
      live.lastError = 'Interrupted pre-submit operation failed safe; retry scheduled.';
      live.lastActionAt = now;
      live.updatedAt = now;
      reconciled = true;
      return draft;
    });

    return reconciled
      ? { kind: 'PRE_SUBMIT_RECOVERY_HELD', wakeAt }
      : { kind: 'OPERATION_CHANGED' };
  }

  async continuePreSend(sessionId, session) {
    const operation = session.operation;
    const expectedOperation = {
      operationId: operation.operationId,
      taskId: operation.taskId,
      promptFingerprint: operation.promptFingerprint,
    };
    const task = session.tasksById[operation.taskId];
    const wakeAt = Math.max(operation.preSendDeadline || 0, task?.retryAfterAt || 0);
    if (wakeAt > this.now()) {
      return { kind: 'WAIT_PRE_SEND', wakeAt };
    }
    const tab = await this.bindTaskTab(sessionId, task.id);
    const prepare = await this.executeInteraction(
      sessionId,
      session,
      task,
      tab.id,
      'PREPARE_SEND',
      operation.operationId,
      operation.promptText,
    );

    const postPrepare = await this.repo.load();
    const postPrepareSession = requireSession(postPrepare, sessionId);
    if (!ACTIVE_STATES.has(postPrepareSession.runState)) {
      return { kind: 'QUIESCED', runState: postPrepareSession.runState };
    }
    if (!matchesOperation(postPrepareSession.operation, expectedOperation, OperationPhase.PRE_SEND_WAIT)) {
      return { kind: 'OPERATION_CHANGED', phase: postPrepareSession.operation?.phase || OperationPhase.NONE };
    }

    if (prepare.status !== InteractionResult.READY) {
      const now = this.now();
      let reconciled = false;
      if (prepare.status === InteractionResult.INSERTED_NOT_SENT) {
        await this.repo.update(draft => {
          const live = requireSession(draft, sessionId);
          if (!matchesOperation(live.operation, expectedOperation, OperationPhase.PRE_SEND_WAIT)) return draft;
          live.operation.preSendDeadline = now + Math.max(500, live.busyCheckDelayMs);
          live.operation.updatedAt = now;
          reconciled = true;
          return draft;
        });
        return reconciled ? { kind: 'WAIT_SEND_READY', result: prepare } : { kind: 'OPERATION_CHANGED', result: prepare };
      }
      await this.repo.update(draft => {
        const live = requireSession(draft, sessionId);
        if (!matchesOperation(live.operation, expectedOperation, OperationPhase.PRE_SEND_WAIT)) return draft;
        applyInteractionResult(live, taskIndex(live, expectedOperation.taskId), prepare, {
          now,
          promptFingerprint: expectedOperation.promptFingerprint,
        });
        reconciled = true;
        return draft;
      });
      if (reconciled) await this.closeOpenCloseTabAfterTerminalResult(sessionId, task.id, prepare);
      return reconciled ? { kind: 'PREPARE_HELD', result: prepare } : { kind: 'OPERATION_CHANGED', result: prepare };
    }

    const result = await this.coordinator.submitWithDurableCheckpoint({
      sessionId,
      operationId: operation.operationId,
      submit: () => this.executeInteraction(
        sessionId,
        session,
        task,
        tab.id,
        'SUBMIT_EXISTING',
        operation.operationId,
        operation.promptText,
      ),
    });
    if (result.status === InteractionResult.SENT_VERIFIED) {
      await this.persistVerifiedConversationBinding(sessionId, task.id, tab.id, result);
      await this.markNormalWorkResumed(sessionId, task.id);
    }
    await this.closeOpenCloseTabAfterTerminalResult(sessionId, task.id, result);
    return { kind: result.status === InteractionResult.SENT_VERIFIED ? 'SENT' : 'SUBMISSION_UNCERTAIN', result };
  }

  async runSessionOnce(sessionId) {
    const state = await this.repo.load();
    const session = requireSession(state, sessionId);
    if (!ACTIVE_STATES.has(session.runState)) return { kind: 'IDLE' };

    const profileRateLimitUntil = Number(state.profile?.rateLimitUntil || 0);
    if (profileRateLimitUntil > this.now()) {
      return { kind: 'PROFILE_RATE_LIMIT_WAIT', wakeAt: profileRateLimitUntil };
    }

    if (session.operation?.phase === OperationPhase.AMBIGUOUS) {
      return this.recoverAmbiguous(sessionId, session);
    }
    if (session.operation?.phase === OperationPhase.PRE_SEND_WAIT) {
      return this.continuePreSend(sessionId, session);
    }
    if (INTERRUPTED_PRE_SUBMIT_PHASES.has(session.operation?.phase)) {
      return this.recoverInterruptedPreSubmit(sessionId, session);
    }
    if (session.operation && !TERMINAL_OPERATION_PHASES.has(session.operation.phase)) {
      return { kind: 'OPERATION_IN_PROGRESS', phase: session.operation.phase };
    }

    const selection = selectNextTask(session, this.now());
    if (selection.kind === 'IDLE' || selection.kind === 'COOLDOWN' || selection.kind === 'WAIT') return selection;
    if (selection.kind === 'COMPLETE') {
      await this.repo.update(draft => {
        const live = requireSession(draft, sessionId);
        if (live.runMode === RunMode.ONE_PASS) {
          live.runState = RunState.STOPPED;
          live.completedAt = this.now();
          live.lastActionAt = live.completedAt;
          appendLog(draft, live.id, 'Session completed all enabled one-pass tasks', { at: live.completedAt });
        }
        return draft;
      });
      return { kind: 'COMPLETE' };
    }

    const task = selection.task;
    const tab = await this.bindTaskTab(sessionId, task.id);
    const checkId = `${sessionId}:${task.id}:check:${this.now()}`;
    const check = await this.executeInteraction(
      sessionId,
      session,
      task,
      tab.id,
      'CHECK_ONLY',
      checkId,
      '',
    );

    const postCheck = await this.repo.load();
    const postCheckSession = requireSession(postCheck, sessionId);
    if (!ACTIVE_STATES.has(postCheckSession.runState)) {
      return { kind: 'QUIESCED', runState: postCheckSession.runState };
    }

    if (postCheckSession.runState === RunState.RECOVERING
        && NORMAL_WORK_CONFIRMED_RESULTS.has(check.status)) {
      await this.markNormalWorkResumed(sessionId, task.id);
    }

    if (check.status !== InteractionResult.READY) {
      await this.applyResult(sessionId, task.id, check);
      await this.closeOpenCloseTabAfterTerminalResult(sessionId, task.id, check);
      return { kind: check.status, result: check };
    }

    const fresh = await this.repo.load();
    const liveSession = requireSession(fresh, sessionId);
    if (!ACTIVE_STATES.has(liveSession.runState)) {
      return { kind: 'QUIESCED', runState: liveSession.runState };
    }
    const liveTask = liveSession.tasksById[task.id];
    const promptText = composePromptForSession(liveSession, liveTask);
    const generation = fresh.revision + 1;
    const identity = await this.coordinator.begin({ sessionId, taskId: task.id, promptText, generation });
    await this.coordinator.markReady({ sessionId, operationId: identity.operationId });
    await this.coordinator.markInserting({ sessionId, operationId: identity.operationId });

    const inserted = await this.executeInteraction(
      sessionId,
      liveSession,
      liveTask,
      tab.id,
      'INSERT_ONLY',
      identity.operationId,
      promptText,
    );
    const textInsertionProven = inserted.composerState === 'VISIBLE_NONEMPTY'
      && ['INSERTION_TEXT_PROVEN', 'PROMPT_ALREADY_INSERTED_MATCH', 'INSERTION_REPEATED_PROMPT_ACCEPTED'].includes(inserted.safeDiagnosticCode);
    const acceptedRepresentationProven = inserted.composerState === 'ACCEPTED_ATTACHMENT_LIKE'
      && inserted.insertionEvidence === 'OPERATION_BOUND_ACCEPTED_REPRESENTATION'
      && inserted.safeDiagnosticCode === 'INSERTION_ATTACHMENT_OPERATION_BOUND';
    const insertionProven = inserted.status === InteractionResult.INSERTED_NOT_SENT
      && (textInsertionProven || acceptedRepresentationProven);

    if (!insertionProven) {
      // Nothing has been submitted yet, so an insertion-proof mismatch is recoverable.
      // Do not pause the whole Session for manual review. Fail this operation safe,
      // apply bounded retry/backoff, and for a shared-URL cycle series hold every
      // sibling cycle so the scheduler retries the same logical cycle first.
      if (inserted.status === InteractionResult.INSERTED_NOT_SENT
          && inserted.composerState !== 'ACCEPTED_ATTACHMENT_LIKE') {
        const now = this.now();
        let wakeAt = now;
        await this.repo.update(draft => {
          const live = requireSession(draft, sessionId);
          const operation = live.operation;
          if (!operation || operation.operationId !== identity.operationId || operation.taskId !== task.id) return draft;
          const liveTask = live.tasksById[task.id];
          wakeAt = now + Math.max(1000, live.retryBackoffMs || 30000);
          operation.phase = OperationPhase.FAILED_SAFE;
          operation.updatedAt = now;
          liveTask.status = 'RETRY_WAIT';
          liveTask.retryAfterAt = Math.max(liveTask.retryAfterAt || 0, wakeAt);
          liveTask.manualReviewReason = '';
          if (live.urlMode === 'shared') {
            for (const candidateId of live.taskOrder || []) {
              const candidate = live.tasksById[candidateId];
              if (!candidate?.enabled || candidate.manualReviewReason) continue;
              candidate.retryAfterAt = Math.max(candidate.retryAfterAt || 0, wakeAt);
            }
          }
          live.lastError = `Вставлення не вдалося підтвердити; безпечний автоматичний повтор заплановано. Код: ${inserted.safeDiagnosticCode || 'INSERTION_NOT_PROVEN'}.`;
          live.lastActionAt = now;
          live.updatedAt = now;
          appendDiagnostic(draft, {
            event: 'ПОВТОР_ВСТАВЛЕННЯ_ЗАПЛАНОВАНО',
            sessionId,
            taskId: task.id,
            phase: operation.phase,
            code: inserted.safeDiagnosticCode || 'INSERTION_NOT_PROVEN',
            message: live.lastError,
            promptFingerprint: identity.promptFingerprint,
          }, { at: now });
          return draft;
        });
        const retryResult = { ...inserted, status: InteractionResult.TEMPORARY_ERROR };
        await this.closeOpenCloseTabAfterTerminalResult(sessionId, task.id, retryResult);
        return { kind: 'INSERTION_RETRY', wakeAt, result: retryResult };
      }

      const heldResult = inserted.status === InteractionResult.INSERTED_NOT_SENT
        ? { ...inserted, status: InteractionResult.MANUAL_REVIEW_REQUIRED }
        : inserted;
      await this.applyResult(sessionId, task.id, heldResult, identity.promptFingerprint);
      await this.closeOpenCloseTabAfterTerminalResult(sessionId, task.id, heldResult);
      return { kind: 'INSERTION_HELD', result: heldResult };
    }

    await this.coordinator.markInsertedForPreSend({ sessionId, operationId: identity.operationId });
    const afterInsert = await this.repo.load();
    return {
      kind: 'WAIT_PRE_SEND',
      operationId: identity.operationId,
      wakeAt: afterInsert.sessionsById[sessionId].operation.preSendDeadline,
    };
  }
}
