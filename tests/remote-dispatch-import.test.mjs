import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, OperationPhase, RunState, validateState } from '../src/core/schema.js';
import { normalizeRemoteDispatch } from '../src/core/remote-dispatch.js';
import {
  compileRemoteSession,
  reconcileRemoteDispatchIntoState,
  remoteLocalSessionId,
  remoteLocalTaskId,
  remoteSessionIsSafeToReconfigure,
} from '../src/core/remote-dispatch-import.js';

function dispatchRaw() {
  return {
    schema_version: 1, dispatch_id: 'dispatch-1', strategy_revision: 1,
    generated_at: '2026-09-11T18:00:00Z', expires_at: '2026-09-11T20:00:00Z',
    project_id: 'project-a', target_repository: 'owner/repo', supersedes_dispatch_ids: [],
    policy: { poll_interval_seconds: 180, fallback_after_seconds: 900, fallback_enabled: true, max_active_sessions: 2 },
    sessions: [
      { session_key: 'a', name: 'A', order: 20, enabled: true, run_mode: 'ONE_PASS', tab_strategy: 'OPEN_CLOSE_PER_TASK', minimum_send_interval_seconds: 120, pre_send_delay_seconds: 8, busy_check_delay_seconds: 2, retry_backoff_seconds: 60, not_before: null, expires_at: null,
        tasks: [
          { task_id: 'two', order: 20, enabled: true, url: 'https://chatgpt.com/', prompt: 'two', not_before: null, expires_at: null, max_launches: 1, supersedes_task_ids: [] },
          { task_id: 'one', order: 10, enabled: true, url: 'https://chatgpt.com/', prompt: 'one', not_before: null, expires_at: null, max_launches: 1, supersedes_task_ids: [] },
        ] },
      { session_key: 'b', name: 'B', order: 10, enabled: true, run_mode: 'CONTINUOUS', tab_strategy: 'ONE_WORKER_TAB_PER_SESSION', minimum_send_interval_seconds: 180, pre_send_delay_seconds: 5, busy_check_delay_seconds: 3, retry_backoff_seconds: 30, not_before: null, expires_at: null,
        tasks: [{ task_id: 'x', order: 1, enabled: true, url: 'https://chatgpt.com/', prompt: 'x', not_before: null, expires_at: null, max_launches: 3, supersedes_task_ids: [] }] },
    ],
  };
}

function dispatch() { return normalizeRemoteDispatch(dispatchRaw()); }

test('remote identities map deterministically to local Session/Task ids', () => {
  assert.equal(remoteLocalSessionId('project-a', 'builders'), 'remote:project-a:builders');
  assert.equal(remoteLocalTaskId('project-a', 'builders', 'task/1'), 'remote:project-a:builders:task:task_2F1');
});

test('compiled remote session uses canonical Session/Task schema and unique prompts', () => {
  const d = dispatch();
  const session = compileRemoteSession(d, d.sessions[0], 100);
  const state = createEmptyState(1);
  state.sessionsById[session.id] = session;
  state.sessionOrder = [session.id];
  state.logs[session.id] = [];
  assert.doesNotThrow(() => validateState(state));
  assert.equal(session.promptMode, 'UNIQUE');
  assert.equal(session.minimumSendIntervalMs, 180000); // session b sorts first
  assert.equal(session.tasksById[session.taskOrder[0]].promptOverride, 'x');
  assert.equal(session.remoteDispatch.projectId, 'project-a');
});

test('reconcile adds remote sessions in coordinator order without replacing local sessions', () => {
  const state = createEmptyState(1);
  const local = compileRemoteSession(dispatch(), dispatch().sessions[0], 1);
  local.id = 'local-existing';
  local.tasksById[local.taskOrder[0]].id = local.taskOrder[0];
  delete local.remoteDispatch;
  state.sessionsById[local.id] = local;
  state.sessionOrder = [local.id];
  state.logs[local.id] = [];
  const result = reconcileRemoteDispatchIntoState(state, dispatch(), { nowMs: 100 });
  assert.equal(result.applied.length, 2);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.state.sessionOrder[0], 'local-existing');
  assert.deepEqual(result.state.sessionOrder.slice(1), [remoteLocalSessionId('project-a', 'b'), remoteLocalSessionId('project-a', 'a')]);
  assert.doesNotThrow(() => validateState(result.state));
});

