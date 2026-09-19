import { createSession, createTask, normalizeChatUrl, PromptMode, RunMode, RunState, TabStrategy } from './schema.js';
import { AgentProviderId, orchestrationProviderContract, resolveAgentProviderLaunchUrl } from './capability-registry.js';

export const ORCHESTRATION_SCHEMA_VERSION = 2;
export const ORCHESTRATION_CONTROL_MARKER = '<!-- CHATGPT_AUTOPILOT_CONTROL_V2 -->';
export const ORCHESTRATION_RUNTIME_SCHEMA_VERSION = 1;

export const OrchestrationMode = Object.freeze({
  RUN: 'RUN',
  DRAIN: 'DRAIN',
  INTEGRATE: 'INTEGRATE',
  PAUSE: 'PAUSE',
});

export const CoordinatorStatus = Object.freeze({
  IDLE: 'IDLE',
  BUSY: 'BUSY',
  WAITING_CONTROL: 'WAITING_CONTROL',
  ROTATION_REQUIRED: 'ROTATION_REQUIRED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

export const WorkerState = Object.freeze({
  QUEUED: 'QUEUED',
  LAUNCHING: 'LAUNCHING',
  ACTIVE: 'ACTIVE',
  BUSY: 'BUSY',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
  STALE: 'STALE',
  CANCELLED: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

export const CoordinatorEventType = Object.freeze({
  WORKER_TERMINAL: 'WORKER_TERMINAL',
  WORKER_STALE_CANDIDATE: 'WORKER_STALE_CANDIDATE',
  WATCHDOG_RECONCILE: 'WATCHDOG_RECONCILE',
  PROVIDER_CHANGED: 'PROVIDER_CHANGED',
  RECOVERY_RECONCILE: 'RECOVERY_RECONCILE',
});

export const ControlActionType = Object.freeze({
  NO_ACTION: 'NO_ACTION',
  SET_DESIRED_CONCURRENCY: 'SET_DESIRED_CONCURRENCY',
  ADD_TASKS: 'ADD_TASKS',
  CANCEL_QUEUED_TASKS: 'CANCEL_QUEUED_TASKS',
  SUPERSEDE_TASKS: 'SUPERSEDE_TASKS',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  ROTATE_COORDINATOR: 'ROTATE_COORDINATOR',
  CONTROL_NOTE: 'CONTROL_NOTE',
});

export const DEFAULT_ORCHESTRATION_CONFIG = Object.freeze({
  enabled: false,
  projectId: '',
  targetRepository: '',
  controlRepository: '',
  controlIssueNumber: 0,
  controlCommentId: 0,
  bootstrapPinnedControlFirst: false,
  coordinatorAgentProviderId: AgentProviderId.CHATGPT_BROWSER,
  workerAgentProviderId: AgentProviderId.CHATGPT_BROWSER,
  coordinatorLaunchUrl: 'https://chatgpt.com/',
  masterCoordinatorPrompt: '',
  coordinatorTickPrompt: 'Продовжуй координацію. Перечитай live GitHub і прийми наступне рішення.',
  masterPromptVersion: 1,
  defaultDesiredWorkers: 5,
  absoluteMaxWorkers: 8,
  maxLaunchesPerWindow: 6,
  launchWindowSeconds: 300,
  minimumWorkerLaunchIntervalMs: 0,
  workerProbeIntervalSeconds: 30,
  watchdogIntervalSeconds: 300,
  maxCoordinatorTurns: 10,
  workerPreSendDelayMs: 8000,
  workerBusyCheckDelayMs: 2000,
  workerRetryBackoffMs: 60000,
  coordinatorPreSendDelayMs: 8000,
  coordinatorRetryBackoffMs: 60000,
  staleWorkerAfterSeconds: 3600,
  fallbackUniversalPromptEnabled: false,
});

const MODES = new Set(Object.values(OrchestrationMode));
const WORKER_STATES = new Set(Object.values(WorkerState));
const EVENT_TYPES = new Set(Object.values(CoordinatorEventType));
const ACTION_TYPES = new Set(Object.values(ControlActionType));
const SLOT_STATES = new Set([
  WorkerState.LAUNCHING,
  WorkerState.ACTIVE,
  WorkerState.BUSY,
  WorkerState.RATE_LIMITED,
  WorkerState.BLOCKED,
  WorkerState.STALE,
  WorkerState.MANUAL_REVIEW,
]);
const TERMINAL_STATES = new Set([
  WorkerState.COMPLETED,
  WorkerState.FAILED,
  WorkerState.CANCELLED,
  WorkerState.SUPERSEDED,
]);
const MAX_PROMPT = 200000;
const MAX_NOTE = 4000;
const MAX_TASKS_PER_DECISION = 1000;
const MAX_PENDING_EVENTS = 10000;
const MAX_COORDINATOR_EVENTS_PER_TURN = 200;
const MAX_WORKER_HISTORY = 10000;
const MIN_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const MAX_STORED_DIRECT_CONTROL_CHARS = 512000;

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function finiteInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isInteger(n) && Number.isFinite(n) ? n : fallback;
}
function boundedInt(value, min, max, fallback) {
  const n = finiteInt(value, fallback);
  return Math.min(max, Math.max(min, n));
}
function boundedNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function requireInteger(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || !Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${label}`);
  return n;
}
function parseIso(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid ${label}`);
  return new Date(ms).toISOString();
}
function requireId(value, label) {
  const v = text(value);
  if (!v || v.length > 180 || !/^[A-Za-z0-9._:@/+-]+$/u.test(v)) throw new Error(`Invalid ${label}`);
  return v;
}
function requireString(value, label, max = 1000) {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  const v = value.trim();
  if (!v || v.length > max) throw new Error(`Invalid ${label}`);
  return v;
}
function uniqueStringArray(value, label, max = 100) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}`);
  const out = value.map((item, index) => requireId(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`Duplicate ${label}`);
  return out;
}
function clone(value) { return structuredClone(value); }
function storedCoordinatorReport(value) {
  const body = String(value || '');
  const markerAt = body.lastIndexOf(ORCHESTRATION_CONTROL_MARKER);
  if (markerAt >= 0) {
    const suffix = body.slice(markerAt);
    return suffix.length <= MAX_STORED_DIRECT_CONTROL_CHARS ? suffix : '';
  }
  return body.slice(-12000);
}
function taskExecutionKey(taskId, generation) { return `${taskId}@${generation}`; }
function workerSessionId(projectId, ordinal) { return `orch:${projectId}:worker:${ordinal}`; }
function workerTaskId(projectId, ordinal) { return `orch:${projectId}:task:${ordinal}`; }
function coordinatorSessionId(projectId) { return `orch:${projectId}:coordinator`; }
function coordinatorTaskId(projectId) { return `orch:${projectId}:coordinator-task`; }

export function validateOrchestrationConfig(raw = {}) {
  const absoluteMaxWorkers = boundedInt(raw.absoluteMaxWorkers, 1, 200, DEFAULT_ORCHESTRATION_CONFIG.absoluteMaxWorkers);
  const defaultDesiredWorkers = boundedInt(raw.defaultDesiredWorkers, 0, absoluteMaxWorkers, Math.min(DEFAULT_ORCHESTRATION_CONFIG.defaultDesiredWorkers, absoluteMaxWorkers));
  const coordinatorAgentProviderId = text(raw.coordinatorAgentProviderId) || DEFAULT_ORCHESTRATION_CONFIG.coordinatorAgentProviderId;
  const workerAgentProviderId = text(raw.workerAgentProviderId) || DEFAULT_ORCHESTRATION_CONFIG.workerAgentProviderId;
  orchestrationProviderContract(coordinatorAgentProviderId);
  orchestrationProviderContract(workerAgentProviderId);
  const config = {
    enabled: raw.enabled === true,
    projectId: text(raw.projectId),
    targetRepository: text(raw.targetRepository),
    controlRepository: text(raw.controlRepository),
    controlIssueNumber: boundedInt(raw.controlIssueNumber, 0, 1000000000, 0),
    controlCommentId: boundedInt(raw.controlCommentId, 0, Number.MAX_SAFE_INTEGER, 0),
    bootstrapPinnedControlFirst: raw.bootstrapPinnedControlFirst === true,
    coordinatorAgentProviderId,
    workerAgentProviderId,
    coordinatorLaunchUrl: resolveAgentProviderLaunchUrl(coordinatorAgentProviderId, raw.coordinatorLaunchUrl),
    masterCoordinatorPrompt: typeof raw.masterCoordinatorPrompt === 'string' ? raw.masterCoordinatorPrompt.trim() : '',
    coordinatorTickPrompt: typeof raw.coordinatorTickPrompt === 'string' && raw.coordinatorTickPrompt.trim() ? raw.coordinatorTickPrompt.trim() : DEFAULT_ORCHESTRATION_CONFIG.coordinatorTickPrompt,
    masterPromptVersion: boundedInt(raw.masterPromptVersion, 1, 100000, 1),
    defaultDesiredWorkers,
    absoluteMaxWorkers,
    maxLaunchesPerWindow: boundedInt(raw.maxLaunchesPerWindow, 0, 10000, DEFAULT_ORCHESTRATION_CONFIG.maxLaunchesPerWindow),
    launchWindowSeconds: boundedInt(raw.launchWindowSeconds, 10, 86400, DEFAULT_ORCHESTRATION_CONFIG.launchWindowSeconds),
    minimumWorkerLaunchIntervalMs: boundedInt(raw.minimumWorkerLaunchIntervalMs, 0, 3600000, DEFAULT_ORCHESTRATION_CONFIG.minimumWorkerLaunchIntervalMs),
    workerProbeIntervalSeconds: boundedInt(raw.workerProbeIntervalSeconds, 30, 600, DEFAULT_ORCHESTRATION_CONFIG.workerProbeIntervalSeconds),
    watchdogIntervalSeconds: boundedInt(raw.watchdogIntervalSeconds, 60, 3600, DEFAULT_ORCHESTRATION_CONFIG.watchdogIntervalSeconds),
    maxCoordinatorTurns: boundedInt(raw.maxCoordinatorTurns, 1, 1000, DEFAULT_ORCHESTRATION_CONFIG.maxCoordinatorTurns),
    workerPreSendDelayMs: boundedInt(raw.workerPreSendDelayMs, 1000, 30000, DEFAULT_ORCHESTRATION_CONFIG.workerPreSendDelayMs),
    workerBusyCheckDelayMs: boundedInt(raw.workerBusyCheckDelayMs, 1000, 30000, DEFAULT_ORCHESTRATION_CONFIG.workerBusyCheckDelayMs),
    workerRetryBackoffMs: boundedInt(raw.workerRetryBackoffMs, 5000, 3600000, DEFAULT_ORCHESTRATION_CONFIG.workerRetryBackoffMs),
    coordinatorPreSendDelayMs: boundedInt(raw.coordinatorPreSendDelayMs, 1000, 30000, DEFAULT_ORCHESTRATION_CONFIG.coordinatorPreSendDelayMs),
    coordinatorRetryBackoffMs: boundedInt(raw.coordinatorRetryBackoffMs, 5000, 3600000, DEFAULT_ORCHESTRATION_CONFIG.coordinatorRetryBackoffMs),
    staleWorkerAfterSeconds: boundedInt(raw.staleWorkerAfterSeconds, 300, 86400, DEFAULT_ORCHESTRATION_CONFIG.staleWorkerAfterSeconds),
    fallbackUniversalPromptEnabled: raw.fallbackUniversalPromptEnabled === true,
  };
  if (config.enabled) {
    requireId(config.projectId, 'projectId');
    requireString(config.targetRepository, 'targetRepository', 250);
    requireString(config.controlRepository, 'controlRepository', 250);
    if (!config.controlIssueNumber) throw new Error('Invalid controlIssueNumber');
    if (!config.masterCoordinatorPrompt) throw new Error('Invalid masterCoordinatorPrompt');
  }
  return config;
}

function parseTaskEnvelope(raw, index) {
  if (!isObject(raw)) throw new Error(`Invalid task[${index}]`);
  const taskId = requireId(raw.task_id, `task[${index}].task_id`);
  const prompt = requireString(raw.prompt, `task[${index}].prompt`, MAX_PROMPT);
  const generation = requireInteger(raw.generation ?? 1, `task[${index}].generation`, 1, 1000000000);
  const priorityRaw = raw.priority ?? 0;
  let priority;
  if (typeof priorityRaw === 'string' && /^P[0-9]$/iu.test(priorityRaw.trim())) {
    // Conventional P0 is the highest urgency. Internally priorities sort descending.
    priority = 9 - Number(priorityRaw.trim().slice(1));
  } else {
    priority = requireInteger(priorityRaw, `task[${index}].priority`, -1000000, 1000000);
  }
  const dependencies = uniqueStringArray(raw.dependencies, `task[${index}].dependencies`, 100);
  if (dependencies.includes(taskId)) throw new Error(`Task ${taskId} depends on itself`);
  const conflictKey = raw.conflict_key == null || String(raw.conflict_key).trim() === '' ? '' : requireString(String(raw.conflict_key), `task[${index}].conflict_key`, 300);
  const launchMode = text(raw.launch_mode || 'FRESH_CHAT').toUpperCase();
  if (!['FRESH_CHAT', 'CONTINUE_EXISTING_WORKER'].includes(launchMode)) throw new Error(`Invalid task[${index}].launch_mode`);
  const continueWorkerId = raw.continue_worker_id == null || (typeof raw.continue_worker_id === 'string' && raw.continue_worker_id.trim() === '')
    ? ''
    : requireId(raw.continue_worker_id, `task[${index}].continue_worker_id`);
  if (launchMode === 'CONTINUE_EXISTING_WORKER' && !continueWorkerId) throw new Error(`Missing task[${index}].continue_worker_id`);
  if (launchMode === 'FRESH_CHAT' && continueWorkerId) throw new Error(`Unexpected task[${index}].continue_worker_id`);
  const exactOnceKey = raw.exact_once_key == null
    ? `${taskId}@${generation}`
    : requireId(raw.exact_once_key, `task[${index}].exact_once_key`);
  const notBefore = parseIso(raw.not_before, `task[${index}].not_before`, { nullable: true });
  const expiresAt = parseIso(raw.expires_at, `task[${index}].expires_at`, { nullable: true });
  if (notBefore && expiresAt && Date.parse(expiresAt) <= Date.parse(notBefore)) throw new Error(`Invalid task[${index}] time window`);
  return {
    task_id: taskId,
    prompt,
    priority,
    dependencies,
    conflict_key: conflictKey,
    generation,
    launch_mode: launchMode,
    continue_worker_id: continueWorkerId,
    exact_once_key: exactOnceKey,
    not_before: notBefore,
    expires_at: expiresAt,
    target_repository: raw.target_repository == null ? '' : requireString(String(raw.target_repository), `task[${index}].target_repository`, 250),
  };
}

function parseAction(raw, index) {
  if (!isObject(raw)) throw new Error(`Invalid action[${index}]`);
  const type = text(raw.type).toUpperCase();
  if (!ACTION_TYPES.has(type)) throw new Error(`Invalid action[${index}].type`);
  if (type === ControlActionType.NO_ACTION) return { type };
  if (type === ControlActionType.SET_DESIRED_CONCURRENCY) {
    const aliases = ['value', 'desired_concurrency', 'desired_workers', 'concurrency'];
    const supplied = aliases.filter(key => raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim() !== '');
    if (!supplied.length) throw new Error(`Invalid action[${index}].value`);
    const values = supplied.map(key => Number(raw[key]));
    if (values.some(value => !Number.isInteger(value) || value < 0 || value > 1000)) throw new Error(`Invalid action[${index}].value`);
    if (new Set(values).size !== 1) throw new Error(`Conflicting action[${index}] concurrency aliases`);
    return { type, value: values[0] };
  }
  if (type === ControlActionType.ADD_TASKS) {
    if (!Array.isArray(raw.tasks) || !raw.tasks.length || raw.tasks.length > MAX_TASKS_PER_DECISION) throw new Error(`Invalid action[${index}].tasks`);
    const tasks = raw.tasks.map((task, taskIndex) => parseTaskEnvelope(task, taskIndex));
    const ids = tasks.map(task => task.task_id);
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate task_id in action[${index}]`);
    const exactKeys = tasks.map(task => task.exact_once_key);
    if (new Set(exactKeys).size !== exactKeys.length) throw new Error(`Duplicate exact_once_key in action[${index}]`);
    return { type, tasks };
  }
  if ([ControlActionType.CANCEL_QUEUED_TASKS, ControlActionType.SUPERSEDE_TASKS].includes(type)) {
    return { type, task_ids: uniqueStringArray(raw.task_ids, `action[${index}].task_ids`, 200) };
  }
  if (type === ControlActionType.CONTROL_NOTE) {
    return { type, note: requireString(raw.note, `action[${index}].note`, MAX_NOTE) };
  }
  return { type };
}

