import { OperationPhase, RunState } from './schema.js';
import { canLaunchRemoteTask, recordVerifiedRemoteSend } from './remote-dispatch-ledger.js';
import { remoteLocalSessionId, remoteLocalTaskId } from './remote-dispatch-import.js';

const UNRESOLVED_PHASES = new Set([
  OperationPhase.CHECKING, OperationPhase.READY, OperationPhase.INSERTING, OperationPhase.INSERTED,
  OperationPhase.PRE_SEND_WAIT, OperationPhase.SUBMITTING, OperationPhase.AMBIGUOUS, OperationPhase.MANUAL_REVIEW,
]);

function withinWindow(item, nowMs) {
  const notBefore = item?.not_before ? Date.parse(item.not_before) : 0;
  const expiresAt = item?.expires_at ? Date.parse(item.expires_at) : Infinity;
  return nowMs >= notBefore && nowMs < expiresAt;
}

function sessionHasUnresolvedOperation(session) {
  return Boolean(session?.operation && UNRESOLVED_PHASES.has(session.operation.phase));
}

function dispatchTaskIdentity(dispatch, remoteSession, remoteTask) {
  return {
    projectId: dispatch.project_id,
    dispatchId: dispatch.dispatch_id,
    sessionKey: remoteSession.session_key,
    taskId: remoteTask.task_id,
  };
}

export function syncVerifiedRemoteSendsIntoLedger(state, ledger, { nowMs = Date.now() } = {}) {
  const counted = [];
  for (const session of Object.values(state.sessionsById || {})) {
    const meta = session.remoteDispatch;
    if (!meta?.managed || meta.projectId !== ledger.projectId || !meta.dispatchId || !meta.sessionKey) continue;
    for (const task of Object.values(session.tasksById || {})) {
      const taskMeta = task.remoteDispatch;
      const fingerprint = String(task.lastVerifiedFingerprint || '');
      if (!taskMeta?.taskId || !fingerprint) continue;
      const result = recordVerifiedRemoteSend(ledger, {
        projectId: meta.projectId,
        dispatchId: meta.dispatchId,
        sessionKey: meta.sessionKey,
        taskId: taskMeta.taskId,
      }, fingerprint, { nowMs });
      if (result.counted) counted.push({ sessionId: session.id, taskId: task.id, count: result.count });
    }
  }
  return counted;
}

export function applyRemoteFallbackSession(state, ledger, config, shouldActivate, { nowMs = Date.now() } = {}) {
  const sessionId = String(config?.fallbackSessionId || ledger?.fallbackSessionId || '');
  const session = sessionId ? state.sessionsById?.[sessionId] : null;
  const changed = [];
  let autoStarted = ledger?.fallbackAutoStarted === true;

  if (shouldActivate) {
    if (!session || session.remoteDispatch?.managed) return { state, changed, autoStarted: false, sessionId };
    if (state.profile?.masterPaused || session.pausedByMaster || session.runState === RunState.PAUSED || sessionHasUnresolvedOperation(session)) {
      return { state, changed, autoStarted, sessionId };
    }
    if (session.enabled !== false && session.runState === RunState.STOPPED && !session.completedAt) {
      session.runState = RunState.RUNNING;
      session.lastActionAt = nowMs;
      session.updatedAt = nowMs;
      autoStarted = true;
      changed.push({ sessionId, action: 'FALLBACK_AUTO_STARTED' });
    }
    return { state, changed, autoStarted, sessionId };
  }

  if (session && autoStarted && !sessionHasUnresolvedOperation(session) && [RunState.RUNNING, RunState.RECOVERING].includes(session.runState)) {
    session.runState = RunState.STOPPED;
    session.lastActionAt = nowMs;
    session.updatedAt = nowMs;
    changed.push({ sessionId, action: 'FALLBACK_AUTO_STOPPED' });
    autoStarted = false;
  } else if (!session || ![RunState.RUNNING, RunState.RECOVERING].includes(session.runState)) {
    autoStarted = false;
  }
  return { state, changed, autoStarted, sessionId };
}

export function revokeRemoteDispatchAuthority(state, { projectId = '', nowMs = Date.now() } = {}) {
  const changed = [];
  for (const session of Object.values(state.sessionsById || {})) {
    const meta = session.remoteDispatch;
    if (!meta?.managed || (projectId && meta.projectId !== projectId)) continue;
    const unresolved = sessionHasUnresolvedOperation(session);
    for (const task of Object.values(session.tasksById || {})) {
      if (!unresolved || session.operation?.taskId !== task.id) task.enabled = false;
    }
    session.enabled = false;
    if (!unresolved && [RunState.RUNNING, RunState.RECOVERING].includes(session.runState)) session.runState = RunState.STOPPED;
    session.updatedAt = nowMs;
    changed.push({ sessionId: session.id, action: unresolved ? 'AUTHORITY_REVOKED_OPERATION_HELD' : 'AUTHORITY_REVOKED' });
  }
  return { state, changed };
}

