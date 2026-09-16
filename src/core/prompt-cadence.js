const PROFILE_KEY = 'promptCadenceBySessionId';
const MAX_PROMPTS = 3;
const MAX_EVERY_N = 1000000;

function normalizeEveryN(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2) return 10;
  return Math.min(parsed, MAX_EVERY_N);
}

function normalizePromptRule(raw = {}) {
  return {
    enabled: raw.enabled === true,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    everyN: normalizeEveryN(raw.everyN),
  };
}

function normalizeChatFlow(raw = {}) {
  const mode = ['same-chat', 'new-chat-after', 'staged'].includes(raw.mode) ? raw.mode : 'same-chat';
  return {
    enabled: raw.enabled === true,
    mode,
    newChatEveryN: normalizeEveryN(raw.newChatEveryN),
    continuePrompt: typeof raw.continuePrompt === 'string' ? raw.continuePrompt : 'продовжуй',
    continueCount: Number.isInteger(Number(raw.continueCount)) && Number(raw.continueCount) >= 0
      ? Math.min(Number(raw.continueCount), MAX_EVERY_N)
      : 10,
    stage2Prompt: typeof raw.stage2Prompt === 'string' ? raw.stage2Prompt : '',
    stage2Count: Number.isInteger(Number(raw.stage2Count)) && Number(raw.stage2Count) >= 1
      ? Math.min(Number(raw.stage2Count), MAX_EVERY_N)
      : 10,
  };
}

export function normalizePromptCadenceConfig(raw = {}) {
  const legacySecondary = normalizePromptRule({
    enabled: raw.enabled === true,
    prompt: raw.secondaryPrompt,
    everyN: raw.everyN,
  });
  const prompts = Array.isArray(raw.prompts)
    ? raw.prompts.slice(0, MAX_PROMPTS).map(normalizePromptRule)
    : [
      { enabled: false, prompt: '', everyN: 10 },
      legacySecondary,
      { enabled: false, prompt: '', everyN: 20 },
    ];
  while (prompts.length < MAX_PROMPTS) prompts.push({ enabled: false, prompt: '', everyN: 10 });

  return {
    enabled: prompts.some(rule => rule.enabled),
    prompts,
    chatFlow: normalizeChatFlow(raw.chatFlow),
  };
}

export function getPromptCadenceConfig(state, sessionId) {
  return normalizePromptCadenceConfig(state?.profile?.[PROFILE_KEY]?.[sessionId] || {});
}

export function setPromptCadenceConfig(state, sessionId, rawConfig) {
  if (!state?.sessionsById?.[sessionId]) throw new Error('Session not found');
  if (!state.profile[PROFILE_KEY] || typeof state.profile[PROFILE_KEY] !== 'object') state.profile[PROFILE_KEY] = {};
  const config = normalizePromptCadenceConfig(rawConfig);
  if (rawConfig && rawConfig.chatFlow) config.chatFlow.enabled = rawConfig.chatFlow.enabled === true || rawConfig.chatFlow.enabled === undefined;
  for (const [index, rule] of config.prompts.entries()) {
    if (rule.enabled && !rule.prompt.trim()) throw new Error(`Промт ${index + 1} не може бути порожнім.`);
  }
  if (config.chatFlow.enabled && config.chatFlow.mode === 'staged' && !config.chatFlow.stage2Prompt.trim()) {
    throw new Error('Для етапного режиму потрібно вказати другий промт.');
  }
  state.profile[PROFILE_KEY][sessionId] = config;
  return config;
}

function stagedPrompt(config, verifiedCount, primaryPrompt) {
  const flow = config.chatFlow;
  if (!flow.enabled || flow.mode !== 'staged') return null;
  const stageOneTotal = 1 + flow.continueCount;
  if (verifiedCount < stageOneTotal) return verifiedCount === 0 ? primaryPrompt : flow.continuePrompt;
  return flow.stage2Prompt;
}

function cadencePrompt(config, verifiedCount, primaryPrompt) {
  const staged = stagedPrompt(config, verifiedCount, primaryPrompt);
  if (staged !== null) return staged;
  const ordinal = verifiedCount + 1;
  const enabled = config.prompts.filter(rule => rule.enabled && rule.prompt.trim());
  for (let index = enabled.length - 1; index >= 0; index -= 1) {
    const rule = enabled[index];
    if (ordinal % rule.everyN === 0) return rule.prompt;
  }
  return primaryPrompt;
}

export function projectPromptForSession(state, session) {
  const config = getPromptCadenceConfig(state, session.id);
  const verifiedCount = Number.isInteger(session.cadenceVerifiedSendCount) && session.cadenceVerifiedSendCount >= 0
    ? session.cadenceVerifiedSendCount
    : 0;
  const primaryPrompt = session.sharedPrompt || '';
  const prompt = cadencePrompt(config, verifiedCount, primaryPrompt);
  if (!prompt) return session;
  if (session.promptMode === 'UNIQUE') {
    for (const task of Object.values(session.tasksById || {})) task.promptOverride = prompt;
  } else {
    session.sharedPrompt = prompt;
  }
  return session;
}

function snapshotVerifiedTimes(state) {
  return Object.fromEntries(Object.entries(state?.sessionsById || {}).map(([id, session]) => [id, session.lastSuccessfulSendAt || 0]));
}

function accountVerifiedTransitions(state, beforeTimes) {
  for (const [id, session] of Object.entries(state?.sessionsById || {})) {
    const before = beforeTimes[id] || 0;
    const after = session.lastSuccessfulSendAt || 0;
    if (after > before) {
      const prior = Number.isInteger(session.cadenceVerifiedSendCount) && session.cadenceVerifiedSendCount >= 0 ? session.cadenceVerifiedSendCount : 0;
      session.cadenceVerifiedSendCount = prior + 1;
      const config = getPromptCadenceConfig(state, id);
      if (config.chatFlow.enabled && config.chatFlow.mode === 'staged') {
        const stageOneTotal = 1 + config.chatFlow.continueCount;
        const stageTwoTotal = config.chatFlow.stage2Count;
        if (session.cadenceVerifiedSendCount >= stageOneTotal + stageTwoTotal) session.runState = 'STOPPED';
      }
    }
  }
  return state;
}

export class CadencedRepository {
  constructor(baseRepository) { this.base = baseRepository; }

  async load() {
    const state = await this.base.load();
    for (const session of Object.values(state?.sessionsById || {})) projectPromptForSession(state, session);
    return state;
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

export const PROMPT_CADENCE_MAX_PROMPTS = MAX_PROMPTS;
export const PROMPT_CADENCE_MAX_EVERY_N = MAX_EVERY_N;