export function validateControlDecision(raw, { projectId = '', coordinatorGeneration = 0, nowMs = Date.now() } = {}) {
  if (!isObject(raw)) throw new Error('Invalid orchestration control payload');
  if (Number(raw.schema_version) !== ORCHESTRATION_SCHEMA_VERSION) throw new Error('Unsupported orchestration schema_version');
  const parsed = {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    project_id: requireId(raw.project_id, 'project_id'),
    revision: requireInteger(raw.revision, 'revision', 1, Number.MAX_SAFE_INTEGER),
    coordinator_generation: requireInteger(raw.coordinator_generation, 'coordinator_generation', 1, Number.MAX_SAFE_INTEGER),
    generated_at: parseIso(raw.generated_at, 'generated_at'),
    expires_at: parseIso(raw.expires_at, 'expires_at'),
    mode: (() => {
      const mode = text(raw.mode || OrchestrationMode.RUN).toUpperCase();
      return mode === 'ACTIVE' ? OrchestrationMode.RUN : mode;
    })(),
    actions: Array.isArray(raw.actions) ? raw.actions.map(parseAction) : [],
  };
  if (!parsed.revision) throw new Error('Invalid revision');
  if (!parsed.coordinator_generation) throw new Error('Invalid coordinator_generation');
  if (!MODES.has(parsed.mode)) throw new Error('Invalid mode');
  if (projectId && parsed.project_id !== projectId) throw new Error('Wrong project_id');
  if (coordinatorGeneration && parsed.coordinator_generation !== coordinatorGeneration) throw new Error('Wrong coordinator_generation');
  if (Date.parse(parsed.expires_at) <= Date.parse(parsed.generated_at)) throw new Error('Invalid control expiry');
  if (Date.parse(parsed.expires_at) <= nowMs) throw new Error('Expired orchestration control');
  if (Date.parse(parsed.generated_at) > nowMs + 5 * 60 * 1000) throw new Error('Future orchestration control');
  if (!parsed.actions.length) throw new Error('Control actions required');
  const noActionCount = parsed.actions.filter(action => action.type === ControlActionType.NO_ACTION).length;
  if (noActionCount && (noActionCount !== 1 || parsed.actions.length !== 1)) throw new Error('NO_ACTION must be the only action');
  const addedTasks = parsed.actions.filter(action => action.type === ControlActionType.ADD_TASKS).flatMap(action => action.tasks);
  const taskIds = addedTasks.map(task => task.task_id);
  if (new Set(taskIds).size !== taskIds.length) throw new Error('Duplicate task_id across ADD_TASKS actions');
  const exactOnceKeys = addedTasks.map(task => task.exact_once_key);
  if (new Set(exactOnceKeys).size !== exactOnceKeys.length) throw new Error('Duplicate exact_once_key across ADD_TASKS actions');
  return parsed;
}

export function parseControlComment(body, options = {}) {
  if (typeof body !== 'string' || !body.startsWith(ORCHESTRATION_CONTROL_MARKER)) return { executable: false, reason: 'UNMARKED' };
  const matches = [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)];
  if (matches.length !== 1) throw new Error('Orchestration control must contain exactly one fenced JSON object');
  let raw;
  try { raw = JSON.parse(matches[0][1]); } catch { throw new Error('Invalid orchestration control JSON'); }
  return { executable: true, control: validateControlDecision(raw, options) };
}

export function parseDirectControlResponse(body, options = {}) {
  if (typeof body !== 'string' || !body.trim()) return { executable: false, reason: 'UNMARKED' };
  const first = body.indexOf(ORCHESTRATION_CONTROL_MARKER);
  if (first < 0) return { executable: false, reason: 'UNMARKED' };
  if (body.indexOf(ORCHESTRATION_CONTROL_MARKER, first + ORCHESTRATION_CONTROL_MARKER.length) >= 0) {
    throw new Error('Direct orchestration response must contain exactly one control marker');
  }
  const suffix = body.slice(first);
  const matches = [...suffix.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)];
  if (matches.length !== 1) throw new Error('Direct orchestration response must contain exactly one fenced JSON object');
  const match = matches[0];
  const closingEnd = Number(match.index || 0) + match[0].length;
  if (suffix.slice(closingEnd).trim()) throw new Error('Direct orchestration control block must be final');
  const prefix = suffix.slice(0, Number(match.index || 0)).trim();
  if (prefix !== ORCHESTRATION_CONTROL_MARKER) throw new Error('Direct orchestration control marker must immediately precede the final JSON block');
  return parseControlComment(`${ORCHESTRATION_CONTROL_MARKER}\n${match[0]}`, options);
}

