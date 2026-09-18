import { getPromptCadenceConfig, setPromptCadenceConfig } from './prompt-cadence.js';

const PROFILE_KEY = 'driveSourceBySessionId';
const VALID_TARGETS = new Set(['primary', 'prompt2', 'prompt3']);
export const DEFAULT_DRIVE_SYNC_INTERVAL_MINUTES = 3;
export const DEFAULT_DRIVE_MIN_CHARS = 1000;
export const MAX_DRIVE_SYNC_INTERVAL_MINUTES = 1440;
export const MAX_DRIVE_MIN_CHARS = 1000000;

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function writeInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function requireSession(state, sessionId) {
  if (!state?.sessionsById?.[sessionId]) throw new Error('Session not found');
  return state.sessionsById[sessionId];
}

function normalizeTarget(value) {
  if (value === 'secondary') return 'prompt2';
  return VALID_TARGETS.has(value) ? value : 'primary';
}

function normalizeVersion(value) {
  const version = String(value ?? '').trim();
  if (!/^\d+$/.test(version)) throw new Error('Drive version must be a decimal integer');
  return version;
}

function compareVersions(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function ensureBucket(state) {
  if (!state.profile[PROFILE_KEY] || typeof state.profile[PROFILE_KEY] !== 'object') {
    state.profile[PROFILE_KEY] = {};
  }
  return state.profile[PROFILE_KEY];
}

export function getDriveSourceConfig(state, sessionId) {
  requireSession(state, sessionId);
  const source = state?.profile?.[PROFILE_KEY]?.[sessionId];
  return {
    fileId: typeof source?.fileId === 'string' ? source.fileId : '',
    sourceUrl: typeof source?.sourceUrl === 'string' ? source.sourceUrl : '',
    target: normalizeTarget(source?.target),
    lastAcceptedVersion: typeof source?.lastAcceptedVersion === 'string' ? source.lastAcceptedVersion : '',
    lastAcceptedHash: typeof source?.lastAcceptedHash === 'string' ? source.lastAcceptedHash : '',
    lastSyncedAt: Number.isFinite(source?.lastSyncedAt) && source.lastSyncedAt >= 0 ? source.lastSyncedAt : 0,
    lastCheckedAt: Number.isFinite(source?.lastCheckedAt) && source.lastCheckedAt >= 0 ? source.lastCheckedAt : 0,
    lastSyncError: typeof source?.lastSyncError === 'string' ? source.lastSyncError : '',
    autoSyncEnabled: source?.autoSyncEnabled === true,
    syncIntervalMinutes: normalizeInteger(
      source?.syncIntervalMinutes,
      DEFAULT_DRIVE_SYNC_INTERVAL_MINUTES,
      1,
      MAX_DRIVE_SYNC_INTERVAL_MINUTES,
    ),
    minChars: normalizeInteger(source?.minChars, DEFAULT_DRIVE_MIN_CHARS, 1, MAX_DRIVE_MIN_CHARS),
  };
}

export function setDriveSourceConfig(state, sessionId, raw = {}) {
  requireSession(state, sessionId);
  const fileId = String(raw.fileId || '').trim();
  const sourceUrl = String(raw.sourceUrl || '').trim();
  const target = normalizeTarget(raw.target);
  if (!fileId) throw new Error('Drive file id is required');
  if (!sourceUrl) throw new Error('Drive source URL is required');
  const bucket = ensureBucket(state);
  const previous = bucket[sessionId];
  const previousTarget = normalizeTarget(previous?.target);
  const sourceChanged = previous && (previous.fileId !== fileId || previous.sourceUrl !== sourceUrl || previousTarget !== target);
  bucket[sessionId] = {
    fileId,
    sourceUrl,
    target,
    lastAcceptedVersion: sourceChanged ? '' : (previous?.lastAcceptedVersion || ''),
    lastAcceptedHash: sourceChanged ? '' : (previous?.lastAcceptedHash || ''),
    lastSyncedAt: sourceChanged ? 0 : (Number(previous?.lastSyncedAt) || 0),
    lastCheckedAt: sourceChanged ? 0 : (Number(previous?.lastCheckedAt) || 0),
    lastSyncError: sourceChanged ? '' : (typeof previous?.lastSyncError === 'string' ? previous.lastSyncError : ''),
    autoSyncEnabled: raw.autoSyncEnabled === true,
    syncIntervalMinutes: writeInteger(
      raw.syncIntervalMinutes,
      normalizeInteger(previous?.syncIntervalMinutes, DEFAULT_DRIVE_SYNC_INTERVAL_MINUTES, 1, MAX_DRIVE_SYNC_INTERVAL_MINUTES),
      1,
      MAX_DRIVE_SYNC_INTERVAL_MINUTES,
      'Drive sync interval',
    ),
    minChars: writeInteger(
      raw.minChars,
      normalizeInteger(previous?.minChars, DEFAULT_DRIVE_MIN_CHARS, 1, MAX_DRIVE_MIN_CHARS),
      1,
      MAX_DRIVE_MIN_CHARS,
      'Drive minimum prompt length',
    ),
  };
  return getDriveSourceConfig(state, sessionId);
}

function applyPromptTarget(state, session, target, content) {
  if (target === 'prompt2' || target === 'prompt3') {
    const config = getPromptCadenceConfig(state, session.id);
    const index = target === 'prompt2' ? 1 : 2;
    config.prompts[index] = { ...config.prompts[index], prompt: content };
    setPromptCadenceConfig(state, session.id, config);
    return;
  }
  if (session.promptMode === 'UNIQUE') {
    throw new Error('Drive primary prompt target requires shared prompt mode');
  }
  session.sharedPrompt = content;
}

export function acceptDriveSnapshot(state, sessionId, snapshot, { now = Date.now() } = {}) {
  const session = requireSession(state, sessionId);
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Drive snapshot is required');
  const fileId = String(snapshot.fileId || '').trim();
  const version = normalizeVersion(snapshot.version);
  const hash = String(snapshot.hash || '').trim();
  const content = typeof snapshot.content === 'string' ? snapshot.content : '';
  if (!fileId || !hash || !content.trim()) throw new Error('Drive snapshot identity and content are required');

  const source = getDriveSourceConfig(state, sessionId);
  if (content.length < source.minChars) {
    throw new Error(`Drive prompt is shorter than the configured minimum (${content.length} < ${source.minChars})`);
  }
  if (!source.fileId || source.fileId !== fileId) throw new Error('Drive snapshot file does not match the configured source');

  if (source.lastAcceptedVersion) {
    const ordering = compareVersions(version, source.lastAcceptedVersion);
    if (ordering < 0) throw new Error('Drive snapshot is older than the last accepted version');
    if (ordering === 0) {
      if (hash !== source.lastAcceptedHash) throw new Error('Drive version returned different content identity');
      return { accepted: false, reason: 'NOOP', source };
    }
  }

  applyPromptTarget(state, session, source.target, content);
  const bucket = ensureBucket(state);
  bucket[sessionId] = {
    ...bucket[sessionId],
    lastAcceptedVersion: version,
    lastAcceptedHash: hash,
    lastSyncedAt: now,
    lastCheckedAt: now,
    lastSyncError: '',
  };
  return {
    accepted: true,
    source: getDriveSourceConfig(state, sessionId),
  };
}

export const DRIVE_SNAPSHOT_TARGETS = Object.freeze({
  PRIMARY: 'primary',
  PROMPT2: 'prompt2',
  PROMPT3: 'prompt3',
  SECONDARY: 'prompt2',
});


export function recordDriveSyncCheck(state, sessionId, { at = Date.now(), error = '' } = {}) {
  requireSession(state, sessionId);
  const bucket = ensureBucket(state);
  if (!bucket[sessionId]) throw new Error('Drive source is not configured');
  bucket[sessionId] = {
    ...bucket[sessionId],
    lastCheckedAt: at,
    lastSyncError: String(error || ''),
  };
  return getDriveSourceConfig(state, sessionId);
}

export function nextDriveSyncAt(state, sessionId, now = Date.now()) {
  const source = getDriveSourceConfig(state, sessionId);
  if (!source.fileId || !source.autoSyncEnabled) return null;
  if (!source.lastCheckedAt) return now;
  return source.lastCheckedAt + source.syncIntervalMinutes * 60_000;
}
