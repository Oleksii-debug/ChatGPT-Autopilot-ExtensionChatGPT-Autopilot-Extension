import {
  createSession,
  createTask,
  PromptMode,
  RunMode,
  RunState,
  TabStrategy,
} from './schema.js';

export const BOOTSTRAP_META_KEY = 'autopilotBundledBootstrapMeta';

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${label}`);
}

function normalizePromptMode(value) {
  if (value === PromptMode.SHARED || value === 'shared') return PromptMode.SHARED;
  if (value === PromptMode.UNIQUE || value === 'unique') return PromptMode.UNIQUE;
  throw new Error('Invalid bootstrap promptMode');
}

function normalizeRunMode(value) {
  if (value === RunMode.ONE_PASS || value === 'one-pass') return RunMode.ONE_PASS;
  if (value === RunMode.CONTINUOUS || value === 'continuous') return RunMode.CONTINUOUS;
  throw new Error('Invalid bootstrap runMode');
}

function normalizeTabStrategy(value) {
  if (value === TabStrategy.KEEP_TASK_TABS_OPEN || value === 'keep-open') return TabStrategy.KEEP_TASK_TABS_OPEN;
  if (value === TabStrategy.ONE_WORKER_TAB_PER_SESSION || value === 'worker') return TabStrategy.ONE_WORKER_TAB_PER_SESSION;
  if (value === TabStrategy.OPEN_CLOSE_PER_TASK || value === 'open-close') return TabStrategy.OPEN_CLOSE_PER_TASK;
  throw new Error('Invalid bootstrap tabStrategy');
}

function buildSession(config, autoStart, now) {
  requireString(config?.id, 'bootstrap session id');
  requireString(config?.name, 'bootstrap session name');
  if (!Array.isArray(config?.tasks) || config.tasks.length < 1 || config.tasks.length > 50) {
    throw new Error('Bootstrap Session requires 1-50 tasks');
  }

  const promptMode = normalizePromptMode(config.promptMode ?? PromptMode.SHARED);
  const tasks = config.tasks.map((task, index) => {
    requireString(task?.id, `bootstrap task ${index + 1} id`);
    requireString(task?.url, `bootstrap task ${index + 1} url`);
    return createTask({
      id: task.id,
      url: task.url,
      enabled: task.enabled !== false,
      label: typeof task.label === 'string' ? task.label : '',
      promptOverride: typeof task.promptOverride === 'string' ? task.promptOverride : '',
    });
  });

  const session = createSession({
    id: config.id,
    name: config.name,
    tasks,
    promptMode,
    sharedPrompt: typeof config.sharedPrompt === 'string' ? config.sharedPrompt : '',
    runMode: normalizeRunMode(config.runMode ?? RunMode.CONTINUOUS),
    minimumSendIntervalMs: Number.isFinite(config.minimumSendIntervalMs) ? config.minimumSendIntervalMs : 120000,
    preSendDelayMs: Number.isFinite(config.preSendDelayMs) ? config.preSendDelayMs : 5000,
    busyCheckDelayMs: Number.isFinite(config.busyCheckDelayMs) ? config.busyCheckDelayMs : 2000,
    retryBackoffMs: Number.isFinite(config.retryBackoffMs) ? config.retryBackoffMs : 30000,
    tabStrategy: normalizeTabStrategy(config.tabStrategy ?? TabStrategy.KEEP_TASK_TABS_OPEN),
    now,
  });

  if (promptMode === PromptMode.SHARED && !session.sharedPrompt.trim()) {
    throw new Error(`Bootstrap Session ${config.id} requires a shared prompt`);
  }
  if (promptMode === PromptMode.UNIQUE) {
    for (const taskId of session.taskOrder) {
      if (!session.tasksById[taskId].promptOverride.trim()) {
        throw new Error(`Bootstrap Task ${taskId} requires a unique prompt`);
      }
    }
  }

  if (autoStart && config.autoStart !== false) {
    session.runState = RunState.RUNNING;
    session.lastActionAt = now;
    session.updatedAt = now;
  }
  return session;
}

function removeManagedSessions(state, sessionIds) {
  const managed = new Set(sessionIds || []);
  for (const sessionId of managed) {
    delete state.sessionsById[sessionId];
    delete state.logs[sessionId];
  }
  state.sessionOrder = state.sessionOrder.filter(sessionId => !managed.has(sessionId));
  for (const [taskId, hint] of Object.entries(state.tabHintsByTaskId)) {
    if (managed.has(hint.sessionId)) delete state.tabHintsByTaskId[taskId];
  }
}

function managedSessionsAreSafeToReplace(state, sessionIds) {
  for (const sessionId of sessionIds || []) {
    const session = state.sessionsById[sessionId];
    if (!session) continue;
    if (session.operation !== null) return false;
    if (![RunState.STOPPED, RunState.PAUSED].includes(session.runState)) return false;
  }
  return true;
}

export async function applyBundledBootstrapProfile({ repository, chromeApi, profile, now = Date.now() }) {
  if (!profile?.enabled) return { applied: false, reason: 'disabled' };
  requireString(profile.profileId, 'bootstrap profileId');
  requirePositiveInteger(profile.revision, 'bootstrap revision');
  if (!Array.isArray(profile.sessions) || profile.sessions.length < 1) {
    throw new Error('Enabled bootstrap profile requires at least one Session');
  }

  const metaRecord = await chromeApi.storage.local.get(BOOTSTRAP_META_KEY);
  const previousMeta = metaRecord[BOOTSTRAP_META_KEY] || null;
  if (previousMeta?.profileId === profile.profileId && previousMeta?.revision === profile.revision) {
    return { applied: false, reason: 'already-applied' };
  }

  const current = await repository.load();
  const replacingPrevious = previousMeta?.profileId === profile.profileId
    && previousMeta.revision < profile.revision
    && profile.replaceManagedOnUpgrade === true;

  if (!previousMeta && current.sessionOrder.length > 0) {
    return { applied: false, reason: 'existing-state' };
  }
  if (previousMeta && !replacingPrevious) {
    return { applied: false, reason: 'different-or-newer-profile-already-present' };
  }
  if (replacingPrevious && !managedSessionsAreSafeToReplace(current, previousMeta.sessionIds)) {
    return { applied: false, reason: 'managed-profile-active' };
  }

  const sessions = profile.sessions.map(config => buildSession(config, profile.autoStart === true, now));
  const sessionIds = sessions.map(session => session.id);
  if (new Set(sessionIds).size !== sessionIds.length) throw new Error('Duplicate bootstrap Session id');

  await repository.update(state => {
    if (replacingPrevious) removeManagedSessions(state, previousMeta.sessionIds);
    for (const session of sessions) {
      if (state.sessionsById[session.id]) throw new Error(`Bootstrap Session id already exists: ${session.id}`);
      state.sessionsById[session.id] = session;
      state.sessionOrder.push(session.id);
      state.logs[session.id] = [];
    }
    return state;
  });

  await chromeApi.storage.local.set({
    [BOOTSTRAP_META_KEY]: {
      profileId: profile.profileId,
      revision: profile.revision,
      sessionIds,
      appliedAt: now,
    },
  });

  return { applied: true, reason: replacingPrevious ? 'upgraded' : 'installed', sessionIds };
}
