import test from 'node:test';
import assert from 'node:assert/strict';
import { completeProvider, listProviderModels, normalizeCompatibleBaseUrl, probeProvider } from '../companion/ai-gateway/gateway.mjs';

function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('gateway talks to Ollama models and chat endpoints', async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push([url, init]);
    if (url.endsWith('/api/tags')) return response({ models: [{ name: 'qwen3:8b' }] });
    if (url.endsWith('/api/chat')) return response({ message: { content: 'ollama result' } });
    throw new Error('unexpected');
  };
  assert.deepEqual(await listProviderModels('ollama', { fetchFn }), ['qwen3:8b']);
  const result = await completeProvider({ provider: 'ollama', model: 'qwen3:8b', prompt: 'task' }, { fetchFn });
  assert.equal(result.text, 'ollama result');
  assert.equal(JSON.parse(calls[1][1].body).model, 'qwen3:8b');
});

test('gateway keeps OpenAI API key outside extension and uses Responses API', async () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-secret';
  try {
    const calls = [];
    const fetchFn = async (url, init = {}) => {
      calls.push([url, init]);
      if (url.endsWith('/models')) return response({ data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] });
      if (url.endsWith('/responses')) return response({ output: [{ content: [{ type: 'output_text', text: 'api result' }] }] });
      throw new Error('unexpected');
    };
    assert.deepEqual(await listProviderModels('openai', { fetchFn }), ['gpt-a', 'gpt-b']);
    const result = await completeProvider({ provider: 'openai', model: 'gpt-b', prompt: 'task', systemPrompt: 'system' }, { fetchFn });
    assert.equal(result.text, 'api result');
    assert.equal(calls[0][1].headers.authorization, 'Bearer test-secret');
    assert.equal(calls[1][1].headers.authorization, 'Bearer test-secret');
    const payload = JSON.parse(calls[1][1].body);
    assert.equal(payload.model, 'gpt-b');
    assert.equal(payload.input, 'task');
    assert.equal(payload.instructions, 'system');
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  }
});

test('gateway supports local OpenAI-compatible servers without requiring an API key', async () => {
  const old = process.env.COMPATIBLE_API_KEY;
  delete process.env.COMPATIBLE_API_KEY;
  try {
    const calls = [];
    const fetchFn = async (url, init = {}) => {
      calls.push([url, init]);
      if (url.endsWith('/models')) return response({ data: [{ id: 'local-model' }] });
      if (url.endsWith('/chat/completions')) return response({ choices: [{ message: { content: 'compatible result' } }] });
      throw new Error(`unexpected ${url}`);
    };
    assert.deepEqual(await listProviderModels('openai-compatible', { fetchFn }), ['local-model']);
    const result = await completeProvider({ provider: 'openai-compatible', model: 'local-model', prompt: 'task', systemPrompt: 'system' }, { fetchFn });
    assert.equal(result.text, 'compatible result');
    assert.equal(calls[0][1].headers.authorization, undefined);
    const payload = JSON.parse(calls[1][1].body);
    assert.equal(payload.messages[0].role, 'system');
    assert.equal(payload.messages[1].content, 'task');
  } finally {
    if (old === undefined) delete process.env.COMPATIBLE_API_KEY; else process.env.COMPATIBLE_API_KEY = old;
  }
});


test('gateway provider status distinguishes unavailable and unconfigured upstreams', async () => {
  const old = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const noKey = await probeProvider('openai', { fetchFn: async () => { throw new Error('must not call upstream without key'); }, timeoutMs: 1000 });
    assert.equal(noKey.configured, false);
    assert.equal(noKey.ok, false);
    assert.equal(noKey.reason, 'api-key-not-configured');

    const ok = await probeProvider('ollama', { fetchFn: async url => {
      assert.match(String(url), /\/api\/tags$/);
      return response({ models: [{ name: 'local-a' }, { name: 'local-b' }] });
    }, timeoutMs: 1000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.models, 2);

    const failed = await probeProvider('openai-compatible', { fetchFn: async () => { throw new Error('connection refused'); }, timeoutMs: 1000 });
    assert.equal(failed.configured, true);
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /connection refused/);
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  }
});


