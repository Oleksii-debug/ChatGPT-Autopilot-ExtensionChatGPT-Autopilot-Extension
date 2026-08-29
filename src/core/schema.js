export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'autopilotState';
export const MAX_LOG_ENTRIES = 500;
export const MAX_LOG_MESSAGE_LENGTH = 2000;
export const RunState = Object.freeze({ STOPPED:'STOPPED', RUNNING:'RUNNING', PAUSED:'PAUSED', RECOVERING:'RECOVERING', ERROR:'ERROR' });
export const PromptMode = Object.freeze({ SHARED:'SHARED', UNIQUE:'UNIQUE' });
export const RunMode = Object.freeze({ ONE_PASS:'ONE_PASS', CONTINUOUS:'CONTINUOUS' });
export const TabStrategy = Object.freeze({ KEEP_TASK_TABS_OPEN:'KEEP_TASK_TABS_OPEN', ONE_WORKER_TAB_PER_SESSION:'ONE_WORKER_TAB_PER_SESSION', OPEN_CLOSE_PER_TASK:'OPEN_CLOSE_PER_TASK' });
export const OperationPhase = Object.freeze({ NONE:'NONE', CHECKING:'CHECKING', READY:'READY', INSERTING:'INSERTING', INSERTED:'INSERTED', PRE_SEND_WAIT:'PRE_SEND_WAIT', SUBMITTING:'SUBMITTING', SENT_VERIFIED:'SENT_VERIFIED', AMBIGUOUS:'AMBIGUOUS', FAILED_SAFE:'FAILED_SAFE', MANUAL_REVIEW:'MANUAL_REVIEW' });

const enumValues = value => new Set(Object.values(value));
const RUN_STATES = enumValues(RunState);
const PROMPT_MODES = enumValues(PromptMode);
const RUN_MODES = enumValues(RunMode);
const TAB_STRATEGIES = enumValues(TabStrategy);
const OPERATION_PHASES = enumValues(OperationPhase);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
}

function requireString(value, label) {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`);
}

function requireNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
}

function requireEnum(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`Invalid ${label}`);
}

function requireUniqueStringArray(value, label, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid ${label}`);
  if (value.some(item => typeof item !== 'string') || new Set(value).size !== value.length) throw new Error(`Invalid ${label}`);
}

export function createEmptyState(now = Date.now()) {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, profile: { masterPaused: false, createdAt: now }, sessionsById: {}, sessionOrder: [], tabHintsByTaskId: {}, sendArbiter: { lease: null, profileNextAllowedSendAt: 0 }, logs: {}, migrationHistory: [] };
}

export function normalizeChatUrl(url) {
  if (!url) return '';
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('Only https://chatgpt.com URLs are allowed');
  }
  parsed.hostname = 'chatgpt.com';
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString();
}

export function createTask({ id, url, promptOverride = '', enabled = true, label = '' }) {
  if (!id) throw new Error('Task id required');
  return { id, enabled, label, url, normalizedUrl: normalizeChatUrl(url), promptOverride, status: 'IDLE', lastCheckedAt: 0, lastVerifiedSendAt: 0, lastVerifiedFingerprint: '', retryAfterAt: 0, manualReviewReason: '' };
}

export function createSession({ id, name, tasks = [], promptMode = PromptMode.SHARED, sharedPrompt = '', runMode = RunMode.CONTINUOUS, minimumSendIntervalMs = 120000, preSendDelayMs = 5000, busyCheckDelayMs = 2000, retryBackoffMs = 30000, tabStrategy = TabStrategy.KEEP_TASK_TABS_OPEN, now = Date.now() }) {
  if (!id || !name) throw new Error('Session id and name required');
  if (tasks.length < 1 || tasks.length > 50) throw new Error('Session requires 1-50 tasks');
  const tasksById = Object.fromEntries(tasks.map(t => [t.id, t]));
  return { id, name, enabled: true, runState: RunState.STOPPED, promptMode, sharedPrompt, runMode, taskOrder: tasks.map(t => t.id), tasksById, currentTaskIndex: 0, minimumSendIntervalMs, preSendDelayMs, busyCheckDelayMs, retryBackoffMs, tabStrategy, nextAllowedSendAt: 0, operation: null, lastActionAt: 0, lastSuccessfulSendAt: 0, lastError: '', onePassCompletedTaskIds: [], createdAt: now, updatedAt: now };
}

