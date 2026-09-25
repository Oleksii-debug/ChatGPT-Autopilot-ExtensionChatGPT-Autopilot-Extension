import test from 'node:test';
import assert from 'node:assert/strict';
import { AiGatewayClient, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, normalizeGatewayUrl } from '../src/core/ai-gateway-client.js';

test('gateway URL is restricted to localhost', () => {
  assert.equal(normalizeGatewayUrl('http://127.0.0.1:17621/'), 'http://127.0.0.1:17621');
  assert.throws(() => normalizeGatewayUrl('https://api.openai.com/v1'), /localhost or 127\.0\.0\.1/);
  assert.throws(() => normalizeGatewayUrl(17621), /URL must be text when supplied/);
  assert.throws(() => normalizeGatewayUrl(null), /URL must be text when supplied/);
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

test('gateway client preserves typed HTTP failure evidence and compatible endpoint identity', async () => {
  let body;
  const client = new AiGatewayClient({ fetchFn: async (_url, init = {}) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ error:'secondary quota exhausted', code:'AI_PROVIDER_QUOTA_EXHAUSTED' }), { status:429 });
  } });
  await assert.rejects(
    () => client.complete({ gatewayUrl:'http://127.0.0.1:17621', timeoutSeconds:30, provider:'openai-compatible', endpointId:'team-a', model:'coder', prompt:'task' }),
    error => {
      assert.equal(error.status, 429);
      assert.equal(error.code, 'AI_PROVIDER_QUOTA_EXHAUSTED');
      return true;
    },
  );
  assert.equal(body.endpointId, 'team-a');
});

test('gateway client includes compatible endpoint identity in model discovery', async () => {
  let requestedUrl = '';
  const client = new AiGatewayClient({ fetchFn:async url => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ ok:true, models:['coder'] }), { status:200 });
  } });
  const result = await client.listModels({ gatewayUrl:'http://127.0.0.1:17621', timeoutSeconds:30, provider:'openai-compatible', endpointId:'team a' });
  assert.deepEqual(result.models, ['coder']);
  assert.match(requestedUrl, /provider=openai-compatible&endpointId=team%20a$/);
});


function jsonWithExactBytes(byteLength) {
  const prefix = '{"ok":true,"payload":"';
  const suffix = '"}';
  const overhead = new TextEncoder().encode(prefix + suffix).byteLength;
  if (byteLength < overhead) throw new Error('fixture byte length is too small');
  return prefix + 'x'.repeat(byteLength - overhead) + suffix;
}

function trackedStreamResponse(text, { declaredLength = null, chunks = null } = {}) {
  const encoded = new TextEncoder().encode(text);
  const parts = chunks || [encoded];
  let index = 0;
  let reads = 0;
  let cancelled = false;
  let released = false;
  let readerTaken = false;

  const reader = {
    async read() {
      if (index >= parts.length) return { done: true, value: undefined };
      const value = parts[index];
      index += 1;
      reads += 1;
      return { done: false, value };
    },
    async cancel() {
      cancelled = true;
    },
    releaseLock() {
      released = true;
    },
  };
  const body = {
    getReader() {
      if (readerTaken) throw new TypeError('ReadableStream is already locked');
      readerTaken = true;
      return reader;
    },
    async cancel() {
      cancelled = true;
    },
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers(declaredLength == null ? {} : { 'content-length': String(declaredLength) }),
    body,
    async text() {
      throw new Error('streaming response must not call text()');
    },
    get reads() { return reads; },
    get cancelled() { return cancelled; },
    get released() { return released; },
  };
}

test('gateway client accepts the exact response byte ceiling through the streaming path', async () => {
  const payload = jsonWithExactBytes(MAX_RESPONSE_BYTES);
  const response = trackedStreamResponse(payload, { declaredLength: MAX_RESPONSE_BYTES });
  const client = new AiGatewayClient({ fetchFn: async () => response });
  const result = await client.health({ gatewayUrl: 'http://127.0.0.1:17621', timeoutSeconds: 30 });
  assert.equal(new TextEncoder().encode(payload).byteLength, MAX_RESPONSE_BYTES);
  assert.equal(result.ok, true);
  assert.equal(response.cancelled, false);
  assert.ok(response.reads >= 1);
  assert.equal(response.released, true);
});

