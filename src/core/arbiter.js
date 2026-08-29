export function acquireSendLease(state, { sessionId, operationId, now = Date.now(), ttlMs = 30000 }) {
  const current = state.sendArbiter.lease;
  if (current && current.expiresAt > now && !(current.ownerSessionId === sessionId && current.operationId === operationId)) return false;
  if ((state.sendArbiter.profileNextAllowedSendAt || 0) > now) return false;
  state.sendArbiter.lease = { ownerSessionId: sessionId, operationId, acquiredAt: now, expiresAt: now + ttlMs };
  return true;
}
export function releaseSendLease(state, { sessionId, operationId, now = Date.now(), profileGapMs = 1000 }) {
  const lease = state.sendArbiter.lease;
  if (!lease || lease.ownerSessionId !== sessionId || lease.operationId !== operationId) return false;
  state.sendArbiter.lease = null;
  state.sendArbiter.profileNextAllowedSendAt = now + profileGapMs;
  return true;
}
