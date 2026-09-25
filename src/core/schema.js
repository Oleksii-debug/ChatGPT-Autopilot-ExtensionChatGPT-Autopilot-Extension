import { DEFAULT_LOCAL_AI_SETTINGS, normalizeLocalAiSettings } from './local-ai-provider.js';
import { DEFAULT_AI_ROUTER_SETTINGS, DEFAULT_AI_ROUTER_RUNTIME, normalizeAiRouterSettings, normalizeAiRouterRuntime } from './ai-orchestrator.js';
import { DEFAULT_AI_MANAGER_SETTINGS, DEFAULT_AI_MANAGER_RUNTIME, normalizeAiManagerSettings, normalizeAiManagerRuntime } from './ai-manager.js';
import { defaultSessionPromptCadence, normalizeSessionPromptCadence } from './session-prompt-cadence.js';
import { defaultSessionDrivePromptSources, normalizeSessionDrivePromptSources } from './session-drive-prompt-source.js';
import { normalizeCalendarSchedule } from './calendar-schedule.js';
export const SCHEMA_VERSION = 2;
export const STORAGE_KEY = 'autopilotState';
export const MAX_LOG_ENTRIES = 500;
export const MAX_LOG_MESSAGE_LENGTH = 2000;
export const MAX_DIAGNOSTIC_ENTRIES = 1000;
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 600;
export const MAX_PHYSICAL_TASKS = 1000;
export const MAX_LOGICAL_TASKS = 1_000_000;
export const RunState = Object.freeze({ STOPPED:'STOPPED', RUNNING:'RUNNING', PAUSED:'PAUSED', RECOVERING:'RECOVERING', ERROR:'ERROR' });
export const PromptMode = Object.freeze({ SHARED:'SHARED', UNIQUE:'UNIQUE' });
export const RunMode = Object.freeze({ ONE_PASS:'ONE_PASS', CONTINUOUS:'CONTINUOUS' });
export const TabStrategy = Object.freeze({ KEEP_TASK_TABS_OPEN:'KEEP_TASK_TABS_OPEN', ONE_WORKER_TAB_PER_SESSION:'ONE_WORKER_TAB_PER_SESSION', OPEN_CLOSE_PER_TASK:'OPEN_CLOSE_PER_TASK' });
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 0;
export const MIN_RATE_LIMIT_COOLDOWN_MS = 0;
export const MAX_RATE_LIMIT_COOLDOWN_MS = 120 * 60 * 1000;
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
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    profile: { masterPaused: false, createdAt: now, rateLimitCooldownMs: DEFAULT_RATE_LIMIT_COOLDOWN_MS, rateLimitReservePolicyVersion: 1, rateLimitUntil: 0, maxConcurrentSessionOperations: 10, localAi: structuredClone(DEFAULT_LOCAL_AI_SETTINGS), aiRouter: structuredClone(DEFAULT_AI_ROUTER_SETTINGS), aiRouterRuntime: structuredClone(DEFAULT_AI_ROUTER_RUNTIME), aiManager: structuredClone(DEFAULT_AI_MANAGER_SETTINGS), aiManagerRuntime: structuredClone(DEFAULT_AI_MANAGER_RUNTIME) },
    sessionsById: {},
    sessionOrder: [],
    tabHintsByTaskId: {},
    sendArbiter: { lease: null, profileNextAllowedSendAt: 0, lastSentSessionId: '', lastSentSchedulingClass: '' },
    logs: {},
    diagnostics: [],
    migrationHistory: [],
  };
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

// Only a concrete conversation identity is exclusive across Sessions. Launch
// surfaces such as / or /g/<slug> intentionally create independent chats and
// are safe for parallel agent Sessions because tab ownership and the send
// arbiter provide the required isolation.
export function isExclusiveConversationUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(normalizeChatUrl(url));
    return /\/c\/[^/]+(?:\/|$)/u.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function createTask({ id, url, promptOverride = '', enabled = true, label = '' }) {
  if (!id) throw new Error('Task id required');
  return { id, enabled, label, url, normalizedUrl: normalizeChatUrl(url), promptOverride, status: 'IDLE', lastCheckedAt: 0, lastVerifiedSendAt: 0, lastVerifiedFingerprint: '', retryAfterAt: 0, manualReviewReason: '', lastConversationUrl: '', lastAssistantReport: '', lastAssistantReportAt: 0, lastAssistantBaselineCount: 0, lastAssistantBaselineKnown: false };
}

