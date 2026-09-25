import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  LocalAiClient,
  normalizeLocalAiBaseUrl,
  normalizeLocalAiSettings,
} from '../src/core/local-ai-provider.js';

async function withServer(run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:3b' }] }));
    if (req.url === '/api/chat') {
      const parsed = JSON.parse(body || '{}');
      return res.end(JSON.stringify({ message: { role: 'assistant', content: `ollama:${parsed.model}:${parsed.messages.at(-1)?.content}` } }));
    }
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'local-model-a' }, { id: 'local-model-b' }] }));
    if (req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body || '{}');
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `openai:${parsed.model}:${parsed.messages.at(-1)?.content}` } }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'missing' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run({ port, requests });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('rejects non-local Local AI endpoints', () => {
  assert.throws(() => normalizeLocalAiBaseUrl('https://example.com/v1', 'openai-compatible'), /localhost or 127\.0\.0\.1/);
  assert.throws(() => normalizeLocalAiBaseUrl('file:///tmp/model', 'ollama'), /http:\/\/ or https:\/\//);
});

test('normalizes defaults and validates timeout', () => {
  assert.equal(normalizeLocalAiSettings({ providerType: 'ollama' }).baseUrl, 'http://127.0.0.1:11434');
  assert.equal(normalizeLocalAiSettings({ providerType: 'openai-compatible' }).baseUrl, 'http://127.0.0.1:1234/v1');
  assert.throws(() => normalizeLocalAiSettings({ timeoutSeconds: 4 }), /5 to 600/);
});

test('Ollama model discovery and completion work end to end', async () => {
  await withServer(async ({ port, requests }) => {
    const client = new LocalAiClient();
    const settings = { enabled: true, providerType: 'ollama', baseUrl: `http://127.0.0.1:${port}`, model: 'qwen3:8b', timeoutSeconds: 30 };
    const models = await client.listModels(settings);
    assert.deepEqual(models.models, ['llama3.2:3b', 'qwen3:8b']);
    assert.equal(models.configuredModelAvailable, true);
    const result = await client.complete(settings, 'привіт');
    assert.equal(result.text, 'ollama:qwen3:8b:привіт');
    assert.deepEqual(requests.map(r => [r.method, r.url]), [['GET', '/api/tags'], ['POST', '/api/chat']]);
  });
});

test('OpenAI-compatible model discovery and completion work end to end', async () => {
  await withServer(async ({ port, requests }) => {
    const client = new LocalAiClient();
    const settings = { enabled: true, providerType: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'local-model-b', timeoutSeconds: 30 };
    const models = await client.listModels(settings);
    assert.deepEqual(models.models, ['local-model-a', 'local-model-b']);
    const result = await client.complete(settings, 'test');
    assert.equal(result.text, 'openai:local-model-b:test');
    assert.deepEqual(requests.map(r => [r.method, r.url]), [['GET', '/v1/models'], ['POST', '/v1/chat/completions']]);
  });
});

test('completion requires enabled integration and selected model', async () => {
  const client = new LocalAiClient({ fetchFn: async () => { throw new Error('should not fetch'); } });
  await assert.rejects(() => client.complete({ enabled: false, providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'x', timeoutSeconds: 30 }, 'x'), /disabled/);
  await assert.rejects(() => client.complete({ enabled: true, providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: '', timeoutSeconds: 30 }, 'x'), /Select a Local AI model/);
});
