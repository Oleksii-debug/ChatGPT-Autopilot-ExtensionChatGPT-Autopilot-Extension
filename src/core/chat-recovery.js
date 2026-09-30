export const ChatRecoveryPhase = Object.freeze({
  IDLE: 'IDLE',
  RETRY_WAIT: 'RETRY_WAIT',
  RELOAD_WAIT: 'RELOAD_WAIT',
  REOPEN_WAIT: 'REOPEN_WAIT',
  FAILED: 'FAILED',
});

export const ChatRecoveryAction = Object.freeze({
  NONE: 'NONE',
  WAIT: 'WAIT',
  RETRY_BUTTON: 'RETRY_BUTTON',
  SAME_URL_RELOAD: 'SAME_URL_RELOAD',
  SAME_URL_REOPEN: 'SAME_URL_REOPEN',
  RECOVERY_SUCCESS: 'RECOVERY_SUCCESS',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
});

export const DEFAULT_CHAT_RECOVERY_POLICY = Object.freeze({
  retryAttempts: 1,
  reloadAttempts: 1,
  reopenAttempts: 1,
  cooldownMs: 30_000,
});

const RECOVERY_CODES = new Set([
  'CHATGPT_ERROR_SURFACE_VISIBLE_REPORT',
  'CHATGPT_RECOVERY_RETRY_UNAVAILABLE',
  'CHATGPT_RECOVERY_RETRY_CLICK_FAILED',
  'CHATGPT_RECOVERY_CONVERSATION_IDENTITY_LOST',
  'ASSISTANT_RESPONSE_TAB_MISSING',
  'ASSISTANT_RESPONSE_TAB_DISCARDED',
  'ASSISTANT_RESPONSE_TAB_FROZEN',
]);

function boundedCount(value) {
  const number = Math.floor(Number(value || 0));
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function safeText(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function normalizeChatRecovery(raw = null) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const phase = Object.values(ChatRecoveryPhase).includes(source.phase)
    ? source.phase
    : ChatRecoveryPhase.IDLE;
  return {
    phase,
    startedAt: Math.max(0, Number(source.startedAt || 0)) || 0,
    nextAt: Math.max(0, Number(source.nextAt || 0)) || 0,
    retryAttempts: boundedCount(source.retryAttempts),
    reloadAttempts: boundedCount(source.reloadAttempts),
    reopenAttempts: boundedCount(source.reopenAttempts),
    lastCategory: safeText(source.lastCategory, 80),
    lastButtonLabel: safeText(source.lastButtonLabel, 80),
    lastErrorLabel: safeText(source.lastErrorLabel, 160),
    lastAction: safeText(source.lastAction, 80),
    lastCode: safeText(source.lastCode, 120),
    elapsedMs: Math.max(0, Number(source.elapsedMs || 0)) || 0,
  };
}

export function isChatRecoveryObservation(report) {
  const code = safeText(report?.safeDiagnosticCode || report?.code, 120);
  return report?.chatRecoveryRequired === true || RECOVERY_CODES.has(code);
}

function observationMetadata(state, report, now) {
  state.lastCategory = safeText(report?.recoveryCategory, 80) || state.lastCategory;
  state.lastButtonLabel = safeText(report?.retryButtonLabel, 80) || state.lastButtonLabel;
  state.lastErrorLabel = safeText(report?.recoveryErrorLabel, 160) || state.lastErrorLabel;
  state.lastCode = safeText(report?.safeDiagnosticCode || report?.code, 120) || state.lastCode;
  if (!state.startedAt) state.startedAt = now;
  state.elapsedMs = Math.max(0, now - state.startedAt);
}

function acted(state, action, now, policy) {
  state.lastAction = action;
  state.nextAt = now + policy.cooldownMs;
  if (action === ChatRecoveryAction.RETRY_BUTTON) {
    state.retryAttempts += 1;
    state.phase = ChatRecoveryPhase.RETRY_WAIT;
  } else if (action === ChatRecoveryAction.SAME_URL_RELOAD) {
    state.reloadAttempts += 1;
    state.phase = ChatRecoveryPhase.RELOAD_WAIT;
  } else if (action === ChatRecoveryAction.SAME_URL_REOPEN) {
    state.reopenAttempts += 1;
    state.phase = ChatRecoveryPhase.REOPEN_WAIT;
  }
  return { state, action };
}

export function planChatRecovery(rawState, report, now = Date.now(), policyRaw = {}) {
  const state = normalizeChatRecovery(rawState);
  const policy = {
    retryAttempts: boundedCount(policyRaw.retryAttempts ?? DEFAULT_CHAT_RECOVERY_POLICY.retryAttempts),
    reloadAttempts: boundedCount(policyRaw.reloadAttempts ?? DEFAULT_CHAT_RECOVERY_POLICY.reloadAttempts),
    reopenAttempts: boundedCount(policyRaw.reopenAttempts ?? DEFAULT_CHAT_RECOVERY_POLICY.reopenAttempts),
    cooldownMs: Math.max(1_000, Number(policyRaw.cooldownMs ?? DEFAULT_CHAT_RECOVERY_POLICY.cooldownMs)) || DEFAULT_CHAT_RECOVERY_POLICY.cooldownMs,
  };
  const active = state.phase !== ChatRecoveryPhase.IDLE;
  const observedFailure = isChatRecoveryObservation(report);

  if (!observedFailure) {
    if (!active) return { state, action: ChatRecoveryAction.NONE };
    return {
      state: normalizeChatRecovery(),
      action: ChatRecoveryAction.RECOVERY_SUCCESS,
      completed: state,
    };
  }

  observationMetadata(state, report, now);
  if (state.phase === ChatRecoveryPhase.FAILED) {
    return { state, action: ChatRecoveryAction.RECOVERY_FAILED, exhausted: true };
  }
  if (state.nextAt > now) return { state, action: ChatRecoveryAction.WAIT };

  if (report?.retryAvailable === true && state.retryAttempts < policy.retryAttempts) {
    return acted(state, ChatRecoveryAction.RETRY_BUTTON, now, policy);
  }
  // There is no physical tab to reload. Recreate this exact saved
  // conversation once, after the effect has been checkpointed by the manager.
  if (state.lastCategory === 'TAB_MISSING') {
    if (state.reopenAttempts < policy.reopenAttempts) {
      return acted(state, ChatRecoveryAction.SAME_URL_REOPEN, now, policy);
    }
    state.phase = ChatRecoveryPhase.FAILED;
    state.nextAt = 0;
    state.lastAction = ChatRecoveryAction.RECOVERY_FAILED;
    state.elapsedMs = Math.max(0, now - state.startedAt);
    return { state, action: ChatRecoveryAction.RECOVERY_FAILED, exhausted: true };
  }
  if (state.reloadAttempts < policy.reloadAttempts) {
    return acted(state, ChatRecoveryAction.SAME_URL_RELOAD, now, policy);
  }
  if (state.reopenAttempts < policy.reopenAttempts) {
    return acted(state, ChatRecoveryAction.SAME_URL_REOPEN, now, policy);
  }

  state.phase = ChatRecoveryPhase.FAILED;
  state.nextAt = 0;
  state.lastAction = ChatRecoveryAction.RECOVERY_FAILED;
  state.elapsedMs = Math.max(0, now - state.startedAt);
  return { state, action: ChatRecoveryAction.RECOVERY_FAILED, exhausted: true };
}

