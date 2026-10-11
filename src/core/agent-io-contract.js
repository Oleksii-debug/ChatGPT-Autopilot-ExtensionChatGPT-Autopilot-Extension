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

export function getAgentActionRequiredCapability(actionType) {
  const type = String(actionType || '').trim();
  if (!ACTION_TYPES.has(type)) throw new Error(`Unsupported agent action type: ${type || '(empty)'}`);
  return ACTION_CAPABILITY_REQUIREMENTS[type] || null;
}

export function getAgentEventRequiredCapability(eventType) {
  const type = String(eventType || '').trim();
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

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireId(value, label) {
  const id = String(value || '').trim();
  if (!ID_PATTERN.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function optionalId(value, label) {
  if (value == null || value === '') return null;
  return requireId(value, label);
}

function normalizeTimestamp(value, label) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be an ISO-compatible timestamp`);
  return date.toISOString();
}

function cloneData(value, label) {
  if (value == null) return {};
  requirePlainObject(value, label);
  return structuredClone(value);
}

export function normalizeAgentAction(input) {
  const action = requirePlainObject(input, 'Agent action');
  if (action.schemaVersion !== 1) throw new Error('Unsupported agent action schemaVersion');
  const type = String(action.type || '').trim();
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
  const event = requirePlainObject(input, 'Agent event');
  if (event.schemaVersion !== 1) throw new Error('Unsupported agent event schemaVersion');
  const type = String(event.type || '').trim();
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
  return Object.freeze(normalized);
}

export class AgentActionHandlerRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(providerId, actionType, handler) {
    const type = String(actionType || '').trim();
    const provider = requireProviderCapabilityForAction(providerId, type);
    if (typeof handler !== 'function') throw new Error('Agent action handler must be a function');
    const key = `${provider.id}:${type}`;
    if (this.handlers.has(key)) throw new Error(`Agent action handler already registered: ${key}`);
    this.handlers.set(key, handler);
    return this;
  }

  has(providerId, actionType) {
    return this.handlers.has(`${String(providerId || '').trim()}:${String(actionType || '').trim()}`);
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
