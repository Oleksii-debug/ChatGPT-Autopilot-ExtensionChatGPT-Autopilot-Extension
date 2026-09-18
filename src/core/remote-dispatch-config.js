import { normalizeRemoteDispatch } from './remote-dispatch.js';

export const REMOTE_DISPATCH_CONFIG_STORAGE_KEY = 'autopilotRemoteDispatchConfig';
export const REMOTE_DISPATCH_CACHE_STORAGE_KEY = 'autopilotRemoteDispatchCache';
export const REMOTE_DISPATCH_CONFIG_SCHEMA_VERSION = 1;
export const REMOTE_DISPATCH_CACHE_SCHEMA_VERSION = 1;

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export const DEFAULT_REMOTE_DISPATCH_CONFIG = Object.freeze({
  schemaVersion: REMOTE_DISPATCH_CONFIG_SCHEMA_VERSION,
  enabled: false,
  intakePaused: false,
  provider: 'github-issue',
  projectId: '',
  repository: '',
  issueNumber: 0,
  minimumPollIntervalSeconds: 300,
  fallbackEnabled: true,
  fallbackAfterSeconds: 900,
  fallbackSessionId: '',
  autoStart: true,
});

function boundedInteger(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function normalizeRemoteDispatchConfig(raw = {}) {
  const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const config = {
    schemaVersion: REMOTE_DISPATCH_CONFIG_SCHEMA_VERSION,
    enabled: candidate.enabled === true,
    intakePaused: candidate.intakePaused === true,
    provider: candidate.provider === 'github-issue' ? 'github-issue' : 'github-issue',
    projectId: typeof candidate.projectId === 'string' ? candidate.projectId.trim().slice(0, 200) : '',
    repository: typeof candidate.repository === 'string' ? candidate.repository.trim().slice(0, 300) : '',
    issueNumber: boundedInteger(candidate.issueNumber, 0, 0, Number.MAX_SAFE_INTEGER),
    minimumPollIntervalSeconds: boundedInteger(candidate.minimumPollIntervalSeconds, 300, 180, 3600),
    fallbackEnabled: candidate.fallbackEnabled !== false,
    fallbackAfterSeconds: boundedInteger(candidate.fallbackAfterSeconds, 900, 180, 86_400),
    fallbackSessionId: typeof candidate.fallbackSessionId === 'string' ? candidate.fallbackSessionId.trim().slice(0, 300) : '',
    autoStart: candidate.autoStart !== false,
  };
  if (config.fallbackAfterSeconds < config.minimumPollIntervalSeconds) config.fallbackAfterSeconds = config.minimumPollIntervalSeconds;
  return config;
}

export function validateRemoteDispatchConfig(config) {
  const normalized = normalizeRemoteDispatchConfig(config);
  if (normalized.enabled) {
    if (!normalized.projectId) throw new Error('Remote Dispatch project_id is required');
    if (!REPOSITORY_RE.test(normalized.repository)) throw new Error('Remote Dispatch GitHub repository must be owner/repo');
    if (!Number.isInteger(normalized.issueNumber) || normalized.issueNumber < 1) throw new Error('Remote Dispatch GitHub issue number is required');
  }
  return normalized;
}

export class RemoteDispatchConfigRepository {
  constructor(chromeApi) { this.chrome = chromeApi; }
  async load() {
    const record = await this.chrome.storage.local.get(REMOTE_DISPATCH_CONFIG_STORAGE_KEY);
    return normalizeRemoteDispatchConfig(record[REMOTE_DISPATCH_CONFIG_STORAGE_KEY]);
  }
  async save(config) {
    const normalized = validateRemoteDispatchConfig(config);
    await this.chrome.storage.local.set({ [REMOTE_DISPATCH_CONFIG_STORAGE_KEY]: normalized });
    return normalized;
  }
}

export class RemoteDispatchCacheRepository {
  constructor(chromeApi) { this.chrome = chromeApi; }
  async load() {
    const record = await this.chrome.storage.local.get(REMOTE_DISPATCH_CACHE_STORAGE_KEY);
    const raw = record[REMOTE_DISPATCH_CACHE_STORAGE_KEY];
    if (raw === undefined) return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== REMOTE_DISPATCH_CACHE_SCHEMA_VERSION) throw new Error('Remote Dispatch cache is corrupt');
    const dispatch = normalizeRemoteDispatch(raw.dispatch);
    return {
      schemaVersion: REMOTE_DISPATCH_CACHE_SCHEMA_VERSION,
      projectId: String(raw.projectId || ''),
      commentId: String(raw.commentId || ''),
      cachedAt: Number(raw.cachedAt || 0),
      dispatch,
    };
  }
  async save({ projectId, commentId = '', cachedAt = Date.now(), dispatch }) {
    const normalized = normalizeRemoteDispatch(dispatch);
    if (normalized.project_id !== projectId) throw new Error('Refusing to cache dispatch for another project');
    const record = { schemaVersion: REMOTE_DISPATCH_CACHE_SCHEMA_VERSION, projectId, commentId: String(commentId || ''), cachedAt, dispatch: normalized };
    await this.chrome.storage.local.set({ [REMOTE_DISPATCH_CACHE_STORAGE_KEY]: record });
    return record;
  }
  async clear() { await this.chrome.storage.local.remove?.(REMOTE_DISPATCH_CACHE_STORAGE_KEY); }
}