export function createSession({ id, name, tasks = [], promptMode = PromptMode.SHARED, sharedPrompt = '', runMode = RunMode.CONTINUOUS, configuredTaskCount = tasks.length, minimumSendIntervalMs = 120000, preSendDelayMs = 20000, busyCheckDelayMs = 2000, retryBackoffMs = 30000, tabStrategy = TabStrategy.KEEP_TASK_TABS_OPEN, now = Date.now() }) {
  if (!id || !name) throw new Error('Session id and name required');
  if (tasks.length < 1 || tasks.length > MAX_PHYSICAL_TASKS) throw new Error(`Session requires 1-${MAX_PHYSICAL_TASKS} physical tasks`);
  const logicalCount = Number(configuredTaskCount);
  if (!Number.isInteger(logicalCount) || logicalCount < 1 || logicalCount > MAX_LOGICAL_TASKS) throw new Error(`Session configuredTaskCount must be 1-${MAX_LOGICAL_TASKS}`);
  if (logicalCount < tasks.length) throw new Error('Session configuredTaskCount cannot be smaller than physical task count');
  const tasksById = Object.fromEntries(tasks.map(t => [t.id, t]));
  return { id, name, enabled: true, runState: RunState.STOPPED, promptMode, sharedPrompt, promptCadence: defaultSessionPromptCadence(), drivePromptSources: defaultSessionDrivePromptSources(), runMode, taskOrder: tasks.map(t => t.id), tasksById, currentTaskIndex: 0, configuredTaskCount: logicalCount, minimumSendIntervalMs, preSendDelayMs, busyCheckDelayMs, retryBackoffMs, tabStrategy, nextAllowedSendAt: 0, operation: null, lastActionAt: 0, lastSuccessfulSendAt: 0, successfulSendCount: 0, completedAt: 0, lastError: '', onePassCompletedTaskIds: [], onePassCompletedCount: 0, createdAt: now, updatedAt: now };
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
  if (task.lastConversationUrl !== undefined) requireString(task.lastConversationUrl, `task ${taskId} lastConversationUrl`);
  if (task.lastAssistantReport !== undefined) requireString(task.lastAssistantReport, `task ${taskId} lastAssistantReport`);
  if (task.lastAssistantReportAt !== undefined) requireNonNegativeNumber(task.lastAssistantReportAt, `task ${taskId} lastAssistantReportAt`);
  if (task.lastAssistantBaselineCount !== undefined) requireNonNegativeNumber(task.lastAssistantBaselineCount, `task ${taskId} lastAssistantBaselineCount`);
  if (task.lastAssistantBaselineKnown !== undefined) requireBoolean(task.lastAssistantBaselineKnown, `task ${taskId} lastAssistantBaselineKnown`);
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
  const task = session.tasksById[operation.taskId];
  if (!task) throw new Error(`Invalid session ${session.id} operation taskId`);
  requireString(operation.promptFingerprint, `session ${session.id} operation promptFingerprint`);
  requireEnum(operation.phase, OPERATION_PHASES, `session ${session.id} operation phase`);
  requireString(operation.targetUrl, `session ${session.id} operation targetUrl`);
  if (!task.normalizedUrl || operation.targetUrl !== task.normalizedUrl) {
    throw new Error(`Invalid session ${session.id} operation targetUrl binding`);
  }
  for (const field of ['createdAt', 'updatedAt', 'preSendDeadline', 'submitStartedAt', 'verificationDeadline']) {
    requireNonNegativeNumber(operation[field], `session ${session.id} operation ${field}`);
  }
  if (operation.generation !== undefined && (!Number.isInteger(operation.generation) || operation.generation < 0)) {
    throw new Error(`Invalid session ${session.id} operation generation`);
  }
  if (operation.promptText !== undefined) requireString(operation.promptText, `session ${session.id} operation promptText`);
  if (operation.calendarOccurrence !== undefined) {
    requireRecord(operation.calendarOccurrence, `session ${session.id} operation calendarOccurrence`);
    requireString(operation.calendarOccurrence.id, `session ${session.id} operation calendarOccurrence id`);
    requireString(operation.calendarOccurrence.revision, `session ${session.id} operation calendarOccurrence revision`);
    requireNonNegativeNumber(operation.calendarOccurrence.scheduledAt, `session ${session.id} operation calendarOccurrence scheduledAt`);
    if (operation.calendarOccurrence.catchUp !== undefined) requireBoolean(operation.calendarOccurrence.catchUp, `session ${session.id} operation calendarOccurrence catchUp`);
  }
  if (operation.launchUrl !== undefined) {
    requireString(operation.launchUrl, `session ${session.id} operation launchUrl`);
    if (operation.launchUrl && normalizeChatUrl(operation.launchUrl) !== operation.launchUrl) {
      throw new Error(`Invalid session ${session.id} operation launchUrl`);
    }
  }
  for (const field of ['previousSendTabId', 'previousSendWindowId']) {
    if (operation[field] !== undefined
        && (!Number.isInteger(operation[field]) || operation[field] < 0)) {
      throw new Error(`Invalid session ${session.id} operation ${field}`);
    }
  }
}

