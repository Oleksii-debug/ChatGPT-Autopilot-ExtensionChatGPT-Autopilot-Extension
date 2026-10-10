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

export class InteractionProviderRouter {
  constructor({ defaultProviderId = AgentProviderId.CHATGPT_BROWSER } = {}) {
    const descriptor = orchestrationProviderContract(defaultProviderId);
    this.defaultProviderId = descriptor.id;
    this.providers = new Map();
  }

  register(providerId, transport) {
    const descriptor = orchestrationProviderContract(providerId);
    if (!transport || typeof transport.execute !== 'function') throw new Error(`Interaction transport required for ${providerId}`);
    this.providers.set(descriptor.id, transport);
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
    const transport = this.providers.get(descriptor.id);
    if (!transport) throw new Error(`No interaction transport registered for ${descriptor.id}`);
    return transport.execute(tabId, request);
  }
}
