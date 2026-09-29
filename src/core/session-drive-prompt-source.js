import { extractGoogleDriveScalarSourceId } from './orchestration-drive-scalar-provider.js';

export const SESSION_DRIVE_PROMPT_SCHEMA_VERSION = 1;
export const SESSION_DRIVE_PROMPT_TARGETS = Object.freeze(['PRIMARY', 'PROMPT_2', 'PROMPT_3']);
export const SESSION_DRIVE_PROMPT_DEFAULT_POLL_MS = 3 * 60 * 1000;
export const SESSION_DRIVE_PROMPT_MIN_POLL_MS = 60 * 1000;
export const SESSION_DRIVE_PROMPT_MAX_POLL_MS = 24 * 60 * 60 * 1000;
export const SESSION_DRIVE_PROMPT_DEFAULT_MIN_CHARS = 1000;
export const SESSION_DRIVE_PROMPT_MAX_CHARS = 1_000_000;

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

export class SessionDrivePromptError extends Error {
  constructor(code, message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.name = 'SessionDrivePromptError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function integer(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || !Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${label}`);
  return n;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRevision(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/u.test(raw) || raw.length > 128) throw new SessionDrivePromptError('INVALID_VERSION', 'Drive version is invalid.');
  return raw.replace(/^0+(?=\d)/u, '') || '0';
}

function compareRevision(a, b) {
  const left = normalizeRevision(a);
  const right = normalizeRevision(b);
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function defaultSessionDrivePromptSources() {
  return {
    schemaVersion: SESSION_DRIVE_PROMPT_SCHEMA_VERSION,
    bindings: [],
  };
}

export function normalizeSessionDrivePromptSources(raw = null) {
  if (raw === undefined || raw === null) return defaultSessionDrivePromptSources();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid drivePromptSources');
  const allowed = new Set(['schemaVersion', 'bindings']);
  const unknown = Object.keys(raw).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Invalid drivePromptSources field ${unknown[0]}`);
  const schemaVersion = raw.schemaVersion === undefined ? 1 : integer(raw.schemaVersion, 'drivePromptSources.schemaVersion', 1, 1);
  if (!Array.isArray(raw.bindings) || raw.bindings.length > 3) throw new Error('Invalid drivePromptSources.bindings');
  const seen = new Set();
  const bindings = raw.bindings.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Invalid drivePromptSources.bindings[${index}]`);
    const fields = new Set([
      'target','enabled','fileId','pollIntervalMs','minChars',
      'lastAcceptedVersion','lastAcceptedHash','lastCheckedAt','nextCheckAt','lastErrorCode',
    ]);
    const extra = Object.keys(item).filter(key => !fields.has(key));
    if (extra.length) throw new Error(`Invalid drive prompt binding field ${extra[0]}`);
    const target = String(item.target || '').toUpperCase();
    if (!SESSION_DRIVE_PROMPT_TARGETS.includes(target) || seen.has(target)) throw new Error('Invalid or duplicate Drive prompt target');
    seen.add(target);
    const fileId = item.fileId ? extractGoogleDriveScalarSourceId(item.fileId) : '';
    const enabled = item.enabled === true;
    if (enabled && !fileId) throw new Error('Enabled Drive prompt binding requires fileId');
    const binding = {
      target,
      enabled,
      fileId,
      pollIntervalMs: item.pollIntervalMs === undefined
        ? SESSION_DRIVE_PROMPT_DEFAULT_POLL_MS
        : integer(item.pollIntervalMs, 'drivePromptSources.pollIntervalMs', SESSION_DRIVE_PROMPT_MIN_POLL_MS, SESSION_DRIVE_PROMPT_MAX_POLL_MS),
      minChars: item.minChars === undefined
        ? SESSION_DRIVE_PROMPT_DEFAULT_MIN_CHARS
        : integer(item.minChars, 'drivePromptSources.minChars', 1, SESSION_DRIVE_PROMPT_MAX_CHARS),
      lastAcceptedVersion: item.lastAcceptedVersion ? normalizeRevision(item.lastAcceptedVersion) : '',
      lastAcceptedHash: clean(item.lastAcceptedHash),
      lastCheckedAt: Math.max(0, Number(item.lastCheckedAt || 0)),
      nextCheckAt: Math.max(0, Number(item.nextCheckAt || 0)),
      lastErrorCode: clean(item.lastErrorCode),
    };
    if (binding.lastAcceptedHash && !/^[a-f0-9]{64}$/u.test(binding.lastAcceptedHash)) throw new Error('Invalid Drive prompt hash');
    for (const field of ['lastCheckedAt','nextCheckAt']) {
      if (!Number.isFinite(binding[field])) throw new Error(`Invalid Drive prompt ${field}`);
    }
    return binding;
  });
  return { schemaVersion, bindings };
}

