import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeProvider,
  listProviderModels,
  normalizeCompatibleEndpointRegistry,
} from '../companion/ai-gateway/gateway.mjs';
import { MISTRAL_ENDPOINT_PRESET } from '../companion/ai-gateway/provider-presets.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

test('Mistral preset reaches the expected model and chat endpoints with environment-only bearer auth', async () => {
  const endpoints = normalizeCompatibleEndpointRegistry([MISTRAL_ENDPOINT_PRESET]);
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/models')) {
      return jsonResponse({ data: [{ id: 'mistral-large-latest' }, { id: 'mistral-small-latest' }] });
    }
    if (String(url).endsWith('/chat/completions')) {
      return jsonResponse({
        choices: [{ message: { content: 'готово' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      });
    }
    return jsonResponse({ error: { message: 'unexpected test URL' } }, 404);
  };
  const env = { MISTRAL_API_KEY: 'test-mistral-secret' };

  const models = await listProviderModels('openai-compatible', {
    fetchFn,
    endpointId: 'mistral',
    compatibleEndpoints: endpoints,
    env,
  });
  assert.deepEqual(models, ['mistral-large-latest', 'mistral-small-latest']);

  const result = await completeProvider({
    provider: 'openai-compatible',
    endpointId: 'mistral',
    model: 'mistral-large-latest',
    prompt: 'виконай задачу',
    maxOutputTokens: 64,
  }, {
    fetchFn,
    compatibleEndpoints: endpoints,
    env,
  });

  assert.equal(result.endpointId, 'mistral');
  assert.equal(result.model, 'mistral-large-latest');
  assert.equal(result.text, 'готово');
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10, modelCalls: 1 });
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.mistral.ai/v1/models',
    'https://api.mistral.ai/v1/chat/completions',
  ]);
  assert.deepEqual(calls.map(call => call.init.headers?.authorization), [
    'Bearer test-mistral-secret',
    'Bearer test-mistral-secret',
  ]);
  const completionPayload = JSON.parse(calls[1].init.body);
  assert.equal(completionPayload.model, 'mistral-large-latest');
  assert.equal(completionPayload.max_tokens, 64);
  assert.equal(completionPayload.stream, false);
  assert.deepEqual(completionPayload.messages, [{ role: 'user', content: 'виконай задачу' }]);
  assert.equal(JSON.stringify(endpoints).includes('test-mistral-secret'), false);
});

test('Mistral model listing fails locally with zero network calls when its declared key is absent', async () => {
  const endpoints = normalizeCompatibleEndpointRegistry([MISTRAL_ENDPOINT_PRESET]);
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return jsonResponse({ data: [] });
  };

  await assert.rejects(() => listProviderModels('openai-compatible', {
    fetchFn,
    endpointId: 'mistral',
    compatibleEndpoints: endpoints,
    env: {},
  }), error => error?.code === 'AI_PROVIDER_API_KEY_NOT_CONFIGURED');

  assert.equal(calls, 0);
});

test('Mistral completion fails locally with zero network calls when its declared key is absent', async () => {
  const endpoints = normalizeCompatibleEndpointRegistry([MISTRAL_ENDPOINT_PRESET]);
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return jsonResponse({ choices: [{ message: { content: 'must-not-arrive' } }] });
  };

  await assert.rejects(() => completeProvider({
    provider: 'openai-compatible',
    endpointId: 'mistral',
    model: 'mistral-large-latest',
    prompt: 'private prompt must not leave the machine without the configured credential',
    maxOutputTokens: 64,
  }, {
    fetchFn,
    compatibleEndpoints: endpoints,
    env: {},
  }), error => error?.code === 'AI_PROVIDER_API_KEY_NOT_CONFIGURED');

  assert.equal(calls, 0);
});

test('Mistral credential cannot be retargeted to another endpoint identity or HTTPS origin', () => {
  assert.throws(() => normalizeCompatibleEndpointRegistry([
    {
      endpointId: 'mistral',
      baseUrl: 'https://other.example/v1',
      apiKeyEnv: 'MISTRAL_API_KEY',
    },
  ]), error => error?.code === 'AI_COMPATIBLE_CREDENTIAL_BINDING_MISMATCH');

  assert.throws(() => normalizeCompatibleEndpointRegistry([
    MISTRAL_ENDPOINT_PRESET,
    {
      endpointId: 'other',
      baseUrl: 'https://other.example/v1',
      apiKeyEnv: 'MISTRAL_API_KEY',
    },
  ]), error => error?.code === 'AI_COMPATIBLE_CREDENTIAL_BINDING_MISMATCH');
});
