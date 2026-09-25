import { OperationPhase, PromptMode, RunState, createSession, createTask, validateState } from './schema.js';

const BLOCKING_OPERATION_PHASES = new Set([
  OperationPhase.CHECKING,
  OperationPhase.READY,
  OperationPhase.INSERTING,
  OperationPhase.INSERTED,
  OperationPhase.PRE_SEND_WAIT,
  OperationPhase.SUBMITTING,
  OperationPhase.AMBIGUOUS,
  OperationPhase.MANUAL_REVIEW,
]);

function encodeIdentity(value) {
  return encodeURIComponent(String(value)).replace(/%/gu, '_');
}

export function remoteLocalSessionId(projectId, sessionKey) {
  if (!projectId || !sessionKey) throw new Error('Remote project/session identity required');
  return `remote:${encodeIdentity(projectId)}:${encodeIdentity(sessionKey)}`;
}

export function remoteLocalTaskId(projectId, sessionKey, taskId) {
  if (!taskId) throw new Error('Remote task identity required');
  return `${remoteLocalSessionId(projectId, sessionKey)}:task:${encodeIdentity(taskId)}`;
}

export function remoteSessionIsSafeToReconfigure(session) {
  if (!session) return true;
  if (![RunState.STOPPED, RunState.PAUSED, RunState.ERROR].includes(session.runState)) return false;
  if (!session.operation) return true;
  return !BLOCKING_OPERATION_PHASES.has(session.operation.phase);
}

function compileRemoteTask(dispatch, remoteSession, remoteTask) {
  const task = createTask({
    id: remoteLocalTaskId(dispatch.project_id, remoteSession.session_key, remoteTask.task_id),
    url: remoteTask.url,
    promptOverride: remoteTask.prompt,
    enabled: remoteTask.enabled,
    label: remoteTask.task_id,
  });
  return task;
}

export function compileRemoteSession(dispatch, remoteSession, nowMs = Date.now()) {
  const tasks = remoteSession.tasks.map(task => compileRemoteTask(dispatch, remoteSession, task));
  const session = createSession({
    id: remoteLocalSessionId(dispatch.project_id, remoteSession.session_key),
    name: remoteSession.name,
    tasks,
    promptMode: PromptMode.UNIQUE,
    sharedPrompt: '',
    runMode: remoteSession.run_mode,
    minimumSendIntervalMs: remoteSession.minimum_send_interval_seconds * 1000,
    preSendDelayMs: remoteSession.pre_send_delay_seconds * 1000,
    busyCheckDelayMs: remoteSession.busy_check_delay_seconds * 1000,
    retryBackoffMs: remoteSession.retry_backoff_seconds * 1000,
    tabStrategy: remoteSession.tab_strategy,
    now: nowMs,
  });
  session.enabled = remoteSession.enabled;
  session.version = 1;
  session.defaultUniquePrompt = '';
  session.retryPolicy = 'safe';
  session.busyChatBehavior = 'skip-next';
  session.urlMode = 'unique';
  session.pausedByMaster = false;
  session.remoteDispatch = {
    managed: true,
    projectId: dispatch.project_id,
    dispatchId: dispatch.dispatch_id,
    strategyRevision: dispatch.strategy_revision,
    sessionKey: remoteSession.session_key,
    notBefore: remoteSession.not_before,
    expiresAt: remoteSession.expires_at,
  };
  for (const [index, remoteTask] of remoteSession.tasks.entries()) {
    const localTask = session.tasksById[session.taskOrder[index]];
    localTask.remoteDispatch = {
      taskId: remoteTask.task_id,
      order: remoteTask.order,
      notBefore: remoteTask.not_before,
      expiresAt: remoteTask.expires_at,
      maxLaunches: remoteTask.max_launches,
      supersedesTaskIds: structuredClone(remoteTask.supersedes_task_ids),
    };
  }
  return session;
}