export function createOrchestrationRuntime(configRaw = {}, nowMs = Date.now()) {
  const config = validateOrchestrationConfig(configRaw);
  const projectId = config.projectId || text(configRaw.projectId);
  return {
    schemaVersion: ORCHESTRATION_RUNTIME_SCHEMA_VERSION,
    projectId,
    mode: OrchestrationMode.RUN,
    desiredActiveWorkers: config.defaultDesiredWorkers,
    hardMaxWorkers: config.absoluteMaxWorkers,
    nextWorkerOrdinal: 1,
    nextEventId: 1,
    lastAppliedControlRevision: 0,
    lastAppliedControlAt: 0,
    lastAppliedControlSource: '',
    lastControlNote: '',
    lastWatchdogAt: 0,
    lastCoordinatorWakeAt: 0,
    lastCoordinatorDecisionAt: 0,
    provider: { lastFetchAt: 0, lastFetchOkAt: 0, lastFetchError: '', retryAfterAt: 0, canonicalCommentId: config.controlCommentId || 0, rateLimitRemaining: null },
    agentProvider: { retryAfterAt: 0, lastRateLimitAt: 0, reason: '', sourceWorkerId: '' },
    coordinator: {
      generation: 1,
      status: CoordinatorStatus.IDLE,
      chatUrl: '',
      turnsUsed: 0,
      maxTurns: config.maxCoordinatorTurns,
      lease: null,
      rotationRequested: false,
      lastError: '',
      retryAfterAt: 0,
      lastAssistantBaselineCount: 0,
      lastAssistantBaselineKnown: false,
      deliveredTurnId: '',
      deliveredAt: 0,
      responseCompleteAt: 0,
      lastAssistantReport: '',
    },
    workersById: {},
    workerOrder: [],
    taskExecutionIndex: {},
    exactOnceIndex: {},
    completedTaskIndex: {},
    launchHistoryAt: [],
    lastWorkerLaunchAt: 0,
    lastRequestedDesiredWorkers: config.defaultDesiredWorkers,
    pendingCoordinatorEvents: [],
    consumedCoordinatorEventIds: [],
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export function normalizeOrchestrationRuntime(raw, configRaw = {}, nowMs = Date.now()) {
  const config = validateOrchestrationConfig(configRaw);
  if (!isObject(raw) || raw.schemaVersion !== ORCHESTRATION_RUNTIME_SCHEMA_VERSION || raw.projectId !== config.projectId) {
    return createOrchestrationRuntime(config, nowMs);
  }
  const runtime = clone(raw);
  runtime.mode = MODES.has(runtime.mode) ? runtime.mode : OrchestrationMode.RUN;
  runtime.desiredActiveWorkers = boundedInt(runtime.desiredActiveWorkers, 0, config.absoluteMaxWorkers, config.defaultDesiredWorkers);
  runtime.hardMaxWorkers = config.absoluteMaxWorkers;
  runtime.nextWorkerOrdinal = boundedInt(runtime.nextWorkerOrdinal, 1, Number.MAX_SAFE_INTEGER, 1);
  runtime.nextEventId = boundedInt(runtime.nextEventId, 1, Number.MAX_SAFE_INTEGER, 1);
  runtime.lastAppliedControlRevision = Math.max(0, finiteInt(runtime.lastAppliedControlRevision, 0));
  runtime.lastAppliedControlAt = Math.max(0, Number(runtime.lastAppliedControlAt || 0));
  runtime.lastAppliedControlSource = typeof runtime.lastAppliedControlSource === 'string' ? runtime.lastAppliedControlSource.slice(0, 80) : '';
  runtime.lastControlNote = typeof runtime.lastControlNote === 'string' ? runtime.lastControlNote.slice(0, MAX_NOTE) : '';
  runtime.lastWatchdogAt = Math.max(0, Number(runtime.lastWatchdogAt || 0));
  runtime.lastCoordinatorWakeAt = Math.max(0, Number(runtime.lastCoordinatorWakeAt || 0));
  runtime.lastCoordinatorDecisionAt = Math.max(0, Number(runtime.lastCoordinatorDecisionAt || 0));
  runtime.provider = isObject(runtime.provider) ? runtime.provider : {};
  runtime.provider.lastFetchAt = Math.max(0, Number(runtime.provider.lastFetchAt || 0));
  runtime.provider.lastFetchOkAt = Math.max(0, Number(runtime.provider.lastFetchOkAt || 0));
  runtime.provider.lastFetchError = typeof runtime.provider.lastFetchError === 'string' ? runtime.provider.lastFetchError.slice(0, 2000) : '';
  runtime.provider.retryAfterAt = Math.max(0, Number(runtime.provider.retryAfterAt || 0));
  runtime.provider.canonicalCommentId = boundedInt(runtime.provider.canonicalCommentId || config.controlCommentId, 0, Number.MAX_SAFE_INTEGER, config.controlCommentId || 0);
  runtime.provider.rateLimitRemaining = runtime.provider.rateLimitRemaining == null ? null : Number(runtime.provider.rateLimitRemaining);
  runtime.agentProvider = isObject(runtime.agentProvider) ? runtime.agentProvider : {};
  runtime.agentProvider.retryAfterAt = Math.max(0, Number(runtime.agentProvider.retryAfterAt || 0));
  runtime.agentProvider.lastRateLimitAt = Math.max(0, Number(runtime.agentProvider.lastRateLimitAt || 0));
  runtime.agentProvider.reason = typeof runtime.agentProvider.reason === 'string' ? runtime.agentProvider.reason.slice(0, 1000) : '';
  runtime.agentProvider.sourceWorkerId = typeof runtime.agentProvider.sourceWorkerId === 'string' ? runtime.agentProvider.sourceWorkerId.slice(0, 250) : '';
  runtime.coordinator = isObject(runtime.coordinator) ? runtime.coordinator : {};
  const workerGenerationFloor = Object.values(isObject(runtime.workersById) ? runtime.workersById : {}).reduce(
    (max, worker) => Math.max(max, boundedInt(worker?.coordinatorGeneration, 1, Number.MAX_SAFE_INTEGER, 1)),
    1,
  );
  const leaseGenerationFloor = isObject(runtime.coordinator.lease)
    ? boundedInt(runtime.coordinator.lease.generation, 1, Number.MAX_SAFE_INTEGER, 1)
    : 1;
  runtime.coordinator.generation = Math.max(
    boundedInt(runtime.coordinator.generation, 1, Number.MAX_SAFE_INTEGER, 1),
    workerGenerationFloor,
    leaseGenerationFloor,
  );
  runtime.coordinator.status = Object.values(CoordinatorStatus).includes(runtime.coordinator.status) ? runtime.coordinator.status : CoordinatorStatus.IDLE;
  runtime.coordinator.chatUrl = typeof runtime.coordinator.chatUrl === 'string' ? runtime.coordinator.chatUrl : '';
  runtime.coordinator.turnsUsed = Math.max(0, finiteInt(runtime.coordinator.turnsUsed, 0));
  runtime.coordinator.maxTurns = config.maxCoordinatorTurns;
  runtime.coordinator.lease = isObject(runtime.coordinator.lease) ? runtime.coordinator.lease : null;
  if (runtime.coordinator.lease) {
    const expectedTurnPrefix = `coord:${runtime.projectId}:g${runtime.coordinator.generation}:t`;
    const validTurnId = typeof runtime.coordinator.lease.turnId === 'string'
      && runtime.coordinator.lease.turnId.startsWith(expectedTurnPrefix)
      && /^\d+$/u.test(runtime.coordinator.lease.turnId.slice(expectedTurnPrefix.length));
    if (runtime.coordinator.lease.generation !== runtime.coordinator.generation || !validTurnId) {
      runtime.coordinator.lease = null;
      runtime.coordinator.status = CoordinatorStatus.MANUAL_REVIEW;
      runtime.coordinator.lastError = 'Discarded stale or corrupt coordinator lease during runtime recovery.';
    }
  }
  runtime.coordinator.rotationRequested = runtime.coordinator.rotationRequested === true;
  runtime.coordinator.lastError = typeof runtime.coordinator.lastError === 'string' ? runtime.coordinator.lastError.slice(0, 2000) : '';
  runtime.coordinator.retryAfterAt = Math.max(0, Number(runtime.coordinator.retryAfterAt || 0));
  runtime.coordinator.lastAssistantBaselineCount = Math.max(0, finiteInt(runtime.coordinator.lastAssistantBaselineCount, 0));
  runtime.coordinator.lastAssistantBaselineKnown = runtime.coordinator.lastAssistantBaselineKnown === true;
  runtime.coordinator.deliveredTurnId = typeof runtime.coordinator.deliveredTurnId === 'string' ? runtime.coordinator.deliveredTurnId.slice(0, 250) : '';
  runtime.coordinator.deliveredAt = Math.max(0, Number(runtime.coordinator.deliveredAt || 0));
  runtime.coordinator.responseCompleteAt = Math.max(0, Number(runtime.coordinator.responseCompleteAt || 0));
  runtime.coordinator.lastAssistantReport = typeof runtime.coordinator.lastAssistantReport === 'string' ? runtime.coordinator.lastAssistantReport.slice(0, 12000) : '';
  runtime.workersById = isObject(runtime.workersById) ? runtime.workersById : {};
  const seenWorkerIds = new Set();
  runtime.workerOrder = Array.isArray(runtime.workerOrder)
    ? runtime.workerOrder.filter(id => typeof id === 'string' && runtime.workersById[id] && !seenWorkerIds.has(id) && seenWorkerIds.add(id))
    : [];
  let maxWorkerOrdinal = 0;
  for (const workerId of runtime.workerOrder) {
    const ordinal = Number(workerId.split(':').at(-1));
    if (Number.isSafeInteger(ordinal) && ordinal > maxWorkerOrdinal) maxWorkerOrdinal = ordinal;
    const worker = runtime.workersById[workerId];
    worker.lastSuccessfulProbeAt = Math.max(0, Number(worker.lastSuccessfulProbeAt || worker.sentAt || 0));
    worker.consecutiveProbeFailures = Math.max(0, finiteInt(worker.consecutiveProbeFailures, 0));
    worker.lastProbeErrorAt = Math.max(0, Number(worker.lastProbeErrorAt || 0));
    worker.lastStaleCandidateAt = Math.max(0, Number(worker.lastStaleCandidateAt || 0));
    worker.retryAfterAt = Math.max(0, Number(worker.retryAfterAt || 0));
  }
  runtime.nextWorkerOrdinal = Math.max(runtime.nextWorkerOrdinal, maxWorkerOrdinal + 1);
  runtime.taskExecutionIndex = isObject(runtime.taskExecutionIndex) ? runtime.taskExecutionIndex : {};
  runtime.exactOnceIndex = isObject(runtime.exactOnceIndex) ? runtime.exactOnceIndex : {};
  runtime.completedTaskIndex = isObject(runtime.completedTaskIndex) ? runtime.completedTaskIndex : {};
  for (const workerId of runtime.workerOrder) {
    const worker = runtime.workersById[workerId];
    if (worker?.state === WorkerState.COMPLETED && worker.taskId) {
      const previous = runtime.completedTaskIndex[worker.taskId];
      const completedAt = Math.max(0, Number(worker.completedAt || 0));
      if (!previous || completedAt >= Number(previous.completedAt || 0)) {
        runtime.completedTaskIndex[worker.taskId] = {
          workerId,
          executionKey: text(worker.executionKey),
          completedAt,
        };
      }
    }
  }
  runtime.launchHistoryAt = Array.isArray(runtime.launchHistoryAt) ? runtime.launchHistoryAt.map(Number).filter(value => Number.isFinite(value) && value > 0).slice(-10000) : [];
  runtime.lastWorkerLaunchAt = Math.max(0, Number(runtime.lastWorkerLaunchAt || 0));
  runtime.lastRequestedDesiredWorkers = boundedInt(runtime.lastRequestedDesiredWorkers, 0, 1000, runtime.desiredActiveWorkers);
  runtime.pendingCoordinatorEvents = Array.isArray(runtime.pendingCoordinatorEvents) ? runtime.pendingCoordinatorEvents.slice(-MAX_PENDING_EVENTS) : [];
  runtime.consumedCoordinatorEventIds = Array.isArray(runtime.consumedCoordinatorEventIds) ? runtime.consumedCoordinatorEventIds.slice(-MAX_PENDING_EVENTS) : [];
  const maxDurableEventId = Math.max(
    0,
    ...runtime.pendingCoordinatorEvents.map(event => finiteInt(event?.id, 0)),
    ...runtime.consumedCoordinatorEventIds.map(id => finiteInt(id, 0)),
    ...(Array.isArray(runtime.coordinator.lease?.eventIds) ? runtime.coordinator.lease.eventIds.map(id => finiteInt(id, 0)) : []),
  );
  runtime.nextEventId = Math.max(runtime.nextEventId, maxDurableEventId + 1);
  runtime.createdAt = Math.max(0, Number(runtime.createdAt || nowMs));
  runtime.updatedAt = nowMs;
  return runtime;
}

function eventDedupeKey(event) {
  if (event.type === CoordinatorEventType.WATCHDOG_RECONCILE) return 'WATCHDOG_RECONCILE';
  if (event.type === CoordinatorEventType.WORKER_TERMINAL) return `${event.type}:${event.workerId}:${event.workerState}`;
  if (event.type === CoordinatorEventType.WORKER_STALE_CANDIDATE) return `${event.type}:${event.workerId}`;
  return `${event.type}:${event.key || ''}:${event.workerId || ''}`;
}

export function enqueueCoordinatorEvent(runtime, rawEvent, nowMs = Date.now()) {
  if (!isObject(rawEvent) || !EVENT_TYPES.has(rawEvent.type)) throw new Error('Invalid coordinator event');
  const candidate = {
    type: rawEvent.type,
    at: Math.max(0, Number(rawEvent.at || nowMs)),
    workerId: text(rawEvent.workerId),
    taskId: text(rawEvent.taskId),
    workerState: text(rawEvent.workerState),
    key: text(rawEvent.key),
    detail: typeof rawEvent.detail === 'string' ? rawEvent.detail.slice(0, 2000) : '',
  };
  const key = eventDedupeKey(candidate);
  const existing = runtime.pendingCoordinatorEvents.find(item => eventDedupeKey(item) === key);
  if (existing) {
    existing.at = Math.max(existing.at, candidate.at);
    existing.detail = candidate.detail || existing.detail;
    runtime.updatedAt = nowMs;
    return { added: false, event: existing, deduplicated: true };
  }
  if (runtime.pendingCoordinatorEvents.length >= MAX_PENDING_EVENTS) {
    runtime.updatedAt = nowMs;
    return { added: false, event: null, capacityExceeded: true, reason: 'COORDINATOR_EVENT_CAPACITY_EXCEEDED' };
  }
  const event = { id: runtime.nextEventId++, ...candidate };
  runtime.pendingCoordinatorEvents.push(event);
  runtime.updatedAt = nowMs;
  return { added: true, event };
}

export function enqueueWatchdogIfDue(runtime, configRaw, nowMs = Date.now()) {
  const config = validateOrchestrationConfig(configRaw);
  const baseline = runtime.lastWatchdogAt || runtime.lastCoordinatorDecisionAt || runtime.createdAt || nowMs;
  const due = nowMs - baseline >= config.watchdogIntervalSeconds * 1000;
  if (!due) return { due: false, wakeAt: baseline + config.watchdogIntervalSeconds * 1000 };
  runtime.lastWatchdogAt = nowMs;
  const result = enqueueCoordinatorEvent(runtime, { type: CoordinatorEventType.WATCHDOG_RECONCILE, at: nowMs }, nowMs);
  return { due: true, ...result };
}

export function acquireCoordinatorLease(runtime, { nowMs = Date.now(), reason = 'RECONCILE' } = {}) {
  if (runtime.coordinator.lease) return { acquired: false, reason: 'BUSY', lease: runtime.coordinator.lease };
  if (!runtime.pendingCoordinatorEvents.length && reason !== 'INITIALIZE') return { acquired: false, reason: 'NO_EVENTS' };
  if (runtime.coordinator.turnsUsed >= runtime.coordinator.maxTurns || runtime.coordinator.rotationRequested) {
    runtime.coordinator.status = CoordinatorStatus.ROTATION_REQUIRED;
    return { acquired: false, reason: 'ROTATION_REQUIRED' };
  }
  const eventIds = runtime.pendingCoordinatorEvents.slice(0, MAX_COORDINATOR_EVENTS_PER_TURN).map(event => event.id);
  const lease = {
    turnId: `coord:${runtime.projectId}:g${runtime.coordinator.generation}:t${runtime.coordinator.turnsUsed + 1}`,
    generation: runtime.coordinator.generation,
    acquiredAt: nowMs,
    reason,
    eventIds,
  };
  runtime.coordinator.lease = lease;
  runtime.coordinator.status = CoordinatorStatus.BUSY;
  // Assistant baseline belongs to exactly one coordinator turn. Never let a new
  // lease probe the previous turn's already-completed answer before its own
  // prompt has been positively delivered.
  runtime.coordinator.lastAssistantBaselineCount = 0;
  runtime.coordinator.lastAssistantBaselineKnown = false;
  runtime.coordinator.deliveredTurnId = '';
  runtime.coordinator.deliveredAt = 0;
  runtime.coordinator.responseCompleteAt = 0;
  runtime.coordinator.lastAssistantReport = '';
  runtime.lastCoordinatorWakeAt = nowMs;
  runtime.updatedAt = nowMs;
  return { acquired: true, lease: clone(lease) };
}

function completeCoordinatorLease(runtime, revision, nowMs, source = '') {
  const lease = runtime.coordinator.lease;
  if (!lease) throw new Error('Coordinator lease required');
  const consumed = new Set(lease.eventIds || []);
  runtime.pendingCoordinatorEvents = runtime.pendingCoordinatorEvents.filter(event => !consumed.has(event.id));
  runtime.consumedCoordinatorEventIds.push(...[...consumed]);
  if (runtime.consumedCoordinatorEventIds.length > MAX_PENDING_EVENTS) runtime.consumedCoordinatorEventIds.splice(0, runtime.consumedCoordinatorEventIds.length - MAX_PENDING_EVENTS);
  runtime.coordinator.lease = null;
  runtime.coordinator.responseCompleteAt = 0;
  runtime.coordinator.lastAssistantReport = '';
  runtime.coordinator.turnsUsed += 1;
  runtime.coordinator.status = runtime.coordinator.turnsUsed >= runtime.coordinator.maxTurns || runtime.coordinator.rotationRequested
    ? CoordinatorStatus.ROTATION_REQUIRED
    : CoordinatorStatus.IDLE;
  runtime.lastAppliedControlRevision = revision;
  runtime.lastAppliedControlAt = nowMs;
  runtime.lastAppliedControlSource = text(source);
  runtime.lastCoordinatorDecisionAt = nowMs;
  runtime.updatedAt = nowMs;
}

function taskDependenciesSatisfied(runtime, worker) {
  if (!worker.dependencies.length) return true;
  return worker.dependencies.every(dependencyTaskId => Boolean(runtime.completedTaskIndex?.[dependencyTaskId])
    || runtime.workerOrder.some(workerId => {
      const candidate = runtime.workersById[workerId];
      return candidate?.taskId === dependencyTaskId && candidate.state === WorkerState.COMPLETED;
    }));
}

function conflictKeyAvailable(runtime, worker) {
  if (!worker.conflictKey) return true;
  return !runtime.workerOrder.some(workerId => {
    if (workerId === worker.workerId) return false;
    const candidate = runtime.workersById[workerId];
    return candidate?.conflictKey === worker.conflictKey && SLOT_STATES.has(candidate.state);
  });
}

function workerTimeEligible(worker, nowMs) {
  if (worker.notBeforeAt && nowMs < worker.notBeforeAt) return false;
  if (worker.expiresAt && nowMs >= worker.expiresAt) return false;
  return true;
}

function continuationReady(runtime, worker) {
  if (worker.launchMode !== 'CONTINUE_EXISTING_WORKER') return true;
  const prior = runtime.workersById?.[worker.continueWorkerId];
  return Boolean(prior?.chatUrl && [WorkerState.COMPLETED, WorkerState.FAILED].includes(prior.state));
}

export function reservedWorkerSlots(runtime) {
  return runtime.workerOrder.reduce((count, workerId) => count + (SLOT_STATES.has(runtime.workersById[workerId]?.state) ? 1 : 0), 0);
}

export function effectiveDesiredWorkers(runtime, configRaw) {
  const config = validateOrchestrationConfig(configRaw);
  return Math.min(config.absoluteMaxWorkers, Math.max(0, runtime.desiredActiveWorkers));
}

function queueTask(runtime, task, control, config, nowMs) {
  const executionKey = taskExecutionKey(task.task_id, task.generation);
  if (runtime.taskExecutionIndex[executionKey] || runtime.exactOnceIndex[task.exact_once_key]) {
    return { added: false, reason: 'EXACT_ONCE_ALREADY_EXISTS', workerId: runtime.taskExecutionIndex[executionKey] || runtime.exactOnceIndex[task.exact_once_key] };
  }
  const ordinal = runtime.nextWorkerOrdinal++;
  const workerId = `worker:${runtime.projectId}:${ordinal}`;
  const worker = {
    workerId,
    taskId: task.task_id,
    executionKey,
    exactOnceKey: task.exact_once_key,
    state: WorkerState.QUEUED,
    priority: task.priority,
    dependencies: [...task.dependencies],
    conflictKey: task.conflict_key,
    launchMode: task.launch_mode,
    continueWorkerId: task.continue_worker_id,
    prompt: task.prompt,
    promptFingerprint: '',
    targetRepository: task.target_repository,
    agentProviderId: config.workerAgentProviderId,
    coordinatorGeneration: control.coordinator_generation,
    controlRevision: control.revision,
    taskGeneration: task.generation,
    authorizedAt: nowMs,
    notBeforeAt: task.not_before ? Date.parse(task.not_before) : 0,
    expiresAt: Math.min(
      task.expires_at ? Date.parse(task.expires_at) : Number.POSITIVE_INFINITY,
      Date.parse(control.expires_at),
    ),
    sessionId: '',
    sessionTaskId: '',
    chatUrl: '',
    assistantBaselineCount: 0,
    assistantBaselineKnown: false,
    launchedAt: 0,
    sentAt: 0,
    completedAt: 0,
    lastObservedAt: 0,
    lastSuccessfulProbeAt: 0,
    consecutiveProbeFailures: 0,
    lastProbeErrorAt: 0,
    lastStaleCandidateAt: 0,
    retryAfterAt: 0,
    terminalReason: '',
    finalAnswerHint: '',
    supersedeRequestedAt: 0,
    staleSince: 0,
    staleEventAt: 0,
    staleReason: '',
  };
  runtime.workersById[workerId] = worker;
  runtime.workerOrder.push(workerId);
  runtime.taskExecutionIndex[executionKey] = workerId;
  runtime.exactOnceIndex[task.exact_once_key] = workerId;
  if (runtime.workerOrder.length > MAX_WORKER_HISTORY) {
    const removable = runtime.workerOrder.filter(id => TERMINAL_STATES.has(runtime.workersById[id]?.state));
    while (runtime.workerOrder.length > MAX_WORKER_HISTORY && removable.length) {
      const removeId = removable.shift();
      const removedWorker = runtime.workersById[removeId];
      if (removedWorker?.state === WorkerState.COMPLETED && removedWorker.taskId) {
        runtime.completedTaskIndex[removedWorker.taskId] = {
          workerId: removeId,
          executionKey: text(removedWorker.executionKey),
          completedAt: Math.max(0, Number(removedWorker.completedAt || nowMs)),
        };
      }
      runtime.workerOrder = runtime.workerOrder.filter(id => id !== removeId);
      delete runtime.workersById[removeId];
    }
  }
  return { added: true, workerId, worker };
}

export function applyControlDecision(runtime, rawControl, configRaw, nowMs = Date.now(), { consumeCoordinatorLease = true, source = '' } = {}) {
  const config = validateOrchestrationConfig(configRaw);
  const control = validateControlDecision(rawControl, {
    projectId: runtime.projectId,
    coordinatorGeneration: runtime.coordinator.generation,
    nowMs,
  });
  if (consumeCoordinatorLease) {
    if (!runtime.coordinator.lease) throw new Error('Cannot apply control without coordinator lease');
    if (runtime.coordinator.lease.generation !== control.coordinator_generation) throw new Error('Coordinator lease generation mismatch');
  }
  if (control.revision <= runtime.lastAppliedControlRevision) throw new Error('Stale control revision');

  const result = { queued: [], cancelled: [], superseded: [], supersedeRequested: [], concurrencyChanged: false, modeChanged: false, rotateRequested: false, notes: [] };
  runtime.mode = control.mode;

  for (const action of control.actions) {
    if (action.type === ControlActionType.NO_ACTION) continue;
    if (action.type === ControlActionType.SET_DESIRED_CONCURRENCY) {
      runtime.lastRequestedDesiredWorkers = action.value;
      const next = Math.min(config.absoluteMaxWorkers, action.value);
      result.concurrencyChanged ||= next !== runtime.desiredActiveWorkers;
      runtime.desiredActiveWorkers = next;
      continue;
    }
    if (action.type === ControlActionType.ADD_TASKS) {
      for (const rawTask of action.tasks) {
        const task = { ...rawTask, target_repository: rawTask.target_repository || config.targetRepository };
        if (task.target_repository !== config.targetRepository) throw new Error(`Task ${task.task_id} targets a different repository`);
        if (task.not_before && Date.parse(task.not_before) >= Date.parse(control.expires_at)) throw new Error(`Task ${task.task_id} starts after control expiry`);
        if (task.launch_mode === 'CONTINUE_EXISTING_WORKER') {
          const prior = runtime.workersById[task.continue_worker_id];
          if (!prior) throw new Error(`Task ${task.task_id} references unknown worker ${task.continue_worker_id}`);
          if (!prior.chatUrl) throw new Error(`Task ${task.task_id} cannot continue a worker without a durable chat URL`);
        }
        const added = queueTask(runtime, task, control, config, nowMs);
        if (added.added) result.queued.push(added.workerId);
      }
      continue;
    }
    if (action.type === ControlActionType.CANCEL_QUEUED_TASKS) {
      for (const taskId of action.task_ids) {
        for (const workerId of runtime.workerOrder) {
          const worker = runtime.workersById[workerId];
          if (worker?.taskId === taskId && worker.state === WorkerState.QUEUED) {
            worker.state = WorkerState.CANCELLED;
            worker.completedAt = nowMs;
            worker.terminalReason = `Cancelled by control revision ${control.revision}`;
            result.cancelled.push(workerId);
          }
        }
      }
      continue;
    }
    if (action.type === ControlActionType.SUPERSEDE_TASKS) {
      for (const taskId of action.task_ids) {
        for (const workerId of runtime.workerOrder) {
          const worker = runtime.workersById[workerId];
          if (!worker || worker.taskId !== taskId || TERMINAL_STATES.has(worker.state)) continue;
          const explicitStaleCandidate = Number(worker.lastStaleCandidateAt || 0) > 0 && Number(worker.consecutiveProbeFailures || 0) >= 2;
          if (worker.state === WorkerState.QUEUED || worker.state === WorkerState.STALE || explicitStaleCandidate) {
            worker.state = WorkerState.SUPERSEDED;
            worker.completedAt = nowMs;
            worker.terminalReason = `Superseded by control revision ${control.revision}`;
            result.superseded.push(workerId);
          } else {
            // Healthy/in-flight workers are not freed merely because a newer
            // control wants them superseded. The request is remembered and
            // can become actionable only after a safe stale/terminal boundary.
            worker.supersedeRequestedAt = nowMs;
            result.supersedeRequested.push(workerId);
          }
        }
      }
      continue;
    }
    if (action.type === ControlActionType.PAUSE) {
      result.modeChanged ||= runtime.mode !== OrchestrationMode.PAUSE;
      runtime.mode = OrchestrationMode.PAUSE;
      continue;
    }
    if (action.type === ControlActionType.RESUME) {
      result.modeChanged ||= runtime.mode !== OrchestrationMode.RUN;
      runtime.mode = OrchestrationMode.RUN;
      continue;
    }
    if (action.type === ControlActionType.ROTATE_COORDINATOR) {
      runtime.coordinator.rotationRequested = true;
      result.rotateRequested = true;
      continue;
    }
    if (action.type === ControlActionType.CONTROL_NOTE) {
      runtime.lastControlNote = action.note;
      result.notes.push(action.note);
    }
  }

  if (consumeCoordinatorLease) {
    completeCoordinatorLease(runtime, control.revision, nowMs, source);
  } else {
    runtime.lastAppliedControlRevision = control.revision;
    runtime.lastAppliedControlAt = nowMs;
    runtime.lastAppliedControlSource = text(source);
    runtime.lastCoordinatorDecisionAt = nowMs;
    runtime.updatedAt = nowMs;
  }
  return { control, result };
}

export function projectBackpressureUntil(runtime, nowMs = Date.now()) {
  let until = Number(runtime.coordinator?.retryAfterAt || 0) > nowMs ? Number(runtime.coordinator.retryAfterAt) : 0;
  for (const workerId of runtime.workerOrder || []) {
    const worker = runtime.workersById?.[workerId];
    if (worker?.state !== WorkerState.RATE_LIMITED) continue;
    const retryAfterAt = Number(worker.retryAfterAt || 0);
    if (retryAfterAt > nowMs) until = Math.max(until, retryAfterAt);
  }
  return until;
}

export function releaseExpiredWorkerBackpressure(runtime, nowMs = Date.now()) {
  const releasedWorkers = [];
  if (Number(runtime.coordinator?.retryAfterAt || 0) > 0 && Number(runtime.coordinator.retryAfterAt) <= nowMs) {
    runtime.coordinator.retryAfterAt = 0;
  }
  for (const workerId of runtime.workerOrder || []) {
    const worker = runtime.workersById?.[workerId];
    if (worker?.state !== WorkerState.RATE_LIMITED) continue;
    const retryAfterAt = Number(worker.retryAfterAt || 0);
    if (retryAfterAt > 0 && retryAfterAt <= nowMs) {
      worker.state = WorkerState.ACTIVE;
      worker.retryAfterAt = 0;
      worker.lastObservedAt = nowMs;
      releasedWorkers.push(workerId);
    }
  }
  if (releasedWorkers.length) runtime.updatedAt = nowMs;
  return { releasedWorkers, backpressureUntil: projectBackpressureUntil(runtime, nowMs) };
}

export function workerLaunchPolicy(runtime, configRaw, nowMs = Date.now()) {
  const config = validateOrchestrationConfig(configRaw);
  const windowMs = config.launchWindowSeconds * 1000;
  const cutoff = nowMs - windowMs;
  const history = (Array.isArray(runtime.launchHistoryAt) ? runtime.launchHistoryAt : [])
    .map(Number)
    .filter(value => Number.isFinite(value) && value > cutoff)
    .sort((a, b) => a - b);
  const windowRemaining = config.maxLaunchesPerWindow > 0
    ? Math.max(0, config.maxLaunchesPerWindow - history.length)
    : Number.POSITIVE_INFINITY;
  const intervalReadyAt = config.minimumWorkerLaunchIntervalMs > 0 && runtime.lastWorkerLaunchAt > 0
    ? runtime.lastWorkerLaunchAt + config.minimumWorkerLaunchIntervalMs
    : 0;
  const intervalRemaining = intervalReadyAt > nowMs
    ? 0
    : (config.minimumWorkerLaunchIntervalMs > 0 ? 1 : Number.POSITIVE_INFINITY);
  let nextWindowAt = 0;
  if (config.maxLaunchesPerWindow > 0 && windowRemaining <= 0 && history.length) {
    nextWindowAt = history[0] + windowMs;
  }
  const nextAllowedLaunchAt = Math.max(intervalReadyAt > nowMs ? intervalReadyAt : 0, nextWindowAt > nowMs ? nextWindowAt : 0);
  return {
    maxLaunchesPerWindow: config.maxLaunchesPerWindow,
    launchWindowSeconds: config.launchWindowSeconds,
    minimumWorkerLaunchIntervalMs: config.minimumWorkerLaunchIntervalMs,
    launchesInWindow: history.length,
    remainingNow: Math.min(windowRemaining, intervalRemaining),
    nextAllowedLaunchAt,
  };
}

export function nextWorkerLaunchAt(runtime, configRaw, nowMs = Date.now()) {
  const config = validateOrchestrationConfig(configRaw);
  if (!config.enabled || runtime.mode !== OrchestrationMode.RUN || projectBackpressureUntil(runtime, nowMs) > nowMs) return 0;
  if (effectiveDesiredWorkers(runtime, config) <= reservedWorkerSlots(runtime)) return 0;
  const queued = runtime.workerOrder
    .map(workerId => runtime.workersById[workerId])
    .filter(worker => worker?.state === WorkerState.QUEUED)
    .filter(worker => taskDependenciesSatisfied(runtime, worker))
    .filter(worker => conflictKeyAvailable(runtime, worker))
    .filter(worker => continuationReady(runtime, worker))
    .filter(worker => !worker.expiresAt || nowMs < worker.expiresAt);
  if (!queued.length) return 0;
  const immediateEligible = queued.some(worker => workerTimeEligible(worker, nowMs));
  const futureTaskAt = queued
    .map(worker => Number(worker.notBeforeAt || 0))
    .filter(value => value > nowMs)
    .sort((a, b) => a - b)[0] || 0;
  const policy = workerLaunchPolicy(runtime, config, nowMs);
  if (immediateEligible && policy.remainingNow > 0) return nowMs;
  if (immediateEligible) return policy.nextAllowedLaunchAt > nowMs ? policy.nextAllowedLaunchAt : 0;
  if (!futureTaskAt) return 0;
  return Math.max(futureTaskAt, policy.nextAllowedLaunchAt > nowMs ? policy.nextAllowedLaunchAt : 0);
}

export function selectWorkersForLaunch(runtime, configRaw, nowMs = Date.now()) {
  const config = validateOrchestrationConfig(configRaw);
  if (!config.enabled || runtime.mode !== OrchestrationMode.RUN || projectBackpressureUntil(runtime, nowMs) > nowMs) return [];
  const concurrencyCapacity = Math.max(0, effectiveDesiredWorkers(runtime, config) - reservedWorkerSlots(runtime));
  if (!concurrencyCapacity) return [];
  const launchPolicy = workerLaunchPolicy(runtime, config, nowMs);
  const launchCapacity = Number.isFinite(launchPolicy.remainingNow) ? launchPolicy.remainingNow : concurrencyCapacity;
  const capacity = Math.max(0, Math.min(concurrencyCapacity, launchCapacity));
  if (!capacity) return [];
  const candidates = runtime.workerOrder
    .map(workerId => runtime.workersById[workerId])
    .filter(worker => worker?.state === WorkerState.QUEUED)
    .filter(worker => workerTimeEligible(worker, nowMs))
    .filter(worker => taskDependenciesSatisfied(runtime, worker))
    .filter(worker => conflictKeyAvailable(runtime, worker))
    .filter(worker => continuationReady(runtime, worker))
    .sort((a, b) => b.priority - a.priority || a.authorizedAt - b.authorizedAt || a.workerId.localeCompare(b.workerId));

  // Reserve exclusive conflict keys inside the same launch batch too. Looking
  // only at already-active workers is insufficient: two queued workers with the
  // same key could otherwise be selected atomically and start together.
  const selected = [];
  const selectedConflictKeys = new Set();
  for (const worker of candidates) {
    if (selected.length >= capacity) break;
    if (worker.conflictKey && selectedConflictKeys.has(worker.conflictKey)) continue;
    selected.push(worker.workerId);
    if (worker.conflictKey) selectedConflictKeys.add(worker.conflictKey);
  }
  return selected;
}

export function expireQueuedWorkerAuthorizations(runtime, nowMs = Date.now()) {
  const expired = [];
  for (const workerId of runtime.workerOrder || []) {
    const worker = runtime.workersById?.[workerId];
    if (!worker || worker.state !== WorkerState.QUEUED) continue;
    const expiresAt = Number(worker.expiresAt || 0);
    if (!expiresAt || nowMs < expiresAt) continue;
    markWorkerTerminal(runtime, workerId, WorkerState.CANCELLED, {
      nowMs,
      reason: 'Launch authorization expired before worker materialization.',
    });
    expired.push(workerId);
  }
  return { expired };
}

export function materializeWorkersIntoCore(coreState, runtime, configRaw, nowMs = Date.now()) {
  const config = validateOrchestrationConfig(configRaw);
  if (coreState?.profile?.masterPaused) return { state: coreState, launched: [] };
  const workerIds = selectWorkersForLaunch(runtime, config, nowMs);
  const launched = [];
  for (const workerId of workerIds) {
    const worker = runtime.workersById[workerId];
    if (!worker || worker.state !== WorkerState.QUEUED) continue;
    if (!continuationReady(runtime, worker)) continue;
    const ordinal = Number(worker.workerId.split(':').at(-1)) || runtime.nextWorkerOrdinal;
    const sid = workerSessionId(runtime.projectId, ordinal);
    const tid = workerTaskId(runtime.projectId, ordinal);
    const url = worker.launchMode === 'CONTINUE_EXISTING_WORKER'
      ? runtime.workersById[worker.continueWorkerId].chatUrl
      : 'https://chatgpt.com/';
    if (coreState.sessionsById[sid]) {
      worker.sessionId = sid;
      worker.sessionTaskId = tid;
      worker.state = coreState.sessionsById[sid].runState === RunState.RUNNING ? WorkerState.LAUNCHING : worker.state;
      continue;
    }
    const task = createTask({ id: tid, url, promptOverride: worker.prompt, enabled: true, label: `Worker ${worker.taskId}` });
    const session = createSession({
      id: sid,
      name: `Agent worker: ${worker.taskId}`,
      tasks: [task],
      promptMode: PromptMode.UNIQUE,
      sharedPrompt: '',
      runMode: RunMode.ONE_PASS,
      minimumSendIntervalMs: 0,
      preSendDelayMs: config.workerPreSendDelayMs,
      busyCheckDelayMs: config.workerBusyCheckDelayMs,
      retryBackoffMs: config.workerRetryBackoffMs,
      tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
      now: nowMs,
    });
    session.runState = RunState.RUNNING;
    session.orchestrationWorker = {
      managed: true,
      projectId: runtime.projectId,
      workerId,
      taskId: worker.taskId,
      controlRevision: worker.controlRevision,
      coordinatorGeneration: worker.coordinatorGeneration,
      exactOnceKey: worker.exactOnceKey,
      launchMode: worker.launchMode,
      continueWorkerId: worker.continueWorkerId || '',
      agentProviderId: worker.agentProviderId || config.workerAgentProviderId,
    };
    coreState.sessionsById[sid] = session;
    if (!coreState.sessionOrder.includes(sid)) coreState.sessionOrder.push(sid);
    worker.sessionId = sid;
    worker.sessionTaskId = tid;
    worker.state = WorkerState.LAUNCHING;
    worker.launchedAt = nowMs;
    worker.lastObservedAt = nowMs;
    launched.push(workerId);
    runtime.launchHistoryAt.push(nowMs);
    runtime.lastWorkerLaunchAt = nowMs;
  }
  runtime.updatedAt = nowMs;
  return { state: coreState, launched };
}

export function syncWorkerDeliveryFromCore(runtime, coreState, nowMs = Date.now()) {
  const activated = [];
  const deliveryFailures = [];
  for (const workerId of runtime.workerOrder) {
    const worker = runtime.workersById[workerId];
    if (!worker?.sessionId || !worker.sessionTaskId || ![WorkerState.LAUNCHING, WorkerState.ACTIVE, WorkerState.BUSY, WorkerState.RATE_LIMITED, WorkerState.MANUAL_REVIEW].includes(worker.state)) continue;
    const session = coreState.sessionsById?.[worker.sessionId];
    const task = session?.tasksById?.[worker.sessionTaskId];
    if (!session || !task) continue;
    if (task.lastVerifiedSendAt > 0 && task.lastConversationUrl) {
      const firstActivation = !worker.sentAt;
      worker.state = WorkerState.ACTIVE;
      worker.sentAt ||= task.lastVerifiedSendAt;
      worker.lastObservedAt = Math.max(worker.lastObservedAt || 0, task.lastVerifiedSendAt);
      worker.chatUrl = task.lastConversationUrl;
      worker.promptFingerprint = task.lastVerifiedFingerprint || worker.promptFingerprint;
      worker.assistantBaselineCount = Math.max(0, Number(task.lastAssistantBaselineCount || 0));
      worker.assistantBaselineKnown = task.lastAssistantBaselineKnown === true;
      if (firstActivation) {
        worker.lastSuccessfulProbeAt = nowMs;
        worker.consecutiveProbeFailures = 0;
        worker.lastProbeErrorAt = 0;
        activated.push(workerId);
      }
      continue;
    }
    if (task.status === 'RATE_LIMITED') {
      worker.state = WorkerState.RATE_LIMITED;
      worker.retryAfterAt = Math.max(worker.retryAfterAt || 0, Number(task.retryAfterAt || 0), nowMs + MIN_RATE_LIMIT_BACKOFF_MS);
      worker.consecutiveProbeFailures = 0;
      continue;
    }
    if (task.status === 'MANUAL_REVIEW') {
      markWorkerTerminal(runtime, workerId, WorkerState.MANUAL_REVIEW, {
        nowMs,
        reason: task.manualReviewReason || session.lastError || 'Manual review required',
      });
      continue;
    }
    if (session.runState === RunState.ERROR) {
      worker.state = WorkerState.FAILED;
      worker.lastObservedAt = nowMs;
      worker.completedAt = nowMs;
      worker.terminalReason = session.lastError || 'Worker delivery session failed';
      deliveryFailures.push(workerId);
      enqueueCoordinatorEvent(runtime, { type: CoordinatorEventType.WORKER_TERMINAL, workerId, taskId: worker.taskId, workerState: worker.state, detail: worker.terminalReason }, nowMs);
    }
  }
  runtime.updatedAt = nowMs;
  return { activated, deliveryFailures };
}

export function reconcileStaleWorkers(runtime, configRaw, nowMs = Date.now()) {
  return { stale: enqueueStaleWorkerCandidates(runtime, configRaw, nowMs).added };
}

export function markWorkerBusy(runtime, workerId, nowMs = Date.now()) {
  const worker = runtime.workersById[workerId];
  if (!worker || ![WorkerState.ACTIVE, WorkerState.BUSY].includes(worker.state)) return false;
  worker.state = WorkerState.BUSY;
  worker.lastObservedAt = nowMs;
  runtime.updatedAt = nowMs;
  return true;
}

export function markWorkerTerminal(runtime, workerId, state, { nowMs = Date.now(), reason = '', finalAnswerHint = '' } = {}) {
  if (!TERMINAL_STATES.has(state) && ![WorkerState.BLOCKED, WorkerState.STALE, WorkerState.MANUAL_REVIEW].includes(state)) {
    throw new Error('Invalid worker terminal state');
  }
  const worker = runtime.workersById[workerId];
  if (!worker) throw new Error('Worker not found');
  if (TERMINAL_STATES.has(worker.state) && worker.state === state) return { changed: false, eventAdded: false };
  worker.state = state;
  worker.completedAt = TERMINAL_STATES.has(state) ? nowMs : worker.completedAt;
  worker.lastObservedAt = nowMs;
  worker.terminalReason = String(reason || '').slice(0, 2000);
  worker.finalAnswerHint = String(finalAnswerHint || '').slice(0, 12000);
  if (state === WorkerState.COMPLETED && worker.taskId) {
    runtime.completedTaskIndex ||= {};
    runtime.completedTaskIndex[worker.taskId] = {
      workerId,
      executionKey: text(worker.executionKey),
      completedAt: worker.completedAt,
    };
  }
  const event = enqueueCoordinatorEvent(runtime, {
    type: CoordinatorEventType.WORKER_TERMINAL,
    workerId,
    taskId: worker.taskId,
    workerState: state,
    detail: worker.terminalReason,
  }, nowMs);
  return { changed: true, eventAdded: event.added };
}

export function workerCompletionProbe(worker, nowMs = Date.now()) {
  if (!worker?.chatUrl || !worker.assistantBaselineKnown) return null;
  const probeable = [WorkerState.ACTIVE, WorkerState.BUSY, WorkerState.STALE].includes(worker.state)
    || (worker.state === WorkerState.RATE_LIMITED && Number(worker.retryAfterAt || 0) <= nowMs);
  if (!probeable) return null;
  return {
    workerId: worker.workerId,
    conversationUrl: worker.chatUrl,
    taskId: worker.taskId,
    assistantBaselineCount: worker.assistantBaselineCount,
    assistantBaselineKnown: true,
  };
}

export function applyWorkerCompletionProbe(runtime, workerId, probeResult, nowMs = Date.now()) {
  const worker = runtime.workersById[workerId];
  if (!worker || ![WorkerState.ACTIVE, WorkerState.BUSY, WorkerState.STALE, WorkerState.RATE_LIMITED].includes(worker.state)) return { changed: false };
  worker.lastObservedAt = nowMs;
  const status = text(probeResult?.status).toUpperCase();
  if (status === 'BUSY') {
    worker.state = WorkerState.BUSY;
    worker.lastSuccessfulProbeAt = nowMs;
    worker.consecutiveProbeFailures = 0;
    worker.lastProbeErrorAt = 0;
    return { changed: true, terminal: false };
  }
  if (status === 'RATE_LIMITED') {
    worker.state = WorkerState.RATE_LIMITED;
    worker.retryAfterAt = Math.max(worker.retryAfterAt || 0, Number(probeResult?.retryAfterAt || 0), nowMs + MIN_RATE_LIMIT_BACKOFF_MS);
    worker.consecutiveProbeFailures = 0;
    worker.lastProbeErrorAt = 0;
    return { changed: true, terminal: false, rateLimited: true };
  }
  if (status === 'READY' && probeResult?.assistantComplete === true && text(probeResult?.assistantText)) {
    worker.lastSuccessfulProbeAt = nowMs;
    worker.consecutiveProbeFailures = 0;
    worker.lastProbeErrorAt = 0;
    const terminal = markWorkerTerminal(runtime, workerId, WorkerState.COMPLETED, {
      nowMs,
      reason: 'Assistant response completed; coordinator must verify project truth in GitHub.',
      finalAnswerHint: probeResult.assistantText,
    });
    return { changed: true, terminal: true, ...terminal };
  }
  if (['AUTH_REQUIRED', 'UNKNOWN_UI', 'MANUAL_REVIEW_REQUIRED'].includes(status)) {
    const terminal = markWorkerTerminal(runtime, workerId, WorkerState.MANUAL_REVIEW, {
      nowMs,
      reason: text(probeResult?.safeDiagnosticCode || status),
    });
    return { changed: true, terminal: true, ...terminal };
  }
  if (status === 'READY') {
    worker.state = WorkerState.ACTIVE;
    worker.lastSuccessfulProbeAt = nowMs;
    worker.consecutiveProbeFailures = 0;
    worker.lastProbeErrorAt = 0;
    return { changed: true, terminal: false };
  }

  // Observation failure is not worker failure. Preserve its reserved slot and
  // let the coordinator verify live GitHub before any replacement is allowed.
  worker.state = worker.state === WorkerState.BUSY ? WorkerState.BUSY : WorkerState.ACTIVE;
  worker.consecutiveProbeFailures = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, finiteInt(worker.consecutiveProbeFailures, 0)) + 1);
  worker.lastProbeErrorAt = nowMs;
  return { changed: true, terminal: false, observationFailed: true };
}

