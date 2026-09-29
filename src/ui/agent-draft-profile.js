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

function dataRecord(value, allowedKeys, label) {
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
}

function snapshotPolicy(input) {
  const raw = dataRecord(input, POLICY_KEYS, 'Політика Agent');
  const out = {};
  const state = { nodes: 0 };
  for (const key of POLICY_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    assertExactPolicyValueType(key, raw[key]);
    out[key] = snapshotJsonValue(raw[key], `Політика Agent.${key}`, state);
  }
  return out;
}

export function parseAgentDraftProfile(input) {
  const raw = dataRecord(input, DRAFT_KEYS, 'Чернетка Agent');
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