export function applyRemoteDispatchGovernance(state, dispatch, ledger, { nowMs = Date.now(), autoStart = true } = {}) {
  const changed = [];
  const dispatchGeneratedAt = Date.parse(dispatch.generated_at);
  const dispatchExpiresAt = Date.parse(dispatch.expires_at);
  const dispatchActive = nowMs >= dispatchGeneratedAt && nowMs < dispatchExpiresAt;
  const currentSessionKeys = new Set(dispatch.sessions.map(session => session.session_key));
  const currentDispatchSupersedes = new Set(dispatch.supersedes_dispatch_ids || []);
  const supersededTaskIds = new Set();
  for (const remoteSession of dispatch.sessions) for (const remoteTask of remoteSession.tasks) for (const id of remoteTask.supersedes_task_ids || []) supersededTaskIds.add(id);

  // Sessions from prior/removed dispatches in the same project may finish an unresolved
  // operation, but otherwise lose authority to launch new work.
  for (const session of Object.values(state.sessionsById || {})) {
    const meta = session.remoteDispatch;
    if (!meta?.managed || meta.projectId !== dispatch.project_id) continue;
    const obsolete = !currentSessionKeys.has(meta.sessionKey)
      || (meta.dispatchId !== dispatch.dispatch_id && currentDispatchSupersedes.has(meta.dispatchId));
    if (!obsolete || sessionHasUnresolvedOperation(session)) continue;
    for (const task of Object.values(session.tasksById || {})) task.enabled = false;
    session.enabled = false;
    if (session.runState === RunState.RUNNING || session.runState === RunState.RECOVERING) session.runState = RunState.STOPPED;
    session.updatedAt = nowMs;
    changed.push({ sessionId: session.id, action: 'OBSOLETE_STOPPED' });
  }

  let activeRemoteSessions = Object.values(state.sessionsById || {}).filter(session =>
    session.remoteDispatch?.managed
    && session.remoteDispatch.projectId === dispatch.project_id
    && [RunState.RUNNING, RunState.RECOVERING].includes(session.runState)
  ).length;

  for (const remoteSession of dispatch.sessions) {
    const sessionId = remoteLocalSessionId(dispatch.project_id, remoteSession.session_key);
    const session = state.sessionsById?.[sessionId];
    if (!session) continue;
    const sessionWindow = dispatchActive && withinWindow(remoteSession, nowMs);
    const unresolved = sessionHasUnresolvedOperation(session);
    let enabledTasks = 0;

    for (const remoteTask of remoteSession.tasks) {
      const taskId = remoteLocalTaskId(dispatch.project_id, remoteSession.session_key, remoteTask.task_id);
      const task = session.tasksById?.[taskId];
      if (!task) continue;
      const eligible = remoteSession.enabled
        && remoteTask.enabled
        && sessionWindow
        && withinWindow(remoteTask, nowMs)
        && !supersededTaskIds.has(remoteTask.task_id)
        && canLaunchRemoteTask(ledger, dispatchTaskIdentity(dispatch, remoteSession, remoteTask), remoteTask.max_launches);
      if (!unresolved || session.operation?.taskId !== taskId) task.enabled = eligible;
      if (task.enabled) enabledTasks += 1;
    }

    session.enabled = remoteSession.enabled && sessionWindow;
    if ((!session.enabled || enabledTasks === 0) && !unresolved) {
      if ([RunState.RUNNING, RunState.RECOVERING].includes(session.runState)) activeRemoteSessions = Math.max(0, activeRemoteSessions - 1);
      if (session.runState !== RunState.PAUSED) session.runState = RunState.STOPPED;
      session.updatedAt = nowMs;
      changed.push({ sessionId, action: 'NO_ELIGIBLE_WORK' });
      continue;
    }

    if (!autoStart || state.profile?.masterPaused || session.pausedByMaster || session.runState === RunState.PAUSED || unresolved) continue;
    if (session.runState === RunState.STOPPED && !session.completedAt && activeRemoteSessions < dispatch.policy.max_active_sessions) {
      session.runState = RunState.RUNNING;
      session.lastActionAt = nowMs;
      session.updatedAt = nowMs;
      session.remoteDispatch.lastAutoStartedAt = nowMs;
      activeRemoteSessions += 1;
      changed.push({ sessionId, action: 'AUTO_STARTED' });
    }
  }
  return { state, changed, activeRemoteSessions };
}

export function computeRemoteDispatchDeadline(dispatch, ledger, nowMs = Date.now()) {
  let earliest = Infinity;
  for (const remoteSession of dispatch.sessions || []) {
    for (const value of [remoteSession.not_before, remoteSession.expires_at]) {
      if (!value) continue;
      const at = Date.parse(value);
      if (Number.isFinite(at) && at > nowMs) earliest = Math.min(earliest, at);
    }
    for (const task of remoteSession.tasks || []) {
      const identity = dispatchTaskIdentity(dispatch, remoteSession, task);
      if (!canLaunchRemoteTask(ledger, identity, task.max_launches)) continue;
      for (const value of [task.not_before, task.expires_at]) {
        if (!value) continue;
        const at = Date.parse(value);
        if (Number.isFinite(at) && at > nowMs) earliest = Math.min(earliest, at);
      }
    }
  }
  return earliest < Infinity ? earliest : null;
}
