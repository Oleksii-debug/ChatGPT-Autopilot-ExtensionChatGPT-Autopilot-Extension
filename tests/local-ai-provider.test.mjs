import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  LocalAiClient,
  MAX_RESPONSE_BYTES,
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

test('Local AI settings are descriptor-snapshotted and reject coercive/exotic authority', () => {
  const base = {
    enabled: true,
    providerType: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    timeoutSeconds: 30,
  };

  let reads = 0;
  const proxy = new Proxy(base, {
    get(target, key, receiver) {
      reads += 1;
      if (key === 'timeoutSeconds') return 600;
      return Reflect.get(target, key, receiver);
    },
  });
  const normalized = normalizeLocalAiSettings(proxy);
  assert.equal(reads, 0, 'settings normalization must never ordinary-read caller Proxy fields');
  assert.equal(normalized.timeoutSeconds, 30);

  const accessor = { ...base };
  Object.defineProperty(accessor, 'baseUrl', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'http://127.0.0.1:9999';
    },
  });
  assert.throws(() => normalizeLocalAiSettings(accessor), /enumerable own data properties/);
  assert.equal(reads, 0, 'settings accessors must never execute');

  assert.throws(
    () => normalizeLocalAiSettings({ ...base, timeoutSeconds: '30' }),
    /whole number from 5 to 600 seconds/,
  );

  const hidden = { ...base };
  Object.defineProperty(hidden, 'providerType', {
    enumerable: false,
    configurable: true,
    value: 'ollama',
  });
  assert.throws(() => normalizeLocalAiSettings(hidden), /enumerable own data properties/);
  assert.throws(
    () => normalizeLocalAiSettings({ ...base, [Symbol('authority')]: true }),
    /symbol fields/,
  );
  assert.throws(
    () => normalizeLocalAiSettings(Object.assign(Object.create({ timeoutSeconds: 600 }), base)),
    /plain data object/,
  );

  const nullProto = Object.assign(Object.create(null), base);
  assert.deepEqual(normalizeLocalAiSettings(nullProto), base);
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
    const chatPayload = JSON.parse(requests[1].body);
    assert.equal(chatPayload.stream, false);
    assert.equal(chatPayload.think, false);
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


test('rejects oversized Content-Length before consuming a Local AI response body', async () => {
  let bodyReads = 0;
  let bodyCancels = 0;
  const client = new LocalAiClient({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return String(name).toLowerCase() === 'content-length'
            ? String(MAX_RESPONSE_BYTES + 1)
            : null;
        },
      },
      body: {
        async cancel() { bodyCancels += 1; },
        getReader() {
          bodyReads += 1;
          throw new Error('body reader must not be created');
        },
      },
      async text() {
        bodyReads += 1;
        throw new Error('body text must not be read');
      },
    }),
  });
  const settings = {
    enabled: true,
    providerType: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    timeoutSeconds: 30,
  };

  await assert.rejects(() => client.complete(settings, 'test'), /response is too large/);
  assert.equal(bodyReads, 0);
  assert.equal(bodyCancels, 1);
});

test('counts streamed response bytes and cancels immediately after the size ceiling', async () => {
  let readCalls = 0;
  let cancelCalls = 0;
  let releaseCalls = 0;
  const first = new Uint8Array(MAX_RESPONSE_BYTES);
  const overflow = new Uint8Array(1);
  const client = new LocalAiClient({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            async read() {
              readCalls += 1;
              if (readCalls === 1) return { done: false, value: first };
              if (readCalls === 2) return { done: false, value: overflow };
              return { done: true, value: undefined };
            },
            async cancel() { cancelCalls += 1; },
            releaseLock() { releaseCalls += 1; },
          };
        },
      },
      async text() {
        throw new Error('stream path must not fall back to response.text()');
      },
    }),
  });
  const settings = {
    enabled: true,
    providerType: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    timeoutSeconds: 30,
  };

  await assert.rejects(() => client.complete(settings, 'test'), /response is too large/);
  assert.equal(readCalls, 2);
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
});

test('rejects non-byte streamed Local AI chunks without coercion', async () => {
  let cancelCalls = 0;
  let releaseCalls = 0;
  const client = new LocalAiClient({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          let read = false;
          return {
            async read() {
              if (read) return { done: true, value: undefined };
              read = true;
              return { done: false, value: { byteLength: 0, secret: 'not-bytes' } };
            },
            async cancel() { cancelCalls += 1; },
            releaseLock() { releaseCalls += 1; },
          };
        },
      },
    }),
  });
  const settings = {
    enabled: true,
    providerType: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    timeoutSeconds: 30,
  };

  await assert.rejects(
    () => client.complete(settings, 'test'),
    /invalid response stream/,
  );
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
});

test('fallback response size guard counts UTF-8 bytes rather than JavaScript characters', async () => {
  const multibyte = 'я'.repeat(Math.floor(MAX_RESPONSE_BYTES / 2) + 100);
  const body = JSON.stringify({ message: { role: 'assistant', content: multibyte } });
  assert.ok(body.length < MAX_RESPONSE_BYTES, 'fixture must remain below the old character-count limit');
  assert.ok(Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES, 'fixture must exceed the byte limit');

  const client = new LocalAiClient({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      async text() { return body; },
    }),
  });
  const settings = {
    enabled: true,
    providerType: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    timeoutSeconds: 30,
  };

  await assert.rejects(() => client.complete(settings, 'test'), /response is too large/);
});

test('Local AI deadline stays armed through response body consumption', async () => {
  let deadline = null;
  let timerCleared = false;
  let bodyReadStarted = false;
  const client = new LocalAiClient({
    setTimeoutFn(callback) {
      deadline = callback;
      return 77;
    },
    clearTimeoutFn(timer) {
      assert.equal(timer, 77);
      timerCleared = true;
    },
    fetchFn: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            async read() {
              bodyReadStarted = true;
              assert.equal(typeof deadline, 'function', 'deadline must remain armed while body is read');
              deadline();
              assert.equal(init.signal.aborted, true);
              const error = new Error('aborted during response body');
              error.name = 'AbortError';
              throw error;
            },
            releaseLock() {},
          };
        },
      },
    }),
  });
  const settings = {
    enabled: true,
    providerType: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    timeoutSeconds: 30,
  };

  await assert.rejects(() => client.complete(settings, 'test'), /timed out after 30 seconds/);
  assert.equal(bodyReadStarted, true);
  assert.equal(timerCleared, true);
});
