const PROFILE_KEY = 'promptCadenceBySessionId';

function normalizeEveryN(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2) return 10;
  return Math.min(parsed, 1000000);
}

export function normalizePromptCadenceConfig(raw = {}) {
  return {
    enabled: raw.enabled === true,
    secondaryPrompt: typeof raw.secondaryPrompt === 'string' ? raw.secondaryPrompt : '',
    everyN: normalizeEveryN(raw.everyN),
  };
}

export function getPromptCadenceConfig(state, sessionId) {
  return normalizePromptCadenceConfig(state?.profile?.[PROFILE_KEY]?.[sessionId] || {});
}

export function setPromptCadenceConfig(state, sessionId, rawConfig) {
  if (!state?.sessionsById?.[sessionId]) throw new Error('Session not found');
  if (!state.profile[PROFILE_KEY] || typeof state.profile[PROFILE_KEY] !== 'object') {
    state.profile[PROFILE_KEY] = {};
  }
  const config = normalizePromptCadenceConfig(rawConfig);
  if (config.enabled && !config.secondaryPrompt.trim()) throw new Error('Alternate prompt is required when cadence is enabled');
  state.profile[PROFILE_KEY][sessionId] = config;
  return config;
}

function cadenceDue(state, session) {
  const config = getPromptCadenceConfig(state, session.id);
  if (!config.enabled || !config.secondaryPrompt.trim()) return null;
  const verifiedCount = Number.isInteger(session.cadenceVerifiedSendCount) && session.cadenceVerifiedSendCount >= 0
    ? session.cadenceVerifiedSendCount
    : 0;
  const nextOrdinal = verifiedCount + 1;
  return nextOrdinal % config.everyN === 0 ? config : null;
}

function applyCadenceProjection(state) {
  for (const session of Object.values(state?.sessionsById || {})) {
    const due = cadenceDue(state, session);
    if (!due) continue;
    session.sharedPrompt = due.secondaryPrompt;
    for (const task of Object.values(session.tasksById || {})) {
      task.promptOverride = due.secondaryPrompt;
    }
  }
  return state;
}

function snapshotVerifiedTimes(state) {
  return Object.fromEntries(Object.entries(state?.sessionsById || {}).map(([id, session]) => [id, session.lastSuccessfulSendAt || 0]));
}

function accountVerifiedTransitions(state, beforeTimes) {
  for (const [id, session] of Object.entries(state?.sessionsById || {})) {
    const before = beforeTimes[id] || 0;
    const after = session.lastSuccessfulSendAt || 0;
    if (after > before) {
      const prior = Number.isInteger(session.cadenceVerifiedSendCount) && session.cadenceVerifiedSendCount >= 0
        ? session.cadenceVerifiedSendCount
        : 0;
      session.cadenceVerifiedSendCount = prior + 1;
    }
  }
  return state;
}

export class CadencedRepository {
  constructor(baseRepository) {
    this.base = baseRepository;
  }

  async load() {
    const state = await this.base.load();
    return applyCadenceProjection(state);
  }

  async update(mutator) {
    return this.base.update(async draft => {
      const beforeTimes = snapshotVerifiedTimes(draft);
      const result = await mutator(draft);
      const next = result || draft;
      return accountVerifiedTransitions(next, beforeTimes);
    });
  }
}