test('OpenAI-compatible endpoint allows loopback HTTP and remote HTTPS but rejects credential-leaking remote HTTP', () => {
  assert.equal(normalizeCompatibleBaseUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeCompatibleBaseUrl('http://localhost:8080/v1'), 'http://localhost:8080/v1');
  assert.equal(normalizeCompatibleBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.throws(() => normalizeCompatibleBaseUrl('http://api.example.com/v1'), /must use HTTPS/);
  assert.throws(() => normalizeCompatibleBaseUrl('https://user:secret@api.example.com/v1'), /must not contain embedded credentials/);
  assert.throws(() => normalizeCompatibleBaseUrl('https://api.example.com/v1?token=x'), /must not contain a query string/);
});

test('gateway sends one optional vision image in provider-native multimodal shape', async () => {
  const imageDataUrl = 'data:image/jpeg;base64,QUJDRA==';

  const oldOpenAi = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'vision-secret';
  try {
    let openPayload;
    const open = await completeProvider({ provider: 'openai', model: 'gpt-vision', prompt: 'inspect', imageDataUrl }, { fetchFn: async (url, init = {}) => {
      openPayload = JSON.parse(init.body);
      return response({ output: [{ content: [{ type: 'output_text', text: 'seen' }] }], usage: { input_tokens: 10, output_tokens: 2 } });
    } });
    assert.equal(open.text, 'seen');
    assert.equal(openPayload.input[0].content[0].type, 'input_text');
    assert.equal(openPayload.input[0].content[1].type, 'input_image');
    assert.equal(openPayload.input[0].content[1].image_url, imageDataUrl);
  } finally {
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi;
  }

  let ollamaPayload;
  await completeProvider({ provider: 'ollama', model: 'llava', prompt: 'inspect', imageDataUrl }, { fetchFn: async (_url, init = {}) => {
    ollamaPayload = JSON.parse(init.body);
    return response({ message: { content: 'seen' }, prompt_eval_count: 10, eval_count: 2 });
  } });
  assert.deepEqual(ollamaPayload.messages.at(-1).images, ['QUJDRA==']);

  let compatiblePayload;
  await completeProvider({ provider: 'openai-compatible', model: 'vision-local', prompt: 'inspect', imageDataUrl }, { fetchFn: async (_url, init = {}) => {
    compatiblePayload = JSON.parse(init.body);
    return response({ choices: [{ message: { content: 'seen' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  } });
  assert.equal(compatiblePayload.messages.at(-1).content[1].type, 'image_url');
  assert.equal(compatiblePayload.messages.at(-1).content[1].image_url.url, imageDataUrl);
});

test('gateway rejects malformed or oversized vision image before contacting provider', async () => {
  let calls = 0;
  await assert.rejects(
    () => completeProvider({ provider: 'ollama', model: 'vision', prompt: 'x', imageDataUrl: 'https://example.com/x.png' }, { fetchFn: async () => { calls += 1; return response({}); } }),
    /base64 JPEG, PNG, or WebP/,
  );
  assert.equal(calls, 0);
});

test('gateway preserves typed retry evidence for provider quota, timeout and availability failures', async () => {
  await assert.rejects(
    () => completeProvider({ provider:'ollama', model:'local', prompt:'task' }, { fetchFn:async () => response({ error:{ message:'secondary quota' } }, 429) }),
    error => error.statusCode === 429 && error.code === 'AI_PROVIDER_RATE_LIMITED',
  );
  await assert.rejects(
    () => completeProvider({ provider:'ollama', model:'local', prompt:'task' }, { fetchFn:async () => response({ error:{ message:'down' } }, 503) }),
    error => error.statusCode === 503 && error.code === 'AI_PROVIDER_UNAVAILABLE',
  );
  await assert.rejects(
    () => completeProvider({ provider:'ollama', model:'local', prompt:'task' }, { fetchFn:async () => { throw new TypeError('connection refused'); } }),
    error => error.statusCode === 503 && error.code === 'AI_PROVIDER_UNAVAILABLE',
  );
  await assert.rejects(
    () => completeProvider({ provider:'ollama', model:'local', prompt:'task' }, { fetchFn:async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; } }),
    error => error.statusCode === 504 && error.code === 'AI_PROVIDER_TIMEOUT',
  );
});