function validateTask(task, taskId) {
  requireRecord(task, `task ${taskId}`);
  if (task.id !== taskId) throw new Error(`Invalid task ${taskId}`);
  requireBoolean(task.enabled, `task ${taskId} enabled`);
  requireString(task.label, `task ${taskId} label`);
  requireString(task.url, `task ${taskId} url`);
  requireString(task.normalizedUrl, `task ${taskId} normalizedUrl`);
  requireString(task.promptOverride, `task ${taskId} promptOverride`);
  requireString(task.status, `task ${taskId} status`);
  requireNonNegativeNumber(task.lastCheckedAt, `task ${taskId} lastCheckedAt`);
  requireNonNegativeNumber(task.lastVerifiedSendAt, `task ${taskId} lastVerifiedSendAt`);
  requireString(task.lastVerifiedFingerprint, `task ${taskId} lastVerifiedFingerprint`);
  requireNonNegativeNumber(task.retryAfterAt, `task ${taskId} retryAfterAt`);
  requireString(task.manualReviewReason, `task ${taskId} manualReviewReason`);
  const expectedNormalizedUrl = task.url ? normalizeChatUrl(task.url) : '';
  if (task.normalizedUrl !== expectedNormalizedUrl) throw new Error(`Invalid task ${taskId} normalizedUrl`);
}

function validateOperation(operation, session) {
  if (operation === null) return;
  requireRecord(operation, `session ${session.id} operation`);
  requireString(operation.operationId, `session ${session.id} operationId`);
  if (!operation.operationId) throw new Error(`Invalid session ${session.id} operationId`);
  if (operation.sessionId !== session.id) throw new Error(`Invalid session ${session.id} operation sessionId`);
  requireString(operation.taskId, `session ${session.id} operation taskId`);
  if (!session.tasksById[operation.taskId]) throw new Error(`Invalid session ${session.id} operation taskId`);
  requireString(operation.promptFingerprint, `session ${session.id} operation promptFingerprint`);
  requireEnum(operation.phase, OPERATION_PHASES, `session ${session.id} operation phase`);
  requireString(operation.targetUrl, `session ${session.id} operation targetUrl`);
  for (const field of ['createdAt', 'updatedAt', 'preSendDeadline', 'submitStartedAt', 'verificationDeadline']) {
    requireNonNegativeNumber(operation[field], `session ${session.id} operation ${field}`);
  }
  if (operation.generation !== undefined && (!Number.isInteger(operation.generation) || operation.generation < 0)) {
    throw new Error(`Invalid session ${session.id} operation generation`);
  }
  if (operation.promptText !== undefined) requireString(operation.promptText, `session ${session.id} operation promptText`);
}

function validateSession(session, id) {
  requireRecord(session, `session ${id}`);
  if (session.id !== id) throw new Error(`Invalid session ${id}`);
  requireString(session.name, `session ${id} name`);
  requireBoolean(session.enabled, `session ${id} enabled`);
  requireEnum(session.runState, RUN_STATES, `session ${id} runState`);
  requireEnum(session.promptMode, PROMPT_MODES, `session ${id} promptMode`);
  requireString(session.sharedPrompt, `session ${id} sharedPrompt`);
  requireEnum(session.runMode, RUN_MODES, `session ${id} runMode`);
  requireUniqueStringArray(session.taskOrder, `session ${id} taskOrder`, { min: 1, max: 50 });
  requireRecord(session.tasksById, `session ${id} tasksById`);
  if (!Number.isInteger(session.currentTaskIndex) || session.currentTaskIndex < 0 || session.currentTaskIndex >= session.taskOrder.length) {
    throw new Error('Invalid currentTaskIndex');
  }
  for (const field of ['minimumSendIntervalMs', 'preSendDelayMs', 'busyCheckDelayMs', 'retryBackoffMs', 'nextAllowedSendAt', 'lastActionAt', 'lastSuccessfulSendAt', 'createdAt', 'updatedAt']) {
    requireNonNegativeNumber(session[field], `session ${id} ${field}`);
  }
  requireEnum(session.tabStrategy, TAB_STRATEGIES, `session ${id} tabStrategy`);
  requireString(session.lastError, `session ${id} lastError`);
  requireUniqueStringArray(session.onePassCompletedTaskIds, `session ${id} onePassCompletedTaskIds`);
  if (session.version !== undefined && (!Number.isInteger(session.version) || session.version < 0)) throw new Error(`Invalid session ${id} version`);
  if (session.pausedByMaster !== undefined) requireBoolean(session.pausedByMaster, `session ${id} pausedByMaster`);

  const taskIds = Object.keys(session.tasksById);
  if (taskIds.length !== session.taskOrder.length || taskIds.some(taskId => !session.taskOrder.includes(taskId))) {
    throw new Error(`Invalid session ${id} task identity set`);
  }
  for (const taskId of session.taskOrder) validateTask(session.tasksById[taskId], taskId);
  for (const taskId of session.onePassCompletedTaskIds) if (!session.tasksById[taskId]) throw new Error(`Invalid session ${id} onePassCompletedTaskIds`);
  validateOperation(session.operation, session);
}

