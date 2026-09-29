import { normalizeBrowserAgentConfig } from '../core/browser-agent.js';

export const AGENT_DRAFT_FORMAT = 'chatgpt-autopilot-agent-draft';

const DRAFT_KEYS = new Set(['format', 'version', 'goal', 'policy']);
const POLICY_KEYS = new Set([
  'startUrl', 'startFromActiveTab', 'maxSteps', 'stepDelayMs',
  'allowCrossOriginNavigation', 'closeOwnedTabsOnStop', 'approvalMode',
  'credentialDecision', 'siteRules', 'visionOnDemand', 'trustedScriptEnabled',
  'acceptanceCriteria', 'repeatMode', 'intervalSeconds', 'scheduleStartAt',
  'scheduleEndAt', 'activeWindowStart', 'activeWindowEnd', 'aiRoutingMode',
  'aiPrimaryProvider', 'aiPrimaryModel', 'aiStrongProvider', 'aiStrongModel',
  'aiPinnedRouteId',
  'maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens',
  'maxOutputTokensPerCall', 'maxRuntimeMinutes', 'maxCostUsd',
  'inputPricePerMillionUsd', 'outputPricePerMillionUsd',
]);

const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 10000;
const MAX_JSON_STRING_LENGTH = 100000;

const BOOLEAN_POLICY_KEYS = new Set([
  'startFromActiveTab', 'allowCrossOriginNavigation', 'closeOwnedTabsOnStop',
  'visionOnDemand', 'trustedScriptEnabled',
]);
const NUMBER_POLICY_KEYS = new Set([
  'maxSteps', 'stepDelayMs', 'intervalSeconds', 'scheduleStartAt', 'scheduleEndAt',
  'maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens',
  'maxOutputTokensPerCall', 'maxRuntimeMinutes', 'maxCostUsd',
  'inputPricePerMillionUsd', 'outputPricePerMillionUsd',
]);
const STRING_POLICY_KEYS = new Set([
  'startUrl', 'approvalMode', 'credentialDecision', 'repeatMode',
  'activeWindowStart', 'activeWindowEnd', 'aiRoutingMode',
  'aiPrimaryProvider', 'aiPrimaryModel', 'aiStrongProvider', 'aiStrongModel',
  'aiPinnedRouteId',
]);
const ARRAY_POLICY_KEYS = new Set(['siteRules', 'acceptanceCriteria']);

const REPEAT_MODES = new Set(['ONCE', 'CONTINUOUS', 'INTERVAL']);
const APPROVAL_MODES = new Set(['CONSEQUENTIAL', 'ALLOW_ALL']);
const POLICY_DECISIONS = new Set(['ALLOW', 'ASK', 'DENY', 'INHERIT']);
const AI_ROUTING_MODES = new Set(['inherit', 'primary', 'strong', 'hybrid-auto', 'hybrid-rules']);
const AI_PROVIDERS = new Set(['inherit', 'ollama', 'openai', 'openai-compatible']);
const SITE_RULE_KEYS = new Set(['pattern', 'defaultDecision', 'actionDecisions']);

const INTEGER_POLICY_RANGES = Object.freeze({
  maxSteps: [1, 10000],
  stepDelayMs: [0, 60000],
  intervalSeconds: [1, 604800],
  maxModelCalls: [0, 1000000],
  maxInputTokens: [0, 2000000000],
  maxOutputTokens: [0, 2000000000],
  maxTotalTokens: [0, 2000000000],
  maxOutputTokensPerCall: [128, 200000],
  maxRuntimeMinutes: [0, 525600],
});
const NUMBER_POLICY_RANGES = Object.freeze({
  maxCostUsd: [0, 1000000],
  inputPricePerMillionUsd: [0, 1000000],
  outputPricePerMillionUsd: [0, 1000000],
});

function dataRecord(value, allowedKeys, label, unknownFieldMessage = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} має бути JSON-об’єктом.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} має бути звичайним JSON-об’єктом.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      if (unknownFieldMessage) throw new Error(unknownFieldMessage);
      throw new Error(`${label} містить невідоме поле: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} має бути власним JSON-полем без getter/setter.`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function snapshotJsonValue(value, label, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) throw new Error(`${label} перевищує допустимий розмір.`);
  if (depth > MAX_JSON_DEPTH) throw new Error(`${label} має надто велику вкладеність.`);

  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      throw new Error(`${label} містить надто довгий текст.`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`${label} містить неканонічне число.`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} має містити лише JSON-значення.`);
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`${label} має бути звичайним JSON-масивом.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_NODES) {
      throw new Error(`${label} має некоректну довжину.`);
    }
    const out = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`${label} має бути щільним масивом без getter/setter.`);
      }
      out.push(snapshotJsonValue(descriptor.value, `${label}[${index}]`, state, depth + 1));
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === 'length') continue;
      if (typeof key !== 'string'
          || !/^(?:0|[1-9]\d*)$/u.test(key)
          || Number(key) >= length) {
        throw new Error(`${label} містить невідоме поле: ${String(key)}`);
      }
    }
    return out;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`${label} має містити лише звичайні JSON-об’єкти.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} містить symbol-поле.`);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} має бути власним JSON-полем без getter/setter.`);
    }
    out[key] = snapshotJsonValue(descriptor.value, `${label}.${key}`, state, depth + 1);
  }
  return out;
}

function assertCanonicalEnum(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} має канонічне непідтримуване значення.`);
}

