import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProviderId } from '../src/core/capability-registry.js';
import { InteractionProviderRouter } from '../src/core/interaction-provider-router.js';

test('router delegates current ChatGPT browser provider without changing request', async () => {
  const calls = [];
  const router = new InteractionProviderRouter().register(AgentProviderId.CHATGPT_BROWSER, {
    async execute(tabId, request) { calls.push({ tabId, request }); return { status: 'READY' }; },
  });
  const request = { providerId: AgentProviderId.CHATGPT_BROWSER, mode: 'CHECK_ONLY' };
  assert.deepEqual(await router.execute(42, request), { status: 'READY' });
  assert.deepEqual(calls, [{ tabId: 42, request }]);
});

test('router fails closed for unsupported or unregistered provider', async () => {
  const router = new InteractionProviderRouter();
  await assert.rejects(() => router.execute(1, { providerId: 'future-provider' }), /Unsupported agent provider/);
  await assert.rejects(() => router.execute(1, { providerId: AgentProviderId.CHATGPT_BROWSER }), /No interaction transport registered/);
});
