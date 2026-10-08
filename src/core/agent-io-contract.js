import { CapabilityId, getAgentProvider, requireAgentProviderCapabilities } from './capability-registry.js';

export const AgentActionType = Object.freeze({
  SUBMIT_PROMPT: 'submit-prompt',
  PROBE_COMPLETION: 'probe-completion',
  RECOVER_INTERACTION: 'recover-interaction',
});

export const AgentEventType = Object.freeze({
  ACTION_STARTED: 'action-started',
  ACTION_SUCCEEDED: 'action-succeeded',
  ACTION_FAILED: 'action-failed',
  COMPLETION_OBSERVED: 'completion-observed',
  RATE_LIMIT_OBSERVED: 'rate-limit-observed',
  RECOVERY_REQUIRED: 'recovery-required',
});

const ACTION_TYPES = new Set(Object.values(AgentActionType));
const EVENT_TYPES = new Set(Object.values(AgentEventType));

const ACTION_CAPABILITY_REQUIREMENTS = Object.freeze({
  [AgentActionType.SUBMIT_PROMPT]: CapabilityId.VERIFIED_PROMPT_SUBMIT,
  [AgentActionType.PROBE_COMPLETION]: CapabilityId.ASSISTANT_COMPLETION_PROBE,
  [AgentActionType.RECOVER_INTERACTION]: CapabilityId.SAFE_RESTART_RECOVERY,
});

const ACTION_LINKED_EVENT_TYPES = new Set([
  AgentEventType.ACTION_STARTED,
  AgentEventType.ACTION_SUCCEEDED,
  AgentEventType.ACTION_FAILED,
]);

const EVENT_CAPABILITY_REQUIREMENTS = Object.freeze({
  [AgentEventType.COMPLETION_OBSERVED]: CapabilityId.ASSISTANT_COMPLETION_PROBE,
  [AgentEventType.RATE_LIMIT_OBSERVED]: CapabilityId.RATE_LIMIT_CLASSIFICATION,
  [AgentEventType.RECOVERY_REQUIRED]: CapabilityId.SAFE_RESTART_RECOVERY,
});

export function getAgentActionRequiredCapability(actionType) {
  const type = typeof actionType === 'string' ? actionType.trim() : '';
  if (!ACTION_TYPES.has(type)) throw new Error(`Unsupported agent action type: ${type || '(empty)'}`);
  return ACTION_CAPABILITY_REQUIREMENTS[type] || null;
}

export function getAgentEventRequiredCapability(eventType) {
  const type = typeof eventType === 'string' ? eventType.trim() : '';
  if (!EVENT_TYPES.has(type)) throw new Error(`Unsupported agent event type: ${type || '(empty)'}`);
  return EVENT_CAPABILITY_REQUIREMENTS[type] || null;
}

function requireProviderCapabilityForAction(providerId, actionType) {
  const capabilityId = getAgentActionRequiredCapability(actionType);
  return capabilityId
    ? requireAgentProviderCapabilities(providerId, [capabilityId])
    : getAgentProvider(providerId);
}

function requireProviderCapabilityForEvent(providerId, eventType) {
  const capabilityId = getAgentEventRequiredCapability(eventType);
  return capabilityId
    ? requireAgentProviderCapabilities(providerId, [capabilityId])
    : getAgentProvider(providerId);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_FIELDS = new Set(['schemaVersion', 'actionId', 'type', 'providerId', 'sessionId', 'taskId', 'createdAt', 'data']);
const EVENT_FIELDS = new Set(['schemaVersion', 'eventId', 'type', 'providerId', 'actionId', 'sessionId', 'taskId', 'occurredAt', 'data']);
const FORBIDDEN_DATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DATA_BYTES = 65_536;
const MAX_DATA_DEPTH = 16;
const MAX_DATA_NODES = 8_192;

function requirePlainObject(value, label, allowed = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be a plain object`);
  }
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed && !allowed.has(key))) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function requireId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalId(value, label) {
  if (value == null || value === '') return null;
  return requireId(value, label);
}

function normalizeTimestamp(value, label) {
  // An event's chronology is evidence. Date.parse accepts ambiguous shorthand
  // and can silently roll impossible calendar days into another month; neither
  // is a trustworthy durable event timestamp.
  const format = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
  if (typeof value !== 'string' || !format.test(value)) {
    throw new Error(`${label} must be an ISO timestamp with an explicit timezone`);
  }
  const wallClock = value.slice(0, 19);
  const calendar = new Date(wallClock + 'Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== wallClock) {
    throw new Error(`${label} contains an invalid calendar date`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be an ISO-compatible timestamp`);
  return date.toISOString();
}

