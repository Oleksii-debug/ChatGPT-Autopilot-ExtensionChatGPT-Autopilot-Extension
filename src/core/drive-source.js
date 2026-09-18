const PROFILE_KEY = 'driveSourceBySessionId';
const PRIMARY_TARGETS = new Set(['primary']);
const PROMPT_2_TARGETS = new Set(['secondary', 'prompt2']);
const PROMPT_3_TARGETS = new Set(['prompt3']);

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
  PROMPT_2: 'prompt2',
  PROMPT_3: 'prompt3',
  SECONDARY: 'prompt2',
});