export function enqueueStaleWorkerCandidates(runtime, configRaw, nowMs = Date.now()) {
  const config = validateOrchestrationConfig(configRaw);
  const staleAfterMs = config.staleWorkerAfterSeconds * 1000;
  const repeatAfterMs = Math.max(60_000, config.watchdogIntervalSeconds * 1000);
  const added = [];
  for (const workerId of runtime.workerOrder || []) {
    const worker = runtime.workersById?.[workerId];
    if (!worker || ![WorkerState.ACTIVE, WorkerState.BUSY].includes(worker.state)) continue;
    if (Math.max(0, finiteInt(worker.consecutiveProbeFailures, 0)) < 2) continue;
    const lastSuccessfulProbeAt = Number(worker.lastSuccessfulProbeAt || worker.sentAt || 0);
    if (!lastSuccessfulProbeAt || nowMs - lastSuccessfulProbeAt < staleAfterMs) continue;
    const lastCandidateAt = Number(worker.lastStaleCandidateAt || 0);
    if (lastCandidateAt && nowMs - lastCandidateAt < repeatAfterMs) continue;
    const event = enqueueCoordinatorEvent(runtime, {
      type: CoordinatorEventType.WORKER_STALE_CANDIDATE,
      workerId,
      taskId: worker.taskId,
      workerState: worker.state,
      at: nowMs,
      detail: `Worker completion probe failed ${worker.consecutiveProbeFailures} consecutive times after the stale threshold. Verify live GitHub before deciding whether work is stale or needs a successor.`,
    }, nowMs);
    worker.lastStaleCandidateAt = nowMs;
    if (event.added) added.push(workerId);
  }
  return { added };
}