test('gateway client rejects declared response overflow before body consumption', async () => {
  const response = trackedStreamResponse('{"ok":true}', { declaredLength: MAX_RESPONSE_BYTES + 1 });
  const client = new AiGatewayClient({ fetchFn: async () => response });
  await assert.rejects(
    () => client.health({ gatewayUrl: 'http://127.0.0.1:17621', timeoutSeconds: 30 }),
    error => error?.code === 'AI_GATEWAY_RESPONSE_TOO_LARGE',
  );
  assert.equal(response.reads, 0);
  assert.equal(response.cancelled, true);
});

test('gateway client rejects and cancels chunked response overflow before JSON parse', async () => {
  const payload = jsonWithExactBytes(MAX_RESPONSE_BYTES + 1);
  const encoded = new TextEncoder().encode(payload);
  const split = MAX_RESPONSE_BYTES - 13;
  const response = trackedStreamResponse(payload, {
    chunks: [encoded.subarray(0, split), encoded.subarray(split)],
  });
  const client = new AiGatewayClient({ fetchFn: async () => response });
  await assert.rejects(
    () => client.health({ gatewayUrl: 'http://127.0.0.1:17621', timeoutSeconds: 30 }),
    error => error?.code === 'AI_GATEWAY_RESPONSE_TOO_LARGE',
  );
  assert.equal(response.cancelled, true);
  assert.equal(response.reads, 2);
  assert.equal(response.released, true);
});

test('gateway client enforces the response ceiling in UTF-8 bytes rather than JavaScript code units', async () => {
  const payload = JSON.stringify({
    ok: true,
    payload: '€'.repeat(Math.floor(MAX_RESPONSE_BYTES / 3) + 32),
  });
  assert.ok(payload.length < MAX_RESPONSE_BYTES, 'fixture must stay below the old code-unit ceiling');
  assert.ok(new TextEncoder().encode(payload).byteLength > MAX_RESPONSE_BYTES, 'fixture must exceed the byte ceiling');
  const response = trackedStreamResponse(payload);
  const client = new AiGatewayClient({ fetchFn: async () => response });
  await assert.rejects(
    () => client.health({ gatewayUrl: 'http://127.0.0.1:17621', timeoutSeconds: 30 }),
    error => error?.code === 'AI_GATEWAY_RESPONSE_TOO_LARGE',
  );
  assert.equal(response.cancelled, true);
  assert.equal(response.released, true);
});


test('gateway client enforces the exact request byte ceiling before fetch', async () => {
  let calls = 0;
  const client = new AiGatewayClient({ fetchFn: async () => {
    calls += 1;
    return new Response('{"ok":true}', { status: 200 });
  } });

  await client.request('http://127.0.0.1:17621', 30, '/complete', {
    method: 'POST',
    body: 'x'.repeat(MAX_REQUEST_BYTES),
  });
  assert.equal(calls, 1);

  await assert.rejects(
    () => client.request('http://127.0.0.1:17621', 30, '/complete', {
      method: 'POST',
      body: 'x'.repeat(MAX_REQUEST_BYTES + 1),
    }),
    error => error?.code === 'AI_GATEWAY_REQUEST_TOO_LARGE',
  );
  assert.equal(calls, 1);
});

test('gateway client counts request size in UTF-8 bytes before fetch', async () => {
  let calls = 0;
  const client = new AiGatewayClient({ fetchFn: async () => {
    calls += 1;
    return new Response('{"ok":true}', { status: 200 });
  } });
  const body = '€'.repeat(Math.floor(MAX_REQUEST_BYTES / 3) + 1);
  assert.ok(body.length < MAX_REQUEST_BYTES);
  assert.ok(new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES);

  await assert.rejects(
    () => client.request('http://127.0.0.1:17621', 30, '/complete', { method: 'POST', body }),
    error => error?.code === 'AI_GATEWAY_REQUEST_TOO_LARGE',
  );
  assert.equal(calls, 0);
});


