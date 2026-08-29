import { InteractionResult } from '../shared/protocol.js';
import { OperationPhase, RunState } from './schema.js';
import { advanceAfterBusy, advanceAfterVerifiedSend } from './scheduler.js';

export function applyInteractionResult(session, taskIndex, result, { now = Date.now(), promptFingerprint = '' } = {}) {
  const taskId = session.taskOrder[taskIndex];
  const task = session.tasksById[taskId];
  if (!task) throw new Error('Task not found');
  task.lastCheckedAt = now;
  switch (result?.status) {
    case InteractionResult.READY:
      task.status = 'READY';
      return { action: 'READY' };
    case InteractionResult.BUSY:
      task.status = 'BUSY';
      task.retryAfterAt = now + Math.max(1000, session.busyCheckDelayMs || 5000);
      advanceAfterBusy(session, taskIndex, now);
      return { action: 'ADVANCE_NO_COOLDOWN', retryAt: task.retryAfterAt };
    case InteractionResult.SENT_VERIFIED:
      task.status = 'IDLE';
      task.lastVerifiedSendAt = now;
      task.lastVerifiedFingerprint = promptFingerprint;
      task.retryAfterAt = 0;
      if (session.operation) { session.operation.phase = OperationPhase.SENT_VERIFIED; session.operation.updatedAt = now; }
      advanceAfterVerifiedSend(session, taskIndex, now);
      return { action: 'SENT_VERIFIED' };
    case InteractionResult.INSERTED_NOT_SENT:
      task.status = 'INSERTED_NOT_SENT';
      if (session.operation) { session.operation.phase = OperationPhase.INSERTED; session.operation.updatedAt = now; }
      return { action: 'HOLD_INSERTED' };
    case InteractionResult.SUBMISSION_UNCERTAIN:
      task.status = 'SUBMISSION_UNCERTAIN';
      task.retryAfterAt = now + Math.max(1000, session.retryBackoffMs || 30000);
      if (![RunState.PAUSED, RunState.STOPPED].includes(session.runState)) session.runState = RunState.RECOVERING;
      if (session.operation) { session.operation.phase = OperationPhase.AMBIGUOUS; session.operation.updatedAt = now; }
      return { action: 'RECOVER_BEFORE_RESEND', retryAt: task.retryAfterAt };
    case InteractionResult.TEMPORARY_ERROR:
      task.status = 'RETRY_WAIT';
      task.retryAfterAt = now + session.retryBackoffMs;
      return { action: 'RETRY_LATER', retryAt: task.retryAfterAt };
    case InteractionResult.RATE_LIMITED:
      task.status = 'RATE_LIMITED';
      // Acknowledgement only dismisses the exact informational modal. The Session's
      // user-configured durable retry/backoff remains authoritative before any recheck.
      task.retryAfterAt = now + Math.max(5000, session.retryBackoffMs || 30000);
      return { action: 'BACKOFF', retryAt: task.retryAfterAt };
    case InteractionResult.AUTH_REQUIRED:
    case InteractionResult.UNKNOWN_UI:
    case InteractionResult.MANUAL_REVIEW_REQUIRED:
      task.status = 'MANUAL_REVIEW';
      task.manualReviewReason = result.status;
      if (session.operation) { session.operation.phase = OperationPhase.MANUAL_REVIEW; session.operation.updatedAt = now; }
      return { action: 'MANUAL_REVIEW' };
    default:
      throw new Error(`Unknown interaction result: ${result?.status}`);
  }
}
