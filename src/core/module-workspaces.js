import { SessionFunctionId, isSessionFunctionEnabled, setSessionFunctionEnabled } from './session-functions.js';

export const ExecutionModuleId = Object.freeze({
  STANDARD_SENDS: 'standard_sends',
  BATCH_CHAT: 'batch_chat',
});

const ACTIVE_ROOT_STATES = new Set(['RUNNING', 'RECOVERING']);
const TERMINAL_OPERATION_PHASES = new Set(['NONE', 'SENT_VERIFIED', 'FAILED_SAFE']);
const BATCH_WORKSPACE_FIELDS = new Set([
  'runState',
  'runMode',
  'tabStrategy',
  'taskOrder',
  'tasksById',
  'currentTaskIndex',
  'nextAllowedSendAt',
  'operation',
  'lastActionAt',
  'lastSuccessfulSendAt',
  'lastError',
  'onePassCompletedTaskIds',
  'moduleCompleted',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inferredModuleRunState(session) {
  if (session?.runState === 'RECOVERING') return 'RECOVERING';
  if (session?.runState === 'RUNNING' || session?.runState === 'PAUSED') return 'RUNNING';
  return 'STOPPED';
}

export function isUnresolvedModuleOperation(operation) {
  return Boolean(operation && !TERMINAL_OPERATION_PHASES.has(operation.phase));
}

export function createBatchModuleWorkspace(tasks, {
  now = 0,
  runState = 'STOPPED',
  sourceSession = null,
} = {}) {
  const taskOrder = tasks.map(task => task.id);
  const tasksById = Object.fromEntries(tasks.map(task => [task.id, task]));
  if (!sourceSession) {
    return {
      runState,
      runMode: 'CONTINUOUS',
      tabStrategy: 'KEEP_TASK_TABS_OPEN',
      taskOrder,
      tasksById,
      currentTaskIndex: 0,
      nextAllowedSendAt: 0,
      operation: null,
      lastActionAt: now,
      lastSuccessfulSendAt: 0,
      lastError: '',
      onePassCompletedTaskIds: [],
      moduleCompleted: false,
    };
  }
  return {
    runState,
    runMode: 'CONTINUOUS',
    tabStrategy: 'KEEP_TASK_TABS_OPEN',
    taskOrder,
    tasksById,
    currentTaskIndex: Math.max(0, Math.min(Number(sourceSession.currentTaskIndex) || 0, Math.max(0, taskOrder.length - 1))),
    nextAllowedSendAt: Math.max(0, Number(sourceSession.nextAllowedSendAt) || 0),
    operation: sourceSession.operation ? structuredClone(sourceSession.operation) : null,
    lastActionAt: Math.max(0, Number(sourceSession.lastActionAt) || 0),
    lastSuccessfulSendAt: Math.max(0, Number(sourceSession.lastSuccessfulSendAt) || 0),
    lastError: typeof sourceSession.lastError === 'string' ? sourceSession.lastError : '',
    onePassCompletedTaskIds: [],
    moduleCompleted: false,
  };
}

function normalizeStandardWorkspace(session) {
  const current = isRecord(session.moduleWorkspaces?.[ExecutionModuleId.STANDARD_SENDS])
    ? session.moduleWorkspaces[ExecutionModuleId.STANDARD_SENDS]
    : {};
  session.moduleWorkspaces[ExecutionModuleId.STANDARD_SENDS] = {
    runState: typeof current.runState === 'string' ? current.runState : inferredModuleRunState(session),
    moduleCompleted: current.moduleCompleted === true,
  };
}

function migrateLegacyBatchWorkspace(session) {
  if (!session.batchChatFlow?.enabled || isRecord(session.moduleWorkspaces?.[ExecutionModuleId.BATCH_CHAT])) return;
  const taskIds = Array.isArray(session.taskOrder) ? session.taskOrder : [];
  const tasks = taskIds.map(id => session.tasksById?.[id]).filter(Boolean);
  if (!tasks.length || tasks.some(task => !task?.batch)) return;
  session.moduleWorkspaces[ExecutionModuleId.BATCH_CHAT] = createBatchModuleWorkspace(
    tasks.map(task => structuredClone(task)),
    { runState: inferredModuleRunState(session), sourceSession: session },
  );
  session.activeFunctions = setSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.BATCH_CHAT, true);
  session.activeFunctions = setSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.ORDINARY_SEND, false);
}

function normalizeBatchWorkspace(session) {
  const workspace = session.moduleWorkspaces?.[ExecutionModuleId.BATCH_CHAT];
  if (!isRecord(workspace)) return;
  if (typeof workspace.runState !== 'string') workspace.runState = inferredModuleRunState(session);
  if (typeof workspace.runMode !== 'string') workspace.runMode = 'CONTINUOUS';
  if (typeof workspace.tabStrategy !== 'string') workspace.tabStrategy = 'KEEP_TASK_TABS_OPEN';
  if (!Array.isArray(workspace.taskOrder)) workspace.taskOrder = [];
  if (!isRecord(workspace.tasksById)) workspace.tasksById = {};
  if (!Number.isInteger(workspace.currentTaskIndex) || workspace.currentTaskIndex < 0) workspace.currentTaskIndex = 0;
  if (!Number.isFinite(workspace.nextAllowedSendAt) || workspace.nextAllowedSendAt < 0) workspace.nextAllowedSendAt = 0;
  if (workspace.operation === undefined) workspace.operation = null;
  if (!Number.isFinite(workspace.lastActionAt) || workspace.lastActionAt < 0) workspace.lastActionAt = 0;
  if (!Number.isFinite(workspace.lastSuccessfulSendAt) || workspace.lastSuccessfulSendAt < 0) workspace.lastSuccessfulSendAt = 0;
  if (typeof workspace.lastError !== 'string') workspace.lastError = '';
  if (!Array.isArray(workspace.onePassCompletedTaskIds)) workspace.onePassCompletedTaskIds = [];
  workspace.moduleCompleted = workspace.moduleCompleted === true;
}