export function coordinatorNeedsRotation(runtime) {
  return runtime.coordinator.rotationRequested === true || runtime.coordinator.turnsUsed >= runtime.coordinator.maxTurns || runtime.coordinator.status === CoordinatorStatus.ROTATION_REQUIRED;
}

export function rotateCoordinator(runtime, nowMs = Date.now()) {
  if (runtime.coordinator.lease) throw new Error('Cannot rotate coordinator while turn is in flight');
  runtime.coordinator.generation += 1;
  runtime.coordinator.status = CoordinatorStatus.IDLE;
  runtime.coordinator.chatUrl = '';
  runtime.coordinator.turnsUsed = 0;
  runtime.coordinator.rotationRequested = false;
  runtime.coordinator.lastError = '';
  runtime.coordinator.retryAfterAt = 0;
  runtime.coordinator.lastAssistantBaselineCount = 0;
  runtime.coordinator.lastAssistantBaselineKnown = false;
  runtime.coordinator.deliveredTurnId = '';
  runtime.coordinator.deliveredAt = 0;
  runtime.coordinator.responseCompleteAt = 0;
  runtime.coordinator.lastAssistantReport = '';
  runtime.updatedAt = nowMs;
  enqueueCoordinatorEvent(runtime, { type: CoordinatorEventType.RECOVERY_RECONCILE, key: `coordinator-rotation-g${runtime.coordinator.generation}`, at: nowMs, detail: 'Fresh coordinator generation requires live GitHub reread.' }, nowMs);
  return runtime.coordinator.generation;
}