function validateSession(session, id) {
  requireRecord(session, `session ${id}`);
  if (session.id !== id) throw new Error(`Invalid session ${id}`);
  requireString(session.name, `session ${id} name`);
  requireBoolean(session.enabled, `session ${id} enabled`);
  requireEnum(session.runState, RUN_STATES, `session ${id} runState`);
  requireEnum(session.promptMode, PROMPT_MODES, `session ${id} promptMode`);
  requireString(session.sharedPrompt, `session ${id} sharedPrompt`);
  if (session.promptCadence !== undefined) normalizeSessionPromptCadence(session.promptCadence);
  if (session.drivePromptSources !== undefined) normalizeSessionDrivePromptSources(session.drivePromptSources);
  if (session.calendarSchedule !== undefined && session.calendarSchedule !== null) normalizeCalendarSchedule(session.calendarSchedule);
  if (session.calendarRuntime !== undefined) requireRecord(session.calendarRuntime, `session ${id} calendarRuntime`);
  requireEnum(session.runMode, RUN_MODES, `session ${id} runMode`);
  requireUniqueStringArray(session.taskOrder, `session ${id} taskOrder`, { min: 1, max: MAX_PHYSICAL_TASKS });
  const configuredTaskCount = session.configuredTaskCount === undefined ? session.taskOrder.length : session.configuredTaskCount;
  if (!Number.isInteger(configuredTaskCount) || configuredTaskCount < 1 || configuredTaskCount > MAX_LOGICAL_TASKS || configuredTaskCount < session.taskOrder.length) {
    throw new Error(`Invalid session ${id} configuredTaskCount`);
  }
  if (configuredTaskCount > session.taskOrder.length && (session.taskOrder.length !== 1 || session.promptMode !== PromptMode.SHARED || (session.urlMode !== undefined && session.urlMode !== 'shared'))) {
    throw new Error(`Invalid session ${id} compact logical task configuration`);
  }
  requireRecord(session.tasksById, `session ${id} tasksById`);
  if (!Number.isInteger(session.currentTaskIndex) || session.currentTaskIndex < 0 || session.currentTaskIndex >= session.taskOrder.length) {
    throw new Error('Invalid currentTaskIndex');
  }
  for (const field of ['minimumSendIntervalMs', 'preSendDelayMs', 'busyCheckDelayMs', 'retryBackoffMs', 'nextAllowedSendAt', 'lastActionAt', 'lastSuccessfulSendAt', 'createdAt', 'updatedAt']) {
    requireNonNegativeNumber(session[field], `session ${id} ${field}`);
  }
  requireEnum(session.tabStrategy, TAB_STRATEGIES, `session ${id} tabStrategy`);
  requireString(session.lastError, `session ${id} lastError`);
  if (session.successfulSendCount !== undefined) requireNonNegativeNumber(session.successfulSendCount, `session ${id} successfulSendCount`);
  if (session.onePassCompletedCount !== undefined) {
    requireNonNegativeNumber(session.onePassCompletedCount, `session ${id} onePassCompletedCount`);
    if (!Number.isInteger(session.onePassCompletedCount) || session.onePassCompletedCount > configuredTaskCount) throw new Error(`Invalid session ${id} onePassCompletedCount`);
  }
  if (session.completedAt !== undefined) requireNonNegativeNumber(session.completedAt, `session ${id} completedAt`);
  requireUniqueStringArray(session.onePassCompletedTaskIds, `session ${id} onePassCompletedTaskIds`);
  if (session.version !== undefined && (!Number.isInteger(session.version) || session.version < 0)) throw new Error(`Invalid session ${id} version`);
  if (session.pausedByMaster !== undefined) requireBoolean(session.pausedByMaster, `session ${id} pausedByMaster`);
  if (session.simplifiedSession !== undefined) requireBoolean(session.simplifiedSession, `session ${id} simplifiedSession`);
  if (session.urlMode !== undefined && !['shared', 'unique'].includes(session.urlMode)) throw new Error(`Invalid session ${id} urlMode`);
  if (session.aiCoordinatorHandoff !== undefined) requireString(session.aiCoordinatorHandoff, `session ${id} aiCoordinatorHandoff`);
  if (session.aiCoordinatorHandoffCreatedAt !== undefined) requireNonNegativeNumber(session.aiCoordinatorHandoffCreatedAt, `session ${id} aiCoordinatorHandoffCreatedAt`);

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
  if (state.profile.rateLimitCooldownMs !== undefined) {
    requireNonNegativeNumber(state.profile.rateLimitCooldownMs, 'profile rateLimitCooldownMs');
    if (state.profile.rateLimitCooldownMs < MIN_RATE_LIMIT_COOLDOWN_MS || state.profile.rateLimitCooldownMs > MAX_RATE_LIMIT_COOLDOWN_MS) {
      throw new Error('Invalid profile rateLimitCooldownMs');
    }
  }
  if (state.profile.rateLimitUntil !== undefined) {
    requireNonNegativeNumber(state.profile.rateLimitUntil, 'profile rateLimitUntil');
  }
  if (state.profile.maxConcurrentSessionOperations !== undefined) {
    if (!Number.isInteger(state.profile.maxConcurrentSessionOperations)
        || state.profile.maxConcurrentSessionOperations < 1
        || state.profile.maxConcurrentSessionOperations > 32) {
      throw new Error('Invalid profile maxConcurrentSessionOperations');
    }
  }
  if (state.profile.localAi !== undefined) {
    requireRecord(state.profile.localAi, 'profile localAi');
    const normalizedLocalAi = normalizeLocalAiSettings(state.profile.localAi);
    requireBoolean(normalizedLocalAi.enabled, 'profile localAi enabled');
    requireString(normalizedLocalAi.providerType, 'profile localAi providerType');
    requireString(normalizedLocalAi.baseUrl, 'profile localAi baseUrl');
    requireString(normalizedLocalAi.model, 'profile localAi model');
    requireNonNegativeNumber(normalizedLocalAi.timeoutSeconds, 'profile localAi timeoutSeconds');
  }
  if (state.profile.aiRouter !== undefined) {
    requireRecord(state.profile.aiRouter, 'profile aiRouter');
    const normalizedAiRouter = normalizeAiRouterSettings(state.profile.aiRouter);
    requireBoolean(normalizedAiRouter.enabled, 'profile aiRouter enabled');
    requireString(normalizedAiRouter.gatewayUrl, 'profile aiRouter gatewayUrl');
    requireString(normalizedAiRouter.mode, 'profile aiRouter mode');
    requireRecord(normalizedAiRouter.primary, 'profile aiRouter primary');
    requireRecord(normalizedAiRouter.strong, 'profile aiRouter strong');
    if (!Array.isArray(normalizedAiRouter.routes)) throw new Error('Invalid profile aiRouter routes');
    requireRecord(normalizedAiRouter.routePolicy, 'profile aiRouter routePolicy');
  }
  if (state.profile.aiRouterRuntime !== undefined) {
    requireRecord(state.profile.aiRouterRuntime, 'profile aiRouterRuntime');
    const runtime = normalizeAiRouterRuntime(state.profile.aiRouterRuntime);
    requireNonNegativeNumber(runtime.requestCount, 'profile aiRouterRuntime requestCount');
    requireNonNegativeNumber(runtime.primaryCount, 'profile aiRouterRuntime primaryCount');
    requireNonNegativeNumber(runtime.startedAt, 'profile aiRouterRuntime startedAt');
    requireNonNegativeNumber(runtime.strongCount, 'profile aiRouterRuntime strongCount');
    requireNonNegativeNumber(runtime.lastStrongAt, 'profile aiRouterRuntime lastStrongAt');
    requireString(runtime.lastRoute, 'profile aiRouterRuntime lastRoute');
    requireString(runtime.lastStrongResult, 'profile aiRouterRuntime lastStrongResult');
    if (!Array.isArray(runtime.strongHistoryAt)) throw new Error('Invalid profile aiRouterRuntime strongHistoryAt');
    requireRecord(runtime.routeStates, 'profile aiRouterRuntime routeStates');
    requireString(runtime.lastRouteId, 'profile aiRouterRuntime lastRouteId');
    if (!Array.isArray(runtime.lastFailoverChain)) throw new Error('Invalid profile aiRouterRuntime lastFailoverChain');
  }
  if (state.profile.aiManager !== undefined) {
    requireRecord(state.profile.aiManager, 'profile aiManager');
    const manager = normalizeAiManagerSettings(state.profile.aiManager);
    requireBoolean(manager.enabled, 'profile aiManager enabled');
    requireBoolean(manager.autoApplySafeActions, 'profile aiManager autoApplySafeActions');
    requireNonNegativeNumber(manager.triggerEveryNSends, 'profile aiManager triggerEveryNSends');
    requireNonNegativeNumber(manager.triggerEveryMinutes, 'profile aiManager triggerEveryMinutes');
    requireBoolean(manager.triggerOnComplete, 'profile aiManager triggerOnComplete');
    requireBoolean(manager.triggerOnErrors, 'profile aiManager triggerOnErrors');
    requireBoolean(manager.captureWebReports, 'profile aiManager captureWebReports');
    requireBoolean(manager.allowRestartCompletedOnePass, 'profile aiManager allowRestartCompletedOnePass');
    requireBoolean(manager.allowSessionTuning, 'profile aiManager allowSessionTuning');
    requireBoolean(manager.triggerOnWebReport, 'profile aiManager triggerOnWebReport');
    requireNonNegativeNumber(manager.webReportPollSeconds, 'profile aiManager webReportPollSeconds');
    requireNonNegativeNumber(manager.webReportMaxWaitMinutes, 'profile aiManager webReportMaxWaitMinutes');
    requireNonNegativeNumber(manager.webReportMaxChars, 'profile aiManager webReportMaxChars');
    requireNonNegativeNumber(manager.failureRetrySeconds, 'profile aiManager failureRetrySeconds');
  }
  if (state.profile.aiManagerRuntime !== undefined) {
    requireRecord(state.profile.aiManagerRuntime, 'profile aiManagerRuntime');
    const managerRuntime = normalizeAiManagerRuntime(state.profile.aiManagerRuntime);
    requireNonNegativeNumber(managerRuntime.nextEventId, 'profile aiManagerRuntime nextEventId');
    requireNonNegativeNumber(managerRuntime.processedEventCount, 'profile aiManagerRuntime processedEventCount');
    requireNonNegativeNumber(managerRuntime.sentSinceDecision, 'profile aiManagerRuntime sentSinceDecision');
    requireNonNegativeNumber(managerRuntime.startedAt, 'profile aiManagerRuntime startedAt');
    requireNonNegativeNumber(managerRuntime.lastDecisionAt, 'profile aiManagerRuntime lastDecisionAt');
    requireNonNegativeNumber(managerRuntime.decisionCount, 'profile aiManagerRuntime decisionCount');
    requireString(managerRuntime.lastDecisionSummary, 'profile aiManagerRuntime lastDecisionSummary');
    requireString(managerRuntime.lastDecisionRoute, 'profile aiManagerRuntime lastDecisionRoute');
    requireString(managerRuntime.lastError, 'profile aiManagerRuntime lastError');
    requireNonNegativeNumber(managerRuntime.retryAfterAt, 'profile aiManagerRuntime retryAfterAt');
    requireNonNegativeNumber(managerRuntime.failureStreak, 'profile aiManagerRuntime failureStreak');
    if (!Array.isArray(managerRuntime.pendingEvents)) throw new Error('Invalid profile aiManagerRuntime pendingEvents');
    requireRecord(managerRuntime.errorStreakBySession, 'profile aiManagerRuntime errorStreakBySession');
    requireNonNegativeNumber(managerRuntime.nextReportId, 'profile aiManagerRuntime nextReportId');
    if (!Array.isArray(managerRuntime.pendingReports)) throw new Error('Invalid profile aiManagerRuntime pendingReports');
    if (!Array.isArray(managerRuntime.decisionHistory)) throw new Error('Invalid profile aiManagerRuntime decisionHistory');
  }
  requireRecord(state.sessionsById, 'sessionsById');
  requireUniqueStringArray(state.sessionOrder, 'sessionOrder');
  requireRecord(state.tabHintsByTaskId, 'tabHintsByTaskId');
  requireRecord(state.sendArbiter, 'sendArbiter');
  requireNonNegativeNumber(state.sendArbiter.profileNextAllowedSendAt, 'sendArbiter profileNextAllowedSendAt');
  if (state.sendArbiter.lastSentSessionId !== undefined) requireString(state.sendArbiter.lastSentSessionId, 'sendArbiter lastSentSessionId');
  if (state.sendArbiter.lastSentSchedulingClass !== undefined) {
    requireString(state.sendArbiter.lastSentSchedulingClass, 'sendArbiter lastSentSchedulingClass');
    if (state.sendArbiter.lastSentSchedulingClass && !['ORDINARY', 'MANAGED'].includes(state.sendArbiter.lastSentSchedulingClass)) throw new Error('Invalid sendArbiter lastSentSchedulingClass');
  }
  requireRecord(state.logs, 'logs');
  if (!Array.isArray(state.diagnostics) || state.diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) {
    throw new Error('Invalid diagnostics');
  }
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

  for (const entry of state.diagnostics) {
    requireRecord(entry, 'diagnostic entry');
    requireNonNegativeNumber(entry.at, 'diagnostic entry at');
    requireString(entry.event, 'diagnostic entry event');
    if (entry.event.length > 80) throw new Error('Invalid diagnostic event');
    for (const field of [
      'sessionId', 'sessionName', 'taskId', 'taskLabel', 'mode', 'phase',
      'runState', 'status', 'code', 'message', 'target', 'observed',
      'promptFingerprint', 'operationIdSuffix',
    ]) {
      if (entry[field] !== undefined && entry[field] !== null) {
        requireString(entry[field], `diagnostic entry ${field}`);
        if (entry[field].length > MAX_DIAGNOSTIC_MESSAGE_LENGTH) {
          throw new Error(`Invalid diagnostic entry ${field}`);
        }
      }
    }
    if (entry.tabId !== undefined && entry.tabId !== null
        && (!Number.isInteger(entry.tabId) || entry.tabId < 0)) {
      throw new Error('Invalid diagnostic entry tabId');
    }
  }

  for (const hint of Object.values(state.tabHintsByTaskId)) {
    requireRecord(hint, 'tab hint');
    if (!Number.isInteger(hint.tabId) || hint.tabId < 0) throw new Error('Invalid tab hint tabId');
    requireString(hint.sessionId, 'tab hint sessionId');
    if (!state.sessionsById[hint.sessionId]) throw new Error('Invalid tab hint sessionId');
    requireString(hint.normalizedUrl, 'tab hint normalizedUrl');
    if (hint.kind !== undefined) requireString(hint.kind, 'tab hint kind');
    if (hint.ownedByExtension !== undefined && typeof hint.ownedByExtension !== 'boolean') throw new Error('Invalid tab hint ownedByExtension');
    if (hint.retirePending !== undefined && typeof hint.retirePending !== 'boolean') throw new Error('Invalid tab hint retirePending');
    if (hint.retireAttempts !== undefined && (!Number.isInteger(hint.retireAttempts) || hint.retireAttempts < 0)) throw new Error('Invalid tab hint retireAttempts');
    if (hint.retireRetryAt !== undefined) requireNonNegativeNumber(hint.retireRetryAt, 'tab hint retireRetryAt');
    if (hint.boundAt !== undefined) requireNonNegativeNumber(hint.boundAt, 'tab hint boundAt');
  }

  return state;
}