export function validateState(state) {
  requireRecord(state, 'state envelope');
  if (state.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported schema version');
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error('Invalid revision');

  requireRecord(state.profile, 'profile');
  requireBoolean(state.profile.masterPaused, 'profile masterPaused');
  requireNonNegativeNumber(state.profile.createdAt, 'profile createdAt');
  requireRecord(state.sessionsById, 'sessionsById');
  requireUniqueStringArray(state.sessionOrder, 'sessionOrder');
  requireRecord(state.tabHintsByTaskId, 'tabHintsByTaskId');
  requireRecord(state.sendArbiter, 'sendArbiter');
  requireNonNegativeNumber(state.sendArbiter.profileNextAllowedSendAt, 'sendArbiter profileNextAllowedSendAt');
  requireRecord(state.logs, 'logs');
  if (!Array.isArray(state.migrationHistory)) throw new Error('Invalid migrationHistory');

  const sessionIds = Object.keys(state.sessionsById);
  if (sessionIds.length !== state.sessionOrder.length || sessionIds.some(id => !state.sessionOrder.includes(id))) {
    throw new Error('Invalid session identity set');
  }
  for (const id of state.sessionOrder) validateSession(state.sessionsById[id], id);

  if (state.sendArbiter.lease !== null) {
    const lease = state.sendArbiter.lease;
    requireRecord(lease, 'sendArbiter lease');
    requireString(lease.ownerSessionId, 'sendArbiter lease ownerSessionId');
    requireString(lease.operationId, 'sendArbiter lease operationId');
    requireNonNegativeNumber(lease.acquiredAt, 'sendArbiter lease acquiredAt');
    requireNonNegativeNumber(lease.expiresAt, 'sendArbiter lease expiresAt');
    if (lease.expiresAt < lease.acquiredAt) throw new Error('Invalid sendArbiter lease expiry');
    const owner = state.sessionsById[lease.ownerSessionId];
    if (!owner?.operation || owner.operation.operationId !== lease.operationId) throw new Error('Invalid sendArbiter lease owner');
  }

  for (const [sessionId, entries] of Object.entries(state.logs)) {
    if (!state.sessionsById[sessionId]) throw new Error(`Invalid log owner ${sessionId}`);
    if (!Array.isArray(entries) || entries.length > MAX_LOG_ENTRIES) throw new Error(`Invalid logs for ${sessionId}`);
    for (const entry of entries) {
      requireRecord(entry, `log entry for ${sessionId}`);
      requireNonNegativeNumber(entry.at, `log entry for ${sessionId} at`);
      requireString(entry.level, `log entry for ${sessionId} level`);
      requireString(entry.message, `log entry for ${sessionId} message`);
      if (entry.message.length > MAX_LOG_MESSAGE_LENGTH) throw new Error(`Invalid log entry for ${sessionId} message length`);
    }
  }

  for (const hint of Object.values(state.tabHintsByTaskId)) {
    requireRecord(hint, 'tab hint');
    if (!Number.isInteger(hint.tabId) || hint.tabId < 0) throw new Error('Invalid tab hint tabId');
    requireString(hint.sessionId, 'tab hint sessionId');
    if (!state.sessionsById[hint.sessionId]) throw new Error('Invalid tab hint sessionId');
    requireString(hint.normalizedUrl, 'tab hint normalizedUrl');
    if (hint.kind !== undefined) requireString(hint.kind, 'tab hint kind');
    if (hint.boundAt !== undefined) requireNonNegativeNumber(hint.boundAt, 'tab hint boundAt');
  }

  return state;
}
