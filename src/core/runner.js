import { recordVerifiedSend, DEFAULT_PROFILE_SEND_GAP_MS } from './arbiter.js';
import { applyInteractionResult } from './execution.js';
import { createOperationId, createPromptFingerprint } from './fingerprint.js';
import { InteractionResult } from '../shared/protocol.js';
import { OperationPhase, RunState } from './schema.js';
import { beginOperation, markSubmitting } from './state-machine.js';
import { appendLog } from './logger.js';

const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);

function safeSubmitDiagnosticCode(error) {
  const explicit = String(error?.safeDiagnosticCode || '');
  return /^[A-Z][A-Z0-9_]{2,79}$/.test(explicit) ? explicit : 'SUBMIT_EFFECT_EXCEPTION';
}

function requireSession(state, sessionId) {
  const session = state.sessionsById[sessionId];
  if (!session) throw new Error('Session not found');
  return session;
}

function requireOperation(session, operationId) {
  const operation = session.operation;
  if (!operation || operation.operationId !== operationId) throw new Error('Operation not found');
  return operation;
}

function taskIndexForOperation(session, operation) {
  const index = session.taskOrder.indexOf(operation.taskId);
  if (index < 0) throw new Error('Operation task is not part of the session');
  return index;
}

export class DurableSubmissionCoordinator {
  constructor(repository, {
    now = () => Date.now(),
    cryptoApi = globalThis.crypto,
    profileGapMs = DEFAULT_PROFILE_SEND_GAP_MS,
  } = {}) {
    this.repo = repository;
    this.now = now;
    this.cryptoApi = cryptoApi;
    this.profileGapMs = profileGapMs;
  }

  async begin({ sessionId, taskId, promptText, generation }) {
    const state = await this.repo.load();
    const session = requireSession(state, sessionId);
    const task = session.tasksById[taskId];
    if (!task) throw new Error('Task not found');
    const promptFingerprint = await createPromptFingerprint({
      sessionId,
      taskId,
      targetUrl: task.normalizedUrl || task.url,
      promptText,
      generation,
      cryptoApi: this.cryptoApi,
    });
    const operationId = createOperationId({ sessionId, taskId, generation, promptFingerprint });
    const now = this.now();

    await this.repo.update(draft => {
      const liveSession = requireSession(draft, sessionId);
      beginOperation(liveSession, {
        operationId,
        taskId,
        promptFingerprint,
        targetUrl: task.normalizedUrl || task.url,
        now,
      });
      // Runtime admission is persisted before a new operation is allowed to
      // start. Copy that immutable identity into the operation in this same
      // transaction, so recovery can prove which scheduled effect it owns.
      const occurrence = liveSession.calendarRuntime?.activeOccurrence;
      if (occurrence?.id && occurrence?.revision && Number.isFinite(occurrence?.scheduledAt)) {
        liveSession.operation.calendarOccurrence = { ...occurrence };
      }
      liveSession.operation.generation = generation;
      liveSession.operation.promptText = promptText;
      return draft;
    });

    return { operationId, promptFingerprint };
  }

  async markReady({ sessionId, operationId }) {
    const now = this.now();
    return this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      const operation = requireOperation(session, operationId);
      if (operation.phase !== OperationPhase.CHECKING) throw new Error('Operation is not checking');
      operation.phase = OperationPhase.READY;
      operation.updatedAt = now;
      return draft;
    });
  }

  async markInserting({ sessionId, operationId }) {
    const now = this.now();
    return this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      const operation = requireOperation(session, operationId);
      if (operation.phase !== OperationPhase.READY) throw new Error('Operation is not ready for insertion');
      operation.phase = OperationPhase.INSERTING;
      operation.updatedAt = now;
      return draft;
    });
  }

  async markInsertedForPreSend({ sessionId, operationId }) {
    const now = this.now();
    return this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      const operation = requireOperation(session, operationId);
      if (![OperationPhase.INSERTING, OperationPhase.INSERTED].includes(operation.phase)) {
        throw new Error('Operation is not in an insertion phase');
      }
      operation.phase = OperationPhase.PRE_SEND_WAIT;
      operation.preSendDeadline = now + session.preSendDelayMs;
      operation.updatedAt = now;
      return draft;
    });
  }

  async submitWithDurableCheckpoint({ sessionId, operationId, submit }) {
    if (typeof submit !== 'function') throw new Error('Submit effect callback is required');
    const submitStartedAt = this.now();

    await this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      const operation = requireOperation(session, operationId);
      if (!ACTIVE_STATES.has(session.runState)) throw new Error('Session is not active for submit');
      if (operation.phase !== OperationPhase.PRE_SEND_WAIT) throw new Error('Operation is not waiting to submit');
      if (operation.preSendDeadline > submitStartedAt) throw new Error('Pre-send delay has not elapsed');
      // Per-Session durable operation state is the exact-once guard. Distinct
      // Sessions may submit concurrently because each owns an isolated tab.
      markSubmitting(session, submitStartedAt);
      return draft;
    });

    let result;
    let submitDiagnosticCode = '';
    try {
      result = await submit();
    } catch (error) {
      submitDiagnosticCode = safeSubmitDiagnosticCode(error);
      result = { status: InteractionResult.SUBMISSION_UNCERTAIN };
    }

    const finishedAt = this.now();
    if (result?.status !== InteractionResult.SENT_VERIFIED) {
      submitDiagnosticCode ||= result?.safeDiagnosticCode || '';
      await this.repo.update(draft => {
        const session = requireSession(draft, sessionId);
        const operation = requireOperation(session, operationId);
        const taskIndex = taskIndexForOperation(session, operation);
        applyInteractionResult(session, taskIndex, { ...result, status: InteractionResult.SUBMISSION_UNCERTAIN }, {
          now: finishedAt,
          promptFingerprint: operation.promptFingerprint,
        });
        if (submitDiagnosticCode) {
          const unattended = session.retryPolicy !== 'manual';
          session.lastError = unattended
            ? `Надсилання не підтверджено. Автоматичне відновлення триває. Код: ${submitDiagnosticCode}.`
            : `Надсилання не підтверджено. Очікується ручне рішення. Код: ${submitDiagnosticCode}.`;
          appendLog(draft, sessionId, unattended
            ? `Submission uncertain; unattended recovery active [${submitDiagnosticCode}]`
            : `Submission held uncertain [${submitDiagnosticCode}]`, {
            at: finishedAt,
            level: 'WARN',
          });
        }
        return draft;
      });
      return { ...result, status: InteractionResult.SUBMISSION_UNCERTAIN };
    }

    await this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      const operation = requireOperation(session, operationId);
      const taskIndex = taskIndexForOperation(session, operation);
      applyInteractionResult(session, taskIndex, result, {
        now: finishedAt,
        promptFingerprint: operation.promptFingerprint,
      });
      recordVerifiedSend(draft, { sessionId, now: finishedAt });
      return draft;
    });
    return result;
  }
}
