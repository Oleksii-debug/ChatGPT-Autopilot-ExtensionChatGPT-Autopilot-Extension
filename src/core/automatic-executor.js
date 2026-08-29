import { releaseSendLease } from './arbiter.js';
import { applyInteractionResult } from './execution.js';
import { DurableSubmissionCoordinator } from './runner.js';
import { selectNextTask } from './scheduler.js';
import { OperationPhase, PromptMode, RunMode, RunState } from './schema.js';
import { resolveTaskTab } from './tabs.js';
import { InteractionResult } from '../shared/protocol.js';

const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);
const QUIESCENT_STATES = new Set([RunState.PAUSED, RunState.STOPPED]);
const TERMINAL_OPERATION_PHASES = new Set([
  OperationPhase.NONE,
  OperationPhase.SENT_VERIFIED,
  OperationPhase.FAILED_SAFE,
]);
const INTERRUPTED_PRE_SUBMIT_PHASES = new Set([
  OperationPhase.CHECKING,
  OperationPhase.READY,
  OperationPhase.INSERTED,
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

function promptFor(session, task) {
  return session.promptMode === PromptMode.UNIQUE ? task.promptOverride : session.sharedPrompt;
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

export class AutomaticSessionExecutor {
  constructor(repository, chromeApi, transport, {
    now = () => Date.now(),
    cryptoApi = globalThis.crypto,
    profileGapMs = 1000,
  } = {}) {
    this.repo = repository;
    this.chrome = chromeApi;
    this.transport = transport;
    this.now = now;
    this.coordinator = new DurableSubmissionCoordinator(repository, { now, cryptoApi, profileGapMs });
  }

  async bindTaskTab(sessionId, taskId) {
    let tab;
    await this.repo.update(async draft => {
      const session = requireSession(draft, sessionId);
      const task = session.tasksById[taskId];
      if (!task) throw new Error('Task not found');
      tab = await resolveTaskTab(this.chrome, draft, sessionId, task);
      return draft;
    });
    return tab;
  }

  request(session, task, mode, requestId, promptText) {
    return {
      requestId,
      taskId: task.id,
      mode,
      expectedUrl: task.normalizedUrl || task.url,
      promptText,
    };
  }

  async applyResult(sessionId, taskId, result, promptFingerprint = '') {
    const now = this.now();
    return this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      applyInteractionResult(session, taskIndex(session, taskId), result, { now, promptFingerprint });
      return draft;
    });
  }

  async recoverAmbiguous(sessionId, session) {
    const operation = session.operation;
    const expectedOperation = {
      operationId: operation.operationId,
      taskId: operation.taskId,
      promptFingerprint: operation.promptFingerprint,
    };
    const task = session.tasksById[operation.taskId];
    const retryAfterAt = task?.retryAfterAt || 0;
    if (retryAfterAt > this.now()) {
      return { kind: 'WAIT_RECOVERY', wakeAt: retryAfterAt };
    }
    const tab = await this.bindTaskTab(sessionId, task.id);
    const result = await this.transport.execute(tab.id, this.request(
      session,
      task,
      'VERIFY_AFTER_UNCERTAIN_SUBMIT',
      operation.operationId,
      operation.promptText,
    ));
    const now = this.now();
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
          profileGapMs: 1000,
        });
        resumeUnlessQuiesced(live, priorRunState);
        reconciled = true;
        return draft;
      });
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
    if ((operation.preSendDeadline || 0) > this.now()) {
      return { kind: 'WAIT_PRE_SEND', wakeAt: operation.preSendDeadline };
    }
    const task = session.tasksById[operation.taskId];
    const tab = await this.bindTaskTab(sessionId, task.id);
    const prepare = await this.transport.execute(tab.id, this.request(
      session,
      task,
      'PREPARE_SEND',
      operation.operationId,
      operation.promptText,
    ));

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
      return reconciled ? { kind: 'PREPARE_HELD', result: prepare } : { kind: 'OPERATION_CHANGED', result: prepare };
    }

    const result = await this.coordinator.submitWithDurableCheckpoint({
      sessionId,
      operationId: operation.operationId,
      submit: () => this.transport.execute(tab.id, this.request(
        session,
        task,
        'SUBMIT_EXISTING',
        operation.operationId,
        operation.promptText,
      )),
    });
    return { kind: result.status === InteractionResult.SENT_VERIFIED ? 'SENT' : 'SUBMISSION_UNCERTAIN', result };
  }

  async runSessionOnce(sessionId) {
    const state = await this.repo.load();
    const session = requireSession(state, sessionId);
    if (!ACTIVE_STATES.has(session.runState)) return { kind: 'IDLE' };

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
        if (live.runMode === RunMode.ONE_PASS) live.runState = RunState.STOPPED;
        return draft;
      });
      return { kind: 'COMPLETE' };
    }

    const task = selection.task;
    const tab = await this.bindTaskTab(sessionId, task.id);
    const checkId = `${sessionId}:${task.id}:check:${this.now()}`;
    const check = await this.transport.execute(tab.id, this.request(session, task, 'CHECK_ONLY', checkId, ''));

    const postCheck = await this.repo.load();
    const postCheckSession = requireSession(postCheck, sessionId);
    if (!ACTIVE_STATES.has(postCheckSession.runState)) {
      return { kind: 'QUIESCED', runState: postCheckSession.runState };
    }

    if (check.status !== InteractionResult.READY) {
      await this.applyResult(sessionId, task.id, check);
      return { kind: check.status, result: check };
    }

    const fresh = await this.repo.load();
    const liveSession = requireSession(fresh, sessionId);
    if (!ACTIVE_STATES.has(liveSession.runState)) {
      return { kind: 'QUIESCED', runState: liveSession.runState };
    }
    const liveTask = liveSession.tasksById[task.id];
    const promptText = promptFor(liveSession, liveTask);
    const generation = fresh.revision + 1;
    const identity = await this.coordinator.begin({ sessionId, taskId: task.id, promptText, generation });
    await this.coordinator.markReady({ sessionId, operationId: identity.operationId });
    await this.coordinator.markInserting({ sessionId, operationId: identity.operationId });

    const inserted = await this.transport.execute(tab.id, this.request(
      liveSession,
      liveTask,
      'INSERT_ONLY',
      identity.operationId,
      promptText,
    ));
    const insertionProven = inserted.status === InteractionResult.INSERTED_NOT_SENT
      && inserted.composerState === 'VISIBLE_NONEMPTY'
      && ['INSERTION_TEXT_PROVEN', 'PROMPT_ALREADY_INSERTED_MATCH'].includes(inserted.safeDiagnosticCode);

    if (!insertionProven) {
      const safeResult = inserted.status === InteractionResult.INSERTED_NOT_SENT
        ? { ...inserted, status: InteractionResult.MANUAL_REVIEW_REQUIRED }
        : inserted;
      await this.applyResult(sessionId, task.id, safeResult, identity.promptFingerprint);
      return { kind: 'INSERTION_HELD', result: safeResult };
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
