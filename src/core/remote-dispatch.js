import { RunMode, TabStrategy, normalizeChatUrl } from './schema.js';

export const REMOTE_DISPATCH_MARKER = '<!-- CHATGPT_AUTOPILOT_DISPATCH_V1 -->';
export const REMOTE_DISPATCH_SCHEMA_VERSION = 1;
export const MAX_DISPATCH_BODY_BYTES = 512 * 1024;
export const MAX_DISPATCH_SESSIONS = 50;
export const MAX_DISPATCH_TASKS_PER_SESSION = 1000;
export const MAX_REMOTE_PROMPT_CHARS = 250_000;

export const REMOTE_DISPATCH_LIMITS = Object.freeze({
  pollIntervalSeconds: [180, 3600],
  fallbackAfterSeconds: [60, 86_400],
  maxActiveSessions: [1, 5],
  minimumSendIntervalSeconds: [60, 86_400],
  preSendDelaySeconds: [1, 30],
  busyCheckDelaySeconds: [1, 30],
  retryBackoffSeconds: [5, 3600],
  maxLaunches: [1, 1000],
  order: [-1_000_000, 1_000_000],
});

const RUN_MODES = new Set(Object.values(RunMode));
const TAB_STRATEGIES = new Set(Object.values(TabStrategy));
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export class RemoteDispatchValidationError extends Error {
  constructor(code, path, message) {
    super(`${code}${path ? ` at ${path}` : ''}: ${message}`);
    this.name = 'RemoteDispatchValidationError';
    this.code = code;
    this.path = path || '';
  }
}

function fail(code, path, message) {
  throw new RemoteDispatchValidationError(code, path, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', path, 'expected object');
  return value;
}

function requireString(value, path, { min = 1, max = 200, pattern = null } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail('INVALID_STRING', path, `expected string length ${min}-${max}`);
  }
  if (pattern && !pattern.test(value)) fail('INVALID_STRING', path, 'invalid format');
  return value;
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') fail('INVALID_BOOLEAN', path, 'expected boolean');
  return value;
}

function requireInteger(value, path, [min, max]) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', path, `expected integer ${min}-${max}`);
  }
  return value;
}

function requireId(value, path) {
  return requireString(value, path, { min: 1, max: 200, pattern: ID_RE });
}

