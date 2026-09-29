import { sessionSchedulingClass } from './scheduler-fairness.js';

// 0.9.8+: cross-session pacing is no longer implemented as a profile-wide
// 90-second barrier. Each Session owns its own cadence; account-wide pauses are
// applied only when ChatGPT explicitly reports a rate limit.
export const DEFAULT_PROFILE_SEND_GAP_MS = 0;

// Legacy compatibility only. New submission code does not acquire a single
// profile-wide lease because independent Sessions operate in independently-owned
// tabs and already persist their own durable SUBMITTING operation checkpoint.
export function acquireSendLease(state, { sessionId, operationId, now = Date.now(), ttlMs = 30000 }) {
  const current = state.sendArbiter.lease;
  if (current && current.expiresAt > now && current.ownerSessionId === sessionId && current.operationId === operationId) return true;
  state.sendArbiter.lease = { ownerSessionId: sessionId, operationId, acquiredAt: now, expiresAt: now + ttlMs };
  return true;
}

export function releaseSendLease(state, { sessionId, operationId }) {
  const lease = state.sendArbiter.lease;
  if (!lease || lease.ownerSessionId !== sessionId || lease.operationId !== operationId) return false;
  state.sendArbiter.lease = null;
  return true;
}

export function recordVerifiedSend(state, { sessionId, now = Date.now() }) {
  state.sendArbiter.lastSentSessionId = sessionId;
  state.sendArbiter.lastSentSchedulingClass = sessionSchedulingClass(state.sessionsById?.[sessionId]);
  // Clear any persisted pre-0.9.8 barrier. It is no longer authoritative.
  state.sendArbiter.profileNextAllowedSendAt = 0;
  const lease = state.sendArbiter.lease;
  if (lease?.ownerSessionId === sessionId) state.sendArbiter.lease = null;
  return now;
}
