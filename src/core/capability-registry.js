import { SiteAdapterId, requireSiteAdapterUrl } from './site-adapter-registry.js';

export const CapabilityId = Object.freeze({
  PERSISTENT_CONVERSATION_URL: 'persistent-conversation-url',
  VERIFIED_PROMPT_SUBMIT: 'verified-prompt-submit',
  ASSISTANT_COMPLETION_PROBE: 'assistant-completion-probe',
  MANAGED_BROWSER_TAB: 'managed-browser-tab',
  RATE_LIMIT_CLASSIFICATION: 'rate-limit-classification',
  SAFE_RESTART_RECOVERY: 'safe-restart-recovery',
});

export const AgentProviderId = Object.freeze({
  CHATGPT_BROWSER: 'chatgpt-browser',
});

const DESCRIPTORS = Object.freeze({
  [AgentProviderId.CHATGPT_BROWSER]: Object.freeze({
    id: AgentProviderId.CHATGPT_BROWSER,
    label: 'ChatGPT Web',
    kind: 'browser-agent',
    version: 1,
    defaultLaunchUrl: 'https://chatgpt.com/',
    siteAdapterId: SiteAdapterId.CHATGPT_WEB,
    capabilities: Object.freeze([
      CapabilityId.PERSISTENT_CONVERSATION_URL,
      CapabilityId.VERIFIED_PROMPT_SUBMIT,
      CapabilityId.ASSISTANT_COMPLETION_PROBE,
      CapabilityId.MANAGED_BROWSER_TAB,
      CapabilityId.RATE_LIMIT_CLASSIFICATION,
      CapabilityId.SAFE_RESTART_RECOVERY,
    ]),
  }),
});

function requireExactProviderId(providerId) {
  if (typeof providerId !== 'string'
      || providerId.length === 0
      || providerId !== providerId.trim()) {
    throw new Error('Agent provider ID must use exact canonical text representation');
  }
  return providerId;
}

export function listAgentProviders() {
  return Object.values(DESCRIPTORS).map(item => ({ ...item, capabilities: [...item.capabilities] }));
}

export function getAgentProvider(providerId) {
  const id = requireExactProviderId(providerId);
  const descriptor = DESCRIPTORS[id];
  if (!descriptor) throw new Error(`Unsupported agent provider: ${id}`);
  return { ...descriptor, capabilities: [...descriptor.capabilities] };
}

export function providerHasCapability(providerId, capabilityId) {
  const descriptor = getAgentProvider(providerId);
  return descriptor.capabilities.includes(capabilityId);
}

export function requireAgentProviderCapabilities(providerId, required = []) {
  const descriptor = getAgentProvider(providerId);
  const missing = [...new Set(required)].filter(capability => !descriptor.capabilities.includes(capability));
  if (missing.length) throw new Error(`Agent provider ${providerId} lacks capabilities: ${missing.join(', ')}`);
  return descriptor;
}

export function orchestrationProviderContract(providerId) {
  return requireAgentProviderCapabilities(providerId, [
    CapabilityId.PERSISTENT_CONVERSATION_URL,
    CapabilityId.VERIFIED_PROMPT_SUBMIT,
    CapabilityId.ASSISTANT_COMPLETION_PROBE,
    CapabilityId.MANAGED_BROWSER_TAB,
    CapabilityId.RATE_LIMIT_CLASSIFICATION,
    CapabilityId.SAFE_RESTART_RECOVERY,
  ]);
}

export function resolveAgentProviderLaunchUrl(providerId, requestedUrl = '') {
  const descriptor = orchestrationProviderContract(providerId);
  const launchUrl = String(requestedUrl || '').trim() || String(descriptor.defaultLaunchUrl || '').trim();
  if (!launchUrl) throw new Error(`Agent provider ${descriptor.id} has no launch URL`);
  if (!descriptor.siteAdapterId) throw new Error(`Agent provider ${descriptor.id} has no site adapter for browser launch`);
  requireSiteAdapterUrl(descriptor.siteAdapterId, launchUrl);
  return launchUrl;
}
