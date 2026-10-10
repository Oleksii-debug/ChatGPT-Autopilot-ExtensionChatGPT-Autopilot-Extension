import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeProvider, listProviderModels, loadCompatibleEndpointRegistry, normalizeCompatibleBaseUrl, normalizeCompatibleEndpointRegistry, probeProvider } from '../companion/ai-gateway/gateway.mjs';

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

test('gateway selects bounded compatible endpoints by ID and resolves secrets only from named environment variables', async () => {
  const endpoints = normalizeCompatibleEndpointRegistry([
    { endpointId:'local', baseUrl:'http://127.0.0.1:1234/v1', apiKeyEnv:'' },
    { endpointId:'team', baseUrl:'https://models.example.com/v1', apiKeyEnv:'TEAM_MODELS_KEY' },
  ]);
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push([url, init]);
    if (url.endsWith('/models')) return response({ data:[{ id:'team-coder' }] });
    return response({ choices:[{ message:{ content:'team result' } }] });
  };
  assert.deepEqual(await listProviderModels('openai-compatible', {
    fetchFn, endpointId:'team', compatibleEndpoints:endpoints, env:{ TEAM_MODELS_KEY:'secret-value' },
  }), ['team-coder']);
  const result = await completeProvider({ provider:'openai-compatible', endpointId:'team', model:'team-coder', prompt:'task' }, {
    fetchFn, compatibleEndpoints:endpoints, env:{ TEAM_MODELS_KEY:'secret-value' },
  });
  assert.equal(result.endpointId, 'team');
  assert.equal(result.text, 'team result');
  assert.deepEqual(calls.map(([url]) => url), ['https://models.example.com/v1/models', 'https://models.example.com/v1/chat/completions']);
  assert.deepEqual(calls.map(([, init]) => init.headers.authorization), ['Bearer secret-value', 'Bearer secret-value']);
  await assert.rejects(
    () => listProviderModels('openai-compatible', { fetchFn, endpointId:'missing', compatibleEndpoints:endpoints }),
    error => error.statusCode === 404 && error.code === 'AI_COMPATIBLE_ENDPOINT_NOT_FOUND',
  );
});

test('compatible endpoint registry rejects duplicate IDs, inline secrets and insecure remote HTTP', () => {
  assert.throws(() => normalizeCompatibleEndpointRegistry([
    { endpointId:'same', baseUrl:'https://one.example/v1' },
    { endpointId:'same', baseUrl:'https://two.example/v1' },
  ]), /Duplicate/);
  assert.throws(() => normalizeCompatibleEndpointRegistry([
    { endpointId:'leak', baseUrl:'https://one.example/v1', apiKey:'inline-secret' },
  ]), /unsupported field: apiKey/);
  assert.throws(() => normalizeCompatibleEndpointRegistry([
    { endpointId:'unsafe', baseUrl:'http://models.example.com/v1' },
  ]), /must use HTTPS/);
  assert.throws(() => normalizeCompatibleEndpointRegistry('{bad json'), /must be valid JSON/);
});

test('Plan4 S1 real gateway registry preserves exact account endpoint and credential-ref identity after JSON restart', () => {
  const endpoint={endpointId:'team',baseUrl:'https://models.example.test/v1',apiKeyEnv:'TEAM_KEY'};
  const valid=normalizeCompatibleEndpointRegistry(JSON.parse(JSON.stringify([endpoint])));
  assert.deepEqual(valid[0],endpoint);
  for(const bad of [
    {...endpoint,endpointId:' team '},
    {...endpoint,endpointId:'team '},
    {...endpoint,endpointId:'\tteam'},
    {...endpoint,endpointId:null},
    {...endpoint,endpointId:undefined},
    {...endpoint,apiKeyEnv:' TEAM_KEY '},
    {...endpoint,apiKeyEnv:'TEAM_KEY\n'},
    {...endpoint,apiKeyEnv:null},
  ]) {
    assert.throws(
      ()=>normalizeCompatibleEndpointRegistry([bad]),
      error=>error.code==='INVALID_COMPATIBLE_ENDPOINT_REGISTRY',
    );
    assert.throws(
      ()=>normalizeCompatibleEndpointRegistry(JSON.parse(JSON.stringify([bad]))),
      error=>error.code==='INVALID_COMPATIBLE_ENDPOINT_REGISTRY',
    );
  }
});

test('Plan4 S1 real gateway denies malformed endpoint IDs before account credential/network effect', async () => {
  const compatibleEndpoints=normalizeCompatibleEndpointRegistry([
    {endpointId:'local',baseUrl:'http://127.0.0.1:1234/v1',apiKeyEnv:''},
    {endpointId:'team',baseUrl:'https://models.example.test/v1',apiKeyEnv:'TEAM_KEY'},
  ]);
  let fetchCalls=0;
  const fetchFn=async ()=>{fetchCalls++;return response({data:[{id:'model'}]});};
  const env={TEAM_KEY:'test-fixture-opaque-credential'};
  for(const endpointId of [' team ','team ', '\tteam',null,{},42]) {
    await assert.rejects(
      listProviderModels('openai-compatible',{endpointId,compatibleEndpoints,env,fetchFn}),
      error=>error.code==='AI_COMPATIBLE_ENDPOINT_ID_INVALID',
    );
    await assert.rejects(
      completeProvider({provider:'openai-compatible',endpointId,model:'model',prompt:'test'},
        {compatibleEndpoints,env,fetchFn}),
      error=>error.code==='AI_COMPATIBLE_ENDPOINT_ID_INVALID',
    );
  }
  assert.equal(fetchCalls,0);
  const ok=await listProviderModels('openai-compatible',{
    endpointId:'team',compatibleEndpoints,env,fetchFn,
  });
  assert.deepEqual(ok,['model']);
  assert.equal(fetchCalls,1);
});

