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

const EVENT_CAPABILITY_REQUIREMENTS = Object.freeze({
  [AgentEventType.COMPLETION_OBSERVED]: CapabilityId.ASSISTANT_COMPLETION_PROBE,
  [AgentEventType.RATE_LIMIT_OBSERVED]: CapabilityId.RATE_LIMIT_CLASSIFICATION,
  [AgentEventType.RECOVERY_REQUIRED]: CapabilityId.SAFE_RESTART_RECOVERY,
});

const ACTION_KEYS = new Set(['schemaVersion', 'actionId', 'type', 'providerId', 'sessionId', 'taskId', 'createdAt', 'data']);
const EVENT_KEYS = new Set(['schemaVersion', 'eventId', 'type', 'providerId', 'actionId', 'sessionId', 'taskId', 'occurredAt', 'data']);
const EVENT_SINK_OPTION_KEYS = new Set(['onEvent']);
const MAX_DATA_DEPTH = 16;
const MAX_DATA_NODES = 4096;
const MAX_DATA_ARRAY_ITEMS = 2048;
const MAX_DATA_OBJECT_KEYS = 512;

export function getAgentActionRequiredCapability(actionType) {
  const type = requireExactType(actionType, ACTION_TYPES, 'agent action');
  return ACTION_CAPABILITY_REQUIREMENTS[type] || null;
}

export function getAgentEventRequiredCapability(eventType) {
  const type = requireExactType(eventType, EVENT_TYPES, 'agent event');
  return EVENT_CAPABILITY_REQUIREMENTS[type] || null;
}

function requireProviderCapabilityForAction(providerId, actionType) {
  const exactProviderId = requireId(providerId, 'providerId');
  const capabilityId = getAgentActionRequiredCapability(actionType);
  return capabilityId
    ? requireAgentProviderCapabilities(exactProviderId, [capabilityId])
    : getAgentProvider(exactProviderId);
}

function requireProviderCapabilityForEvent(providerId, eventType) {
  const exactProviderId = requireId(providerId, 'providerId');
  const capabilityId = getAgentEventRequiredCapability(eventType);
  return capabilityId
    ? requireAgentProviderCapabilities(exactProviderId, [capabilityId])
    : getAgentProvider(exactProviderId);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function snapshotRecord(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || (allowedKeys && !allowedKeys.has(key))) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable own data property`);
    }
    Object.defineProperty(out, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function requireExactType(value, allowed, label) {
  if (typeof value !== 'string' || value !== value.trim() || !allowed.has(value)) {
    throw new Error(`Unsupported ${label} type: ${typeof value === 'string' && value ? value : '(invalid)'}`);
  }
  return value;
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
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO-compatible timestamp string`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} must be an ISO-compatible timestamp`);
  return new Date(millis).toISOString();
}

function snapshotPortableData(value, label, state = { nodes: 0, seen: new WeakSet() }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_DATA_NODES) throw new Error(`${label} exceeds portable data node bound`);
  if (depth > MAX_DATA_DEPTH) throw new Error(`${label} exceeds portable data depth bound`);

  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${label} contains a non-canonical number`);
    return value;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} contains unsupported portable data`);
  }
  if (state.seen.has(value)) throw new Error(`${label} must not contain cyclic or aliased object graphs`);
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must use canonical arrays`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DATA_ARRAY_ITEMS) {
      throw new Error(`${label} array exceeds portable data bound`);
    }
    const expected = new Set(['length']);
    for (let index = 0; index < length; index += 1) expected.add(String(index));
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !expected.has(key)) {
        throw new Error(`${label} array contains a non-canonical property`);
      }
    }
    const out = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error(`${label}[${index}] must be an enumerable own data property`);
      }
      out.push(snapshotPortableData(descriptor.value, `${label}[${index}]`, state, depth + 1));
    }
    return Object.freeze(out);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must contain only plain data objects`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > MAX_DATA_OBJECT_KEYS) throw new Error(`${label} object exceeds portable data key bound`);
  const out = {};
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error(`${label} contains a symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable own data property`);
    }
    Object.defineProperty(out, key, {
      value: snapshotPortableData(descriptor.value, `${label}.${key}`, state, depth + 1),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
}

function cloneData(value, label) {
  return snapshotPortableData(value == null ? {} : value, label);
}

export function normalizeAgentAction(input) {
  const action = snapshotRecord(input, 'Agent action', ACTION_KEYS);
  if (action.schemaVersion !== 1) throw new Error('Unsupported agent action schemaVersion');
  const type = requireExactType(action.type, ACTION_TYPES, 'agent action');
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
  const event = snapshotRecord(input, 'Agent event', EVENT_KEYS);
  if (event.schemaVersion !== 1) throw new Error('Unsupported agent event schemaVersion');
  const type = requireExactType(event.type, EVENT_TYPES, 'agent event');
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
  return Object.freeze(normalized);
}

export class AgentActionHandlerRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(providerId, actionType, handler) {
    const type = requireExactType(actionType, ACTION_TYPES, 'agent action');
    const provider = requireProviderCapabilityForAction(providerId, type);
    if (typeof handler !== 'function') throw new Error('Agent action handler must be a function');
    const key = `${provider.id}:${type}`;
    if (this.handlers.has(key)) throw new Error(`Agent action handler already registered: ${key}`);
    this.handlers.set(key, handler);
    return this;
  }

  has(providerId, actionType) {
    if (typeof providerId !== 'string' || !ID_PATTERN.test(providerId) || providerId !== providerId.trim()) return false;
    if (typeof actionType !== 'string' || !ACTION_TYPES.has(actionType) || actionType !== actionType.trim()) return false;
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
  constructor(options = {}) {
    const raw = snapshotRecord(options, 'AgentEventSink options', EVENT_SINK_OPTION_KEYS);
    const onEvent = Object.prototype.hasOwnProperty.call(raw, 'onEvent') ? raw.onEvent : null;
    if (onEvent != null && typeof onEvent !== 'function') throw new Error('onEvent must be a function');
    this.onEvent = onEvent;
  }

  async emit(input) {
    const event = normalizeAgentEvent(input);
    if (this.onEvent) await this.onEvent(event);
    return event;
  }
}
