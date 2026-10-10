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
  // Provider IDs are an exact authority allowlist, not inherited object keys.
  // Do not disclose attacker-supplied identifiers in diagnostic errors.
  if (!Object.hasOwn(DESCRIPTORS, id)) throw new Error('Unsupported agent provider');
  const descriptor = DESCRIPTORS[id];
  return { ...descriptor, capabilities: [...descriptor.capabilities] };
}

export function providerHasCapability(providerId, capabilityId) {
  const descriptor = getAgentProvider(providerId);
  return descriptor.capabilities.includes(capabilityId);
}

// Source-of-truth remains DESCRIPTORS. This is an admission fence, not a new
// registry: never iterate caller-owned capability data or expose its contents
// in a diagnostic before authorizing provider operations.
function snapshotRequiredCapabilities(required) {
  const label = 'Agent provider required capabilities';
  let descriptors;
  try {
    if (!Array.isArray(required) || Object.getPrototypeOf(required) !== Array.prototype) {
      throw new Error('noncanonical array');
    }
    descriptors = Object.getOwnPropertyDescriptors(required);
  } catch {
    // A Proxy trap can throw an arbitrary secret-bearing Error. Do not log it.
    throw new Error(`${label} must be a bounded plain data array`);
  }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 128) {
    throw new Error(`${label} must be a bounded plain data array`);
  }
  // Reject own symbols, hidden members and non-index properties. In particular,
  // never execute a custom iterator, an accessor or an inherited authority list.
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\\d*)$/u.test(key)
        || !Number.isSafeInteger(Number(key)) || Number(key) >= length) {
      throw new Error(`${label} contains noncanonical fields`);
    }
  }
  const ids = [];
  for (let index = 0; index < length; index += 1) {
    const entry = descriptors[String(index)];
    if (!entry || entry.enumerable !== true || !Object.hasOwn(entry, 'value')
        || typeof entry.value !== 'string' || entry.value.length === 0
        || entry.value.length > 180 || entry.value !== entry.value.trim()) {
      throw new Error(`${label} must contain exact data-only capability IDs`);
    }
    ids.push(entry.value);
  }
  return [...new Set(ids)];
}

export function requireAgentProviderCapabilities(providerId, required = []) {
  const descriptor = getAgentProvider(providerId);
  const exact = snapshotRequiredCapabilities(required);
  // Never interpolate caller-controlled provider/capability values in logs.
  if (exact.some(capability => !descriptor.capabilities.includes(capability))) {
    throw new Error('Agent provider lacks required capabilities');
  }
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
