import { InteractionResult } from '../shared/protocol.js';
import { OperationPhase, RunState, isExclusiveConversationUrl } from './schema.js';
import { advanceAfterBusy, advanceAfterVerifiedSend } from './scheduler.js';

export const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;

export function applyInteractionResult(session, taskIndex, result, { now = Date.now(), promptFingerprint = '', rateLimitBackoffMs = RATE_LIMIT_BACKOFF_MS, rateLimitRetryAt = 0 } = {}) {
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
      const observedConversation = typeof result?.normalizedObservedUrl === 'string' ? result.normalizedObservedUrl : '';
      if (observedConversation && isExclusiveConversationUrl(observedConversation)) task.lastConversationUrl = observedConversation;
      if (Number.isInteger(Number(result?.assistantBaselineCount)) && Number(result.assistantBaselineCount) >= 0) {
        task.lastAssistantBaselineCount = Number(result.assistantBaselineCount);
        task.lastAssistantBaselineKnown = true;
      }
      // If uncertain recovery temporarily rebound a fresh launch task to the
      // concrete /c/<id> conversation, restore the configured launch surface for
      // the next recurring cycle after this operation is positively verified.
      if (session.operation?.taskId === taskId && session.operation.launchUrl) {
        const launchUrl = session.operation.launchUrl;
        task.url = launchUrl;
        task.normalizedUrl = launchUrl;
        session.operation.targetUrl = launchUrl;
      }
      session.lastError = '';
      // A manager handoff is single-use. It is appended to the operation prompt at
      // insertion time and cleared only after that send is positively verified.
      if (session.aiCoordinatorHandoff) {
        session.aiCoordinatorHandoff = '';
        session.aiCoordinatorHandoffCreatedAt = 0;
      }
      if (session.operation) { session.operation.phase = OperationPhase.SENT_VERIFIED; session.operation.updatedAt = now; }
      advanceAfterVerifiedSend(session, taskIndex, now);
      return { action: 'SENT_VERIFIED' };
    case InteractionResult.INSERTED_NOT_SENT:
      task.status = 'INSERTED_NOT_SENT';
      if (session.operation) { session.operation.phase = OperationPhase.INSERTED; session.operation.updatedAt = now; }
      return { action: 'HOLD_INSERTED' };
    case InteractionResult.SUBMISSION_UNCERTAIN: {
      task.status = 'SUBMISSION_UNCERTAIN';
      // A fresh ChatGPT launch surface can become a concrete /c/<id> URL at the
      // moment Send is attempted even when acknowledgement remains uncertain.
      // Persist that observed exclusive conversation as the recovery identity for
      // every Session. After a Send attempt becomes ambiguous, recovery must stay
      // bound to the exact conversation instead of reopening a fresh root chat.
      const observedConversation = typeof result?.normalizedObservedUrl === 'string' ? result.normalizedObservedUrl : '';
      if (observedConversation && isExclusiveConversationUrl(observedConversation)
          && session.operation?.taskId === taskId) {
        // Recovery may need to bind to the concrete conversation created by a
        // Send from a launch surface. Preserve the configured launch target so
        // a recurring Session can return to / (or /g/<slug>) after this one
        // operation is resolved instead of becoming permanently pinned to /c/<id>.
        if (!session.operation.launchUrl) session.operation.launchUrl = task.normalizedUrl;
        task.url = observedConversation;
        task.normalizedUrl = observedConversation;
        task.lastConversationUrl = observedConversation;
        session.operation.targetUrl = observedConversation;
      }
      const unattended = session.retryPolicy !== 'manual';
      session.lastError = unattended
        ? 'Спроба надсилання ще не підтверджена. Автоматичне відновлення триває.'
        : 'Спроба надсилання ще не підтверджена. Очікується ручне рішення.';
      if (session.operation && !session.operation.verificationDeadline) {
        const recoveryWindow = unattended
          ? Math.max(15000, Math.min(45000, Math.max(1000, session.retryBackoffMs || 30000) * 2))
          : 120000;
        session.operation.verificationDeadline = now + recoveryWindow;
      }
      task.retryAfterAt = Math.min(
        now + Math.max(1000, session.retryBackoffMs || 30000),
        session.operation?.verificationDeadline || Infinity,
      );
      if (![RunState.PAUSED, RunState.STOPPED].includes(session.runState)) session.runState = RunState.RECOVERING;
      if (session.operation) { session.operation.phase = OperationPhase.AMBIGUOUS; session.operation.updatedAt = now; }
      return { action: 'RECOVER_BEFORE_RESEND', retryAt: task.retryAfterAt };
    }
    case InteractionResult.TEMPORARY_ERROR: {
      task.status = 'RETRY_WAIT';
      const retryAt = now + Math.max(1000, session.retryBackoffMs || 30000);
      task.retryAfterAt = retryAt;
      if (session.urlMode === 'shared') {
        for (const candidateId of session.taskOrder || []) {
          const candidate = session.tasksById[candidateId];
          if (!candidate?.enabled || candidate.manualReviewReason) continue;
          candidate.retryAfterAt = Math.max(candidate.retryAfterAt || 0, retryAt);
        }
      }
      return { action: 'RETRY_LATER', retryAt };
    }
    case InteractionResult.RATE_LIMITED: {
      task.status = 'RATE_LIMITED';
      // The acknowledgement button only dismisses ChatGPT's informational modal.
      // Respect the notice itself ("wait a few minutes") instead of hammering the
      // same account every 15-30 seconds. Five minutes is the minimum durable hold.
      const retryAt = Number.isFinite(rateLimitRetryAt) && rateLimitRetryAt > now
        ? rateLimitRetryAt
        : now + Math.max(rateLimitBackoffMs, session.retryBackoffMs || 0);
      task.retryAfterAt = retryAt;
      // If the limit was detected before any Send attempt, the current insertion/pre-send
      // operation is safe to abandon and rebuild after the cooldown. This prevents a
      // stale PRE_SEND_WAIT/INSERTING operation from bouncing through short recovery loops.
      if (session.operation?.taskId === taskId
          && Number(session.operation.submitStartedAt || 0) <= 0
          && ![OperationPhase.SENT_VERIFIED, OperationPhase.AMBIGUOUS].includes(session.operation.phase)) {
        session.operation.phase = OperationPhase.FAILED_SAFE;
        session.operation.updatedAt = now;
      }
      // A shared launch URL represents one logical ChatGPT surface/account lane.
      // Hold the whole series and retry the same logical cycle after the cooldown.
      if (session.urlMode === 'shared') {
        for (const candidateId of session.taskOrder || []) {
          const candidate = session.tasksById[candidateId];
          if (!candidate?.enabled || candidate.manualReviewReason) continue;
          candidate.retryAfterAt = Math.max(candidate.retryAfterAt || 0, retryAt);
        }
      }
      return { action: 'BACKOFF', retryAt };
    }
    case InteractionResult.AUTH_REQUIRED:
    case InteractionResult.UNKNOWN_UI:
    case InteractionResult.MANUAL_REVIEW_REQUIRED: {
      const reason = result.safeDiagnosticCode || result.status;
      // A check for the next task can happen while the previous task's terminal
      // operation record is still retained for provenance. Never mutate that
      // previous operation in response to a result that belongs to another task.
      const operationForTask = session.operation?.taskId === taskId ? session.operation : null;
      if (session.retryPolicy !== 'manual') {
        const retryAt = now + Math.max(5000, session.retryBackoffMs || 30000);
        task.status = 'RETRY_WAIT';
        task.manualReviewReason = '';
        task.retryAfterAt = Math.max(task.retryAfterAt || 0, retryAt);
        if (session.urlMode === 'shared') {
          for (const candidateId of session.taskOrder || []) {
            const candidate = session.tasksById[candidateId];
            if (!candidate?.enabled) continue;
            candidate.retryAfterAt = Math.max(candidate.retryAfterAt || 0, retryAt);
          }
        }
        session.lastError = result.safeDiagnosticMessage
          || `Тимчасова перешкода ${reason}; автоматичний повтор заплановано.`;
        if (operationForTask) {
          operationForTask.phase = operationForTask.submitStartedAt > 0
            ? OperationPhase.AMBIGUOUS
            : OperationPhase.FAILED_SAFE;
          operationForTask.updatedAt = now;
        }
        if (![RunState.PAUSED, RunState.STOPPED].includes(session.runState)) {
          session.runState = operationForTask?.phase === OperationPhase.AMBIGUOUS
            ? RunState.RECOVERING
            : RunState.RUNNING;
        }
        return { action: 'AUTO_RETRY', retryAt };
      }

      task.status = 'MANUAL_REVIEW';
      task.manualReviewReason = reason;
      session.lastError = result.safeDiagnosticMessage || `Потрібна перевірка: ${task.manualReviewReason}`;
      if (session.runState !== RunState.STOPPED) session.runState = RunState.PAUSED;
      if (operationForTask) { operationForTask.phase = OperationPhase.MANUAL_REVIEW; operationForTask.updatedAt = now; }
      return { action: 'MANUAL_REVIEW' };
    }
    default:
      throw new Error(`Unknown interaction result: ${result?.status}`);
  }
}
