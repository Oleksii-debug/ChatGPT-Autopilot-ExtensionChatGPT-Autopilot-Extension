import { OperationPhase, RunState } from './schema.js';
import {
  ExecutionModuleId,
  ensureSessionModuleState,
  isUnresolvedModuleOperation,
} from './module-workspaces.js';
import { SessionFunctionId, isSessionFunctionEnabled } from './session-functions.js';

function batchComplete(session) {
  const config = session.batchChatFlow;
  return Boolean(config?.enabled && Number(config.completedTasks || 0) >= Number(config.totalTasks || 0));
}

export function startSession(session, now = Date.now()) {
  ensureSessionModuleState(session);
  if (session.runState !== RunState.RUNNING) session.runState = RunState.RUNNING;
  const standard = session.moduleWorkspaces[ExecutionModuleId.STANDARD_SENDS];
  const batch = session.moduleWorkspaces[ExecutionModuleId.BATCH_CHAT];
  if (isSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.ORDINARY_SEND)
      || isUnresolvedModuleOperation(session.operation)) {
    standard.runState = RunState.RUNNING;
    standard.moduleCompleted = false;
  }
  if (batch
      && (isSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.BATCH_CHAT)
          || isUnresolvedModuleOperation(batch.operation))
      && !batchComplete(session)) {
    batch.runState = RunState.RUNNING;
    batch.moduleCompleted = false;
  }
  session.lastError = '';
  session.lastActionAt = now;
  return session;
}
export function pauseSession(session, now = Date.now()) { session.runState = RunState.PAUSED; session.lastActionAt = now; return session; }
export function resumeSession(session, now = Date.now()) { session.runState = RunState.RUNNING; session.lastActionAt = now; return session; }
export function stopSession(session, now = Date.now()) {
  ensureSessionModuleState(session);
  session.runState = RunState.STOPPED;
  if (session.operation && [OperationPhase.NONE, OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE].includes(session.operation.phase)) {
    session.operation = null;
  }
  const batch = session.moduleWorkspaces[ExecutionModuleId.BATCH_CHAT];
  if (batch?.operation && [OperationPhase.NONE, OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE].includes(batch.operation.phase)) {
    batch.operation = null;
  }
  session.lastActionAt = now;
  return session;
}
export function beginOperation(session, { operationId, taskId, promptFingerprint, targetUrl, now = Date.now() }) {
  if (session.operation && ![OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE, OperationPhase.NONE].includes(session.operation.phase)) throw new Error('Outstanding operation exists');
  session.lastError = '';
  session.operation = { operationId, sessionId: session.id, taskId, promptFingerprint, phase: OperationPhase.CHECKING, targetUrl, createdAt: now, updatedAt: now, preSendDeadline: 0, submitStartedAt: 0, verificationDeadline: 0 };
  return session.operation;
}
export function markSubmitting(session, now = Date.now()) { if (!session.operation) throw new Error('No operation'); session.operation.phase = OperationPhase.SUBMITTING; session.operation.submitStartedAt = now; session.operation.updatedAt = now; return session.operation; }
export function markSentVerified(session, now = Date.now()) { if (!session.operation) throw new Error('No operation'); session.operation.phase = OperationPhase.SENT_VERIFIED; session.operation.updatedAt = now; return session.operation; }
