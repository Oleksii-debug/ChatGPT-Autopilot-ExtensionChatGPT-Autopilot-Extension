import { RunState } from './schema.js';
import { appendLog } from './logger.js';
import { buildBatchTasks, normalizeBatchChatFlow, validateBatchChatFlow, isBatchSessionComplete } from './batch-chat-flow.js';
import {
  ExecutionModuleId,
  createBatchModuleWorkspace,
  createModuleSessionView,
  ensureSessionModuleState,
} from './module-workspaces.js';
import { startSession } from './state-machine.js';

function requireSession(state, sessionId) {
  const session = state.sessionsById[sessionId];
  if (!session) throw new Error('Session not found');
  ensureSessionModuleState(session);
  return session;
}

function requireBatchWorkspace(session) {
  const workspace = session.moduleWorkspaces?.[ExecutionModuleId.BATCH_CHAT];
  if (!workspace) throw new Error('Пакетну роботу ще не налаштовано.');
  return workspace;
}

export function configureBatchChatFlow(state, sessionId, rawConfig, now = Date.now()) {
  const session = requireSession(state, sessionId);
  if (![RunState.STOPPED, RunState.ERROR].includes(session.runState)) {
    throw new Error('Зупиніть Session перед зміною пакетної роботи.');
  }
  const config = validateBatchChatFlow({ ...rawConfig, enabled: true, nextOrdinal: 1, completedTasks: 0 });
  const tasks = buildBatchTasks(config);
  session.batchChatFlow = { ...normalizeBatchChatFlow(config), nextOrdinal: tasks.length + 1, completedTasks: 0 };
  session.moduleWorkspaces[ExecutionModuleId.BATCH_CHAT] = createBatchModuleWorkspace(tasks, {
    now,
    runState: RunState.STOPPED,
  });
  session.version = (session.version || 0) + 1;
  session.updatedAt = now;
  appendLog(state, session.id, 'Batch Chat Flow configured in isolated module workspace', { at: now });
  return session;
}

export function batchChatFlowSnapshot(state, sessionId) {
  const session = requireSession(state, sessionId);
  const workspace = session.moduleWorkspaces?.[ExecutionModuleId.BATCH_CHAT];
  if (!workspace) {
    return {
      config: normalizeBatchChatFlow(session.batchChatFlow || {}),
      taskCount: 0,
      activeTaskCount: 0,
      completedTasks: Number(session.batchChatFlow?.completedTasks || 0),
      totalTasks: Number(session.batchChatFlow?.totalTasks || 0),
      nextOrdinal: Number(session.batchChatFlow?.nextOrdinal || 1),
      runState: RunState.STOPPED,
    };
  }
  const view = createModuleSessionView(session, ExecutionModuleId.BATCH_CHAT);
  return {
    config: normalizeBatchChatFlow(session.batchChatFlow || {}),
    taskCount: view.taskOrder.length,
    activeTaskCount: view.taskOrder.filter(id => view.tasksById[id]?.enabled).length,
    completedTasks: Number(session.batchChatFlow?.completedTasks || 0),
    totalTasks: Number(session.batchChatFlow?.totalTasks || 0),
    nextOrdinal: Number(session.batchChatFlow?.nextOrdinal || 1),
    runState: view.runState,
    lastError: view.lastError || '',
    moduleCompleted: view.moduleCompleted === true,
  };
}

export function startBatchChatFlow(state, sessionId, now = Date.now()) {
  const session = requireSession(state, sessionId);
  const config = validateBatchChatFlow(session.batchChatFlow || {});
  const workspace = requireBatchWorkspace(session);
  const view = createModuleSessionView(session, ExecutionModuleId.BATCH_CHAT);
  if (isBatchSessionComplete(view)) throw new Error('Batch Chat Flow уже завершено; налаштуйте новий пакет перед повторним запуском.');
  workspace.runState = RunState.RUNNING;
  workspace.moduleCompleted = false;
  workspace.lastError = '';
  startSession(session, now);
  session.updatedAt = now;
  appendLog(state, session.id, 'Batch Chat Flow started from isolated module workspace', { at: now });
  return session;
}
