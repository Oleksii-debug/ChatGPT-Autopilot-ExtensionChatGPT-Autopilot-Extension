import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentProviderId,
  CapabilityId,
  getAgentProvider,
  listAgentProviders,
  orchestrationProviderContract,
  providerHasCapability,
  requireAgentProviderCapabilities,
  resolveAgentProviderLaunchUrl,
} from '../src/core/capability-registry.js';

test('ChatGPT browser is registered through capability contract', () => {
  const provider = orchestrationProviderContract(AgentProviderId.CHATGPT_BROWSER);
  assert.equal(provider.defaultLaunchUrl, 'https://chatgpt.com/');
  assert.equal(provider.siteAdapterId, 'chatgpt-web');
  assert.equal(providerHasCapability(provider.id, CapabilityId.ASSISTANT_COMPLETION_PROBE), true);
  assert.equal(providerHasCapability(provider.id, CapabilityId.SAFE_RESTART_RECOVERY), true);
});

test('provider descriptors are copied and cannot mutate registry truth', () => {
  const providers = listAgentProviders();
  providers[0].capabilities.length = 0;
  assert.ok(getAgentProvider(AgentProviderId.CHATGPT_BROWSER).capabilities.length > 0);
});

test('unknown or under-capable providers fail closed', () => {
  assert.throws(() => getAgentProvider('future-provider'), /Unsupported agent provider/);
  assert.throws(() => requireAgentProviderCapabilities(AgentProviderId.CHATGPT_BROWSER, ['not-yet-supported']), /lacks capabilities/);
});


test('provider launch URL is bound to its declared site adapter', () => {
  assert.equal(resolveAgentProviderLaunchUrl(AgentProviderId.CHATGPT_BROWSER, ''), 'https://chatgpt.com/');
  assert.equal(resolveAgentProviderLaunchUrl(AgentProviderId.CHATGPT_BROWSER, 'https://chatgpt.com/c/example'), 'https://chatgpt.com/c/example');
  assert.throws(() => resolveAgentProviderLaunchUrl(AgentProviderId.CHATGPT_BROWSER, 'https://example.com/'), /does not accept URL/);
  assert.throws(() => resolveAgentProviderLaunchUrl(AgentProviderId.CHATGPT_BROWSER, 'https://www.chatgpt.com/'), /does not accept URL/);
});
