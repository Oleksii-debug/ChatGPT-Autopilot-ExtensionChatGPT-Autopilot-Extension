import {
  OperationPhase,
  PromptMode,
  RunMode,
  RunState,
  TabStrategy,
  createSession,
  createTask,
  normalizeChatUrl,
} from './schema.js';
import { appendLog } from './logger.js';
import { startSession } from './state-machine.js';

export const PORTABLE_PROFILE_FORMAT = 'chatgpt-autopilot-profile';
export const PORTABLE_PROFILE_VERSION = 1;
export const MAX_PORTABLE_SESSIONS = 5;

const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);
const TERMINAL_OPERATION_PHASES = new Set([
  OperationPhase.NONE,
  OperationPhase.SENT_VERIFIED,
  OperationPhase.FAILED_SAFE,
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasUnresolvedOperation(session) {
  return Boolean(session?.operation && !TERMINAL_OPERATION_PHASES.has(session.operation.phase));
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
}

function requireId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, dot, underscore, colon or dash`);
  }
  return value;
}

function requireString(value, label, { allowEmpty = true, maxLength = 200000 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function boundedNumber(value, label, min, max, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return number;
}

function promptMode(value) {
  if (value === undefined || value === 'shared') return PromptMode.SHARED;
  if (value === 'unique') return PromptMode.UNIQUE;
  throw new Error('promptMode must be shared or unique');
}

function runMode(value) {
  if (value === undefined || value === 'continuous') return RunMode.CONTINUOUS;
  if (value === 'one-pass') return RunMode.ONE_PASS;
  throw new Error('runMode must be continuous or one-pass');
}

function tabStrategy(value) {
  if (value === undefined || value === 'worker') return TabStrategy.ONE_WORKER_TAB_PER_SESSION;
  if (value === 'keep-open') return TabStrategy.KEEP_TASK_TABS_OPEN;
  if (value === 'open-close') return TabStrategy.OPEN_CLOSE_PER_TASK;
  throw new Error('tabStrategy must be worker, keep-open or open-close');
}

function buildTask(raw, index) {
  requireRecord(raw, `Task ${index + 1}`);
  const id = requireId(raw.id, `Task ${index + 1} id`);
  const url = requireString(raw.url, `Task ${index + 1} URL`, { allowEmpty: false, maxLength: 4096 });
  const normalizedUrl = normalizeChatUrl(url);
  return createTask({
    id,
    url: normalizedUrl,
    enabled: raw.enabled !== false,
    label: requireString(raw.label ?? '', `Task ${index + 1} label`, { maxLength: 500 }),
    promptOverride: requireString(raw.promptOverride ?? '', `Task ${index + 1} prompt`, { maxLength: 200000 }),
  });
}

function buildSession(raw, index, now, version = 1) {
  requireRecord(raw, `Session ${index + 1}`);
  const id = requireId(raw.id, `Session ${index + 1} id`);
  const name = requireString(raw.name, `Session ${index + 1} name`, { allowEmpty: false, maxLength: 500 }).trim();
  if (!Array.isArray(raw.tasks) || raw.tasks.length < 1 || raw.tasks.length > 50) {
    throw new Error(`Session ${name} must contain 1-50 tasks`);
  }
  const tasks = raw.tasks.map(buildTask);
  const taskIds = tasks.map(task => task.id);
  if (new Set(taskIds).size !== taskIds.length) throw new Error(`Session ${name} contains duplicate Task ids`);
  const taskUrls = tasks.map(task => task.normalizedUrl);
  if (new Set(taskUrls).size !== taskUrls.length) throw new Error(`Session ${name} contains the same ChatGPT URL more than once`);

  const session = createSession({
    id,
    name,
    tasks,
    promptMode: promptMode(raw.promptMode),
    sharedPrompt: requireString(raw.sharedPrompt ?? '', `Session ${name} sharedPrompt`, { maxLength: 200000 }),
    runMode: runMode(raw.runMode),
    minimumSendIntervalMs: boundedNumber(raw.minimumSendIntervalMinutes, `Session ${name} minimumSendIntervalMinutes`, 1, 1440, 2) * 60000,
    preSendDelayMs: boundedNumber(raw.preSendDelaySeconds, `Session ${name} preSendDelaySeconds`, 1, 30, 5) * 1000,
    busyCheckDelayMs: boundedNumber(raw.busyCheckDelaySeconds, `Session ${name} busyCheckDelaySeconds`, 1, 30, 2) * 1000,
    retryBackoffMs: boundedNumber(raw.retryBackoffSeconds, `Session ${name} retryBackoffSeconds`, 5, 3600, 30) * 1000,
    tabStrategy: tabStrategy(raw.tabStrategy),
    now,
  });
  session.version = Math.max(1, Number(version) || 1);
  session.defaultUniquePrompt = requireString(raw.defaultUniquePrompt ?? '', `Session ${name} defaultUniquePrompt`, { maxLength: 200000 });
  session.retryPolicy = raw.retryPolicy === 'manual' ? 'manual' : 'safe';
  session.busyChatBehavior = 'skip-next';
  session.pausedByMaster = false;
  return session;
}

function parseProfile(profile, now = Date.now()) {
  requireRecord(profile, 'Profile');
  if (profile.format !== PORTABLE_PROFILE_FORMAT) throw new Error(`Unsupported profile format: ${profile.format || 'missing'}`);
  if (profile.version !== PORTABLE_PROFILE_VERSION) throw new Error(`Unsupported profile version: ${profile.version}`);
  if (!Array.isArray(profile.sessions) || profile.sessions.length < 1 || profile.sessions.length > MAX_PORTABLE_SESSIONS) {
    throw new Error(`Profile must contain 1-${MAX_PORTABLE_SESSIONS} sessions`);
  }
  const profileName = requireString(profile.profileName ?? 'ChatGPT Autopilot profile', 'profileName', { allowEmpty: false, maxLength: 500 }).trim();
  const profileAutoStartRequested = profile.autoStart === true;
  const sessionConfigs = profile.sessions.map((raw, index) => ({
    raw,
    session: buildSession(raw, index, now, 1),
    autoStartRequested: profileAutoStartRequested || raw.autoStart === true,
  }));
  const sessionIds = sessionConfigs.map(item => item.session.id);
  if (new Set(sessionIds).size !== sessionIds.length) throw new Error('Profile contains duplicate Session ids');
  return { profileName, sessionConfigs };
}

function validateRunnable(session) {
  const enabled = session.taskOrder.map(id => session.tasksById[id]).filter(task => task.enabled);
  if (!enabled.length) throw new Error(`Session ${session.name} has no enabled tasks`);
  for (const task of enabled) {
    const prompt = session.promptMode === PromptMode.UNIQUE ? task.promptOverride : session.sharedPrompt;
    if (!prompt?.trim()) throw new Error(`Session ${session.name} is missing a prompt for ${task.label || task.id}`);
  }
}

function reservedUrls(state, excludedSessionIds = new Set()) {
  const urls = new Set();
  for (const session of Object.values(state.sessionsById || {})) {
    if (excludedSessionIds.has(session.id)) continue;
    if (ACTIVE_STATES.has(session.runState)) {
      for (const taskId of session.taskOrder) {
        const task = session.tasksById[taskId];
        if (task.enabled && task.normalizedUrl) urls.add(task.normalizedUrl);
      }
    }
    if (hasUnresolvedOperation(session) && session.operation?.targetUrl) urls.add(session.operation.targetUrl);
  }
  return urls;
}

function clearSessionTabHints(state, sessionId) {
  for (const [key, hint] of Object.entries(state.tabHintsByTaskId || {})) {
    if (hint?.sessionId === sessionId) delete state.tabHintsByTaskId[key];
  }
}

export function previewPortableProfile(profile, now = Date.now()) {
  const parsed = parseProfile(profile, now);
  return {
    format: PORTABLE_PROFILE_FORMAT,
    version: PORTABLE_PROFILE_VERSION,
    profileName: parsed.profileName,
    sessionCount: parsed.sessionConfigs.length,
    taskCount: parsed.sessionConfigs.reduce((sum, item) => sum + item.session.taskOrder.length, 0),
    autoStartSessionCount: parsed.sessionConfigs.filter(item => item.autoStartRequested).length,
    sessionNames: parsed.sessionConfigs.map(item => item.session.name),
  };
}

export function applyPortableProfile(state, profile, {
  now = Date.now(),
  confirmAutoStart = false,
  executionAvailable = true,
} = {}) {
  const parsed = parseProfile(profile, now);
  const targetIds = new Set(parsed.sessionConfigs.map(item => item.session.id));

  for (const { session } of parsed.sessionConfigs) {
    const existing = state.sessionsById[session.id];
    if (!existing) continue;
    if (ACTIVE_STATES.has(existing.runState) || hasUnresolvedOperation(existing)) {
      throw new Error(`Stop or pause Session ${existing.name} and resolve unfinished work before importing over it`);
    }
  }

  const wantsAutoStart = confirmAutoStart && parsed.sessionConfigs.some(item => item.autoStartRequested);
  if (wantsAutoStart && !executionAvailable) throw new Error('Automatic execution is unavailable');
  if (wantsAutoStart && state.profile.masterPaused) throw new Error('Resume the extension before importing with automatic start');

  const reserved = reservedUrls(state, targetIds);
  if (wantsAutoStart) {
    for (const item of parsed.sessionConfigs) {
      if (!item.autoStartRequested) continue;
      validateRunnable(item.session);
      for (const taskId of item.session.taskOrder) {
        const task = item.session.tasksById[taskId];
        if (!task.enabled) continue;
        if (reserved.has(task.normalizedUrl)) {
          throw new Error(`Cannot auto-start Session ${item.session.name}: a ChatGPT conversation is already owned by another active or unresolved Session`);
        }
        reserved.add(task.normalizedUrl);
      }
    }
  }

  const importedSessionIds = [];
  const startedSessionIds = [];
  for (const item of parsed.sessionConfigs) {
    const existing = state.sessionsById[item.session.id];
    const replacement = item.session;
    if (existing) {
      replacement.version = Math.max(1, Number(existing.version || 0) + 1);
      replacement.createdAt = existing.createdAt;
      replacement.updatedAt = now;
    }
    replacement.runState = RunState.STOPPED;
    replacement.currentTaskIndex = 0;
    replacement.nextAllowedSendAt = 0;
    replacement.operation = null;
    replacement.lastActionAt = 0;
    replacement.lastSuccessfulSendAt = 0;
    replacement.lastError = '';
    replacement.onePassCompletedTaskIds = [];
    replacement.pausedByMaster = false;
    clearSessionTabHints(state, replacement.id);
    state.sessionsById[replacement.id] = replacement;
    if (!state.sessionOrder.includes(replacement.id)) state.sessionOrder.push(replacement.id);
    appendLog(state, replacement.id, 'Session configuration imported from portable profile', { at: now });
    importedSessionIds.push(replacement.id);
  }

  if (confirmAutoStart) {
    for (const item of parsed.sessionConfigs) {
      if (!item.autoStartRequested) continue;
      const session = state.sessionsById[item.session.id];
      startSession(session, now);
      appendLog(state, session.id, 'Session started after confirmed portable profile import', { at: now });
      startedSessionIds.push(session.id);
    }
  }

  return {
    profileName: parsed.profileName,
    importedSessionIds,
    startedSessionIds,
    autoStartRequested: parsed.sessionConfigs.some(item => item.autoStartRequested),
  };
}

function sessionToPortable(session) {
  return {
    id: session.id,
    name: session.name,
    autoStart: false,
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

export function exportPortableProfile(state, { sessionIds = null, profileName = 'ChatGPT Autopilot export' } = {}) {
  const requested = Array.isArray(sessionIds) && sessionIds.length ? new Set(sessionIds) : null;
  const sessions = state.sessionOrder
    .filter(id => !requested || requested.has(id))
    .map(id => state.sessionsById[id])
    .filter(Boolean)
    .map(sessionToPortable);
  if (!sessions.length) throw new Error('There are no Sessions to export');
  return {
    format: PORTABLE_PROFILE_FORMAT,
    version: PORTABLE_PROFILE_VERSION,
    profileName,
    autoStart: false,
    sessions,
  };
}
