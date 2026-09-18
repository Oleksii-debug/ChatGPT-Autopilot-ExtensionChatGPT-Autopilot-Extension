const PROFILE_KEY = 'driveSourceBySessionId';
const PRIMARY_TARGETS = new Set(['primary']);
const PROMPT_2_TARGETS = new Set(['secondary', 'prompt2']);
const PROMPT_3_TARGETS = new Set(['prompt3']);
const DEFAULT_SYNC_INTERVAL_MS = 3 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 60 * 1000;
const MAX_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MINIMUM_CHARACTERS = 1000;
const MAX_MINIMUM_CHARACTERS = 1000000;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeTarget(value) {
  if (PROMPT_3_TARGETS.has(value)) return 'prompt3';
  if (PROMPT_2_TARGETS.has(value)) return 'prompt2';
  return 'primary';
}

function requireSession(state, sessionId) {
  if (!state?.sessionsById?.[sessionId]) throw new Error('Session not found');
  return state.sessionsById[sessionId];
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
    autoSync: source?.autoSync === true,
    syncIntervalMs: boundedInteger(source?.syncIntervalMs, DEFAULT_SYNC_INTERVAL_MS, MIN_SYNC_INTERVAL_MS, MAX_SYNC_INTERVAL_MS),
    minimumCharacters: boundedInteger(source?.minimumCharacters, DEFAULT_MINIMUM_CHARACTERS, 1, MAX_MINIMUM_CHARACTERS),
    nextSyncAt: Number.isFinite(source?.nextSyncAt) && source.nextSyncAt >= 0 ? source.nextSyncAt : 0,
    lastCheckedAt: Number.isFinite(source?.lastCheckedAt) && source.lastCheckedAt >= 0 ? source.lastCheckedAt : 0,
    lastSyncError: typeof source?.lastSyncError === 'string' ? source.lastSyncError : '',
  };
}

export function setDriveSourceConfig(state, sessionId, raw = {}) {
  requireSession(state, sessionId);
  const fileId = String(raw.fileId || '').trim();
  const sourceUrl = String(raw.sourceUrl || '').trim();
  const target = normalizeTarget(raw.target);
  const autoSync = raw.autoSync === true;
  const syncIntervalMs = boundedInteger(raw.syncIntervalMs, DEFAULT_SYNC_INTERVAL_MS, MIN_SYNC_INTERVAL_MS, MAX_SYNC_INTERVAL_MS);
  const minimumCharacters = boundedInteger(raw.minimumCharacters, DEFAULT_MINIMUM_CHARACTERS, 1, MAX_MINIMUM_CHARACTERS);
  if (!fileId) throw new Error('Drive file id is required');
  if (!sourceUrl) throw new Error('Drive source URL is required');
  const bucket = ensureBucket(state);
  const previous = bucket[sessionId];
  const sourceChanged = previous && (previous.fileId !== fileId || previous.sourceUrl !== sourceUrl || previous.target !== target);
  bucket[sessionId] = {
    fileId,
    sourceUrl,
    target,
    lastAcceptedVersion: sourceChanged ? '' : (previous?.lastAcceptedVersion || ''),
    lastAcceptedHash: sourceChanged ? '' : (previous?.lastAcceptedHash || ''),
    lastSyncedAt: sourceChanged ? 0 : (Number(previous?.lastSyncedAt) || 0),
    autoSync,
    syncIntervalMs,
    minimumCharacters,
    nextSyncAt: sourceChanged ? 0 : (Number(previous?.nextSyncAt) || 0),
    lastCheckedAt: sourceChanged ? 0 : (Number(previous?.lastCheckedAt) || 0),
    lastSyncError: sourceChanged ? '' : (typeof previous?.lastSyncError === 'string' ? previous.lastSyncError : ''),
  };
  return getDriveSourceConfig(state, sessionId);
}

