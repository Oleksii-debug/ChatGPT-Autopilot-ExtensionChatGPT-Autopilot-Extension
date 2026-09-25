import { OperationPhase, RunState } from './schema.js';
export function startSession(session, now = Date.now()) { if (session.runState !== RunState.RUNNING) session.runState = RunState.RUNNING; session.lastError = ''; session.lastActionAt = now; return session; }
export function pauseSession(session, now = Date.now()) { session.runState = RunState.PAUSED; session.lastActionAt = now; return session; }
export function resumeSession(session, now = Date.now()) { session.runState = RunState.RUNNING; session.lastActionAt = now; return session; }
export function stopSession(session, now = Date.now()) {
  session.runState = RunState.STOPPED;
  if (session.operation && [OperationPhase.NONE, OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE].includes(session.operation.phase)) {
    session.operation = null;
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