export function coordinatorControlContract(configRaw) {
  const config = validateOrchestrationConfig(configRaw);
  const controlLocation = `https://github.com/${config.controlRepository}/issues/${config.controlIssueNumber}`;
  const commentInstruction = config.controlCommentId
    ? `Update canonical issue comment id ${config.controlCommentId}; do not create a new comment for each tick.`
    : 'Use one stable canonical issue comment. If it does not exist yet, create it once, then update that same comment on future turns.';
  return `AUTOPILOT ORCHESTRATION CONTROL V2 CONTRACT\nGitHub control issue: ${controlLocation}\n${commentInstruction}\nEvery coordinator turn, including NO_ACTION, return a strictly machine-readable current control decision with a monotonically increasing revision. Direct Chat is the PRIMARY low-latency control channel; GitHub is the durable mirror/fallback.\nAUTOPILOT ACK RULE: the machine handoff field last_control_revision is the only authority for what Autopilot has actually applied. Never assume a GitHub control revision/task was dispatched merely because it exists in GitHub or because an earlier coordinator mentioned it. If live GitHub contains an ADD_TASKS decision whose revision is greater than last_control_revision, re-emit the still-required task(s) in the next revision with the SAME task_id and SAME exact_once_key; Autopilot will deduplicate safely. Only after last_control_revision reaches/passes that decision may you treat it as applied.\nYour ChatGPT response MUST END with exactly one direct control block: the line ${ORCHESTRATION_CONTROL_MARKER} immediately followed by exactly one fenced JSON object, with no non-whitespace text after the closing fence. Mirror the same decision to the canonical GitHub control comment when available. The GitHub mirror comment MUST begin exactly with ${ORCHESTRATION_CONTROL_MARKER} and contain exactly one fenced JSON object.\nRequired top-level fields: schema_version=2, project_id=${config.projectId}, revision, coordinator_generation, generated_at, expires_at, mode, actions.\nAllowed action types only: NO_ACTION, SET_DESIRED_CONCURRENCY, ADD_TASKS, CANCEL_QUEUED_TASKS, SUPERSEDE_TASKS, PAUSE, RESUME, ROTATE_COORDINATOR, CONTROL_NOTE.\nNO_ACTION must be the only action when used.\nADD_TASKS task fields: task_id, prompt, priority, dependencies[], conflict_key, generation, launch_mode(FRESH_CHAT by default), optional continue_worker_id, exact_once_key, not_before, expires_at, target_repository.\nNever put credentials, cookies, private browser/profile data, secret tokens or arbitrary executable code into control.\nCoordinator may propose a large backlog; Autopilot independently enforces the owner's local concurrency and launch-rate limits. Never assume requested concurrency equals executable capacity.
Never create tasks merely because a periodic watchdog tick occurred. Live GitHub project state is authoritative.`;
}