export function ensureSessionModuleState(session) {
  if (!session || typeof session !== 'object') throw new Error('Session required');
  if (!isRecord(session.moduleWorkspaces)) session.moduleWorkspaces = {};
  if (!isRecord(session.moduleCoordinator)) session.moduleCoordinator = {};
  if (typeof session.moduleCoordinator.lastModuleId !== 'string') session.moduleCoordinator.lastModuleId = '';
  normalizeStandardWorkspace(session);
  migrateLegacyBatchWorkspace(session);
  normalizeBatchWorkspace(session);
  return session;
}

export function createModuleSessionView(session, moduleId) {
  ensureSessionModuleState(session);
  if (moduleId === ExecutionModuleId.BATCH_CHAT && !session.moduleWorkspaces[ExecutionModuleId.BATCH_CHAT]) return null;
  const workspace = session.moduleWorkspaces[moduleId];
  if (!workspace) return null;
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === '__moduleId') return moduleId;
      if (property === '__rootSession') return target;
      if (property === 'runState') {
        if (!ACTIVE_ROOT_STATES.has(target.runState)) return target.runState;
        if (workspace.moduleCompleted === true) return workspace.runState || 'STOPPED';
        if (workspace.runState === 'RECOVERING' || workspace.runState === 'RUNNING') return workspace.runState;
        if (moduleId === ExecutionModuleId.STANDARD_SENDS) {
          const enabled = isSessionFunctionEnabled(target.activeFunctions, SessionFunctionId.ORDINARY_SEND);
          if (enabled || isUnresolvedModuleOperation(target.operation)) return target.runState;
        }
        if (moduleId === ExecutionModuleId.BATCH_CHAT) {
          const enabled = isSessionFunctionEnabled(target.activeFunctions, SessionFunctionId.BATCH_CHAT)
            && target.batchChatFlow?.enabled === true;
          if (enabled || isUnresolvedModuleOperation(workspace.operation)) return target.runState;
        }
        return workspace.runState || target.runState;
      }
      if (property === 'moduleCompleted') return workspace.moduleCompleted === true;
      if (property === 'batchChatFlow' && moduleId === ExecutionModuleId.STANDARD_SENDS) {
        return target.batchChatFlow ? { ...target.batchChatFlow, enabled: false } : { enabled: false };
      }
      if (moduleId === ExecutionModuleId.BATCH_CHAT && BATCH_WORKSPACE_FIELDS.has(property)) return workspace[property];
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (property === 'runState') {
        workspace.runState = value;
        if (value === 'STOPPED' && ACTIVE_ROOT_STATES.has(target.runState)) workspace.moduleCompleted = true;
        return true;
      }
      if (property === 'moduleCompleted') {
        workspace.moduleCompleted = value === true;
        return true;
      }
      if (moduleId === ExecutionModuleId.BATCH_CHAT && BATCH_WORKSPACE_FIELDS.has(property)) {
        workspace[property] = value;
        return true;
      }
      return Reflect.set(target, property, value, receiver);
    },
  });
}

export function listExecutionModuleIds(session, { includeDisabledWithOperation = false } = {}) {
  ensureSessionModuleState(session);
  const result = [];
  const standard = session.moduleWorkspaces[ExecutionModuleId.STANDARD_SENDS];
  const batch = session.moduleWorkspaces[ExecutionModuleId.BATCH_CHAT];
  const standardEnabled = isSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.ORDINARY_SEND);
  const batchEnabled = isSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.BATCH_CHAT)
    && session.batchChatFlow?.enabled === true
    && Boolean(batch);

  if ((standardEnabled && !standard.moduleCompleted)
      || (includeDisabledWithOperation && isUnresolvedModuleOperation(session.operation))) {
    result.push(ExecutionModuleId.STANDARD_SENDS);
  }
  if ((batchEnabled && !batch?.moduleCompleted)
      || (includeDisabledWithOperation && isUnresolvedModuleOperation(batch?.operation))) {
    result.push(ExecutionModuleId.BATCH_CHAT);
  }
  return result;
}

export function unresolvedOperationModuleIds(session) {
  return listExecutionModuleIds(session, { includeDisabledWithOperation: true }).filter(moduleId => {
    const view = createModuleSessionView(session, moduleId);
    return isUnresolvedModuleOperation(view?.operation);
  });
}

export function hasUnresolvedModuleOperation(session) {
  return unresolvedOperationModuleIds(session).length > 0;
}

export function moduleTaskById(session, moduleId, taskId) {
  const view = createModuleSessionView(session, moduleId);
  return view?.tasksById?.[taskId] || null;
}
