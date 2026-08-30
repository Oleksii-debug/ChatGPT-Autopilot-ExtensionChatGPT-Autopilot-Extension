import {
  createSession,
  createTask,
  PromptMode,
  RunMode,
  RunState,
  TabStrategy,
  OperationPhase,
} from './schema.js';

export const CONFIG_FILE_FORMAT = 'chatgpt-autopilot-config';
export const CONFIG_FILE_VERSION = 1;
export const MAX_IMPORTED_SESSIONS = 5;

const SAFE_REPLACE_STATES = new Set([RunState.STOPPED, RunState.PAUSED, RunState.ERROR]);
const TERMINAL_OPERATION_PHASES = new Set([
  OperationPhase.NONE,
  OperationPhase.SENT_VERIFIED,
  OperationPhase.FAILED_SAFE,
]);

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function asFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hasUnresolvedOperation(session) {
  return Boolean(session?.operation && !TERMINAL_OPERATION_PHASES.has(session.operation.phase));
}

function normalizePromptMode(value) {
  return String(value || 'shared').toLowerCase() === 'unique' ? PromptMode.UNIQUE : PromptMode.SHARED;
}

function normalizeRunMode(value) {
  return String(value || 'continuous').toLowerCase() === 'one-pass' ? RunMode.ONE_PASS : RunMode.CONTINUOUS;
}

function normalizeTabStrategy(value) {
  const key = String(value || 'keep-open').toLowerCase();
  if (key === 'worker') return TabStrategy.ONE_WORKER_TAB_PER_SESSION;
  if (key === 'open-close') return TabStrategy.OPEN_CLOSE_PER_TASK;
  return TabStrategy.KEEP_TASK_TABS_OPEN;
}

function createImportedSession(raw, now, topLevelAutoStart = false) {
  requireRecord(raw, 'Session');
  const name = requireString(raw.name, 'Session name');
  if (!Array.isArray(raw.tasks) || raw.tasks.length < 1 || raw.tasks.length > 50) {
    throw new Error(`Session ${name} requires 1-50 tasks`);
  }

  const sessionId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : crypto.randomUUID();
  const promptMode = normalizePromptMode(raw.promptMode);
  const tasks = raw.tasks.map((task, index) => {
    requireRecord(task, `Task ${index + 1}`);
    const url = requireString(task.url, `Task ${index + 1} URL`);
    return createTask({
      id: typeof task.id === 'string' && task.id.trim() ? task.id.trim() : crypto.randomUUID(),
      url,
      enabled: task.enabled !== false,
      label: typeof task.label === 'string' ? task.label : '',
      promptOverride: typeof task.promptOverride === 'string' ? task.promptOverride : '',
    });
  });
  const taskIds = tasks.map(task => task.id);
  if (new Set(taskIds).size !== taskIds.length) throw new Error(`Duplicate Task id in Session ${name}`);

  const session = createSession({
    id: sessionId,
    name,
    tasks,
    promptMode,
    sharedPrompt: typeof raw.sharedPrompt === 'string' ? raw.sharedPrompt : '',
    runMode: normalizeRunMode(raw.runMode),
    minimumSendIntervalMs: Math.max(60000, asFiniteNumber(raw.minimumSendIntervalMinutes, 2) * 60000),
    preSendDelayMs: Math.min(30000, Math.max(1000, asFiniteNumber(raw.preSendDelaySeconds, 5) * 1000)),
    busyCheckDelayMs: Math.min(30000, Math.max(1000, asFiniteNumber(raw.busyCheckDelaySeconds, 2) * 1000)),
    retryBackoffMs: Math.min(3600000, Math.max(5000, asFiniteNumber(raw.retryBackoffSeconds, 30) * 1000)),
    tabStrategy: normalizeTabStrategy(raw.tabStrategy),
    now,
  });

  session.version = 1;
  session.defaultUniquePrompt = typeof raw.defaultUniquePrompt === 'string' ? raw.defaultUniquePrompt : '';
  session.retryPolicy = raw.retryPolicy === 'manual' ? 'manual' : 'safe';
  session.busyChatBehavior = 'skip-next';
  session.pausedByMaster = false;

  let enabledCount = 0;
  const normalizedUrls = [];
  for (const taskId of session.taskOrder) {
    const task = session.tasksById[taskId];
    if (!task.enabled) continue;
    enabledCount += 1;
    normalizedUrls.push(task.normalizedUrl);
    const prompt = promptMode === PromptMode.UNIQUE ? task.promptOverride : session.sharedPrompt;
    if (!prompt?.trim()) throw new Error(`Prompt is required for enabled task ${task.label || taskId}`);
  }
  if (enabledCount === 0) throw new Error(`Session ${name} must have at least one enabled task`);
  if (new Set(normalizedUrls).size !== normalizedUrls.length) {
    throw new Error(`Session ${name} contains the same ChatGPT conversation more than once`);
  }

  const shouldStart = raw.autoStart === true || (raw.autoStart === undefined && topLevelAutoStart === true);
  if (shouldStart) {
    session.runState = RunState.RUNNING;
    session.lastActionAt = now;
    session.updatedAt = now;
  }
  return { session, shouldStart };
}