function optionalIdArray(value, path, { max = 1000 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail('INVALID_ARRAY', path, `expected array of at most ${max}`);
  const normalized = value.map((item, index) => requireId(item, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail('DUPLICATE_ID', path, 'duplicate values');
  return normalized;
}

function parseIso(value, path, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  const text = requireString(value, path, { min: 20, max: 40 });
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) fail('INVALID_TIMESTAMP', path, 'expected ISO-8601 timestamp');
  return { text, ms };
}

function normalizedNullableTimestamp(value, path) {
  const parsed = parseIso(value, path, { nullable: true });
  return parsed?.text ?? null;
}

function normalizedOrder(value, path, fallbackIndex) {
  if (value === undefined) return fallbackIndex;
  return requireInteger(value, path, REMOTE_DISPATCH_LIMITS.order);
}

function stableSortByOrder(items, idField) {
  return [...items].sort((a, b) => a.order - b.order || String(a[idField]).localeCompare(String(b[idField]), 'en'));
}

function normalizeTask(rawTask, sessionPath, index) {
  const path = `${sessionPath}.tasks[${index}]`;
  const task = requireRecord(rawTask, path);
  const taskId = requireId(task.task_id, `${path}.task_id`);
  const prompt = requireString(task.prompt, `${path}.prompt`, { min: 1, max: MAX_REMOTE_PROMPT_CHARS });
  let url;
  try {
    url = normalizeChatUrl(requireString(task.url, `${path}.url`, { min: 20, max: 5000 }));
  } catch {
    fail('INVALID_URL', `${path}.url`, 'expected allowed https://chatgpt.com URL');
  }
  const notBefore = normalizedNullableTimestamp(task.not_before, `${path}.not_before`);
  const expiresAt = normalizedNullableTimestamp(task.expires_at, `${path}.expires_at`);
  if (notBefore && expiresAt && Date.parse(notBefore) >= Date.parse(expiresAt)) {
    fail('INVALID_TIME_WINDOW', path, 'not_before must be before expires_at');
  }
  return {
    task_id: taskId,
    order: normalizedOrder(task.order, `${path}.order`, index),
    enabled: task.enabled === undefined ? true : requireBoolean(task.enabled, `${path}.enabled`),
    url,
    prompt,
    not_before: notBefore,
    expires_at: expiresAt,
    max_launches: task.max_launches === undefined ? 1 : requireInteger(task.max_launches, `${path}.max_launches`, REMOTE_DISPATCH_LIMITS.maxLaunches),
    supersedes_task_ids: optionalIdArray(task.supersedes_task_ids, `${path}.supersedes_task_ids`),
  };
}

function normalizeSession(rawSession, index) {
  const path = `sessions[${index}]`;
  const session = requireRecord(rawSession, path);
  const sessionKey = requireId(session.session_key, `${path}.session_key`);
  const tasks = session.tasks;
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_DISPATCH_TASKS_PER_SESSION) {
    fail('INVALID_ARRAY', `${path}.tasks`, `expected 1-${MAX_DISPATCH_TASKS_PER_SESSION} tasks`);
  }
  const normalizedTasks = tasks.map((task, taskIndex) => normalizeTask(task, path, taskIndex));
  const taskIds = normalizedTasks.map(task => task.task_id);
  if (new Set(taskIds).size !== taskIds.length) fail('DUPLICATE_ID', `${path}.tasks`, 'duplicate task_id');

  const runMode = requireString(session.run_mode, `${path}.run_mode`, { min: 1, max: 40 });
  if (!RUN_MODES.has(runMode)) fail('INVALID_ENUM', `${path}.run_mode`, 'unsupported run mode');
  const tabStrategy = requireString(session.tab_strategy, `${path}.tab_strategy`, { min: 1, max: 80 });
  if (!TAB_STRATEGIES.has(tabStrategy)) fail('INVALID_ENUM', `${path}.tab_strategy`, 'unsupported tab strategy');

  const notBefore = normalizedNullableTimestamp(session.not_before, `${path}.not_before`);
  const expiresAt = normalizedNullableTimestamp(session.expires_at, `${path}.expires_at`);
  if (notBefore && expiresAt && Date.parse(notBefore) >= Date.parse(expiresAt)) {
    fail('INVALID_TIME_WINDOW', path, 'not_before must be before expires_at');
  }

  return {
    session_key: sessionKey,
    name: requireString(session.name, `${path}.name`, { min: 1, max: 160 }),
    order: normalizedOrder(session.order, `${path}.order`, index),
    enabled: session.enabled === undefined ? true : requireBoolean(session.enabled, `${path}.enabled`),
    run_mode: runMode,
    tab_strategy: tabStrategy,
    minimum_send_interval_seconds: requireInteger(session.minimum_send_interval_seconds, `${path}.minimum_send_interval_seconds`, REMOTE_DISPATCH_LIMITS.minimumSendIntervalSeconds),
    pre_send_delay_seconds: requireInteger(session.pre_send_delay_seconds, `${path}.pre_send_delay_seconds`, REMOTE_DISPATCH_LIMITS.preSendDelaySeconds),
    busy_check_delay_seconds: requireInteger(session.busy_check_delay_seconds, `${path}.busy_check_delay_seconds`, REMOTE_DISPATCH_LIMITS.busyCheckDelaySeconds),
    retry_backoff_seconds: requireInteger(session.retry_backoff_seconds, `${path}.retry_backoff_seconds`, REMOTE_DISPATCH_LIMITS.retryBackoffSeconds),
    not_before: notBefore,
    expires_at: expiresAt,
    tasks: stableSortByOrder(normalizedTasks, 'task_id'),
  };
}

export function normalizeRemoteDispatch(raw) {
  const dispatch = requireRecord(raw, 'dispatch');
  if (dispatch.schema_version !== REMOTE_DISPATCH_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA', 'schema_version', `expected ${REMOTE_DISPATCH_SCHEMA_VERSION}`);
  }
  const generatedAt = parseIso(dispatch.generated_at, 'generated_at');
  const expiresAt = parseIso(dispatch.expires_at, 'expires_at');
  if (generatedAt.ms >= expiresAt.ms) fail('INVALID_TIME_WINDOW', 'expires_at', 'must be after generated_at');

  const policy = requireRecord(dispatch.policy, 'policy');
  const pollInterval = requireInteger(policy.poll_interval_seconds, 'policy.poll_interval_seconds', REMOTE_DISPATCH_LIMITS.pollIntervalSeconds);
  const fallbackAfter = requireInteger(policy.fallback_after_seconds, 'policy.fallback_after_seconds', REMOTE_DISPATCH_LIMITS.fallbackAfterSeconds);
  if (fallbackAfter < pollInterval) fail('INVALID_POLICY', 'policy.fallback_after_seconds', 'must be >= poll_interval_seconds');

  if (!Array.isArray(dispatch.sessions) || dispatch.sessions.length < 1 || dispatch.sessions.length > MAX_DISPATCH_SESSIONS) {
    fail('INVALID_ARRAY', 'sessions', `expected 1-${MAX_DISPATCH_SESSIONS} sessions`);
  }
  const sessions = dispatch.sessions.map((session, index) => normalizeSession(session, index));
  const sessionKeys = sessions.map(session => session.session_key);
  if (new Set(sessionKeys).size !== sessionKeys.length) fail('DUPLICATE_ID', 'sessions', 'duplicate session_key');
  const globalTaskIds = sessions.flatMap(session => session.tasks.map(task => task.task_id));
  if (new Set(globalTaskIds).size !== globalTaskIds.length) {
    fail('DUPLICATE_ID', 'sessions[].tasks', 'task_id must be globally unique within a dispatch');
  }

  return {
    schema_version: REMOTE_DISPATCH_SCHEMA_VERSION,
    dispatch_id: requireId(dispatch.dispatch_id, 'dispatch_id'),
    strategy_revision: requireInteger(dispatch.strategy_revision, 'strategy_revision', [0, Number.MAX_SAFE_INTEGER]),
    generated_at: generatedAt.text,
    expires_at: expiresAt.text,
    project_id: requireId(dispatch.project_id, 'project_id'),
    target_repository: requireString(dispatch.target_repository, 'target_repository', { min: 3, max: 300, pattern: REPOSITORY_RE }),
    supersedes_dispatch_ids: optionalIdArray(dispatch.supersedes_dispatch_ids, 'supersedes_dispatch_ids'),
    policy: {
      poll_interval_seconds: pollInterval,
      fallback_after_seconds: fallbackAfter,
      fallback_enabled: requireBoolean(policy.fallback_enabled, 'policy.fallback_enabled'),
      max_active_sessions: requireInteger(policy.max_active_sessions, 'policy.max_active_sessions', REMOTE_DISPATCH_LIMITS.maxActiveSessions),
    },
    sessions: stableSortByOrder(sessions, 'session_key'),
  };
}

function extractSingleJsonFence(body) {
  const fenceRe = /```json\s*\n([\s\S]*?)\n```/giu;
  const matches = [...body.matchAll(fenceRe)];
  if (matches.length !== 1) fail('INVALID_ENVELOPE', 'body', 'expected exactly one fenced json block');
  return matches[0][1];
}

export function parseRemoteDispatchComment(body) {
  if (typeof body !== 'string') fail('INVALID_BODY', 'body', 'expected string');
  if (new TextEncoder().encode(body).length > MAX_DISPATCH_BODY_BYTES) fail('BODY_TOO_LARGE', 'body', 'dispatch body exceeds size limit');
  const trimmedStart = body.trimStart();
  if (!trimmedStart.startsWith(REMOTE_DISPATCH_MARKER)) return { marked: false, dispatch: null };
  const afterMarker = trimmedStart.slice(REMOTE_DISPATCH_MARKER.length);
  const jsonText = extractSingleJsonFence(afterMarker);
  let raw;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    fail('INVALID_JSON', 'body', 'JSON parse failed');
  }
  return { marked: true, dispatch: normalizeRemoteDispatch(raw) };
}

