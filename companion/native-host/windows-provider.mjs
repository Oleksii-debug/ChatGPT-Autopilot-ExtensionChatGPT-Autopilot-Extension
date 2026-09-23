const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_TEXT = 4096;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 8192;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_UIA_RESULTS = 256;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function clean(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function id(value, label) {
  const out = clean(value, 128);
  if (!ID.test(out)) fail('WINDOWS_INVALID_REQUEST', `${label} is invalid`);
  return out;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('WINDOWS_INVALID_REQUEST', `${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('WINDOWS_INVALID_REQUEST', `${label} contains unknown field: ${key}`);
}

function boundedArgs(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS) fail('WINDOWS_INVALID_REQUEST', `args must contain at most ${MAX_ARGS} items`);
  let chars = 0;
  const args = value.map((item, index) => {
    if (typeof item !== 'string') fail('WINDOWS_INVALID_REQUEST', `args[${index}] must be text`);
    chars += item.length;
    if (chars > MAX_ARG_CHARS) fail('WINDOWS_INVALID_REQUEST', 'args are too large');
    return item;
  });
  return args;
}

function normalizeExecutable(raw, index) {
  exactKeys(raw, new Set(['executableId', 'path', 'readOnly']), `executables[${index}]`);
  const executableId = id(raw.executableId, `executables[${index}].executableId`);
  const executablePath = clean(raw.path, 32000);
  if (!executablePath || !/^[A-Za-z]:\\[^\0]+$/u.test(executablePath)) fail('WINDOWS_CONFIG_INVALID', `executables[${index}].path must be an absolute Windows path`);
  return Object.freeze({ executableId, path: executablePath, readOnly: raw.readOnly === true });
}

export function normalizeWindowsProviderConfig(raw) {
  exactKeys(raw, new Set(['schemaVersion', 'executables']), 'windows provider config');
  if (raw.schemaVersion !== 1) fail('WINDOWS_CONFIG_INVALID', 'windows provider config schemaVersion must be 1');
  if (!Array.isArray(raw.executables) || raw.executables.length > 64) fail('WINDOWS_CONFIG_INVALID', 'executables must be a bounded array');
  const executables = raw.executables.map(normalizeExecutable);
  if (new Set(executables.map(item => item.executableId)).size !== executables.length) fail('WINDOWS_CONFIG_INVALID', 'executableId values must be unique');
  return Object.freeze({ schemaVersion: 1, executables: Object.freeze(executables) });
}

function requireWindows(platform) {
  if (platform !== 'win32') fail('WINDOWS_UNAVAILABLE', 'Windows provider is available only on Windows');
}

function normalizeOutput(value) {
  const text = typeof value === 'string' ? value : Buffer.from(value || '').toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) fail('WINDOWS_OUTPUT_TOO_LARGE', 'Windows process output exceeded the bounded limit');
  return text;
}

export function createWindowsProvider({ config, platform = process.platform, execFile, uiaAdapter = null } = {}) {
  const normalized = normalizeWindowsProviderConfig(config);
  if (typeof execFile !== 'function') fail('WINDOWS_CONFIG_INVALID', 'execFile adapter is required');

  return Object.freeze({
    capabilities() {
      return Object.freeze([
        { capabilityId: 'windows.process.execPinned', readOnly: false, scoped: true },
        { capabilityId: 'windows.uia.query', readOnly: true, scoped: true, available: Boolean(uiaAdapter) },
      ]);
    },

    async execPinned(payload) {
      requireWindows(platform);
      exactKeys(payload, new Set(['executableId', 'args', 'timeoutMs']), 'windows process request');
      const executableId = id(payload.executableId, 'executableId');
      const executable = normalized.executables.find(item => item.executableId === executableId);
      if (!executable) fail('WINDOWS_EXECUTABLE_NOT_ALLOWED', 'Executable identity is not owner-configured');
      const args = boundedArgs(payload.args);
      const timeoutMs = payload.timeoutMs == null ? 30_000 : Number(payload.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) fail('WINDOWS_INVALID_REQUEST', 'timeoutMs must be 100..120000');
      const result = await execFile(executable.path, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES });
      const stdout = normalizeOutput(result?.stdout);
      const stderr = normalizeOutput(result?.stderr);
      return Object.freeze({ executableId, exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 0, stdout, stderr });
    },

    async queryUia(payload) {
      requireWindows(platform);
      if (!uiaAdapter || typeof uiaAdapter.query !== 'function') fail('WINDOWS_UIA_UNAVAILABLE', 'UI Automation adapter is unavailable');
      exactKeys(payload, new Set(['windowId', 'role', 'name', 'limit']), 'UIA query');
      const windowId = id(payload.windowId, 'windowId');
      const role = payload.role == null ? '' : clean(payload.role, 120);
      const name = payload.name == null ? '' : clean(payload.name, 512);
      const limit = payload.limit == null ? 64 : Number(payload.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_UIA_RESULTS) fail('WINDOWS_INVALID_REQUEST', `limit must be 1..${MAX_UIA_RESULTS}`);
      const rows = await uiaAdapter.query({ windowId, role, name, limit });
      if (!Array.isArray(rows) || rows.length > limit) fail('WINDOWS_UIA_INVALID_RESPONSE', 'UI Automation adapter returned an invalid result set');
      return Object.freeze(rows.map((row, index) => {
        exactKeys(row, new Set(['elementId', 'role', 'name', 'enabled', 'offscreen']), `UIA result[${index}]`);
        return Object.freeze({
          elementId: id(row.elementId, `UIA result[${index}].elementId`),
          role: clean(row.role, 120),
          name: clean(row.name, 512),
          enabled: row.enabled !== false,
          offscreen: row.offscreen === true,
        });
      }));
    },
  });
}