export function buildCoordinatorTickPrompt(runtime, configRaw, { initial = false, nowMs = Date.now() } = {}) {
  const config = validateOrchestrationConfig(configRaw);
  if (initial || !runtime.coordinator.chatUrl) {
    const handoff = {
      project_id: runtime.projectId,
      target_repository: config.targetRepository,
      agent_providers: { coordinator: config.coordinatorAgentProviderId, worker: config.workerAgentProviderId },
      control_location: { repository: config.controlRepository, issue: config.controlIssueNumber, comment_id: config.controlCommentId || null },
      coordinator_generation: runtime.coordinator.generation,
      last_control_revision: runtime.lastAppliedControlRevision,
      requested_active_workers: runtime.lastRequestedDesiredWorkers,
      desired_active_workers: runtime.desiredActiveWorkers,
      absolute_max_workers: config.absoluteMaxWorkers,
      active_worker_ids: runtime.workerOrder.filter(id => SLOT_STATES.has(runtime.workersById[id]?.state)),
      stale_worker_ids: runtime.workerOrder.filter(id => runtime.workersById[id]?.state === WorkerState.STALE),
      rate_limited_worker_ids: runtime.workerOrder.filter(id => runtime.workersById[id]?.state === WorkerState.RATE_LIMITED),
      pending_events: runtime.coordinator.lease
        ? runtime.pendingCoordinatorEvents.filter(event => runtime.coordinator.lease.eventIds?.includes(event.id))
        : runtime.pendingCoordinatorEvents.slice(0, MAX_COORDINATOR_EVENTS_PER_TURN),
      policy: { watchdog_interval_seconds: config.watchdogIntervalSeconds, max_coordinator_turns: config.maxCoordinatorTurns, max_active_workers: config.absoluteMaxWorkers, max_launches_per_window: config.maxLaunchesPerWindow, launch_window_seconds: config.launchWindowSeconds, minimum_worker_launch_interval_seconds: config.minimumWorkerLaunchIntervalMs / 1000 },
    };
    return `${config.masterCoordinatorPrompt}\n\n${coordinatorControlContract(config)}\n\nAUTOPILOT_MACHINE_HANDOFF_V2\n\`\`\`json\n${JSON.stringify(handoff, null, 2)}\n\`\`\`\n\nMandatory: reread live GitHub before deciding. End this ChatGPT response with the strict V2 direct control block required above; mirror the same revision to the canonical GitHub control location. Treat handoff last_control_revision as Autopilot's durable ACK: any required task from a newer/unacknowledged GitHub revision must be reasserted idempotently with the SAME task_id/exact_once_key instead of replaced by NO_ACTION. Do not create work merely because this coordinator chat was opened.`;
  }
  const lease = runtime.coordinator.lease;
  const leasedEvents = new Set(lease?.eventIds || []);
  const events = runtime.pendingCoordinatorEvents.filter(event => leasedEvents.has(event.id));
  const completionDriven = events.some(event => event.type === CoordinatorEventType.WORKER_TERMINAL);
  const staleCandidates = events.some(event => event.type === CoordinatorEventType.WORKER_STALE_CANDIDATE);
  const watchdogOnly = events.length > 0 && events.every(event => event.type === CoordinatorEventType.WATCHDOG_RECONCILE);
  const instruction = completionDriven
    ? `Worker terminal event(s) occurred.${staleCandidates ? ' Some workers are also stale candidates because browser probes failed; verify those workers in live GitHub and do not assume they are dead.' : ''} Refresh live GitHub, verify actual project results, keep healthy active workers, and return only justified control changes for genuinely free capacity or blockers.`
    : staleCandidates
      ? 'Worker stale-candidate event(s) occurred because browser completion probes repeatedly failed past the stale threshold. Refresh live GitHub and verify real project movement/ownership before deciding. Do not assume stale solely from probe failure and do not create a duplicate successor unless live evidence justifies it.'
      : watchdogOnly
        ? 'Periodic reconciliation only. Refresh live GitHub if needed. If current work remains healthy and concurrency is appropriate, publish NO_ACTION/KEEP_RUNNING. Do not create tasks merely because this tick occurred.'
        : 'Reconcile the supplied events against live GitHub and publish only justified control changes.';
  const payload = {
    coordinator_generation: runtime.coordinator.generation,
    turn_id: lease?.turnId || '',
    last_control_revision: runtime.lastAppliedControlRevision,
    requested_active_workers: runtime.lastRequestedDesiredWorkers,
    desired_active_workers: runtime.desiredActiveWorkers,
    agent_providers: { coordinator: config.coordinatorAgentProviderId, worker: config.workerAgentProviderId },
    local_launch_limits: { max_active_workers: config.absoluteMaxWorkers, max_launches_per_window: config.maxLaunchesPerWindow, launch_window_seconds: config.launchWindowSeconds, minimum_worker_launch_interval_seconds: config.minimumWorkerLaunchIntervalMs / 1000 },
    effective_active_slots: reservedWorkerSlots(runtime),
    stale_worker_ids: runtime.workerOrder.filter(id => runtime.workersById[id]?.state === WorkerState.STALE),
    rate_limited_worker_ids: runtime.workerOrder.filter(id => runtime.workersById[id]?.state === WorkerState.RATE_LIMITED),
    agent_provider_retry_after: runtime.agentProvider?.retryAfterAt || 0,
    pending_events: events,
    at: new Date(lease?.acquiredAt || nowMs).toISOString(),
  };
  return `${config.coordinatorTickPrompt}\n\n${coordinatorControlContract(config)}\n\nCOORDINATOR_TICK_V2\n${instruction}\nMandatory: live GitHub is authoritative for project state. End this ChatGPT response with the strict V2 direct control block required above; GitHub is mirror/fallback for the control transport.\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

export function ensureCoordinatorSession(coreState, runtime, configRaw, prompt, nowMs = Date.now()) {
  const config = validateOrchestrationConfig(configRaw);
  const sid = coordinatorSessionId(runtime.projectId);
  const tid = coordinatorTaskId(runtime.projectId);
  const targetUrl = runtime.coordinator.chatUrl || config.coordinatorLaunchUrl;
  let session = coreState.sessionsById[sid];
  const turnId = runtime.coordinator.lease?.turnId || '';
  if (turnId && runtime.coordinator.deliveredTurnId === turnId) {
    return { state: coreState, sessionId: sid, taskId: tid, alreadyDelivered: true };
  }
  if (!session) {
    const task = createTask({ id: tid, url: targetUrl, promptOverride: prompt, enabled: true, label: 'Orchestration coordinator' });
    session = createSession({
      id: sid,
      name: `Coordinator: ${runtime.projectId}`,
      tasks: [task],
      promptMode: PromptMode.UNIQUE,
      runMode: RunMode.ONE_PASS,
      minimumSendIntervalMs: 0,
      preSendDelayMs: config.coordinatorPreSendDelayMs,
      busyCheckDelayMs: 2000,
      retryBackoffMs: config.coordinatorRetryBackoffMs,
      tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
      now: nowMs,
    });
    session.orchestrationCoordinator = { managed: true, projectId: runtime.projectId, generation: runtime.coordinator.generation, agentProviderId: config.coordinatorAgentProviderId };
    coreState.sessionsById[sid] = session;
    if (!coreState.sessionOrder.includes(sid)) coreState.sessionOrder.push(sid);
  }
  if (session.operation && !['SENT_VERIFIED', 'FAILED_SAFE'].includes(session.operation.phase)) throw new Error('Coordinator Session has unresolved operation');
  // A terminal Core operation belongs to the coordinator turn that just ended.
  // Re-arming the durable one-pass Session for a new turn may rebind the Task
  // from the fresh launch surface to the concrete conversation URL. Keeping the
  // old terminal operation across that rebind violates Core's exact targetUrl
  // binding invariant and can make StorageRepository fail the entire mixed
  // runtime save. Terminal evidence has already been projected onto the Task
  // (lastVerifiedSendAt / lastConversationUrl / assistant baseline), so clear
  // only the terminal operation checkpoint before changing turn identity.
  if (session.operation && ['SENT_VERIFIED', 'FAILED_SAFE'].includes(session.operation.phase)) session.operation = null;
  const task = session.tasksById[tid];
  const normalizedTargetUrl = normalizeChatUrl(targetUrl);
  const targetChanged = task.normalizedUrl !== normalizedTargetUrl;
  const previousTurnId = session.orchestrationCoordinator?.turnId || '';
  const newTurn = Boolean(turnId && previousTurnId !== turnId);
  task.url = normalizedTargetUrl;
  task.normalizedUrl = normalizedTargetUrl;
  task.promptOverride = prompt;
  if (targetChanged || newTurn) {
    task.status = 'IDLE';
    task.lastCheckedAt = 0;
    task.lastVerifiedSendAt = 0;
    task.lastVerifiedFingerprint = '';
    // Preserve the configured coordinator target URL, but clear evidence that
    // belongs to the previous turn so Core cannot treat it as this turn's Send.
    task.lastConversationUrl = '';
    task.lastAssistantReport = '';
    task.lastAssistantReportAt = 0;
    task.lastAssistantBaselineCount = 0;
    task.lastAssistantBaselineKnown = false;
  }
  task.enabled = true;
  task.retryAfterAt = 0;
  task.manualReviewReason = '';
  session.runState = coreState.profile?.masterPaused
    ? RunState.PAUSED
    : session.runState === RunState.RECOVERING ? RunState.RECOVERING : RunState.RUNNING;
  session.completedAt = 0;
  session.onePassCompletedTaskIds = [];
  session.currentTaskIndex = 0;
  session.orchestrationCoordinator = { managed: true, projectId: runtime.projectId, generation: runtime.coordinator.generation, turnId: runtime.coordinator.lease?.turnId || '', agentProviderId: config.coordinatorAgentProviderId };
  session.updatedAt = nowMs;
  return { state: coreState, sessionId: sid, taskId: tid };
}

export function syncCoordinatorDeliveryFromCore(runtime, coreState, nowMs = Date.now()) {
  const sid = coordinatorSessionId(runtime.projectId);
  const tid = coordinatorTaskId(runtime.projectId);
  const session = coreState.sessionsById?.[sid];
  const task = session?.tasksById?.[tid];
  const lease = runtime.coordinator.lease;
  if (!session || !task || !lease) return { changed: false };
  if (session.orchestrationCoordinator?.turnId !== lease.turnId) return { changed: false };
  if (task.status === 'RATE_LIMITED') {
    runtime.coordinator.retryAfterAt = Math.max(runtime.coordinator.retryAfterAt || 0, Number(task.retryAfterAt || 0), nowMs + MIN_RATE_LIMIT_BACKOFF_MS);
    runtime.coordinator.status = CoordinatorStatus.BUSY;
    runtime.agentProvider.retryAfterAt = Math.max(runtime.agentProvider?.retryAfterAt || 0, runtime.coordinator.retryAfterAt);
    runtime.agentProvider.lastRateLimitAt = nowMs;
    runtime.agentProvider.reason = 'ChatGPT coordinator delivery rate-limited';
    runtime.agentProvider.sourceWorkerId = '';
    runtime.updatedAt = nowMs;
    return { changed: true, rateLimited: true, retryAfterAt: runtime.coordinator.retryAfterAt };
  }
  if (task.lastVerifiedSendAt >= lease.acquiredAt && task.lastConversationUrl) {
    runtime.coordinator.chatUrl = task.lastConversationUrl;
    runtime.coordinator.lastAssistantBaselineCount = Math.max(0, Number(task.lastAssistantBaselineCount || 0));
    runtime.coordinator.lastAssistantBaselineKnown = task.lastAssistantBaselineKnown === true;
    runtime.coordinator.deliveredTurnId = lease.turnId;
    runtime.coordinator.deliveredAt = task.lastVerifiedSendAt;
    runtime.updatedAt = nowMs;
    return { changed: true, sentAt: task.lastVerifiedSendAt, chatUrl: task.lastConversationUrl, turnId: lease.turnId };
  }
  return { changed: false };
}

export function coordinatorCompletionProbe(runtime) {
  if (!runtime.coordinator.lease || runtime.coordinator.deliveredTurnId !== runtime.coordinator.lease.turnId || !runtime.coordinator.chatUrl || !runtime.coordinator.lastAssistantBaselineKnown) return null;
  return {
    conversationUrl: runtime.coordinator.chatUrl,
    taskId: `coordinator:g${runtime.coordinator.generation}`,
    assistantBaselineCount: runtime.coordinator.lastAssistantBaselineCount,
    assistantBaselineKnown: true,
  };
}

export function applyCoordinatorCompletionProbe(runtime, probeResult, nowMs = Date.now()) {
  if (!runtime.coordinator.lease) return { changed: false, reason: 'NO_LEASE' };
  const status = text(probeResult?.status).toUpperCase();
  if (status === 'BUSY') {
    runtime.coordinator.status = CoordinatorStatus.BUSY;
    runtime.coordinator.retryAfterAt = 0;
    runtime.updatedAt = nowMs;
    return { changed: true, complete: false };
  }
  if (status === 'RATE_LIMITED') {
    runtime.coordinator.status = CoordinatorStatus.BUSY;
    runtime.coordinator.retryAfterAt = Math.max(runtime.coordinator.retryAfterAt || 0, Number(probeResult?.retryAfterAt || 0), nowMs + MIN_RATE_LIMIT_BACKOFF_MS);
    runtime.agentProvider.retryAfterAt = Math.max(runtime.agentProvider?.retryAfterAt || 0, runtime.coordinator.retryAfterAt);
    runtime.agentProvider.lastRateLimitAt = nowMs;
    runtime.agentProvider.reason = 'ChatGPT coordinator report rate-limited';
    runtime.agentProvider.sourceWorkerId = '';
    runtime.updatedAt = nowMs;
    return { changed: true, complete: false, rateLimited: true, retryAfterAt: runtime.coordinator.retryAfterAt };
  }
  if (status === 'READY' && probeResult?.assistantComplete === true) {
    runtime.coordinator.status = CoordinatorStatus.WAITING_CONTROL;
    runtime.coordinator.retryAfterAt = 0;
    runtime.coordinator.responseCompleteAt = nowMs;
    runtime.coordinator.lastAssistantReport = storedCoordinatorReport(probeResult?.assistantText);
    runtime.updatedAt = nowMs;
    return { changed: true, complete: true };
  }
  if (['AUTH_REQUIRED', 'UNKNOWN_UI', 'MANUAL_REVIEW_REQUIRED'].includes(status)) {
    runtime.coordinator.status = CoordinatorStatus.MANUAL_REVIEW;
    runtime.coordinator.lastError = text(probeResult?.safeDiagnosticCode || status);
    runtime.updatedAt = nowMs;
    return { changed: true, complete: false, manualReview: true };
  }
  runtime.coordinator.status = CoordinatorStatus.BUSY;
  runtime.updatedAt = nowMs;
  return { changed: true, complete: false };
}

export function recordProviderFetch(runtime, { ok, nowMs = Date.now(), error = '', retryAfterAt = 0, canonicalCommentId = 0, rateLimitRemaining = null } = {}) {
  runtime.provider.lastFetchAt = nowMs;
  if (ok) {
    runtime.provider.lastFetchOkAt = nowMs;
    runtime.provider.lastFetchError = '';
    runtime.provider.retryAfterAt = 0;
    if (canonicalCommentId) runtime.provider.canonicalCommentId = canonicalCommentId;
  } else {
    runtime.provider.lastFetchError = String(error || '').slice(0, 2000);
    runtime.provider.retryAfterAt = Math.max(runtime.provider.retryAfterAt || 0, Number(retryAfterAt || 0));
  }
  if (rateLimitRemaining !== null && rateLimitRemaining !== undefined && Number.isFinite(Number(rateLimitRemaining))) runtime.provider.rateLimitRemaining = Number(rateLimitRemaining);
  runtime.updatedAt = nowMs;
  return runtime;
}

export function orchestrationSnapshot(runtime, configRaw) {
  const config = validateOrchestrationConfig(configRaw);
  const counts = {};
  for (const state of WORKER_STATES) counts[state] = 0;
  for (const workerId of runtime.workerOrder) {
    const state = runtime.workersById[workerId]?.state;
    if (state in counts) counts[state] += 1;
  }
  const coordinator = clone(runtime.coordinator);
  coordinator.lastAssistantReportAvailable = Boolean(text(coordinator.lastAssistantReport));
  delete coordinator.lastAssistantReport;
  const hierarchy = runtime?.hierarchy?.graph && runtime?.hierarchy?.state
    ? {
      graphId: String(runtime.hierarchy.graph.graphId || ''),
      nodeCount: Array.isArray(runtime.hierarchy.graph.nodeOrder) ? runtime.hierarchy.graph.nodeOrder.length : 0,
      providers: (runtime.hierarchy.graph.nodeOrder || [])
        .map(nodeId => {
          const node = runtime.hierarchy.graph.nodesById?.[nodeId];
          if (!node?.providerBinding) return null;
          const providerState = runtime.hierarchy.state.nodesById?.[nodeId]?.providerState || {};
          return {
            nodeId,
            providerId: node.providerBinding.providerId,
            maxSlots: node.providerBinding.maxSlots,
            pollIntervalMs: node.providerBinding.pollIntervalMs,
            sourceConfigured: Boolean(node.providerBinding.sourceId),
            lastAcceptedRevision: String(providerState.lastAcceptedRevision || ''),
            lastRequestedSlotCount: Number(providerState.lastRequestedSlotCount || 0),
            lastCheckedAt: Number(providerState.lastCheckedAt || 0),
            nextCheckAt: Number(providerState.nextCheckAt || 0),
            lastErrorCode: String(providerState.lastErrorCode || ''),
          };
        })
        .filter(Boolean),
    }
    : null;
  return {
    projectId: runtime.projectId,
    mode: runtime.mode,
    coordinator,
    provider: clone(runtime.provider),
    agentProvider: clone(runtime.agentProvider),
    desiredActiveWorkers: runtime.desiredActiveWorkers,
    effectiveDesiredWorkers: effectiveDesiredWorkers(runtime, config),
    hardMaxWorkers: config.absoluteMaxWorkers,
    requestedActiveWorkers: runtime.lastRequestedDesiredWorkers,
    launchPolicy: workerLaunchPolicy(runtime, config, Date.now()),
    reservedWorkerSlots: reservedWorkerSlots(runtime),
    backpressureUntil: projectBackpressureUntil(runtime),
    workerCounts: counts,
    pendingCoordinatorEvents: runtime.pendingCoordinatorEvents.length,
    lastAppliedControlRevision: runtime.lastAppliedControlRevision,
    lastAppliedControlSource: runtime.lastAppliedControlSource || '',
    lastWatchdogAt: runtime.lastWatchdogAt,
    lastCoordinatorDecisionAt: runtime.lastCoordinatorDecisionAt,
    lastControlNote: runtime.lastControlNote,
    hierarchy,
  };
}
