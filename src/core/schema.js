export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'autopilotState';
export const RunState = Object.freeze({ STOPPED:'STOPPED', RUNNING:'RUNNING', PAUSED:'PAUSED', RECOVERING:'RECOVERING', ERROR:'ERROR' });
export const PromptMode = Object.freeze({ SHARED:'SHARED', UNIQUE:'UNIQUE' });
export const RunMode = Object.freeze({ ONE_PASS:'ONE_PASS', CONTINUOUS:'CONTINUOUS' });
export const TabStrategy = Object.freeze({ KEEP_TASK_TABS_OPEN:'KEEP_TASK_TABS_OPEN', ONE_WORKER_TAB_PER_SESSION:'ONE_WORKER_TAB_PER_SESSION', OPEN_CLOSE_PER_TASK:'OPEN_CLOSE_PER_TASK' });
export const OperationPhase = Object.freeze({ NONE:'NONE', CHECKING:'CHECKING', READY:'READY', INSERTING:'INSERTING', INSERTED:'INSERTED', PRE_SEND_WAIT:'PRE_SEND_WAIT', SUBMITTING:'SUBMITTING', SENT_VERIFIED:'SENT_VERIFIED', AMBIGUOUS:'AMBIGUOUS', FAILED_SAFE:'FAILED_SAFE', MANUAL_REVIEW:'MANUAL_REVIEW' });

export function createEmptyState(now = Date.now()) {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, profile: { masterPaused: false, createdAt: now }, sessionsById: {}, sessionOrder: [], tabHintsByTaskId: {}, sendArbiter: { lease: null, profileNextAllowedSendAt: 0 }, logs: {}, migrationHistory: [] };
}

export function normalizeChatUrl(url) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://chatgpt.com') throw new Error('Only https://chatgpt.com URLs are allowed');
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

export function validateState(state) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported schema version');
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error('Invalid revision');
  for (const id of state.sessionOrder) {
    const s = state.sessionsById[id];
    if (!s || s.id !== id) throw new Error(`Invalid session ${id}`);
    if (s.taskOrder.length < 1 || s.taskOrder.length > 50) throw new Error('Invalid task count');
    if (s.currentTaskIndex < 0 || s.currentTaskIndex >= s.taskOrder.length) throw new Error('Invalid currentTaskIndex');
    for (const taskId of s.taskOrder) if (!s.tasksById[taskId]) throw new Error(`Missing task ${taskId}`);
  }
  return state;
}