test('gateway client snapshots public request envelopes before authority reads', async () => {
  const client = new AiGatewayClient({ fetchFn: async () => { throw new Error('transport should be stubbed'); } });
  client.request = async (...args) => args;

  let reads = 0;
  const healthInput = new Proxy({
    gatewayUrl: 'http://127.0.0.1:17621',
    timeoutSeconds: 30,
    mode: 'hybrid-auto',
  }, {
    get(target, key, receiver) {
      reads += 1;
      if (key === 'timeoutSeconds') return 900;
      return Reflect.get(target, key, receiver);
    },
  });
  const healthArgs = await client.health(healthInput);
  assert.equal(reads, 0, 'health request must not ordinary-read caller Proxy fields');
  assert.equal(healthArgs[1], 30);
  assert.equal(healthArgs[2], '/health');

  const accessor = {
    gatewayUrl: 'http://127.0.0.1:17621',
    timeoutSeconds: 30,
  };
  Object.defineProperty(accessor, 'gatewayUrl', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'http://127.0.0.1:9999';
    },
  });
  await assert.rejects(() => client.status(accessor), /enumerable own data properties/);
  assert.equal(reads, 0, 'request accessor must never execute');

  const completion = new Proxy({
    gatewayUrl: 'http://127.0.0.1:17621',
    timeoutSeconds: 30,
    provider: 'ollama',
    model: 'qwen3:8b',
    prompt: 'test',
    maxOutputTokens: 256,
  }, {
    get(target, key, receiver) {
      reads += 1;
      if (key === 'maxOutputTokens') return 999999;
      return Reflect.get(target, key, receiver);
    },
  });
  const completionArgs = await client.complete(completion);
  assert.equal(reads, 0, 'completion request must not ordinary-read caller Proxy fields');
  assert.equal(JSON.parse(completionArgs[3].body).maxOutputTokens, 256);

  await assert.rejects(
    () => client.complete({
      gatewayUrl: 'http://127.0.0.1:17621',
      timeoutSeconds: 30,
      provider: 'ollama',
      model: 'qwen3:8b',
      prompt: 'test',
      maxOutputTokens: '256',
    }),
    /maxOutputTokens must be a number/,
  );
});

test('gateway client rejects string timeout coercion before fetch', async () => {
  let fetchCalls = 0;
  const client = new AiGatewayClient({
    fetchFn: async () => {
      fetchCalls += 1;
      throw new Error('must not fetch');
    },
  });
  await assert.rejects(
    () => client.request('http://127.0.0.1:17621', '30', '/health'),
    /timeout must be 5-900 seconds/,
  );
  assert.equal(fetchCalls, 0);
});

test('gateway client rejects non-string request bodies before fetch', async () => {
  let calls = 0;
  const client = new AiGatewayClient({ fetchFn: async () => {
    calls += 1;
    return new Response('{"ok":true}', { status: 200 });
  } });

  await assert.rejects(
    () => client.request('http://127.0.0.1:17621', 30, '/complete', {
      method: 'POST',
      body: new Uint8Array([123, 125]),
    }),
    error => error?.code === 'AI_GATEWAY_INVALID_REQUEST_BODY',
  );
  assert.equal(calls, 0);
});

test('gateway client rejects endpoint and resource aliases before fetch', async () => {
  let fetchCalls = 0;
  let lastBody = null;
  const client = new AiGatewayClient({
    fetchFn: async (_url, init = {}) => {
      fetchCalls += 1;
      lastBody = init.body ? JSON.parse(init.body) : null;
      return new Response(JSON.stringify({ ok: true, provider: 'ollama', model: 'qwen3:8b', text: 'ok', models: [] }), { status: 200 });
    },
  });
  const base = {
    gatewayUrl: 'http://127.0.0.1:17621',
    timeoutSeconds: 30,
    provider: 'ollama',
    model: 'qwen3:8b',
    prompt: 'test',
  };

  await assert.rejects(
    () => client.health({ gatewayUrl: 17621, timeoutSeconds: 30 }),
    /URL must be text when supplied/,
  );
  await assert.rejects(
    () => client.listModels({ gatewayUrl: base.gatewayUrl, timeoutSeconds: 30, provider: 'ollama', endpointId: 7 }),
    /endpointId must be text when supplied/,
  );
  await assert.rejects(
    () => client.complete({ ...base, endpointId: 7 }),
    /endpointId must be text when supplied/,
  );
  await assert.rejects(
    () => client.complete({ ...base, systemPrompt: 7 }),
    /systemPrompt must be text when supplied/,
  );
  await assert.rejects(
    () => client.complete({ ...base, imageDataUrl: { value: 'data:image/png;base64,AA==' } }),
    /imageDataUrl must be text when supplied/,
  );
  await assert.rejects(
    () => client.complete({ ...base, maxOutputTokens: -1 }),
    /maxOutputTokens must be 0 or at least 1/,
  );
  await assert.rejects(
    () => client.complete({ ...base, maxOutputTokens: 0.5 }),
    /maxOutputTokens must be 0 or at least 1/,
  );
  assert.equal(fetchCalls, 0);

  await client.complete({ ...base, maxOutputTokens: 1.9 });
  assert.equal(fetchCalls, 1);
  assert.equal(lastBody.maxOutputTokens, 1);
});

