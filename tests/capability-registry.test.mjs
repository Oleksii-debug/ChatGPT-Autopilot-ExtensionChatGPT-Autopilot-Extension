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

test('provider identities are exact text and never trimmed or coerced', () => {
  for (const alias of [
    ` ${AgentProviderId.CHATGPT_BROWSER}`,
    `${AgentProviderId.CHATGPT_BROWSER} `,
    '',
  ]) {
    assert.throws(
      () => getAgentProvider(alias),
      /exact canonical text representation/,
    );
  }

  let coercions = 0;
  const coercive = {
    toString() {
      coercions += 1;
      return AgentProviderId.CHATGPT_BROWSER;
    },
  };
  assert.throws(
    () => getAgentProvider(coercive),
    /exact canonical text representation/,
  );
  assert.equal(coercions, 0);
});

test('provider launch URL is bound to its declared site adapter', () => {
  assert.equal(resolveAgentProviderLaunchUrl(AgentProviderId.CHATGPT_BROWSER, ''), 'https://chatgpt.com/');
  assert.equal(resolveAgentProviderLaunchUrl(AgentProviderId.CHATGPT_BROWSER, 'https://chatgpt.com/c/example'), 'https://chatgpt.com/c/example');
  assert.throws(() => resolveAgentProviderLaunchUrl(AgentProviderId.CHATGPT_BROWSER, 'https://example.com/'), /rejected by site adapter/);
  assert.throws(() => resolveAgentProviderLaunchUrl(AgentProviderId.CHATGPT_BROWSER, 'https://www.chatgpt.com/'), /rejected by site adapter/);
});


test('Plan-1 S1: provider launch admission is data-only and redacts rejected URL secrets', () => {
  const providerId = AgentProviderId.CHATGPT_BROWSER;
  const secret = 'OWNER_PRIVATE_LAUNCH_CREDENTIAL_DO_NOT_LOG';
  let calls = 0;
  const hostile = {
    toString() { calls += 1; throw new Error(secret); },
    valueOf() { calls += 1; throw new Error(secret); },
  };
  for (const input of [hostile, 1, false, true, Symbol(secret)]) {
    assert.throws(
      () => resolveAgentProviderLaunchUrl(providerId, input),
      error => {
        assert.match(error.message, /must be text/);
        assert.doesNotMatch(error.message, /OWNER_PRIVATE|CREDENTIAL_DO_NOT_LOG/);
        return true;
      },
    );
  }
  assert.equal(calls, 0, 'hostile conversion hooks must never run');
  assert.throws(
    () => resolveAgentProviderLaunchUrl(providerId, `https://not-chatgpt.example/${secret}`),
    error => {
      assert.match(error.message, /rejected by site adapter/);
      assert.doesNotMatch(error.message, /OWNER_PRIVATE|CREDENTIAL_DO_NOT_LOG|not-chatgpt/);
      return true;
    },
  );
  // Legacy omitted/null request, explicit canonical URL and JSON cold restart
  // preserve the same existing site adapter authority without mutation.
  assert.equal(resolveAgentProviderLaunchUrl(providerId), 'https://chatgpt.com/');
  assert.equal(resolveAgentProviderLaunchUrl(providerId, null), 'https://chatgpt.com/');
  const input = { providerId, requestedUrl: 'https://chatgpt.com/c/legitimate' };
  const persisted = JSON.parse(JSON.stringify(input));
  assert.equal(
    resolveAgentProviderLaunchUrl(persisted.providerId, persisted.requestedUrl),
    input.requestedUrl,
  );
  assert.deepEqual(persisted, input);
});
