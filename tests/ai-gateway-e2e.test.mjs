import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensionPairingStore, createGatewayServer, normalizeCompatibleEndpointRegistry } from '../companion/ai-gateway/gateway.mjs';
import { AiGatewayClient } from '../src/core/ai-gateway-client.js';
import { AiOrchestrator } from '../src/core/ai-orchestrator.js';
import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { createAiRouteRegistryEvidenceV1 } from '../src/core/ai-route-pool.js';

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

test('Plan4 S1: real router-to-local-Gateway account endpoint effect is matched to durable reservation', async () => {
  const compatibleEndpoints=normalizeCompatibleEndpointRegistry([
    {endpointId:'owner-a',baseUrl:'https://owner-a.example.test/v1',apiKeyEnv:'OWNER_A_KEY'},
    {endpointId:'owner-b',baseUrl:'https://owner-b.example.test/v1',apiKeyEnv:'OWNER_B_KEY'},
  ]);
  const effects=[];
  const gateway=createGatewayServer({
    compatibleEndpoints,env:{OWNER_A_KEY:'fixture-key-a',OWNER_B_KEY:'fixture-key-b'},
    fetchFn:async (url,init={}) => {
      effects.push({
        url,auth:init.headers?.authorization,
        model:JSON.parse(init.body||'{}').model,
      });
      assert.equal(url,'https://owner-a.example.test/v1/chat/completions',
        'selected owner account origin must be exact');
      assert.equal(init.headers.authorization,'Bearer fixture-key-a',
        'selected endpoint binds exactly one credential namespace');
      return response({
        choices:[{message:{content:'durable account-bound result'}}],
        usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8},
      });
    },
  });
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  const gatewayUrl='http://127.0.0.1:'+gateway.address().port;
  try {
    const id='fixture-gateway-account-bound';
    let stored={byId:{[id]:{
      config:{maxModelCalls:1,maxOutputTokensPerCall:48,maxInputTokens:0,
        maxOutputTokens:0,maxTotalTokens:0,maxCostUsd:0,
        inputPricePerMillionUsd:0,outputPricePerMillionUsd:0},
      runtime:{runState:'RUNNING',controlEpoch:3,modelCalls:0,
        modelBudgetReservation:null,modelBudgetReservationSeq:0,
        inputTokens:0,outputTokens:0,totalTokens:0,
        estimatedCostUsd:0,history:[],startedAt:50_000},
    }}};
    const durable=Object.create(BrowserAgentManager.prototype);
    durable.now=()=>50_000;
    durable.update=async mutator => { stored=await mutator(stored);return stored; };
    const router=new AiOrchestrator({
      now:()=>50_000,gatewayClient:new AiGatewayClient(),
      providerCallLifecycle:{
        async beforeProviderCall({context,route,prompt,systemPrompt,maxOutputTokens,callNumber}) {
          return durable.reserveProviderModelBudget({
            jobId:context.jobId,controlEpoch:context.controlEpoch,
            route,prompt,systemPrompt,maxOutputTokens,callNumber,
          });
        },
        async afterProviderCall({context,reservation,ok,result}) {
          return durable.settleProviderModelBudget({
            jobId:context.jobId,reservationId:reservation.reservationId,ok,result,
          });
        },
      },
    });
    const result=await router.run({
      enabled:true,gatewayUrl,timeoutSeconds:30,mode:'primary',
      primary:{provider:'openai-compatible',model:'fixture-model'},
      routes:[{routeId:'route-owner-a',provider:'openai-compatible',
        model:'fixture-model',endpointId:'owner-a',roles:['planner'],
        locality:'remote',costClass:'paid',inputPricePerMillionUsd:1,
        outputPricePerMillionUsd:1,inputPriceKnown:true,outputPriceKnown:true,
        priority:1}],
      routePolicy:{autoSwitch:false,pinnedRouteId:'route-owner-a'},
      fallbackToStrongOnPrimaryError:false,
    },{},'account-bound fixture prompt',{
      maxOutputTokens:48,
      providerCallBudgetContext:{kind:'browser-agent',jobId:id,controlEpoch:3},
    });
    assert.equal(result.text,'durable account-bound result');
    assert.equal(result.runtime.lastRouteId,'route-owner-a');
    assert.equal(result.runtime.lastEndpointId,'owner-a');
    assert.equal(effects.length,1,'exactly one network effect for one durable reservation');
    assert.deepEqual(effects[0],{
      url:'https://owner-a.example.test/v1/chat/completions',
      auth:'Bearer fixture-key-a',model:'fixture-model',
    });
    assert.equal(stored.byId[id].runtime.modelCalls,1);
    assert.equal(stored.byId[id].runtime.modelBudgetReservation,null);
    assert.deepEqual(stored.byId[id].runtime.history.map(item=>item.type),
      ['model-budget-reserved','model-budget-settled']);
    assert.equal(JSON.stringify(result).includes('fixture-key-a'),false,
      'the model response and route runtime must never expose credential values');
  } finally {
    await new Promise(resolve=>gateway.close(resolve));
  }
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
    // Provider selection must be exact even on raw HTTP callers: duplicate,
    // whitespace-aliased or extra query fields cannot select an account.
    const malformedQueries = [
      'provider=ollama&provider=openai-compatible',
      'provider=openai-compatible&provider=openai-compatible&endpointId=team',
      'provider=%20openai-compatible%20&endpointId=team',
      'provider=&endpointId=team',
      'provider=openai-compatible&endpointId=team&credentialRef=fixture',
    ];
    for (const query of JSON.parse(JSON.stringify(malformedQueries))) {
      const result = await fetch(`${root}/models?${query}`);
      assert.equal(result.status, 400);
      assert.equal((await result.json()).code, 'AI_GATEWAY_PROVIDER_ID_INVALID');
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

test('Plan4 S1 loopback HTTP never infers a custom provider account from a single configured endpoint', async () => {
  const stored=JSON.stringify([{endpointId:'only-account',baseUrl:'https://tenant.example.test/v1',
    apiKeyEnv:'TENANT_KEY'}]);
  const endpoints=normalizeCompatibleEndpointRegistry(JSON.parse(stored));
  let upstream=0;
  const server=createGatewayServer({
    compatibleEndpoints:endpoints,env:{TENANT_KEY:'fixture-token-only'},
    fetchFn:async (url,init={})=>{
      upstream++;
      assert.equal(url.startsWith('https://tenant.example.test/v1/'),true);
      assert.equal(init.headers.authorization,'Bearer fixture-token-only');
      return url.endsWith('/models') ? response({data:[{id:'model-x'}]})
        : response({choices:[{message:{content:'verified'}}]});
    },
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  try {
    const health=await fetch(`${root}/health`);
    assert.equal(health.status,200);
    assert.deepEqual((await health.json()).compatibleEndpoints.map(x=>x.endpointId),['only-account']);
    const discovery=await fetch(`${root}/models?provider=openai-compatible`);
    assert.equal(discovery.status,404);
    assert.equal((await discovery.json()).code,'AI_COMPATIBLE_ENDPOINT_NOT_FOUND');
    const completion=await fetch(`${root}/complete`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({provider:'openai-compatible',model:'model-x',prompt:'no bound account'}),
    });
    assert.equal(completion.status,404);
    assert.equal((await completion.json()).code,'AI_COMPATIBLE_ENDPOINT_NOT_FOUND');
    assert.equal(upstream,0,'no credential or prompt leaves without explicit account identity');
    const models=await fetch(`${root}/models?provider=openai-compatible&endpointId=only-account`);
    assert.equal(models.status,200);
    assert.equal((await models.json()).endpointId,'only-account');
    const exact=await fetch(`${root}/complete`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({provider:'openai-compatible',endpointId:'only-account',model:'model-x',prompt:'approved'}),
    });
    assert.equal(exact.status,200);
    const result=await exact.json();
    assert.equal(result.endpointId,'only-account');
    assert.equal(result.text,'verified');
    assert.equal(upstream,2);
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});

test('Plan4 S1 explicitly empty endpoint registry remains disabled after restart with a healthy local gateway', async () => {
  // Persisted [] is intentional authorization of zero compatible accounts.
  // /health must not crash, invent an implicit default, or perform provider I/O.
  const compatibleEndpoints=normalizeCompatibleEndpointRegistry(JSON.stringify([]));
  let providerCalls=0;
  const server=createGatewayServer({
    compatibleEndpoints,
    fetchFn:async ()=>{ providerCalls++; throw new Error('provider must not be contacted'); },
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  try {
    const health=await fetch(`${root}/health`);
    assert.equal(health.status,200);
    const state=await health.json();
    assert.equal(state.ok,true);
    assert.deepEqual(state.compatibleEndpoints,[]);
    assert.equal(state.compatibleBaseUrl,'');
    assert.equal(state.compatibleTransport,'');
    for (const req of [
      () => fetch(`${root}/models?provider=openai-compatible`),
      () => fetch(`${root}/complete`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({provider:'openai-compatible',model:'model-x',prompt:'never send'}),
      }),
    ]) {
      const result=await req();
      assert.equal(result.status,404);
      assert.equal((await result.json()).code,'AI_COMPATIBLE_ENDPOINT_NOT_FOUND');
    }
    assert.equal(providerCalls,0);
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

test('Plan4 S1 HTTP boundary rejects foreign endpointId for built-in account before any upstream request', async () => {
  const upstream=[];
  const server=createGatewayServer({
    fetchFn:async (url,init={})=>{
      upstream.push({url,method:init.method || 'GET'});
      return url.endsWith('/api/tags') ? response({models:[{name:'fixture-ollama'}]})
        : response({message:{content:'fixture-response'}});
    },
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const provider of ['ollama','openai']) {
      const discovered=await fetch(`${root}/models?provider=${provider}&endpointId=wrong.account`);
      assert.equal(discovered.status,400);
      assert.equal((await discovered.json()).code,'AI_BUILTIN_ENDPOINT_ID_UNSUPPORTED');
      const completion=await fetch(`${root}/complete`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({provider,endpointId:'wrong.account',model:'fixture',prompt:'approved'}),
      });
      assert.equal(completion.status,400);
      assert.equal((await completion.json()).code,'AI_BUILTIN_ENDPOINT_ID_UNSUPPORTED');
    }
    assert.equal(upstream.length,0,'no model discovery or provider call can cross the wrong account boundary');
    const valid=await fetch(`${root}/models?provider=ollama`);
    assert.equal(valid.status,200);
    assert.deepEqual((await valid.json()).models,['fixture-ollama']);
    assert.equal(upstream.length,1,'legacy unbound local provider still functions');
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});

test('Plan4 S1 remote compatible registry requires credential ref before provider I/O and after JSON restart', async () => {
  const remote = { endpointId: 'tenant-account', baseUrl: 'https://tenant.example.test/v1' };
  const unauthenticated = [remote, { ...remote, apiKeyEnv: '' }];
  for (const entry of unauthenticated) {
    for (const snapshot of [entry, JSON.parse(JSON.stringify(entry))]) {
      assert.throws(
        () => normalizeCompatibleEndpointRegistry([snapshot]),
        error => error?.code === 'AI_COMPATIBLE_CREDENTIAL_REF_REQUIRED',
        'remote compatible account cannot silently become credentialless',
      );
    }
  }

  // The existing explicitly credentialless loopback configuration stays valid.
  const local = normalizeCompatibleEndpointRegistry([
    { endpointId: 'local-only', baseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnv: '' },
  ]);
  assert.equal(local[0].apiKeyEnv, '');

  const persisted = JSON.stringify([{ ...remote, apiKeyEnv: 'TENANT_TEST_KEY' }]);
  const compatibleEndpoints = normalizeCompatibleEndpointRegistry(JSON.parse(persisted));
  assert.equal(compatibleEndpoints[0].apiKeyEnv, 'TENANT_TEST_KEY');
  let upstreamCalls = 0;
  const server = createGatewayServer({
    compatibleEndpoints,
    env: {},
    fetchFn: async () => {
      upstreamCalls += 1;
      throw new Error('unconfigured remote account must not dispatch');
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const discovery = await fetch(`${root}/models?provider=openai-compatible&endpointId=tenant-account`);
    assert.equal(discovery.status, 428);
    assert.equal((await discovery.json()).code, 'AI_PROVIDER_API_KEY_NOT_CONFIGURED');
    const completion = await fetch(`${root}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai-compatible', endpointId: 'tenant-account', model: 'fixture',
        prompt: 'private fixture must never be sent',
      }),
    });
    assert.equal(completion.status, 428);
    assert.equal((await completion.json()).code, 'AI_PROVIDER_API_KEY_NOT_CONFIGURED');
    assert.equal(upstreamCalls, 0, 'missing remote credentials never trigger discovery or completion effect');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Plan4 S1 built-in OpenAI uses exact injected gateway credential scope for health, discovery, probe and completion', async () => {
  for (const configured of [false, true]) {
    const env = configured ? { OPENAI_API_KEY: 'scope-only-fixture-key' } : {};
    const upstream = [];
    const fetchFn = async (url, init = {}) => {
      if (url.startsWith('https://api.openai.com/v1/')) {
        upstream.push({ url, auth: init.headers?.authorization });
        assert.equal(init.headers?.authorization, 'Bearer scope-only-fixture-key');
        return url.endsWith('/models')
          ? response({ data: [{ id: 'scope-fixture-model' }] })
          : response({
              output_text: 'scope-fixture-reply',
              usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            });
      }
      return response({ models: [] });
    };
    const server = createGatewayServer({ env, fetchFn });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    try {
      const health = await (await fetch(`${root}/health`)).json();
      assert.equal(health.openaiConfigured, configured, 'health must reflect the injected account');
      const status = await (await fetch(`${root}/status`)).json();
      const openai = status.providers.find(item => item.provider === 'openai');
      assert.equal(openai.configured, configured, 'probe must agree with the same account scope');
      assert.equal(openai.ok, configured);
      const discovery = await fetch(`${root}/models?provider=openai`);
      const completion = await fetch(`${root}/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', model: 'scope-fixture-model', prompt: 'bounded fixture prompt' }),
      });
      if (configured) {
        assert.equal(discovery.status, 200);
        assert.deepEqual((await discovery.json()).models, ['scope-fixture-model']);
        assert.equal(completion.status, 200);
        assert.equal((await completion.json()).text, 'scope-fixture-reply');
        assert.equal(upstream.length, 3, 'one readiness probe, one discovery, one completion');
        assert.ok(upstream.every(call => call.auth === 'Bearer scope-only-fixture-key'));
      } else {
        assert.equal(discovery.status, 400);
        assert.equal(completion.status, 400);
        assert.equal(upstream.length, 0, 'unconfigured account never inherits host credentials or dispatches');
      }
      assert.equal(JSON.stringify(health).includes('scope-only-fixture-key'), false);
      assert.equal(JSON.stringify(status).includes('scope-only-fixture-key'), false);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('Plan4 S1 named loopback account never silently drops an explicitly required key after JSON cold restart', async () => {
  const source = { endpointId:'local-team', baseUrl:'http://127.0.0.1:1234/v1', apiKeyEnv:'LOCAL_TEAM_KEY' };
  for (const persisted of [source, JSON.parse(JSON.stringify(source))]) {
    const endpoints = normalizeCompatibleEndpointRegistry([persisted]);
    let upstreamCalls = 0;
    const server = createGatewayServer({
      compatibleEndpoints:endpoints,
      env:{},
      fetchFn:async () => { upstreamCalls += 1; return response({ data:[] }); },
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    try {
      const discovery = await fetch(`${root}/models?provider=openai-compatible&endpointId=local-team`);
      assert.equal(discovery.status, 428);
      assert.equal((await discovery.json()).code, 'AI_PROVIDER_API_KEY_NOT_CONFIGURED');
      const completion = await fetch(`${root}/complete`, {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ provider:'openai-compatible', endpointId:'local-team', model:'fixture', prompt:'private fixture' }),
      });
      assert.equal(completion.status, 428);
      assert.equal((await completion.json()).code, 'AI_PROVIDER_API_KEY_NOT_CONFIGURED');
      assert.equal(upstreamCalls, 0, 'credential-bound loopback never dispatches without its named key');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  const endpoints = normalizeCompatibleEndpointRegistry([source]);
  const calls = [];
  const server = createGatewayServer({
    compatibleEndpoints:endpoints,
    env:{ LOCAL_TEAM_KEY:'local-fixture-only' },
    fetchFn:async (url, init) => {
      calls.push([url, init.headers.authorization]);
      return url.endsWith('/models')
        ? response({ data:[{ id:'local-fixture-model' }] })
        : response({ choices:[{ message:{ content:'local fixture result' } }] });
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const discovery = await fetch(`${root}/models?provider=openai-compatible&endpointId=local-team`);
    assert.equal(discovery.status, 200);
    assert.deepEqual((await discovery.json()).models, ['local-fixture-model']);
    const completion = await fetch(`${root}/complete`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ provider:'openai-compatible', endpointId:'local-team', model:'local-fixture-model', prompt:'task' }),
    });
    assert.equal(completion.status, 200);
    assert.equal((await completion.json()).text, 'local fixture result');
    assert.deepEqual(calls, [
      ['http://127.0.0.1:1234/v1/models', 'Bearer local-fixture-only'],
      ['http://127.0.0.1:1234/v1/chat/completions', 'Bearer local-fixture-only'],
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Plan4 S1 direct HTTP provider output ceiling is exact and never coerced to unlimited', async () => {
  const upstreamCalls = [];
  const server = createGatewayServer({
    fetchFn:async (url, init) => {
      upstreamCalls.push([url, init]);
      return response({ message:{ content:'bounded fixture' } });
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const request = async maxOutputTokens => fetch(`${root}/complete`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ provider:'ollama', model:'local-fixture', prompt:'bounded task', maxOutputTokens }),
  });
  try {
    const invalid = [-1, null, '12', 1.25, true, [], {}, Number.MAX_SAFE_INTEGER + 1];
    for (const raw of invalid) {
      const restored = JSON.parse(JSON.stringify(raw));
      const result = await request(restored);
      assert.equal(result.status, 400, `reject malformed ceiling ${JSON.stringify(raw)}`);
      assert.equal((await result.json()).code, 'AI_PROVIDER_OUTPUT_LIMIT_INVALID');
      assert.equal(upstreamCalls.length, 0, 'invalid owner ceiling must not reach a model provider');
    }
    const positive = await request(12);
    assert.equal(positive.status, 200);
    assert.equal((await positive.json()).text, 'bounded fixture');
    assert.equal(upstreamCalls.length, 1);
    assert.deepEqual(JSON.parse(upstreamCalls[0][1].body).options, { num_predict:12 });
    const legacyZero = await request(0);
    assert.equal(legacyZero.status, 200);
    assert.equal(upstreamCalls.length, 2);
    assert.equal(JSON.parse(upstreamCalls[1][1].body).options, undefined,
      'explicit numeric zero keeps the documented legacy unlimited setting');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Plan4 S1 actual route evidence to HTTP provider and durable budget lifecycle', async () => {
  const route = {
    schemaVersion:1, routeId:'owner-route', provider:'openai-compatible',
    model:'fixture-model', endpointId:'owner.account', locality:'remote',
    costClass:'paid', priority:10, inputPriceKnown:true, outputPriceKnown:true,
    inputPricePerMillionUsd:1, outputPricePerMillionUsd:2,
  };
  const profile = {
    schemaVersion:1, profileId:'owner.profile', provider:'openai-compatible',
    endpointId:'owner.account', origin:'https://fixture-provider.example.test/',
    locality:'remote', credentialRef:'PLAN4_E2E_KEY', credentialless:false,
    accountId:'owner', modelIds:['fixture-model'],
  };
  const registry = {schemaVersion:1, registryRevision:10, routes:[route], endpointProfiles:[profile]};
  const evidence = await createAiRouteRegistryEvidenceV1(registry);
  const restartedEvidence = await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(registry)));
  assert.equal(restartedEvidence.configSha256, evidence.configSha256);
  assert.equal(evidence.routeIdentities[0].endpointBinding, 'MATCHED');
  assert.equal(evidence.routeIdentities[0].endpointProfileId, 'owner.profile');

  let upstreamCalls = 0;
  for (const changed of [
    {...route, endpointId:'wrong-account'},
    {...route, model:'unapproved-model'},
    {...route, locality:'local'},
  ]) {
    await assert.rejects(createAiRouteRegistryEvidenceV1({
      ...registry, routes:[changed],
    }), /endpoint|model|locality/i);
  }
  await assert.rejects(createAiRouteRegistryEvidenceV1({
    ...registry, endpointProfiles:[profile, {
      ...profile, profileId:'owner.other', endpointId:'other.account',
      origin:'https://second-provider.example.test/',
    }],
  }), /credential reference cannot bind distinct origins/);
  assert.equal(upstreamCalls,0,'invalid registry evidence cannot dispatch a provider request');

  const endpoints = normalizeCompatibleEndpointRegistry(JSON.parse(JSON.stringify([
    {endpointId:'owner.account',baseUrl:'https://fixture-provider.example.test/v1',
      apiKeyEnv:'PLAN4_E2E_KEY'},
  ])));
  const dispatched = [];
  const gateway = createGatewayServer({
    compatibleEndpoints:endpoints, env:{PLAN4_E2E_KEY:'fixture-token-not-real'},
    fetchFn:async (url,init={}) => {
      upstreamCalls++;
      dispatched.push({url,authorization:init.headers?.authorization,
        payload:JSON.parse(init.body)});
      return response({
        choices:[{message:{content:'fixture-approved'}}],
        usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5},
      });
    },
  });
  await new Promise(resolve => gateway.listen(0,'127.0.0.1',resolve));
  const gatewayUrl=`http://127.0.0.1:${gateway.address().port}`;
  try {
    const ownerSettings = JSON.parse(JSON.stringify({
      enabled:true,mode:'primary',
      primary:{provider:'openai-compatible',model:'fixture-model'},
      fallbackToStrongOnPrimaryError:false, gatewayUrl,
      routes:[route],routePolicy:{pinnedRouteId:'owner-route',autoSwitch:false},
    }));
    const budgetContext = {jobId:'plan4-end-to-end',controlEpoch:3};
    const options = {
      providerCallBudgetContext:budgetContext,
      maxModelCallsForRequest:1,maxOutputTokens:12,
    };
    const events = [];
    const lifecycle = {
      async beforeProviderCall({context,route:selected,maxOutputTokens,callNumber}) {
        assert.equal(context,budgetContext);
        assert.deepEqual({
          routeId:selected.routeId,provider:selected.provider,
          model:selected.model,endpointId:selected.endpointId,
        }, {
          routeId:'owner-route',provider:'openai-compatible',
          model:'fixture-model',endpointId:'owner.account',
        });
        assert.equal(maxOutputTokens,12);
        assert.equal(callNumber,1);
        events.push('reserved');
        return {reservationId:'plan4-end-to-end:reserved:1'};
      },
      async afterProviderCall({reservation,route:selected,ok,result}) {
        assert.equal(reservation.reservationId,'plan4-end-to-end:reserved:1');
        assert.equal(selected.endpointId,'owner.account');
        assert.equal(ok,true);
        assert.equal(result.provider,'openai-compatible');
        assert.equal(result.model,'fixture-model');
        assert.equal(result.endpointId,'owner.account');
        assert.equal(result.usage.totalTokens,5);
        events.push('settled');
        return {settled:true};
      },
    };
    const router=new AiOrchestrator({
      gatewayClient:new AiGatewayClient(),providerCallLifecycle:lifecycle,
    });
    const completed=await router.run(ownerSettings,{},'approved owner prompt',options);
    assert.equal(completed.routing.selectedRouteId,'owner-route');
    assert.equal(completed.routing.selectedEndpointId,'owner.account');
    assert.equal(completed.text,'fixture-approved');
    assert.deepEqual(events,['reserved','settled']);
    assert.equal(upstreamCalls,1,'exactly one actual compatible provider dispatch');
    assert.equal(dispatched[0].url,'https://fixture-provider.example.test/v1/chat/completions');
    assert.equal(dispatched[0].authorization,'Bearer fixture-token-not-real');
    assert.equal(dispatched[0].payload.model,'fixture-model');
    assert.equal(dispatched[0].payload.max_tokens,12);
    assert.equal(dispatched[0].payload.messages.at(-1).content,'approved owner prompt');
    assert.equal(JSON.stringify(completed).includes('fixture-token-not-real'),false);

    // A consumed provider result with UNKNOWN settlement must not be replayed
    // into a second model call or published as a successful answer.
    const unverified = new AiOrchestrator({
      gatewayClient:new AiGatewayClient(),
      providerCallLifecycle:{
        async beforeProviderCall(){return {reservationId:'plan4-unknown:1'};},
        async afterProviderCall(){return {settled:false};},
      },
    });
    await assert.rejects(unverified.run(JSON.parse(JSON.stringify(ownerSettings)),{},
      'approved retry safety',options),
      error => error.code==='AI_MODEL_BUDGET_SETTLEMENT_UNKNOWN'
        && error.routeAttempts?.[0]?.outcome==='UNKNOWN');
    assert.equal(upstreamCalls,2,'UNKNOWN settlement must not retry a second provider');
  } finally {
    await new Promise(resolve => gateway.close(resolve));
  }
});
