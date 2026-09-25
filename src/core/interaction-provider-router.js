import { AgentProviderId, orchestrationProviderContract } from './capability-registry.js';

export class InteractionProviderRouter {
  constructor({ defaultProviderId = AgentProviderId.CHATGPT_BROWSER } = {}) {
    this.defaultProviderId = defaultProviderId;
    this.providers = new Map();
  }

  register(providerId, transport) {
    const descriptor = orchestrationProviderContract(providerId);
    if (!transport || typeof transport.execute !== 'function') throw new Error(`Interaction transport required for ${providerId}`);
    this.providers.set(descriptor.id, transport);
    return this;
  }

  has(providerId) {
    return this.providers.has(String(providerId || '').trim());
  }

  async execute(tabId, request = {}) {
    const providerId = String(request?.providerId || this.defaultProviderId || '').trim();
    orchestrationProviderContract(providerId);
    const transport = this.providers.get(providerId);
    if (!transport) throw new Error(`No interaction transport registered for ${providerId}`);
    return transport.execute(tabId, request);
  }
}
