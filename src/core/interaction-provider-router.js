import { AgentProviderId, orchestrationProviderContract } from './capability-registry.js';

function providerIdFromRequest(request, defaultProviderId) {
  if (request == null) return defaultProviderId;
  if (typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Interaction request must be an object');
  }

  const descriptor = Object.getOwnPropertyDescriptor(request, 'providerId');
  if (!descriptor) {
    if (Reflect.has(request, 'providerId')) {
      throw new Error('request.providerId must be an own enumerable data property');
    }
    for (const key of Reflect.ownKeys(request)) {
      if (typeof key === 'symbol' && key.description === 'providerId') {
        throw new Error('request.providerId must use the canonical string field');
      }
    }
    return defaultProviderId;
  }

  if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new Error('request.providerId must be an own enumerable data property');
  }
  return descriptor.value;
}

function snapshotTransportExecutor(transport, providerId) {
  if ((typeof transport !== 'object' || transport === null) && typeof transport !== 'function') {
    throw new Error(`Interaction transport required for ${providerId}`);
  }

  let cursor = transport;
  const visited = new Set();
  while (cursor !== null && cursor !== Object.prototype && cursor !== Function.prototype) {
    if (visited.has(cursor)) {
      throw new Error(`Interaction transport prototype chain is invalid for ${providerId}`);
    }
    visited.add(cursor);

    const descriptor = Object.getOwnPropertyDescriptor(cursor, 'execute');
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || typeof descriptor.value !== 'function') {
        throw new Error(`Interaction transport execute must be a data-property function for ${providerId}`);
      }
      const execute = descriptor.value;
      return (tabId, request) => Reflect.apply(execute, transport, [tabId, request]);
    }

    cursor = Object.getPrototypeOf(cursor);
  }

  throw new Error(`Interaction transport required for ${providerId}`);
}

export class InteractionProviderRouter {
  constructor({ defaultProviderId = AgentProviderId.CHATGPT_BROWSER } = {}) {
    const descriptor = orchestrationProviderContract(defaultProviderId);
    this.defaultProviderId = descriptor.id;
    this.providers = new Map();
  }

  register(providerId, transport) {
    const descriptor = orchestrationProviderContract(providerId);
    const execute = snapshotTransportExecutor(transport, descriptor.id);
    this.providers.set(descriptor.id, execute);
    return this;
  }

  has(providerId) {
    if (typeof providerId !== 'string'
        || providerId.length === 0
        || providerId !== providerId.trim()) {
      return false;
    }
    return this.providers.has(providerId);
  }

  async execute(tabId, request = {}) {
    const providerId = providerIdFromRequest(request, this.defaultProviderId);
    const descriptor = orchestrationProviderContract(providerId);
    const execute = this.providers.get(descriptor.id);
    if (!execute) throw new Error(`No interaction transport registered for ${descriptor.id}`);
    return execute(tabId, request);
  }
}