async function sha256Text(value) {
  if (!globalThis.crypto?.subtle) throw new SessionDrivePromptError('HASH_UNAVAILABLE', 'Web Crypto is unavailable.');
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readStableSessionDrivePrompt({
  fileId,
  minChars = SESSION_DRIVE_PROMPT_DEFAULT_MIN_CHARS,
  readMetadata,
  readContent,
  hashContent = sha256Text,
  maxAttempts = 3,
} = {}) {
  const sourceId = extractGoogleDriveScalarSourceId(fileId);
  const minimum = integer(minChars, 'minChars', 1, SESSION_DRIVE_PROMPT_MAX_CHARS);
  if (typeof readMetadata !== 'function' || typeof readContent !== 'function') throw new SessionDrivePromptError('INVALID_READER', 'Drive readers are required.');
  const attempts = Number.isInteger(maxAttempts) ? Math.max(1, Math.min(5, maxAttempts)) : 3;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = await readMetadata({ fileId: sourceId });
    if (clean(before?.id) !== sourceId) throw new SessionDrivePromptError('FILE_ID_CHANGED', 'Drive file identity changed.');
    const versionBefore = normalizeRevision(before?.version);
    const content = await readContent({ fileId: sourceId, metadata: before });
    if (typeof content !== 'string') throw new SessionDrivePromptError('INVALID_CONTENT', 'Drive prompt content must be text.');
    const chars = [...content.trim()].length;
    if (chars < minimum || chars > SESSION_DRIVE_PROMPT_MAX_CHARS) {
      throw new SessionDrivePromptError('CONTENT_LENGTH', `Drive prompt must contain ${minimum}..${SESSION_DRIVE_PROMPT_MAX_CHARS} characters.`);
    }
    const after = await readMetadata({ fileId: sourceId });
    if (clean(after?.id) !== sourceId) throw new SessionDrivePromptError('FILE_ID_CHANGED', 'Drive file identity changed.');
    const versionAfter = normalizeRevision(after?.version);
    if (versionBefore !== versionAfter) {
      if (attempt < attempts) continue;
      throw new SessionDrivePromptError('VERSION_RACE', 'Drive prompt changed during stable read.', { retryable: true });
    }
    return {
      fileId: sourceId,
      version: versionAfter,
      content,
      hash: await hashContent(content),
      attempts: attempt,
    };
  }
  throw new SessionDrivePromptError('VERSION_RACE', 'Drive prompt did not stabilize.', { retryable: true });
}