function validateDocument(document) {
  requireRecord(document, 'configuration document');
  if (document.format !== CONFIG_FILE_FORMAT) throw new Error(`Unsupported configuration format: ${document.format || 'missing'}`);
  if (document.version !== CONFIG_FILE_VERSION) throw new Error(`Unsupported configuration version: ${document.version}`);
  if (!['replace-safe', 'add'].includes(document.mode || 'replace-safe')) throw new Error('Configuration mode must be replace-safe or add');
  if (!Array.isArray(document.sessions) || document.sessions.length < 1 || document.sessions.length > MAX_IMPORTED_SESSIONS) {
    throw new Error(`Configuration requires 1-${MAX_IMPORTED_SESSIONS} Sessions`);
  }
}

function clearAllSessions(state) {
  state.sessionsById = {};
  state.sessionOrder = [];
  state.tabHintsByTaskId = {};
  state.logs = {};
  state.sendArbiter.lease = null;
  state.sendArbiter.profileNextAllowedSendAt = 0;
}

function assertSafeReplace(state) {
  for (const session of Object.values(state.sessionsById)) {
    if (!SAFE_REPLACE_STATES.has(session.runState) || hasUnresolvedOperation(session)) {
      throw new Error(`Stop active Sessions and resolve uncertain sends before replacing configuration (${session.name})`);
    }
  }
}

function activeUrlOwners(state) {
  const urls = new Set();
  for (const session of Object.values(state.sessionsById)) {
    if ([RunState.RUNNING, RunState.RECOVERING].includes(session.runState)) {
      for (const taskId of session.taskOrder) {
        const task = session.tasksById[taskId];
        if (task.enabled) urls.add(task.normalizedUrl);
      }
    }
    // A stopped/paused Session with unresolved submit evidence still reserves its exact target.
    if (hasUnresolvedOperation(session) && session.operation?.targetUrl) urls.add(session.operation.targetUrl);
  }
  return urls;
}

function assertStartedUrlUniqueness(state, importedSessions, mode) {
  const reserved = mode === 'add' ? activeUrlOwners(state) : new Set();
  for (const { session, shouldStart } of importedSessions) {
    if (!shouldStart) continue;
    for (const taskId of session.taskOrder) {
      const task = session.tasksById[taskId];
      if (!task.enabled) continue;
      if (reserved.has(task.normalizedUrl)) {
        throw new Error('Two auto-start Sessions would own the same ChatGPT conversation');
      }
      reserved.add(task.normalizedUrl);
    }
  }
}

export async function importConfigurationDocument({ repository, document, now = Date.now() }) {
  validateDocument(document);
  const mode = document.mode || 'replace-safe';
  const imported = document.sessions.map(raw => createImportedSession(raw, now, document.autoStart === true));
  const ids = imported.map(item => item.session.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate Session id in configuration file');

  const result = await repository.update(state => {
    if (mode === 'replace-safe') assertSafeReplace(state);
    if (mode === 'add' && state.sessionOrder.length + imported.length > MAX_IMPORTED_SESSIONS) {
      throw new Error(`At most ${MAX_IMPORTED_SESSIONS} Sessions are supported by configuration-file import`);
    }
    if (state.profile.masterPaused && imported.some(item => item.shouldStart)) {
      throw new Error('Resume the extension before importing Sessions with autoStart enabled');
    }
    if (mode === 'add') {
      for (const id of ids) if (state.sessionsById[id]) throw new Error(`Session id already exists: ${id}`);
    }
    assertStartedUrlUniqueness(state, imported, mode);
    if (mode === 'replace-safe') clearAllSessions(state);
    for (const { session } of imported) {
      state.sessionsById[session.id] = session;
      state.sessionOrder.push(session.id);
      state.logs[session.id] = [{ at: now, level: 'info', message: 'Session imported from configuration file' }];
    }
    return state;
  });

  return {
    mode,
    sessionIds: ids,
    sessionsImported: imported.length,
    sessionsAutoStarted: imported.filter(item => item.shouldStart).length,
    revision: result.revision,
  };
}

function sessionToConfig(session) {
  return {
    id: session.id,
    name: session.name,
    autoStart: [RunState.RUNNING, RunState.RECOVERING].includes(session.runState),
    promptMode: session.promptMode === PromptMode.UNIQUE ? 'unique' : 'shared',
    sharedPrompt: session.sharedPrompt || '',
    defaultUniquePrompt: session.defaultUniquePrompt || '',
    runMode: session.runMode === RunMode.ONE_PASS ? 'one-pass' : 'continuous',
    minimumSendIntervalMinutes: session.minimumSendIntervalMs / 60000,
    preSendDelaySeconds: session.preSendDelayMs / 1000,
    busyCheckDelaySeconds: session.busyCheckDelayMs / 1000,
    retryBackoffSeconds: session.retryBackoffMs / 1000,
    retryPolicy: session.retryPolicy === 'manual' ? 'manual' : 'safe',
    tabStrategy: session.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION
      ? 'worker'
      : session.tabStrategy === TabStrategy.OPEN_CLOSE_PER_TASK ? 'open-close' : 'keep-open',
    tasks: session.taskOrder.map(taskId => {
      const task = session.tasksById[taskId];
      return {
        id: task.id,
        enabled: task.enabled,
        label: task.label || '',
        url: task.url,
        promptOverride: task.promptOverride || '',
      };
    }),
  };
}

export async function exportConfigurationDocument({ repository }) {
  const state = await repository.load();
  return {
    format: CONFIG_FILE_FORMAT,
    version: CONFIG_FILE_VERSION,
    mode: 'replace-safe',
    autoStart: false,
    sessions: state.sessionOrder.map(id => sessionToConfig(state.sessionsById[id])),
  };
}
