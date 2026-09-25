import { normalizeScenarioWorkConfig } from '../core/scenario-work.js';

export const SCENARIO_PROFILE_FORMAT = 'chatgpt-autopilot-scenario-work';
const MODES = new Set(['CHAT_CYCLE', 'PAIRS', 'AUDITOR_GROUP', 'AUDITOR_PIPELINE']);
const BOUNDS = Object.freeze({
  roundsPerGeneration: [1, 10000], maxGenerations: [0, 10000],
  responseTimeoutMinutes: [1, 1440], pollSeconds: [5, 600],
  minimumLaunchGapSeconds: [0, 3600], preSendDelaySeconds: [1, 30],
  busyCheckDelaySeconds: [1, 30], retryBackoffSeconds: [5, 3600],
  pairCount: [1, 100], workerCount: [1, 200], firstCount: [1, 100],
  secondCount: [0, 100], auditTimeboxMinutes: [1, 1440], maxCorrectionAttempts: [0, 10],
});

export function makeScenarioWorkProfile(config) {
  const { id, ...portable } = normalizeScenarioWorkConfig(config);
  return { format: SCENARIO_PROFILE_FORMAT, version: 1, config: portable };
}

export function parseScenarioWorkProfile(text) {
  if (typeof text !== 'string' || text.length > 10_000_000) throw new Error('Файл сценарію перевищує 10 МБ.');
  let profile;
  try { profile = JSON.parse(text); } catch { throw new Error('Файл сценарію не є коректним JSON.'); }
  if (!profile || Array.isArray(profile) || profile.format !== SCENARIO_PROFILE_FORMAT || profile.version !== 1
      || !profile.config || Array.isArray(profile.config) || typeof profile.config !== 'object') {
    throw new Error('Невідомий формат або версія конфігурації сценарію.');
  }
  const raw = profile.config;
  if (!MODES.has(raw.mode)) throw new Error('Невідомий формат сценарію.');
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || raw[key] < min || raw[key] > max)) {
      throw new Error(`Некоректне значення ${key}: потрібно ціле число ${min}–${max}.`);
    }
  }
  if (raw.mode === 'CHAT_CYCLE') {
    if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 10000
        || raw.steps.some(step => !step || typeof step.prompt !== 'string' || !step.prompt.trim()
          || !Number.isSafeInteger(step.repeat) || step.repeat < 1 || step.repeat > 10000)) {
      throw new Error('Потрібен принаймні один непорожній промпт із коректною кількістю повторів.');
    }
  }
  const { id, ...config } = normalizeScenarioWorkConfig(raw);
  // A profile is configuration only. Creating a fresh scenario establishes new runtime and identity.
  return config;
}
