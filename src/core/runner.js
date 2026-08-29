import { acquireSendLease, releaseSendLease } from './arbiter.js';
import { applyInteractionResult } from './execution.js';
import { createOperationId, createPromptFingerprint } from './fingerprint.js';
import { InteractionResult } from '../shared/protocol.js';
import { OperationPhase, RunState } from './schema.js';
import { beginOperation, markSubmitting } from './state-machine.js';

const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);

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
    profileGapMs = 1000,
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
      if (!acquireSendLease(draft, { sessionId, operationId, now: submitStartedAt })) {
        throw new Error('Profile send arbiter is busy');
      }
      markSubmitting(session, submitStartedAt);
      return draft;
    });

    let result;
    try {
      result = await submit();
    } catch (_) {
      result = { status: InteractionResult.SUBMISSION_UNCERTAIN };
    }

    const finishedAt = this.now();
    if (result?.status !== InteractionResult.SENT_VERIFIED) {
      await this.repo.update(draft => {
        const session = requireSession(draft, sessionId);
        const operation = requireOperation(session, operationId);
        const taskIndex = taskIndexForOperation(session, operation);
        applyInteractionResult(session, taskIndex, { status: InteractionResult.SUBMISSION_UNCERTAIN }, {
          now: finishedAt,
          promptFingerprint: operation.promptFingerprint,
        });
        return draft;
      });
      return { status: InteractionResult.SUBMISSION_UNCERTAIN };
    }

    await this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      const operation = requireOperation(session, operationId);
      const taskIndex = taskIndexForOperation(session, operation);
      applyInteractionResult(session, taskIndex, result, {
        now: finishedAt,
        promptFingerprint: operation.promptFingerprint,
      });
      releaseSendLease(draft, {
        sessionId,
        operationId,
        now: finishedAt,
        profileGapMs: this.profileGapMs,
      });
      return draft;
    });
    return result;
  }
}
