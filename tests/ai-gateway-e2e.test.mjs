import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensionPairingStore, createGatewayServer, normalizeCompatibleEndpointRegistry } from '../companion/ai-gateway/gateway.mjs';
import { AiGatewayClient } from '../src/core/ai-gateway-client.js';

function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('extension client talks over real localhost HTTP to gateway which routes Ollama and OpenAI', async () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'e2e-secret';
  const upstream = [];
  const fetchFn = async (url, init = {}) => {
    upstream.push([url, init]);
    if (url.endsWith('/api/tags')) return response({ models: [{ name: 'local-qwen' }] });
    if (url.endsWith('/api/chat')) return response({ message: { content: 'local-answer' } });
    if (url.endsWith('/models')) return response({ data: [{ id: 'remote-weak' }, { id: 'remote-strong' }] });
    if (url.endsWith('/responses')) return response({ output: [{ content: [{ type: 'output_text', text: 'remote-answer' }] }] });
    return response({ error: { message: 'missing' } }, 404);
  };
  const server = createGatewayServer({ fetchFn });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const gatewayUrl = `http://127.0.0.1:${port}`;
  try {
    const client = new AiGatewayClient();
    const health = await client.health({ gatewayUrl, timeoutSeconds: 30 });
    assert.equal(health.ok, true);
    assert.equal(typeof health.compatibleApiKeyConfigured, 'boolean');
    assert.match(health.compatibleBaseUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(health.compatibleTransport, 'http');
    assert.deepEqual(health.compatibleEndpoints.map(item => item.endpointId), ['default']);
    assert.equal(JSON.stringify(health).includes('e2e-secret'), false);
    assert.deepEqual((await client.listModels({ gatewayUrl, timeoutSeconds: 30, provider: 'ollama' })).models, ['local-qwen']);
    assert.deepEqual((await client.listModels({ gatewayUrl, timeoutSeconds: 30, provider: 'openai' })).models, ['remote-strong', 'remote-weak']);
    assert.equal((await client.complete({ gatewayUrl, timeoutSeconds: 30, provider: 'ollama', model: 'local-qwen', prompt: 'x' })).text, 'local-answer');
    assert.equal((await client.complete({ gatewayUrl, timeoutSeconds: 30, provider: 'openai', model: 'remote-strong', prompt: 'x' })).text, 'remote-answer');
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  }
  assert.ok(upstream.some(([url]) => url.endsWith('/api/chat')));
  assert.ok(upstream.some(([url]) => url.endsWith('/responses')));
});

test('Plan4 S1 real HTTP gateway forbids endpoint alias, duplicate ID and erased POST account before upstream I/O', async () => {
  const endpoints=normalizeCompatibleEndpointRegistry([
    {endpointId:'local',baseUrl:'http://127.0.0.1:1234/v1',apiKeyEnv:''},
    {endpointId:'team',baseUrl:'https://models.example.test/v1',apiKeyEnv:'TEAM_KEY'},
  ]);
  const upstream=[];
  const fetchFn=async (url,init={})=>{
    upstream.push({url,authorization:init.headers?.authorization});
    return url.endsWith('/models')
      ? response({data:[{id:'test-model'}]})
      : response({choices:[{message:{content:'fixture-ok'}}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}});
  };
  const server=createGatewayServer({compatibleEndpoints:endpoints,fetchFn,env:{TEAM_KEY:'fixture-only-key'}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const query of [
      'provider=openai-compatible&endpointId=%20team%20',
      'provider=openai-compatible&endpointId=',
      'provider=openai-compatible&endpointId=team&endpointId=local',
    ]) {
      const result=await fetch(`${root}/models?${query}`);
      assert.equal(result.status,400);
      assert.equal((await result.json()).code,'AI_COMPATIBLE_ENDPOINT_ID_INVALID');
    }
    for(const endpointId of ['', ' team ', null, 42]) {
      const result=await fetch(`${root}/complete`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({provider:'openai-compatible',endpointId,model:'test-model',prompt:'test'}),
      });
      assert.equal(result.status,400);
      assert.equal((await result.json()).code,'AI_COMPATIBLE_ENDPOINT_ID_INVALID');
    }
    assert.equal(upstream.length,0,'never contact remote provider for ambiguous or forged account endpoint');
    const discovery=await fetch(`${root}/models?provider=openai-compatible&endpointId=team`);
    assert.equal(discovery.status,200);
    assert.equal((await discovery.json()).endpointId,'team');
    const completion=await fetch(`${root}/complete`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({provider:'openai-compatible',endpointId:'team',model:'test-model',prompt:'approved'}),
    });
    assert.equal(completion.status,200);
    assert.equal((await completion.json()).endpointId,'team');
    assert.equal(upstream.length,2);
    assert.deepEqual(upstream.map(x=>x.authorization),['Bearer fixture-only-key','Bearer fixture-only-key']);
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});

test('gateway rejects web origins and binds exactly one Chrome extension during an explicit pairing window', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-gateway-e2e-pair-'));
  const pairingStore = createExtensionPairingStore({ configDir });
  const server = createGatewayServer({ fetchFn: async () => response({}), pairingStore });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/health`;
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const otherOrigin = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';
  try {
    const blocked = await fetch(url, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);

    const beforePair = await fetch(url, { headers: { Origin: extensionOrigin } });
    assert.equal(beforePair.status, 428);
    assert.equal(beforePair.headers.get('access-control-allow-origin'), extensionOrigin);
    assert.equal((await beforePair.json()).code, 'GATEWAY_PAIRING_REQUIRED');

    pairingStore.openWindow();
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: extensionOrigin, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), extensionOrigin);
    assert.equal(pairingStore.snapshot().paired, false);

    const allowed = await fetch(url, { headers: { Origin: extensionOrigin } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), extensionOrigin);
    const health = await allowed.json();
    assert.equal(health.extensionPairing.paired, true);
    assert.equal(health.extensionPairing.pairingWindowOpen, false);

    const deniedOther = await fetch(url, { headers: { Origin: otherOrigin } });
    assert.equal(deniedOther.status, 403);
    assert.equal((await deniedOther.json()).code, 'GATEWAY_EXTENSION_NOT_PAIRED');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
