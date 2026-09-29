const LIFECYCLE_SUCCESS_TARGETS = Object.freeze({
  START_SESSION: 'pause-session-button',
  PAUSE_SESSION: 'resume-session-button',
  RESUME_SESSION: 'pause-session-button',
  STOP_SESSION: 'start-session-button',
});

export function lifecycleSuccessTargetId(command) {
  return LIFECYCLE_SUCCESS_TARGETS[command] || null;
}

export function focusAfterLifecycleSuccess(command, getById) {
  const targetId = lifecycleSuccessTargetId(command);
  if (!targetId || typeof getById !== 'function') return null;

  const target = getById(targetId);
  if (target && !target.disabled && typeof target.focus === 'function') {
    target.focus();
    return targetId;
  }

  const fallback = getById('command-result');
  if (fallback && typeof fallback.focus === 'function') {
    fallback.focus();
    return 'command-result';
  }

  return null;
}