test('reconcile does not mutate caller state', () => {
  const state = createEmptyState(1);
  const before = structuredClone(state);
  reconcileRemoteDispatchIntoState(state, dispatch(), { nowMs: 100 });
  assert.deepEqual(state, before);
});

test('active remote session is fail-closed and not reconfigured', () => {
  let state = reconcileRemoteDispatchIntoState(createEmptyState(1), dispatch(), { nowMs: 100 }).state;
  const id = remoteLocalSessionId('project-a', 'a');
  state.sessionsById[id].runState = RunState.RUNNING;
  const changed = dispatchRaw();
  changed.strategy_revision = 2;
  changed.dispatch_id = 'dispatch-2';
  changed.sessions.find(s => s.session_key === 'a').tasks.find(t => t.task_id === 'one').prompt = 'CHANGED';
  const result = reconcileRemoteDispatchIntoState(state, normalizeRemoteDispatch(changed), { nowMs: 200 });
  assert.equal(result.blocked.find(x => x.sessionKey === 'a').reason, 'SESSION_ACTIVE');
  const taskId = remoteLocalTaskId('project-a', 'a', 'one');
  assert.equal(result.state.sessionsById[id].tasksById[taskId].promptOverride, 'one');
});

test('unresolved send operation blocks remote prompt/url reconfiguration', () => {
  let state = reconcileRemoteDispatchIntoState(createEmptyState(1), dispatch(), { nowMs: 100 }).state;
  const id = remoteLocalSessionId('project-a', 'a');
  const taskId = remoteLocalTaskId('project-a', 'a', 'one');
  state.sessionsById[id].runState = RunState.PAUSED;
  state.sessionsById[id].operation = {
    operationId: 'op-1', sessionId: id, taskId, promptFingerprint: 'fp', phase: OperationPhase.AMBIGUOUS,
    targetUrl: 'https://chatgpt.com/', createdAt: 1, updatedAt: 2, preSendDeadline: 0, submitStartedAt: 2, verificationDeadline: 3,
  };
  const changed = dispatchRaw();
  changed.strategy_revision = 2; changed.dispatch_id = 'dispatch-2';
  changed.sessions.find(s => s.session_key === 'a').tasks.find(t => t.task_id === 'one').prompt = 'CHANGED';
  const result = reconcileRemoteDispatchIntoState(state, normalizeRemoteDispatch(changed), { nowMs: 200 });
  assert.equal(result.blocked.find(x => x.sessionKey === 'a').reason, 'UNRESOLVED_OPERATION');
  assert.equal(result.state.sessionsById[id].tasksById[taskId].promptOverride, 'one');
});

test('stopped remote session safely updates config and preserves verified runtime evidence', () => {
  let state = reconcileRemoteDispatchIntoState(createEmptyState(1), dispatch(), { nowMs: 100 }).state;
  const id = remoteLocalSessionId('project-a', 'a');
  const taskId = remoteLocalTaskId('project-a', 'a', 'one');
  const session = state.sessionsById[id];
  session.runState = RunState.STOPPED;
  session.tasksById[taskId].lastVerifiedSendAt = 123;
  session.tasksById[taskId].lastVerifiedFingerprint = 'sha256:verified';
  const changed = dispatchRaw();
  changed.strategy_revision = 2; changed.dispatch_id = 'dispatch-2';
  changed.sessions.find(s => s.session_key === 'a').tasks.find(t => t.task_id === 'one').prompt = 'CHANGED';
  const result = reconcileRemoteDispatchIntoState(state, normalizeRemoteDispatch(changed), { nowMs: 200 });
  assert.equal(result.blocked.length, 0);
  assert.equal(result.state.sessionsById[id].tasksById[taskId].promptOverride, 'CHANGED');
  assert.equal(result.state.sessionsById[id].tasksById[taskId].lastVerifiedSendAt, 123);
  assert.equal(result.state.sessionsById[id].tasksById[taskId].lastVerifiedFingerprint, 'sha256:verified');
  assert.equal(result.state.sessionsById[id].remoteDispatch.dispatchId, 'dispatch-2');
});