function assertExactPolicyValueType(key, value) {
  if (BOOLEAN_POLICY_KEYS.has(key) && typeof value !== 'boolean') {
    throw new Error(`Політика Agent.${key} має бути boolean.`);
  }
  if (NUMBER_POLICY_KEYS.has(key)
      && (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0))) {
    throw new Error(`Політика Agent.${key} має бути канонічним числом.`);
  }
  if (STRING_POLICY_KEYS.has(key) && typeof value !== 'string') {
    throw new Error(`Політика Agent.${key} має бути рядком.`);
  }
  if (ARRAY_POLICY_KEYS.has(key) && !Array.isArray(value)) {
    throw new Error(`Політика Agent.${key} має бути масивом.`);
  }

  if (key === 'repeatMode') assertCanonicalEnum(value, REPEAT_MODES, 'Політика Agent.repeatMode');
  if (key === 'approvalMode') assertCanonicalEnum(value, APPROVAL_MODES, 'Політика Agent.approvalMode');
  if (key === 'credentialDecision') {
    assertCanonicalEnum(value, POLICY_DECISIONS, 'Політика Agent.credentialDecision');
  }
  if (key === 'aiRoutingMode') assertCanonicalEnum(value, AI_ROUTING_MODES, 'Політика Agent.aiRoutingMode');
  if (key === 'aiPrimaryProvider' || key === 'aiStrongProvider') {
    assertCanonicalEnum(value, AI_PROVIDERS, `Політика Agent.${key}`);
  }

  if (Object.hasOwn(INTEGER_POLICY_RANGES, key)) {
    const [min, max] = INTEGER_POLICY_RANGES[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`Політика Agent.${key} виходить за канонічні межі.`);
    }
  }
  if (Object.hasOwn(NUMBER_POLICY_RANGES, key)) {
    const [min, max] = NUMBER_POLICY_RANGES[key];
    if (value < min || value > max) {
      throw new Error(`Політика Agent.${key} виходить за канонічні межі.`);
    }
  }
  if (key === 'scheduleStartAt' || key === 'scheduleEndAt') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Політика Agent.${key} має бути невід’ємним цілим timestamp.`);
    }
  }
  if ((key === 'aiPrimaryModel' || key === 'aiStrongModel')
      && (value !== value.trim() || value.length > 300)) {
    throw new Error(`Політика Agent.${key} має бути канонічним model ID до 300 символів.`);
  }
  if (key === 'aiPinnedRouteId'
      && (value !== value.trim() || value.length > 180)) {
    throw new Error('Політика Agent.aiPinnedRouteId має бути канонічним route ID до 180 символів.');
  }
  if (key === 'startUrl') {
    if (value !== value.trim() || value.length > 4096) {
      throw new Error('Політика Agent.startUrl має бути канонічним URL до 4096 символів.');
    }
    if (value) {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error('Політика Agent.startUrl має бути валідним HTTP(S) URL.');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Політика Agent.startUrl має використовувати HTTP(S).');
      }
      if (parsed.username || parsed.password) {
        throw new Error('Політика Agent.startUrl не може містити credentials.');
      }
      if (parsed.hash) {
        throw new Error('Політика Agent.startUrl не може містити fragment, який буде втрачено.');
      }
    }
  }
  if (key === 'activeWindowStart' || key === 'activeWindowEnd') {
    if (value && !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
      throw new Error(`Політика Agent.${key} має бути канонічним HH:MM.`);
    }
  }
}

function assertCanonicalSiteRules(siteRules) {
  if (siteRules.length > 100) throw new Error('Політика Agent.siteRules перевищує 100 правил.');
  for (let ruleIndex = 0; ruleIndex < siteRules.length; ruleIndex += 1) {
    const rule = siteRules[ruleIndex];
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`Політика Agent.siteRules[${ruleIndex}] має бути JSON-об’єктом.`);
    }
    for (const key of Object.keys(rule)) {
      if (!SITE_RULE_KEYS.has(key)) {
        throw new Error(`Політика Agent.siteRules[${ruleIndex}] містить невідоме поле: ${key}`);
      }
    }
    if (typeof rule.pattern !== 'string' || rule.pattern.length > 500) {
      throw new Error(`Політика Agent.siteRules[${ruleIndex}].pattern має бути рядком до 500 символів.`);
    }
    if (Object.hasOwn(rule, 'defaultDecision')) {
      assertCanonicalEnum(
        rule.defaultDecision,
        POLICY_DECISIONS,
        `Політика Agent.siteRules[${ruleIndex}].defaultDecision`,
      );
    }
    if (Object.hasOwn(rule, 'actionDecisions')) {
      const decisions = rule.actionDecisions;
      if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
        throw new Error(`Політика Agent.siteRules[${ruleIndex}].actionDecisions має бути JSON-об’єктом.`);
      }
      for (const [action, decision] of Object.entries(decisions)) {
        assertCanonicalEnum(
          decision,
          POLICY_DECISIONS,
          `Політика Agent.siteRules[${ruleIndex}].actionDecisions.${action}`,
        );
      }
    }
  }
}

function assertCanonicalAcceptanceCriteria(criteria) {
  if (criteria.length > 20) throw new Error('Політика Agent.acceptanceCriteria перевищує 20 критеріїв.');
  for (let index = 0; index < criteria.length; index += 1) {
    const criterion = criteria[index];
    if (typeof criterion !== 'string' || !criterion.trim() || criterion.length > 1000) {
      throw new Error(`Політика Agent.acceptanceCriteria[${index}] має бути непорожнім рядком до 1000 символів.`);
    }
  }
}

function snapshotPolicy(input) {
  const raw = dataRecord(
    input,
    POLICY_KEYS,
    'Політика Agent',
    'Невідоме поле політики Agent; credentials та стан виконання не імпортуються.',
  );
  const out = {};
  const state = { nodes: 0 };
  for (const key of POLICY_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    assertExactPolicyValueType(key, raw[key]);
    out[key] = snapshotJsonValue(raw[key], `Політика Agent.${key}`, state);
  }
  if (Object.hasOwn(out, 'siteRules')) assertCanonicalSiteRules(out.siteRules);
  if (Object.hasOwn(out, 'acceptanceCriteria')) {
    assertCanonicalAcceptanceCriteria(out.acceptanceCriteria);
  }
  if (Object.hasOwn(out, 'scheduleStartAt')
      && Object.hasOwn(out, 'scheduleEndAt')
      && out.scheduleStartAt > 0
      && out.scheduleEndAt > 0
      && out.scheduleEndAt <= out.scheduleStartAt) {
    throw new Error('Політика Agent.scheduleEndAt має бути пізніше scheduleStartAt.');
  }
  const hasWindowStart = Boolean(out.activeWindowStart);
  const hasWindowEnd = Boolean(out.activeWindowEnd);
  if (hasWindowStart !== hasWindowEnd) {
    throw new Error('Політика Agent active window вимагає і start, і end.');
  }
  return out;
}

export function parseAgentDraftProfile(input) {
  const raw = dataRecord(
    input,
    DRAFT_KEYS,
    'Чернетка Agent',
    'Невідомий формат або невідоме поле чернетки Agent.',
  );
  if (raw.format !== AGENT_DRAFT_FORMAT || raw.version !== 1) {
    throw new Error('Невідомий формат або версія чернетки Agent.');
  }
  if (typeof raw.goal !== 'string' || !raw.goal.trim() || raw.goal.length > 50000) {
    throw new Error('Завдання Agent має містити від 1 до 50000 символів.');
  }
  if (!Object.hasOwn(raw, 'policy')) {
    throw new Error('Чернетка Agent не містить політики.');
  }

  const policyInput = snapshotPolicy(raw.policy);
  const goal = raw.goal.trim();
  const config = normalizeBrowserAgentConfig({ ...policyInput, goal }, { id: 'import-preview' });
  const normalizedState = { nodes: 0 };
  const policy = Object.fromEntries(
    [...POLICY_KEYS]
      .filter(key => Object.hasOwn(config, key))
      .map(key => [
        key,
        snapshotJsonValue(config[key], `Нормалізована політика Agent.${key}`, normalizedState),
      ]),
  );
  return { format: AGENT_DRAFT_FORMAT, version: 1, goal, policy };
}

export function makeAgentDraftProfile(goal, policy) {
  return parseAgentDraftProfile({ format: AGENT_DRAFT_FORMAT, version: 1, goal, policy });
}
