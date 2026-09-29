import { OperationPhase, RunState } from './schema.js';

export const RUN_TIMELINE_VERSION = 1;
export const MAX_RUN_TIMELINE_ENTRIES = 200;

const RUN_STATES = new Set(Object.values(RunState));
const OPERATION_PHASES = new Set(Object.values(OperationPhase));
const SAFE_DIAGNOSTIC_LOCATION = /^(?:chatgpt\.com\/розмова: (?:немає ідентифікатора|…[A-Za-z0-9_-]{1,6})|не-ChatGPT-адреса|некоректна адреса ChatGPT)$/u;
const LOG_LEVELS = new Set(['INFO', 'WARN', 'WARNING', 'ERROR']);
const MAX_DATE_MILLIS = 8_640_000_000_000_000;
const TIMELINE_OPTION_KEYS = new Set(['sessionId', 'limit']);

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value;
}

function timelineOptions(value) {
  if (value === undefined) return Object.create(null);
  const raw = plainObject(value, 'Run timeline options');
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !TIMELINE_OPTION_KEYS.has(key)) {
      throw new Error(`Run timeline options contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`Run timeline options field ${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
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

function safeEnum(value, allowed, fallback = 'UNKNOWN') {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function safeLogLevel(value) {
  if (typeof value !== 'string') return 'INFO';
  const normalized = value.toUpperCase();
  return LOG_LEVELS.has(normalized) ? normalized : 'INFO';
}

function safeDiagnosticLocation(value) {
  return typeof value === 'string' && SAFE_DIAGNOSTIC_LOCATION.test(value) ? value : '';
}
function safeTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DATE_MILLIS ? value : 0;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function logProjection(entry, ordinal) {
  const raw = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  return {
    entryId: `log:${ordinal}`, source: 'LOG', at: safeTime(raw.at),
    level: safeLogLevel(raw.level), event: 'CORE_LOG',
    message: 'Подію Core log зафіксовано.', taskLabel: '', phase: '', status: '', code: '', target: '',
    observed: '', operationIdSuffix: '', promptFingerprint: '', ordinal,
  };
}
function diagnosticProjection(entry, ordinal) {
  const raw = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  return {
    entryId: `diagnostic:${ordinal}`, source: 'DIAGNOSTIC', at: safeTime(raw.at),
    level: raw.code ? 'WARNING' : 'INFO', event: 'DIAGNOSTIC_EVENT',
    message: 'Діагностичну подію зафіксовано.', taskLabel: '',
    phase: safeEnum(raw.phase, OPERATION_PHASES, ''), status: '', code: '',
    target: safeDiagnosticLocation(raw.target), observed: safeDiagnosticLocation(raw.observed),
    operationIdSuffix: '', promptFingerprint: '', ordinal,
  };
}
function currentSessionSummary(session) {
  return {
    name: '',
    runState: safeEnum(session.runState, RUN_STATES),
    phase: safeEnum(session.operation?.phase, OPERATION_PHASES, OperationPhase.NONE),
    currentTaskLabel: '',
    lastError: '',
    lastActionAt: safeTime(session.lastActionAt),
    updatedAt: safeTime(session.updatedAt),
  };
}
/**
 * Read-only projection of already-canonical Core evidence.
 * This function never mutates state, creates effects, or stores a second log.
 */
export function buildRunTimelineV1(state, options = undefined) {
  const rawOptions = timelineOptions(options);
  const root = plainObject(state, 'Run timeline state');
  const id = requiredSessionId(rawOptions.sessionId);
  const maxEntries = boundedLimit(rawOptions.limit);
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
