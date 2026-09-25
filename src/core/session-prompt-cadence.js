export const SESSION_PROMPT_CADENCE_SCHEMA_VERSION = 1;
export const SESSION_PROMPT_CADENCE_MAX_EVERY_N = 1_000_000;

function integer(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

export function defaultSessionPromptCadence() {
  return {
    schemaVersion: SESSION_PROMPT_CADENCE_SCHEMA_VERSION,
    prompt2: { enabled: false, prompt: '', everyN: 10 },
    prompt3: { enabled: false, prompt: '', everyN: 20 },
  };
}

function normalizeRule(raw, fallbackEveryN, label) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = source.enabled === true;
  const prompt = text(source.prompt);
  const everyN = source.everyN === undefined
    ? fallbackEveryN
    : integer(source.everyN, `${label}.everyN`, 2, SESSION_PROMPT_CADENCE_MAX_EVERY_N);
  if (enabled && !prompt.trim()) throw new Error(`Invalid ${label}.prompt`);
  return { enabled, prompt, everyN };
}

export function normalizeSessionPromptCadence(raw = {}) {
  if (raw === undefined || raw === null) return defaultSessionPromptCadence();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid promptCadence');
  const schemaVersion = raw.schemaVersion === undefined
    ? SESSION_PROMPT_CADENCE_SCHEMA_VERSION
    : integer(raw.schemaVersion, 'promptCadence.schemaVersion', 1, 1);
  const allowed = new Set(['schemaVersion', 'prompt2', 'prompt3']);
  const unknown = Object.keys(raw).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Invalid promptCadence field ${unknown[0]}`);
  return {
    schemaVersion,
    prompt2: normalizeRule(raw.prompt2, 10, 'promptCadence.prompt2'),
    prompt3: normalizeRule(raw.prompt3, 20, 'promptCadence.prompt3'),
  };
}

export function promptForVerifiedSendOrdinal(session, primaryPrompt) {
  const config = normalizeSessionPromptCadence(session?.promptCadence);
  const completedVerifiedSends = Number(session?.successfulSendCount || 0);
  if (!Number.isInteger(completedVerifiedSends) || completedVerifiedSends < 0) {
    throw new Error('Invalid successfulSendCount');
  }
  const ordinal = completedVerifiedSends + 1;

  // Deterministic collision rule: Prompt 3 outranks Prompt 2.
  if (config.prompt3.enabled && ordinal % config.prompt3.everyN === 0) {
    return config.prompt3.prompt;
  }
  if (config.prompt2.enabled && ordinal % config.prompt2.everyN === 0) {
    return config.prompt2.prompt;
  }
  return primaryPrompt;
}