function apiUrl(path, params = {}) {
  const url = new URL(`${DRIVE_API_BASE}${path}`);
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function checkedFetch(fetchFn, url, token) {
  let response;
  try {
    response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new SessionDrivePromptError('NETWORK', 'Google Drive request failed.', { retryable: true });
  }
  if (response?.ok) return response;
  const status = Number(response?.status || 0);
  const code = status === 401 ? 'AUTH_REQUIRED'
    : status === 403 ? 'ACCESS_DENIED'
      : status === 404 ? 'NOT_FOUND'
        : 'HTTP_ERROR';
  throw new SessionDrivePromptError(code, `Google Drive HTTP ${status || 'error'}.`, {
    status,
    retryable: [408,429,500,502,503,504].includes(status),
  });
}

export function createGoogleSessionDrivePromptReader({
  fileId,
  getAccessToken,
  fetchFn = globalThis.fetch,
} = {}) {
  const sourceId = extractGoogleDriveScalarSourceId(fileId);
  if (typeof getAccessToken !== 'function') throw new SessionDrivePromptError('AUTH_REQUIRED', 'Drive access-token provider required.');
  const token = async () => {
    const value = clean(await getAccessToken());
    if (!value) throw new SessionDrivePromptError('AUTH_REQUIRED', 'Drive access token unavailable.');
    return value;
  };
  return {
    fileId: sourceId,
    async readMetadata() {
      const response = await checkedFetch(
        fetchFn,
        apiUrl(`/files/${encodeURIComponent(sourceId)}`, { fields:'id,version,mimeType' }),
        await token(),
      );
      return response.json();
    },
    async readContent({ metadata } = {}) {
      const mime = clean(metadata?.mimeType);
      let url;
      if (mime === GOOGLE_DOC_MIME) {
        url = apiUrl(`/files/${encodeURIComponent(sourceId)}/export`, { mimeType:'text/plain' });
      } else if (TEXT_MIME_TYPES.has(mime)) {
        url = apiUrl(`/files/${encodeURIComponent(sourceId)}`, { alt:'media' });
      } else {
        throw new SessionDrivePromptError('UNSUPPORTED_MIME', `Unsupported Drive prompt MIME: ${mime || 'unknown'}.`);
      }
      const response = await checkedFetch(fetchFn, url, await token());
      const content = await response.text();
      if (new TextEncoder().encode(content).byteLength > 4_000_000) throw new SessionDrivePromptError('TOO_LARGE', 'Drive prompt response is too large.');
      return content;
    },
  };
}

function applyPrompt(session, target, content) {
  if (target === 'PRIMARY') {
    if (session.promptMode === 'UNIQUE') throw new SessionDrivePromptError('PRIMARY_REQUIRES_SHARED_MODE', 'Primary Drive prompt requires shared prompt mode.');
    session.sharedPrompt = content;
    return;
  }
  const key = target === 'PROMPT_2' ? 'prompt2' : 'prompt3';
  if (!session.promptCadence?.[key]) throw new SessionDrivePromptError('CADENCE_CONFIG_MISSING', 'Prompt cadence config is missing.');
  session.promptCadence[key].prompt = content;
}

export async function syncDueSessionDrivePrompts(repository, {
  resolveReader,
  nowMs = Date.now(),
} = {}) {
  if (!repository || typeof resolveReader !== 'function') return { checked:0, accepted:0, failed:0, results:[] };
  const snapshot = await repository.load();
  const due = [];
  for (const session of Object.values(snapshot.sessionsById || {})) {
    const sources = normalizeSessionDrivePromptSources(session.drivePromptSources);
    for (const binding of sources.bindings) {
      if (!binding.enabled || !binding.fileId || binding.nextCheckAt > nowMs) continue;
      due.push({ sessionId:session.id, binding:structuredClone(binding) });
    }
  }

  const results = [];
  for (const item of due) {
    let outcome = null;
    try {
      const reader = await resolveReader(item.binding);
      const read = await readStableSessionDrivePrompt({
        fileId:item.binding.fileId,
        minChars:item.binding.minChars,
        readMetadata:reader?.readMetadata,
        readContent:reader?.readContent,
      });
      await repository.update(draft => {
        const session = draft.sessionsById?.[item.sessionId];
        if (!session) return draft;
        const sources = normalizeSessionDrivePromptSources(session.drivePromptSources);
        const binding = sources.bindings.find(candidate => candidate.target === item.binding.target);
        if (!binding || !binding.enabled || binding.fileId !== item.binding.fileId) return draft;

        if (binding.lastAcceptedVersion) {
          const order = compareRevision(read.version, binding.lastAcceptedVersion);
          if (order < 0) throw new SessionDrivePromptError('STALE_VERSION', 'Drive prompt version is older than accepted version.');
          if (order === 0 && binding.lastAcceptedHash && binding.lastAcceptedHash !== read.hash) {
            throw new SessionDrivePromptError('VERSION_CONFLICT', 'Same Drive version returned different prompt content.');
          }
        }

        if (read.version !== binding.lastAcceptedVersion || read.hash !== binding.lastAcceptedHash) {
          applyPrompt(session, binding.target, read.content);
          binding.lastAcceptedVersion = read.version;
          binding.lastAcceptedHash = read.hash;
          outcome = 'ACCEPTED';
        } else {
          outcome = 'UNCHANGED';
        }
        binding.lastCheckedAt = nowMs;
        binding.nextCheckAt = nowMs + binding.pollIntervalMs;
        binding.lastErrorCode = '';
        session.drivePromptSources = sources;
        session.updatedAt = Math.max(Number(session.updatedAt || 0), nowMs);
        return draft;
      });
      results.push({ sessionId:item.sessionId,target:item.binding.target,kind:outcome || 'STALE_BINDING' });
    } catch (error) {
      const code = error?.code || 'DRIVE_PROMPT_SYNC_FAILED';
      await repository.update(draft => {
        const session = draft.sessionsById?.[item.sessionId];
        if (!session) return draft;
        const sources = normalizeSessionDrivePromptSources(session.drivePromptSources);
        const binding = sources.bindings.find(candidate => candidate.target === item.binding.target);
        if (!binding || binding.fileId !== item.binding.fileId) return draft;
        binding.lastCheckedAt = nowMs;
        binding.nextCheckAt = nowMs + binding.pollIntervalMs;
        binding.lastErrorCode = code;
        session.drivePromptSources = sources;
        return draft;
      });
      results.push({ sessionId:item.sessionId,target:item.binding.target,kind:'FAILED',error:code });
    }
  }

  return {
    checked:due.length,
    accepted:results.filter(item=>item.kind==='ACCEPTED').length,
    failed:results.filter(item=>item.kind==='FAILED').length,
    results,
  };
}
