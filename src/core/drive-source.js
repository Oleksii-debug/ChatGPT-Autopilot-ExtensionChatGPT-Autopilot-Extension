const PROFILE_KEY = 'driveSourceBySessionId';
const PRIMARY_TARGETS = new Set(['primary']);
const SECONDARY_TARGETS = new Set(['secondary']);

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
    target: source?.target === 'secondary' ? 'secondary' : 'primary',
    lastAcceptedVersion: typeof source?.lastAcceptedVersion === 'string' ? source.lastAcceptedVersion : '',
    lastAcceptedHash: typeof source?.lastAcceptedHash === 'string' ? source.lastAcceptedHash : '',
    lastSyncedAt: Number.isFinite(source?.lastSyncedAt) && source.lastSyncedAt >= 0 ? source.lastSyncedAt : 0,
  };
}

export function setDriveSourceConfig(state, sessionId, raw = {}) {
  requireSession(state, sessionId);
  const fileId = String(raw.fileId || '').trim();
  const sourceUrl = String(raw.sourceUrl || '').trim();
  const target = raw.target === 'secondary' ? 'secondary' : 'primary';
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
  };
  return getDriveSourceConfig(state, sessionId);
}

function applyPromptTarget(state, session, target, content) {
  if (target === 'secondary') {
    if (!state.profile.promptCadenceBySessionId || typeof state.profile.promptCadenceBySessionId !== 'object') {
      state.profile.promptCadenceBySessionId = {};
    }
    const current = state.profile.promptCadenceBySessionId[session.id] || { enabled: false, secondaryPrompt: '', everyN: 10 };
    state.profile.promptCadenceBySessionId[session.id] = { ...current, secondaryPrompt: content };
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

export const DRIVE_SNAPSHOT_TARGETS = Object.freeze({
  PRIMARY: [...PRIMARY_TARGETS][0],
  SECONDARY: [...SECONDARY_TARGETS][0],
});
