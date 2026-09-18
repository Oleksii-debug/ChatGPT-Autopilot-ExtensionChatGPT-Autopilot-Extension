import test from 'node:test';
import assert from 'node:assert/strict';
import { AiGatewayClient, normalizeGatewayUrl } from '../src/core/ai-gateway-client.js';

test('gateway URL is restricted to localhost', () => {
  assert.equal(normalizeGatewayUrl('http://127.0.0.1:17621/'), 'http://127.0.0.1:17621');
  assert.throws(() => normalizeGatewayUrl('https://api.openai.com/v1'), /localhost or 127\.0\.0\.1/);
});

test('gateway client health, model list and completion use local HTTP API', async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push([url, init.method || 'GET', init.body || '']);
    const path = new URL(url).pathname;
    if (path === '/health') return new Response(JSON.stringify({ ok: true, providers: ['ollama','openai'] }), { status: 200 });
    if (path === '/status') return new Response(JSON.stringify({ ok: true, providers: [{ provider: 'ollama', ok: true, models: 1 }] }), { status: 200 });
    if (path === '/models') return new Response(JSON.stringify({ ok: true, provider: 'ollama', models: ['qwen'] }), { status: 200 });
    if (path === '/complete') return new Response(JSON.stringify({ ok: true, provider: 'ollama', model: 'qwen', text: 'done' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const client = new AiGatewayClient({ fetchFn });
  assert.equal((await client.health({ gatewayUrl: 'http://localhost:17621', timeoutSeconds: 30 })).ok, true);
  assert.equal((await client.status({ gatewayUrl: 'http://localhost:17621', timeoutSeconds: 30 })).providers[0].provider, 'ollama');
  assert.deepEqual((await client.listModels({ gatewayUrl: 'http://localhost:17621', timeoutSeconds: 30, provider: 'ollama' })).models, ['qwen']);
  assert.equal((await client.complete({ gatewayUrl: 'http://localhost:17621', timeoutSeconds: 30, provider: 'ollama', model: 'qwen', prompt: 'hi' })).text, 'done');
  assert.deepEqual(calls.map(x => [new URL(x[0]).pathname, x[1]]), [['/health','GET'],['/status','GET'],['/models','GET'],['/complete','POST']]);
});

test('gateway client forwards optional vision image only to localhost gateway payload', async () => {
  let body;
  const client = new AiGatewayClient({ fetchFn: async (_url, init = {}) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, provider: 'openai', model: 'vision', text: 'done' }), { status: 200 });
  } });
  const imageDataUrl = 'data:image/jpeg;base64,QUJDRA==';
  await client.complete({ gatewayUrl: 'http://127.0.0.1:17621', timeoutSeconds: 30, provider: 'openai', model: 'vision', prompt: 'inspect', imageDataUrl });
  assert.equal(body.imageDataUrl, imageDataUrl);
});