test('compatible endpoint registry loads local non-secret settings unless an explicit env registry overrides them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-endpoints-'));
  const configFile = path.join(dir, 'gateway-settings.json');
  try {
    fs.writeFileSync(configFile, JSON.stringify({ compatibleEndpoints:[{ endpointId:'saved', baseUrl:'https://saved.example/v1', apiKeyEnv:'SAVED_KEY' }] }));
    assert.equal(loadCompatibleEndpointRegistry({ env:{}, configFile })[0].endpointId, 'saved');
    const overridden = loadCompatibleEndpointRegistry({
      env:{ AUTOPILOT_COMPATIBLE_ENDPOINTS_JSON:JSON.stringify([{ endpointId:'env', baseUrl:'https://env.example/v1' }]) },
      configFile,
    });
    assert.equal(overridden[0].endpointId, 'env');
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
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

test('Plan4 S1 bound endpoint identity cannot silently fall through to builtin default account', async () => {
  let providerEffects=0;
  const fetchFn=async () => { providerEffects++; return response({models:[],data:[]}); };
  // Builtin OpenAI and Ollama each have exactly one configured transport
  // identity; a persisted route endpointId for a different account is not
  // evidence that the transport can honor it.
  for (const provider of ['ollama', 'openai']) {
    for (const endpointId of ['team.account', ' local ', null, 13, {}]) {
      await assert.rejects(
        listProviderModels(provider, { endpointId, fetchFn }),
        error => error.code === 'AI_BUILTIN_ENDPOINT_ID_UNSUPPORTED' && error.statusCode === 400,
      );
      await assert.rejects(
        completeProvider({provider, endpointId, model:'fixture', prompt:'approved'}, {fetchFn}),
        error => error.code === 'AI_BUILTIN_ENDPOINT_ID_UNSUPPORTED' && error.statusCode === 400,
      );
      await assert.rejects(
        probeProvider(provider, { endpointId, fetchFn }),
        error => error.code === 'AI_BUILTIN_ENDPOINT_ID_UNSUPPORTED' && error.statusCode === 400,
      );
    }
  }
  assert.equal(providerEffects,0,'no discovery or completion I/O on wrong account identity');
  const restored=JSON.parse(JSON.stringify({provider:'ollama',endpointId:'team.account',model:'fixture',prompt:'approved'}));
  await assert.rejects(completeProvider(restored,{fetchFn}),error =>
    error.code === 'AI_BUILTIN_ENDPOINT_ID_UNSUPPORTED');
  assert.equal(providerEffects,0,'cold restart may not reset wrong account endpoint to default');
  assert.deepEqual(await listProviderModels('ollama',{fetchFn:async () => response({models:[{name:'fixture'}]})}),['fixture']);
});


test('Plan4 S1 standalone provider gateway rejects aliased and hostile model identity before upstream or credential effects', async () => {
  let upstream = 0;
  const fetchFn = async () => { upstream++; throw new Error('unexpected upstream model effect'); };
  const bad = [
    ' model', 'model ', 'model\u0000identity', 'model\u000Aidentity',
    'model\u007fidentity', 'model\u0080identity', 'model\u061cidentity',
    'model\u200eidentity', 'model\u202eidentity', 'model\u2028identity',
    'model\u2066identity', 'model\ud800identity', 'model\udc00identity',
    'x'.repeat(301),
  ];
  for (const malformed of bad) {
    for (const persisted of [malformed, JSON.parse(JSON.stringify(malformed))]) {
      for (const provider of ['ollama','openai','openai-compatible']) {
        await assert.rejects(
          completeProvider({provider,model:persisted,prompt:'approved'}, {fetchFn}),
          error => error.statusCode === 400 && error.code === 'AI_MODEL_ID_INVALID'
            && !String(error.message).includes('unexpected upstream'),
        );
      }
    }
  }
  assert.equal(upstream,0,'no provider request can be sent with aliased or malformed model');
});

test('Plan4 S1 standalone gateway preserves exact multilingual model identity after JSON cold restart', async () => {
  const model = 'Київ/模型:v2';
  const persisted = JSON.parse(JSON.stringify({provider:'ollama',model,prompt:'approved'}));
  const sent = [];
  const result = await completeProvider(persisted, {fetchFn:async (url,init) => {
    sent.push({url,body:JSON.parse(init.body)});
    return response({message:{content:'verified'},prompt_eval_count:2,eval_count:1});
  }});
  assert.equal(sent.length,1);
  assert.equal(sent[0].body.model,model);
  assert.equal(result.model,model);
  assert.equal(result.text,'verified');
});
