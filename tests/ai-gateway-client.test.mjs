import test from 'node:test';
import assert from 'node:assert/strict';
import { AiGatewayClient, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, normalizeGatewayUrl } from '../src/core/ai-gateway-client.js';

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
  const body = new ReadableStream({
    pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(parts[index]);
      index += 1;
    },
    cancel() {
      cancelled = true;
    },
  });
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