function preserveSafeRuntime(oldSession, replacement) {
  replacement.runState = oldSession.runState;
  replacement.pausedByMaster = oldSession.pausedByMaster === true;
  replacement.nextAllowedSendAt = Math.max(0, Number(oldSession.nextAllowedSendAt || 0));
  replacement.lastActionAt = Math.max(0, Number(oldSession.lastActionAt || 0));
  replacement.lastSuccessfulSendAt = Math.max(0, Number(oldSession.lastSuccessfulSendAt || 0));
  replacement.successfulSendCount = Math.max(0, Number(oldSession.successfulSendCount || 0));
  replacement.lastError = String(oldSession.lastError || '');
  replacement.createdAt = oldSession.createdAt;
  replacement.updatedAt = oldSession.updatedAt;
  replacement.version = Math.max(1, Number(oldSession.version || 1)) + 1;

  // Terminal operation evidence may remain until normal recovery/stop cleanup.
  replacement.operation = oldSession.operation ? structuredClone(oldSession.operation) : null;

  const sameDispatchIdentity = oldSession.remoteDispatch?.dispatchId === replacement.remoteDispatch?.dispatchId;
  const completed = sameDispatchIdentity ? new Set(oldSession.onePassCompletedTaskIds || []) : new Set();
  replacement.onePassCompletedTaskIds = replacement.taskOrder.filter(taskId => completed.has(taskId));
  replacement.completedAt = sameDispatchIdentity
    && replacement.onePassCompletedTaskIds.length === replacement.taskOrder.filter(id => replacement.tasksById[id]?.enabled).length
      ? Math.max(0, Number(oldSession.completedAt || 0)) : 0;

  for (const taskId of replacement.taskOrder) {
    const oldTask = oldSession.tasksById?.[taskId];
    const nextTask = replacement.tasksById[taskId];
    if (!oldTask || oldTask.normalizedUrl !== nextTask.normalizedUrl) continue;
    for (const field of [
      'status', 'lastCheckedAt', 'lastVerifiedSendAt', 'lastVerifiedFingerprint', 'retryAfterAt',
      'manualReviewReason', 'lastConversationUrl', 'lastAssistantReport', 'lastAssistantReportAt',
      'lastAssistantBaselineCount', 'lastAssistantBaselineKnown',
    ]) {
      if (oldTask[field] !== undefined) nextTask[field] = structuredClone(oldTask[field]);
    }
  }
  return replacement;
}

function cleanRemoteTabHints(state, oldSession, replacement) {
  for (const [key, hint] of Object.entries(state.tabHintsByTaskId || {})) {
    if (hint?.sessionId !== oldSession.id) continue;
    const task = replacement.tasksById[key];
    const workerHint = key === `__session_worker__:${oldSession.id}`;
    if (workerHint || !task || task.normalizedUrl !== hint.normalizedUrl || oldSession.tabStrategy !== replacement.tabStrategy) {
      delete state.tabHintsByTaskId[key];
    }
  }
}

export function reconcileRemoteDispatchIntoState(state, dispatch, { nowMs = Date.now() } = {}) {
  validateState(state);
  const next = structuredClone(state);
  const applied = [];
  const blocked = [];

  for (const remoteSession of dispatch.sessions) {
    const localId = remoteLocalSessionId(dispatch.project_id, remoteSession.session_key);
    const existing = next.sessionsById[localId];
    if (existing && existing.remoteDispatch?.managed !== true) {
      blocked.push({ sessionKey: remoteSession.session_key, localSessionId: localId, reason: 'LOCAL_ID_COLLISION' });
      continue;
    }
    if (existing && !remoteSessionIsSafeToReconfigure(existing)) {
      blocked.push({ sessionKey: remoteSession.session_key, localSessionId: localId, reason: existing.operation ? 'UNRESOLVED_OPERATION' : 'SESSION_ACTIVE' });
      continue;
    }

    let replacement = compileRemoteSession(dispatch, remoteSession, nowMs);
    if (existing) {
      replacement = preserveSafeRuntime(existing, replacement);
      replacement.updatedAt = nowMs;
      cleanRemoteTabHints(next, existing, replacement);
    }
    next.sessionsById[localId] = replacement;
    if (!next.sessionOrder.includes(localId)) next.sessionOrder.push(localId);
    if (!Array.isArray(next.logs[localId])) next.logs[localId] = [];
    applied.push({ sessionKey: remoteSession.session_key, localSessionId: localId, created: !existing });
  }

  // Deterministic position for remote-managed sessions: keep local sessions in their
  // existing order, then current dispatch remote sessions in coordinator order.
  const currentRemoteIds = dispatch.sessions.map(session => remoteLocalSessionId(dispatch.project_id, session.session_key));
  const currentRemoteSet = new Set(currentRemoteIds);
  const localAndOther = next.sessionOrder.filter(id => !currentRemoteSet.has(id));
  next.sessionOrder = [...localAndOther, ...currentRemoteIds.filter(id => next.sessionsById[id])];

  validateState(next);
  return { state: next, applied, blocked };
}