function applyPromptTarget(state, session, target, content) {
  if (target === 'prompt2' || target === 'prompt3') {
    if (!state.profile.promptCadenceBySessionId || typeof state.profile.promptCadenceBySessionId !== 'object') {
      state.profile.promptCadenceBySessionId = {};
    }
    const current = state.profile.promptCadenceBySessionId[session.id] || {};
    const legacyPrompt2 = {
      enabled: current.enabled === true,
      prompt: typeof current.secondaryPrompt === 'string' ? current.secondaryPrompt : '',
      everyN: Number.isInteger(Number(current.everyN)) ? Number(current.everyN) : 10,
    };
    const prompts = Array.isArray(current.prompts)
      ? current.prompts.slice(0, 3).map(rule => ({ ...rule }))
      : [{ enabled: false, prompt: '', everyN: 10 }, legacyPrompt2, { enabled: false, prompt: '', everyN: 20 }];
    while (prompts.length < 3) prompts.push({ enabled: false, prompt: '', everyN: prompts.length === 2 ? 20 : 10 });
    const slot = target === 'prompt3' ? 2 : 1;
    prompts[slot] = { ...prompts[slot], prompt: content };
    state.profile.promptCadenceBySessionId[session.id] = {
      ...current,
      prompts,
      ...(slot === 1 ? { secondaryPrompt: content } : {}),
    };
    return;
  }
  if (session.promptMode === 'UNIQUE') {
    session.defaultUniquePrompt = content;
  } else {
    session.sharedPrompt = content;
  }
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
  if (content.length < source.minimumCharacters) {
    throw new Error(`Drive prompt has ${content.length} characters; minimum is ${source.minimumCharacters}.`);
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
  };
  return {
    accepted: true,
    source: getDriveSourceConfig(state, sessionId),
  };
}

export function recordDriveSyncOutcome(state, sessionId, { now = Date.now(), error = '' } = {}) {
  const source = getDriveSourceConfig(state, sessionId);
  const bucket = ensureBucket(state);
  bucket[sessionId] = {
    ...bucket[sessionId],
    lastCheckedAt: now,
    lastSyncError: String(error || ''),
    nextSyncAt: source.autoSync ? now + source.syncIntervalMs : 0,
  };
  return getDriveSourceConfig(state, sessionId);
}

export function nextDriveSyncWake(state, now = Date.now()) {
  let earliest = Infinity;
  for (const [sessionId, session] of Object.entries(state?.sessionsById || {})) {
    if (!['RUNNING', 'RECOVERING'].includes(session?.runState)) continue;
    if (session?.activeFunctions?.drive_source?.enabled !== true) continue;
    const source = getDriveSourceConfig(state, sessionId);
    if (!source.fileId || !source.autoSync) continue;
    earliest = Math.min(earliest, Math.max(now, source.nextSyncAt || 0));
  }
  return earliest < Infinity ? earliest : null;
}

export function dueDriveSourceSessionIds(state, now = Date.now()) {
  const result = [];
  for (const [sessionId, session] of Object.entries(state?.sessionsById || {})) {
    if (!['RUNNING', 'RECOVERING'].includes(session?.runState)) continue;
    if (session?.activeFunctions?.drive_source?.enabled !== true) continue;
    const source = getDriveSourceConfig(state, sessionId);
    if (!source.fileId || !source.autoSync) continue;
    if ((source.nextSyncAt || 0) <= now) result.push(sessionId);
  }
  return result;
}

export const DRIVE_SNAPSHOT_TARGETS = Object.freeze({
  PRIMARY: [...PRIMARY_TARGETS][0],
  PROMPT_2: 'prompt2',
  PROMPT_3: 'prompt3',
  SECONDARY: 'prompt2',
});

export const DRIVE_SYNC_LIMITS = Object.freeze({
  defaultSyncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
  minSyncIntervalMs: MIN_SYNC_INTERVAL_MS,
  maxSyncIntervalMs: MAX_SYNC_INTERVAL_MS,
  defaultMinimumCharacters: DEFAULT_MINIMUM_CHARACTERS,
  maxMinimumCharacters: MAX_MINIMUM_CHARACTERS,
});