test('changed remote URL clears prior task runtime evidence and tab hint', () => {
  let state = reconcileRemoteDispatchIntoState(createEmptyState(1), dispatch(), { nowMs: 100 }).state;
  const id = remoteLocalSessionId('project-a', 'a');
  const taskId = remoteLocalTaskId('project-a', 'a', 'one');
  state.sessionsById[id].tasksById[taskId].lastVerifiedSendAt = 123;
  state.tabHintsByTaskId[taskId] = { tabId: 9, sessionId: id, normalizedUrl: 'https://chatgpt.com/' };
  const changed = dispatchRaw();
  changed.strategy_revision = 2; changed.dispatch_id = 'dispatch-2';
  changed.sessions.find(s => s.session_key === 'a').tasks.find(t => t.task_id === 'one').url = 'https://chatgpt.com/g/g-test';
  const result = reconcileRemoteDispatchIntoState(state, normalizeRemoteDispatch(changed), { nowMs: 200 });
  assert.equal(result.state.sessionsById[id].tasksById[taskId].lastVerifiedSendAt, 0);
  assert.equal(result.state.tabHintsByTaskId[taskId], undefined);
});

test('safe terminal operation does not grant authority to edit operation binding', () => {
  const base = dispatch();
  let state = reconcileRemoteDispatchIntoState(createEmptyState(1), base, { nowMs: 100 }).state;
  const id = remoteLocalSessionId('project-a', 'a');
  const taskId = remoteLocalTaskId('project-a', 'a', 'one');
  state.sessionsById[id].operation = {
    operationId: 'op-safe', sessionId: id, taskId, promptFingerprint: 'fp', phase: OperationPhase.SENT_VERIFIED,
    targetUrl: 'https://chatgpt.com/', createdAt: 1, updatedAt: 2, preSendDeadline: 0, submitStartedAt: 2, verificationDeadline: 3,
  };
  assert.equal(remoteSessionIsSafeToReconfigure(state.sessionsById[id]), true);
  const changed = dispatchRaw(); changed.dispatch_id = 'dispatch-2'; changed.strategy_revision = 2;
  const result = reconcileRemoteDispatchIntoState(state, normalizeRemoteDispatch(changed), { nowMs: 200 });
  assert.equal(result.state.sessionsById[id].operation.operationId, 'op-safe');
  assert.equal(result.state.sessionsById[id].operation.taskId, taskId);
});


test('new dispatch identity resets one-pass completion but preserves verified evidence', () => {
  let state = reconcileRemoteDispatchIntoState(createEmptyState(1), dispatch(), { nowMs: 100 }).state;
  const id = remoteLocalSessionId('project-a', 'a');
  const taskId = remoteLocalTaskId('project-a', 'a', 'one');
  state.sessionsById[id].onePassCompletedTaskIds = [taskId];
  state.sessionsById[id].completedAt = 150;
  state.sessionsById[id].tasksById[taskId].lastVerifiedSendAt = 123;
  state.sessionsById[id].tasksById[taskId].lastVerifiedFingerprint = 'sha256:old';
  const newer = dispatchRaw(); newer.dispatch_id = 'dispatch-2'; newer.strategy_revision = 2;
  const result = reconcileRemoteDispatchIntoState(state, normalizeRemoteDispatch(newer), { nowMs: 200 });
  assert.deepEqual(result.state.sessionsById[id].onePassCompletedTaskIds, []);
  assert.equal(result.state.sessionsById[id].completedAt, 0);
  assert.equal(result.state.sessionsById[id].tasksById[taskId].lastVerifiedFingerprint, 'sha256:old');
});
