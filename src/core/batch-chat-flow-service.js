import { RunState, PromptMode, RunMode, TabStrategy } from './schema.js';
import { appendLog } from './logger.js';
import { buildBatchTasks, normalizeBatchChatFlow, validateBatchChatFlow } from './batch-chat-flow.js';

function requireSession(state, sessionId) {
  const session = state.sessionsById[sessionId];
  if (!session) throw new Error('Session not found');
  return session;
}

export function configureBatchChatFlow(state, sessionId, rawConfig, now = Date.now()) {
  const session = requireSession(state, sessionId);
  if (![RunState.STOPPED, RunState.ERROR].includes(session.runState)) {
    throw new Error('Зупиніть Session перед зміною пакетної роботи.');
  }
  const config = validateBatchChatFlow({ ...rawConfig, enabled: true, nextOrdinal: 1, completedTasks: 0 });
  const tasks = buildBatchTasks(config);
  session.batchChatFlow = { ...normalizeBatchChatFlow(config), nextOrdinal: tasks.length + 1, completedTasks: 0 };
  session.promptMode = PromptMode.SHARED;
  session.sharedPrompt = config.primaryPrompt;
  session.runMode = RunMode.CONTINUOUS;
  session.tabStrategy = TabStrategy.KEEP_TASK_TABS_OPEN;
  session.taskOrder = tasks.map(task => task.id);
  session.tasksById = Object.fromEntries(tasks.map(task => [task.id, task]));
  session.currentTaskIndex = 0;
  session.onePassCompletedTaskIds = [];
  session.nextAllowedSendAt = 0;
  session.operation = null;
  session.lastError = '';
  session.version = (session.version || 0) + 1;
  session.updatedAt = now;
  appendLog(state, session.id, 'Batch Chat Flow configured', { at: now });
  return session;
}

export function batchChatFlowSnapshot(state, sessionId) {
  const session = requireSession(state, sessionId);
  return {
    config: normalizeBatchChatFlow(session.batchChatFlow || {}),
    taskCount: session.taskOrder.length,
    activeTaskCount: session.taskOrder.filter(id => session.tasksById[id]?.enabled).length,
    completedTasks: Number(session.batchChatFlow?.completedTasks || 0),
    totalTasks: Number(session.batchChatFlow?.totalTasks || 0),
    nextOrdinal: Number(session.batchChatFlow?.nextOrdinal || 1),
    runState: session.runState,
  };
}

export function startBatchChatFlow(state, sessionId, now = Date.now()) {
  const session = requireSession(state, sessionId);
  const config = validateBatchChatFlow(session.batchChatFlow || {});
  if (![RunState.STOPPED, RunState.ERROR].includes(session.runState)) throw new Error('Batch Session вже запущена або призупинена.');
  if (!session.taskOrder.length) throw new Error('Немає batch-слотів для запуску.');
  session.runState = RunState.RUNNING;
  session.pausedByMaster = false;
  session.sharedPrompt = config.primaryPrompt;
  session.lastError = '';
  session.updatedAt = now;
  appendLog(state, session.id, 'Batch Chat Flow started', { at: now });
  return session;
}
