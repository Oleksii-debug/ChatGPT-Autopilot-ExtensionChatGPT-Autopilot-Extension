export const SessionFunctionId = Object.freeze({
  ORDINARY_SEND: 'ordinary_send',
  BATCH_CHAT: 'batch_chat',
  PROMPT_CADENCE: 'prompt_cadence',
  DRIVE_SOURCE: 'drive_source',
});

export const SESSION_FUNCTIONS = Object.freeze([
  SessionFunctionId.ORDINARY_SEND,
  SessionFunctionId.BATCH_CHAT,
  SessionFunctionId.PROMPT_CADENCE,
  SessionFunctionId.DRIVE_SOURCE,
]);

const DEFAULT_ENABLED = Object.freeze({
  [SessionFunctionId.ORDINARY_SEND]: true,
  [SessionFunctionId.BATCH_CHAT]: false,
  [SessionFunctionId.PROMPT_CADENCE]: false,
  [SessionFunctionId.DRIVE_SOURCE]: false,
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeModule(value, fallbackEnabled) {
  const source = isRecord(value) ? value : {};
  return {
    enabled: source.enabled === undefined ? fallbackEnabled : source.enabled === true,
    config: isRecord(source.config) ? source.config : {},
  };
}

export function createDefaultSessionFunctions() {
  return Object.fromEntries(SESSION_FUNCTIONS.map(id => [id, { enabled: DEFAULT_ENABLED[id], config: {} }]));
}

export function normalizeSessionFunctions(raw) {
  const source = isRecord(raw) ? raw : {};
  const defaults = createDefaultSessionFunctions();
  return Object.fromEntries(SESSION_FUNCTIONS.map(id => [
    id,
    normalizeModule(source[id], defaults[id].enabled),
  ]));
}

export function validateSessionFunctions(raw) {
  const normalized = normalizeSessionFunctions(raw);
  for (const id of SESSION_FUNCTIONS) {
    if (typeof normalized[id].enabled !== 'boolean') throw new Error(`Invalid Session function ${id} enabled`);
    if (!isRecord(normalized[id].config)) throw new Error(`Invalid Session function ${id} config`);
  }
  return normalized;
}

export function isSessionFunctionEnabled(raw, id) {
  if (!SESSION_FUNCTIONS.includes(id)) throw new Error(`Unknown Session function ${id}`);
  return normalizeSessionFunctions(raw)[id].enabled;
}

export function setSessionFunctionEnabled(raw, id, enabled) {
  if (!SESSION_FUNCTIONS.includes(id)) throw new Error(`Unknown Session function ${id}`);
  const next = normalizeSessionFunctions(raw);
  next[id].enabled = enabled === true;
  return next;
}

export function setSessionFunctionConfig(raw, id, config) {
  if (!SESSION_FUNCTIONS.includes(id)) throw new Error(`Unknown Session function ${id}`);
  if (!isRecord(config)) throw new Error(`Invalid Session function ${id} config`);
  const next = normalizeSessionFunctions(raw);
  next[id].config = { ...config };
  return next;
}