export function getDispatchApplicability(dispatch, { projectId, nowMs = Date.now() } = {}) {
  if (!dispatch || dispatch.schema_version !== REMOTE_DISPATCH_SCHEMA_VERSION) return { applicable: false, reason: 'INVALID' };
  if (dispatch.project_id !== projectId) return { applicable: false, reason: 'WRONG_PROJECT' };
  const generatedAt = Date.parse(dispatch.generated_at);
  const expiresAt = Date.parse(dispatch.expires_at);
  if (generatedAt > nowMs) return { applicable: false, reason: 'NOT_YET_GENERATED' };
  if (expiresAt <= nowMs) return { applicable: false, reason: 'EXPIRED' };
  return { applicable: true, reason: 'OK' };
}

export function selectApplicableRemoteDispatch(comments, { projectId, nowMs = Date.now() } = {}) {
  if (!Array.isArray(comments)) fail('INVALID_ARRAY', 'comments', 'expected array');
  const accepted = [];
  const diagnostics = [];
  for (const [index, comment] of comments.entries()) {
    const body = typeof comment === 'string' ? comment : comment?.body;
    const commentId = typeof comment === 'object' && comment !== null ? String(comment.id ?? index) : String(index);
    try {
      const parsed = parseRemoteDispatchComment(body);
      if (!parsed.marked) continue;
      const applicability = getDispatchApplicability(parsed.dispatch, { projectId, nowMs });
      if (!applicability.applicable) {
        diagnostics.push({ commentId, status: 'ignored', reason: applicability.reason, dispatchId: parsed.dispatch.dispatch_id });
        continue;
      }
      accepted.push({ commentId, dispatch: parsed.dispatch });
    } catch (error) {
      diagnostics.push({ commentId, status: 'rejected', reason: error?.code || 'INVALID', message: String(error?.message || error).slice(0, 300) });
    }
  }
  accepted.sort((a, b) =>
    b.dispatch.strategy_revision - a.dispatch.strategy_revision ||
    Date.parse(b.dispatch.generated_at) - Date.parse(a.dispatch.generated_at) ||
    b.commentId.localeCompare(a.commentId, 'en')
  );
  const selected = accepted[0] || null;
  return {
    selected: selected ? { commentId: selected.commentId, dispatch: structuredClone(selected.dispatch) } : null,
    diagnostics,
  };
}