function cloneData(value, label) {
  if (value == null) return {};
  const seen = new Set();
  let visited = 0;
  function copy(item, depth) {
    if (++visited > MAX_DATA_NODES || depth > MAX_DATA_DEPTH) throw new Error(`${label} exceeds structural bounds`);
    if (item == null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) throw new Error(`${label} must be an acyclic JSON data value`);
    seen.add(item);
    let output;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > MAX_DATA_NODES) throw new Error(`${label} must be a bounded plain array`);
      const keys = Reflect.ownKeys(item);
      if (keys.length !== item.length + 1) throw new Error(`${label} contains non-canonical array fields`);
      output = [];
      for (let i = 0; i < item.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(`${label} contains sparse/accessor array entries`);
        output.push(copy(descriptor.value, depth + 1));
      }
    } else {
      const record = requirePlainObject(item, label);
      output = {};
      for (const key of Object.keys(record)) {
        if (FORBIDDEN_DATA_KEYS.has(key)) throw new Error(`${label} contains unsafe property key`);
        Object.defineProperty(output, key, { value: copy(record[key], depth + 1), enumerable: true, writable: true, configurable: true });
      }
    }
    seen.delete(item);
    return output;
  }
  const result = copy(value, 0);
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error(`${label} must be a plain object`);
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_DATA_BYTES) {
    throw new Error(`${label} exceeds size limit`);
  }
  function freeze(item) {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  }
  return freeze(result);
}

export function normalizeAgentAction(input) {
  const action = requirePlainObject(input, 'Agent action', ACTION_FIELDS);
  if (action.schemaVersion !== 1) throw new Error('Unsupported agent action schemaVersion');
  const type = typeof action.type === 'string' ? action.type.trim() : '';
  if (!ACTION_TYPES.has(type)) throw new Error(`Unsupported agent action type: ${type || '(empty)'}`);
  const providerId = requireId(action.providerId, 'providerId');
  requireProviderCapabilityForAction(providerId, type);
  const normalized = {
    schemaVersion: 1,
    actionId: requireId(action.actionId, 'actionId'),
    type,
    providerId,
    sessionId: optionalId(action.sessionId, 'sessionId'),
    taskId: optionalId(action.taskId, 'taskId'),
    createdAt: normalizeTimestamp(action.createdAt, 'createdAt'),
    data: cloneData(action.data, 'action data'),
  };
  return Object.freeze(normalized);
}

export function normalizeAgentEvent(input) {
  const event = requirePlainObject(input, 'Agent event', EVENT_FIELDS);
  if (event.schemaVersion !== 1) throw new Error('Unsupported agent event schemaVersion');
  const type = typeof event.type === 'string' ? event.type.trim() : '';
  if (!EVENT_TYPES.has(type)) throw new Error(`Unsupported agent event type: ${type || '(empty)'}`);
  const providerId = requireId(event.providerId, 'providerId');
  requireProviderCapabilityForEvent(providerId, type);
  const normalized = {
    schemaVersion: 1,
    eventId: requireId(event.eventId, 'eventId'),
    type,
    providerId,
    actionId: optionalId(event.actionId, 'actionId'),
    sessionId: optionalId(event.sessionId, 'sessionId'),
    taskId: optionalId(event.taskId, 'taskId'),
    occurredAt: normalizeTimestamp(event.occurredAt, 'occurredAt'),
    data: cloneData(event.data, 'event data'),
  };
  if (ACTION_LINKED_EVENT_TYPES.has(type) && normalized.actionId === null) {
    throw new Error('Agent action lifecycle event requires an exact actionId');
  }
  return Object.freeze(normalized);
}

export class AgentActionHandlerRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(providerId, actionType, handler) {
    const type = typeof actionType === 'string' ? actionType.trim() : '';
    const provider = requireProviderCapabilityForAction(providerId, type);
    if (typeof handler !== 'function') throw new Error('Agent action handler must be a function');
    const key = `${provider.id}:${type}`;
    if (this.handlers.has(key)) throw new Error(`Agent action handler already registered: ${key}`);
    this.handlers.set(key, handler);
    return this;
  }

  has(providerId, actionType) {
    if (typeof providerId !== 'string' || typeof actionType !== 'string') return false;
    // A capability probe must agree with execute(): whitespace aliases in
    // provider identity are not valid durable provider IDs.
    if (providerId !== providerId.trim() || actionType !== actionType.trim()
        || !ID_PATTERN.test(providerId) || !ACTION_TYPES.has(actionType)) return false;
    return this.handlers.has(`${providerId}:${actionType}`);
  }

  async execute(input, context = {}) {
    const action = normalizeAgentAction(input);
    const handler = this.handlers.get(`${action.providerId}:${action.type}`);
    if (!handler) throw new Error(`No agent action handler registered for ${action.providerId}:${action.type}`);
    return handler(action, context);
  }
}

export class AgentEventSink {
  constructor({ onEvent = null } = {}) {
    if (onEvent != null && typeof onEvent !== 'function') throw new Error('onEvent must be a function');
    this.onEvent = onEvent;
  }

  async emit(input) {
    const event = normalizeAgentEvent(input);
    if (this.onEvent) await this.onEvent(event);
    return event;
  }
}
