export const RUN_TIMELINE_VERSION = 1;
export const MAX_RUN_TIMELINE_ENTRIES = 200;

const CHATGPT_URL = /https:\/\/(?:www\.)?chatgpt\.com\/[^\s"'<>()[\]]+/giu;

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value;
}

function requiredSessionId(value) {
  if (typeof value !== 'string') throw new Error('Run timeline sessionId must be text');
  if (!value.trim() || value.length > 512) throw new Error('Run timeline sessionId is invalid');
  return value;
}

function boundedLimit(value) {
  if (value === undefined) return 100;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_RUN_TIMELINE_ENTRIES) {
    throw new Error(`Run timeline limit must be an integer from 1 to ${MAX_RUN_TIMELINE_ENTRIES}`);
  }
  return value;
}

function safeText(value, maximum = 1000) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : String(value);
  return text.replace(CHATGPT_URL, '[приховане посилання ChatGPT]')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function safeTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function logProjection(entry, ordinal) {
  if (typeof entry === 'string') {
    return {
      entryId: `log:${ordinal}`, source: 'LOG', at: 0, level: 'INFO', event: 'CORE_LOG',
      message: safeText(entry), taskLabel: '', phase: '', status: '', code: '', target: '',
      observed: '', operationIdSuffix: '', promptFingerprint: '', ordinal,
    };
  }
  const raw = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  return {
    entryId: `log:${ordinal}`, source: 'LOG', at: safeTime(raw.at),
    level: safeText(raw.level || 'INFO', 40).toUpperCase() || 'INFO', event: 'CORE_LOG',
    message: safeText(raw.message), taskLabel: '', phase: '', status: '', code: '', target: '',
    observed: '', operationIdSuffix: '', promptFingerprint: '', ordinal,
  };
}

function diagnosticProjection(entry, ordinal) {
  const raw = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  return {
    entryId: `diagnostic:${ordinal}`, source: 'DIAGNOSTIC', at: safeTime(raw.at),
    level: raw.code ? 'WARNING' : 'INFO', event: safeText(raw.event || 'ПОДІЯ_ДІАГНОСТИКИ', 80),
    message: safeText(raw.message), taskLabel: safeText(raw.taskLabel, 160),
    phase: safeText(raw.phase, 80), status: safeText(raw.status, 120), code: safeText(raw.code, 120),
    target: safeText(raw.target, 240), observed: safeText(raw.observed, 240),
    operationIdSuffix: safeText(raw.operationIdSuffix, 80),
    promptFingerprint: safeText(raw.promptFingerprint, 80), ordinal,
  };
}

function currentSessionSummary(session) {
  const taskId = Array.isArray(session.taskOrder) ? session.taskOrder[session.currentTaskIndex] : '';
  const task = taskId && session.tasksById && typeof session.tasksById === 'object' ? session.tasksById[taskId] : null;
  return {
    name: safeText(session.name || 'Без назви', 160),
    runState: safeText(session.runState, 80),
    phase: safeText(session.operation?.phase, 80),
    currentTaskLabel: safeText(task?.label || task?.id, 160),
    lastError: safeText(session.lastError, 1000),
    lastActionAt: safeTime(session.lastActionAt),
    updatedAt: safeTime(session.updatedAt),
  };
}

/**
 * Read-only projection of already-canonical Core evidence.
 * This function never mutates state, creates effects, or stores a second log.
 */
export function buildRunTimelineV1(state, { sessionId, limit } = {}) {
  const root = plainObject(state, 'Run timeline state');
  const id = requiredSessionId(sessionId);
  const maxEntries = boundedLimit(limit);
  const sessionsById = root.sessionsById;
  if (!sessionsById || typeof sessionsById !== 'object' || Array.isArray(sessionsById)
      || !Object.hasOwn(sessionsById, id)) {
    throw new Error('Run timeline session not found');
  }
  const session = sessionsById[id];
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('Run timeline session not found');

  const logs = root.logs && typeof root.logs === 'object' && Object.hasOwn(root.logs, id) && Array.isArray(root.logs[id])
    ? root.logs[id]
    : [];
  const diagnostics = Array.isArray(root.diagnostics) ? root.diagnostics : [];
  const entries = [];

  logs.forEach((entry, ordinal) => {
    const projected = logProjection(entry, ordinal);
    if (projected.message) entries.push(projected);
  });
  diagnostics.forEach((entry, ordinal) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.sessionId !== id) return;
    const projected = diagnosticProjection(entry, ordinal);
    if (projected.event || projected.message || projected.code || projected.status) entries.push(projected);
  });

  entries.sort((left, right) => left.at - right.at
    || (left.source === right.source ? 0 : left.source === 'LOG' ? -1 : 1)
    || left.ordinal - right.ordinal);

  const totalEntries = entries.length;
  const visible = entries.slice(Math.max(0, totalEntries - maxEntries)).map(({ ordinal, ...entry }) => entry);
  const logCount = visible.filter(entry => entry.source === 'LOG').length;

  return freezeDeep({
    schemaVersion: RUN_TIMELINE_VERSION,
    sessionId: id,
    session: currentSessionSummary(session),
    totalEntries,
    returnedEntries: visible.length,
    truncated: totalEntries > visible.length,
    sources: { logCount, diagnosticCount: visible.length - logCount },
    entries: visible,
  });
}
