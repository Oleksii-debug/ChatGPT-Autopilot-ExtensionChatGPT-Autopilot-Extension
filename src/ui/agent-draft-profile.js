import { normalizeBrowserAgentConfig } from '../core/browser-agent.js';

export const AGENT_DRAFT_FORMAT = 'chatgpt-autopilot-agent-draft';

const POLICY_KEYS = new Set([
  'startUrl', 'startFromActiveTab', 'maxSteps', 'stepDelayMs',
  'allowCrossOriginNavigation', 'closeOwnedTabsOnStop', 'approvalMode',
  'credentialDecision', 'siteRules', 'visionOnDemand', 'trustedScriptEnabled',
  'acceptanceCriteria', 'repeatMode', 'intervalSeconds', 'scheduleStartAt',
  'scheduleEndAt', 'activeWindowStart', 'activeWindowEnd', 'aiRoutingMode',
  'aiPrimaryProvider', 'aiPrimaryModel', 'aiStrongProvider', 'aiStrongModel',
  'maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens',
  'maxOutputTokensPerCall', 'maxRuntimeMinutes', 'maxCostUsd',
  'inputPricePerMillionUsd', 'outputPricePerMillionUsd',
]);

export function parseAgentDraftProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Очікується JSON-об’єкт чернетки Agent.');
  if (Object.keys(raw).some(key => !['format', 'version', 'goal', 'policy'].includes(key))
    || raw.format !== AGENT_DRAFT_FORMAT || raw.version !== 1) {
    throw new Error('Невідомий формат або версія чернетки Agent.');
  }
  if (typeof raw.goal !== 'string' || !raw.goal.trim() || raw.goal.length > 50000) {
    throw new Error('Завдання Agent має містити від 1 до 50000 символів.');
  }
  if (!raw.policy || typeof raw.policy !== 'object' || Array.isArray(raw.policy)
    || Object.keys(raw.policy).some(key => !POLICY_KEYS.has(key))) {
    throw new Error('Невідоме поле політики Agent; credentials та стан виконання не імпортуються.');
  }
  const config = normalizeBrowserAgentConfig({ ...raw.policy, goal: raw.goal }, { id: 'import-preview' });
  const policy = Object.fromEntries([...POLICY_KEYS].filter(key => key in config).map(key => [key, config[key]]));
  return { format: AGENT_DRAFT_FORMAT, version: 1, goal: raw.goal.trim(), policy };
}

export function makeAgentDraftProfile(goal, policy) {
  return parseAgentDraftProfile({ format: AGENT_DRAFT_FORMAT, version: 1, goal, policy });
}
