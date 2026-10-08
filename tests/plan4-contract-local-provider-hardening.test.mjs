import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAiRoutePool, normalizeAiRoutePolicy, createAiRouteRegistryEvidenceV1, selectAiRouteCandidates } from '../src/core/ai-route-pool.js';
import { LocalAiClient, normalizeLocalAiSettings, normalizeLocalAiBaseUrl, normalizeLocalAiUsage } from '../src/core/local-ai-provider.js';
import { AiGatewayClient, normalizeGatewayUrl } from '../src/core/ai-gateway-client.js';
import { normalizeAiRouterSettings } from '../src/core/ai-orchestrator.js';

const route = { routeId:'primary', provider:'ollama', model:'llama3', locality:'local' };
const endpoint = { schemaVersion:1, profileId:'local.ollama', provider:'ollama', endpointId:'', locality:'local', origin:'http://127.0.0.1:11434/', credentialRef:'', credentialless:true };
const snapshot = { schemaVersion:1, registryRevision:4, routes:[route], endpointProfiles:[endpoint] };
const settings = { enabled:true, providerType:'ollama', model:'llama3', baseUrl:'http://127.0.0.1:11434', timeoutSeconds:5 };

test('route migration accepts versionless v1 and rejects unknown versions', () => {
  assert.equal(normalizeAiRoutePool([route])[0].schemaVersion,1);
  assert.throws(() => normalizeAiRoutePool([{...route,schemaVersion:'1'}]));
  assert.throws(() => normalizeAiRoutePool([{...route,schemaVersion:2}]));
});

test('price-capped route eligibility fails closed on unreported cost after migration/restart', () => {
  const unreported = { routeId:'fixture.free', provider:'openai-compatible', model:'fixture',
    locality:'local', costClass:'free' };
  const policy = { maxInputPricePerMillionUsd:0, maxOutputPricePerMillionUsd:0 };
  const select = routes => selectAiRouteCandidates({
    routes:JSON.parse(JSON.stringify(routes)), policy, now:1,
  }).candidates.map(item => item.routeId);
  assert.deepEqual(select([unreported]), []);
  assert.deepEqual(select([{...unreported,inputPricePerMillionUsd:0}]), []);
  assert.deepEqual(select([{...unreported,outputPricePerMillionUsd:0}]), []);
  assert.deepEqual(select([{...unreported,inputPricePerMillionUsd:0,outputPricePerMillionUsd:0}]), ['fixture.free']);
  assert.deepEqual(select([{...unreported,inputPricePerMillionUsd:1,outputPricePerMillionUsd:0}]), []);
  assert.deepEqual(select([{...unreported,inputPricePerMillionUsd:0,outputPricePerMillionUsd:0,inputPriceKnown:false}]), []);
  assert.deepEqual(selectAiRouteCandidates({routes:[unreported],policy:{},now:1}).eligibleRouteIds,['fixture.free']);
});

test('configuration evidence is deterministic, versioned and non-authoritative', async () => {
  const first = await createAiRouteRegistryEvidenceV1(snapshot);
  const restored = await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(snapshot)));
  const changed = await createAiRouteRegistryEvidenceV1({...snapshot,registryRevision:5});
  assert.equal(first.configSha256,restored.configSha256);
  assert.notEqual(first.configSha256,changed.configSha256);
  assert.match(first.configSha256,/^[0-9a-f]{64}$/);
  assert.equal(first.authority.canGrantPermission,false);
  assert.ok(Object.isFrozen(first.routeIdentities));
});

for (const [name, invalid] of [
  ['future evidence version', {...snapshot,schemaVersion:2}],
  ['negative registry revision', {...snapshot,registryRevision:-1}],
  ['unexpected permission field', {...snapshot,executionAuthorized:true}],
  ['future endpoint schema', {...snapshot,endpointProfiles:[{...endpoint,schemaVersion:2}]}],
  ['duplicate profiles', {...snapshot,endpointProfiles:[endpoint,endpoint]}],
  ['embedded credential', {...snapshot,endpointProfiles:[{...endpoint,origin:'http://secret@127.0.0.1:11434/'}]}],
  ['local SSRF', {...snapshot,endpointProfiles:[{...endpoint,origin:'https://example.com/'}]}],
  ['remote HTTP', {...snapshot,endpointProfiles:[{...endpoint,origin:'http://example.com/',locality:'remote'}]}],
  ['remote credentialless', {...snapshot,endpointProfiles:[{...endpoint,origin:'https://example.com/',locality:'remote'}]}],
]) test('configuration rejects '+name, async () => {
  await assert.rejects(createAiRouteRegistryEvidenceV1(invalid));
});

test('opaque credential reference allowed but remote profile requires it', async () => {
  const remote = {...endpoint,profileId:'r1',provider:'openai-compatible',origin:'https://provider.example/',locality:'remote',credentialless:false,credentialRef:'ref-1'};
  const ok = await createAiRouteRegistryEvidenceV1({...snapshot,endpointProfiles:[remote]});
  assert.equal(ok.endpointProfiles[0].credentialRef,'ref-1');
  await assert.rejects(createAiRouteRegistryEvidenceV1({...snapshot,endpointProfiles:[{...remote,credentialRef:''}]}));
});

test('local endpoint is loopback-only and refuses secrets in URL or extra permissions', () => {
  assert.throws(() => normalizeLocalAiBaseUrl('http://127.0.0.1:11434/?token=abc'));
  assert.throws(() => normalizeLocalAiBaseUrl('http://127.0.0.1:11434/#token'));
  assert.throws(() => normalizeLocalAiSettings({...settings,allowRemote:true}));
});

test('NOT_CONFIGURED performs no network operation', async () => {
  let called=0;
  const client=new LocalAiClient({fetchFn:()=>{called++;throw new Error('unexpected network');}});
  for (const config of [{...settings,enabled:false},{...settings,model:''}]) {
    await assert.rejects(client.complete(config,'hi'),e=>e.code==='LOCAL_AI_NOT_CONFIGURED'&&e.retryable===false);
  }
  assert.equal(called,0);
});

for (const [status,category,retryable] of [[401,'AUTH',false],[403,'AUTH',false],[429,'RATE_LIMIT',true],[408,'TIMEOUT',true],[500,'UNAVAILABLE',true],[503,'UNAVAILABLE',true],[404,'NOT_FOUND',false]]) {
  test('local HTTP '+status+' classified; never remote failover',async()=>{
    const calls=[];
    const client=new LocalAiClient({fetchFn:async url=>{
      calls.push(url);
      return new Response(JSON.stringify({error:{message:'sk-fake-secret'}}),{status});
    }});
    await assert.rejects(client.complete(settings,'hi'),e=>
      e.status===status&&e.category===category&&e.retryable===retryable&&!e.message.includes('sk-fake-secret'));
    assert.equal(calls.length,1);
    assert.equal(new URL(calls[0]).hostname,'127.0.0.1');
  });
}

test('network and timeout errors are typed without leaking upstream messages', async()=>{
  const network=new LocalAiClient({fetchFn:async()=>{throw new Error('sk-fake-secret');}});
  await assert.rejects(network.complete(settings,'hi'),e=>e.code==='LOCAL_AI_UNAVAILABLE'&&!e.message.includes('sk-fake-secret'));
  const timeout=new LocalAiClient({fetchFn:async()=>{throw Object.assign(new Error('aborted'),{name:'AbortError'});}});
  await assert.rejects(timeout.complete(settings,'hi'),e=>e.code==='LOCAL_AI_TIMEOUT'&&e.retryable===true);
});

test('usage accounting preserves unknown, validates provider numbers and rejects mismatch',()=>{
  assert.equal(normalizeLocalAiUsage('ollama',{prompt_eval_count:3,eval_count:2}).totalTokens,5);
  assert.equal(normalizeLocalAiUsage('openai-compatible',{usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}).totalTokens,5);
  assert.equal(normalizeLocalAiUsage('openai-compatible',{}).totalTokens,null);
  assert.throws(()=>normalizeLocalAiUsage('openai-compatible',{usage:{prompt_tokens:3,completion_tokens:2,total_tokens:10}}));
});

test('successful completion retains local boundary and returns normalized usage',async()=>{
  const client=new LocalAiClient({fetchFn:async (url,init)=>{
    assert.match(url,/^http:\/\/127\.0\.0\.1:11434\/api\/chat$/);
    assert.equal(init.redirect,'error');
    return new Response(JSON.stringify({message:{content:'hello'},prompt_eval_count:3,eval_count:2}),{status:200});
  }});
  const result=await client.complete(settings,'hi');
  assert.equal(result.text,'hello');
  assert.equal(result.usage.totalTokens,5);
  assert.equal('permissionAuthority' in result,false);
});


test('endpoint identity must match provider and locality; missing and ambiguous bindings fail closed', async () => {
  const boundRoute={...route,endpointId:'endpoint.loopback'};
  const boundEndpoint={...endpoint,endpointId:'endpoint.loopback'};
  const evidence=await createAiRouteRegistryEvidenceV1({...snapshot,routes:[boundRoute],endpointProfiles:[boundEndpoint]});
  assert.equal(evidence.routeIdentities[0].endpointBinding,'MATCHED');
  assert.equal(evidence.routeIdentities[0].endpointProfileId,'local.ollama');
  assert.equal(evidence.authority.canGrantPermission,false);
  const legacy=await createAiRouteRegistryEvidenceV1(snapshot);
  assert.equal(legacy.routeIdentities[0].endpointBinding,'UNRESOLVED_LEGACY');
  await assert.rejects(createAiRouteRegistryEvidenceV1({...snapshot,routes:[boundRoute]}),/no registry profile/);
  await assert.rejects(createAiRouteRegistryEvidenceV1({
    ...snapshot,routes:[boundRoute],endpointProfiles:[{...boundEndpoint,provider:'openai'}],
  }),/does not match/);
  await assert.rejects(createAiRouteRegistryEvidenceV1({
    ...snapshot,routes:[boundRoute],endpointProfiles:[{...boundEndpoint,locality:'remote',origin:'https:\/\/provider.example/',credentialless:false,credentialRef:'opaque.ref'}],
  }),/does not match/);
  await assert.rejects(createAiRouteRegistryEvidenceV1({
    ...snapshot,routes:[boundRoute],endpointProfiles:[boundEndpoint,{...boundEndpoint,profileId:'other'}],
  }),/Ambiguous AI endpoint identity/);
  const changed=await createAiRouteRegistryEvidenceV1({
    ...snapshot,routes:[boundRoute],endpointProfiles:[{...boundEndpoint,origin:'http:\/\/localhost:11434/'}],
  });
  assert.notEqual(changed.configSha256,evidence.configSha256);
});

for (const [status,category,body] of [
  [401,'AUTH','<html>sk-secret-provider-response</html>'],
  [429,'RATE_LIMIT','invalid-json:sk-secret-provider-response'],
  [503,'UNAVAILABLE',''],
]) {
  test('non-JSON HTTP '+status+' retains sanitized transport classification',async()=>{
    const client=new LocalAiClient({fetchFn:async()=>new Response(body,{status})});
    await assert.rejects(client.complete(settings,'hi'),e=>
      e.status===status && e.category===category
      && e.code==='LOCAL_AI_'+category
      && !e.message.includes('sk-secret-provider-response'));
  });
}

test('local 401/429/503 errors preserve HTTP identity without reading untrusted oversized bodies', async () => {
  for (const [status,category,retryable] of [
    [401,'AUTH',false], [429,'RATE_LIMIT',true], [503,'UNAVAILABLE',true],
  ]) {
    let reads=0, cancels=0;
    const client=new LocalAiClient({fetchFn:async()=>({
      ok:false,status,
      body:{cancel:async()=>{cancels++;}},
      text:async()=>{reads++;throw new Error('sk-private-upstream-error-body');},
    })});
    await assert.rejects(client.complete(settings,'test'),error=>
      error.status===status && error.category===category
      && error.retryable===retryable
      && !String(error.message).includes('sk-private-upstream-error-body'));
    assert.equal(reads,0,'error payload must never be read');
    assert.equal(cancels,1,'error response stream must be cancelled');
  }
});

test('gateway preserves AUTH/RATE_LIMIT/UNAVAILABLE status on non-JSON and empty errors without secret leakage', async () => {
  for (const [status,category,body] of [
    [401,'AUTH','<html>sk-gateway-private</html>'],
    [429,'RATE_LIMIT','invalid-json sk-gateway-private'],
    [503,'UNAVAILABLE',''],
  ]) {
    const client=new AiGatewayClient({fetchFn:async()=>new Response(body,{status})});
    await assert.rejects(
      client.complete({gatewayUrl:'http://127.0.0.1:17621',provider:'openai-compatible',model:'fixture',prompt:'test'}),
      error=>error.status===status && error.category===category
        && !error.message.includes('sk-gateway-private') && /^AI_GATEWAY_HTTP_/.test(error.code),
    );
  }
});

test('gateway typed HTTP and timeout failures retain retryability without leaking private body',async()=>{
  for(const [status,category,retryable] of [
    [401,'AUTH',false],[403,'AUTH',false],[429,'RATE_LIMIT',true],
    [408,'TIMEOUT',true],[503,'UNAVAILABLE',true],
  ]){
    const gateway=new AiGatewayClient({fetchFn:async()=>new Response(
      'sk-private-gateway-provider-payload',{status},
    )});
    await assert.rejects(gateway.complete({provider:'openai-compatible',model:'fixture',prompt:'test'}),
      error=>error.status===status && error.category===category
        && error.retryable===retryable
        && !error.message.includes('sk-private-gateway-provider-payload'));
  }
  const aborted=new AiGatewayClient({fetchFn:async()=>{
    throw Object.assign(new Error('sk-transport-secret'),{name:'AbortError'});
  }});
  await assert.rejects(aborted.complete({provider:'openai-compatible',model:'fixture',prompt:'test'}),
    error=>error.code==='AI_GATEWAY_TIMEOUT' && error.category==='TIMEOUT'
      && error.retryable===true && !error.message.includes('sk-transport-secret'));
});

test('gateway retains a safe provider code but never a secret-bearing error body or raw network exception',async()=>{
  const typed=new AiGatewayClient({fetchFn:async()=>new Response(
    JSON.stringify({code:'AI_PROVIDER_QUOTA_EXHAUSTED',error:'sk-private-secret'}),{status:429},
  )});
  await assert.rejects(
    typed.complete({provider:'openai-compatible',model:'fixture',prompt:'test'}),
    error=>error.status===429 && error.code==='AI_PROVIDER_QUOTA_EXHAUSTED'
      && !error.message.includes('sk-private-secret'),
  );
  const network=new AiGatewayClient({fetchFn:async()=>{throw new Error('sk-private-secret endpoint');}});
  await assert.rejects(
    network.complete({provider:'openai-compatible',model:'fixture',prompt:'test'}),
    error=>error.code==='AI_GATEWAY_UNAVAILABLE' && error.retryable===true
      && !error.message.includes('sk-private-secret'),
  );
});

test('owner policy and route eligibility flags reject coerced values across restart', () => {
  const validRoute = { ...route, enabled:false, supportsVision:false };
  const validPolicy = { autoSwitch:false, freeOnly:true };
  assert.equal(normalizeAiRoutePool([validRoute])[0].enabled, false);
  assert.equal(normalizeAiRoutePolicy(validPolicy).autoSwitch, false);
  assert.equal(normalizeAiRoutePolicy(validPolicy).freeOnly, true);
  const persisted = JSON.parse(JSON.stringify({ routes:[validRoute], policy:validPolicy }));
  assert.equal(normalizeAiRoutePool(persisted.routes)[0].enabled, false);
  assert.equal(normalizeAiRoutePolicy(persisted.policy).autoSwitch, false);
  for (const field of ['enabled','supportsVision']) {
    for (const forged of ['false', 0, null, [], {}]) {
      assert.throws(() => normalizeAiRoutePool([{ ...route, [field]: forged }]), /must be boolean/);
    }
  }
  for (const field of ['autoSwitch','freeOnly']) {
    for (const forged of ['false', 0, null, [], {}]) {
      assert.throws(() => normalizeAiRoutePolicy({ [field]: forged }), /must be boolean/);
    }
  }
});

test('Gateway profile refuses query and fragment secrets before any provider request', async () => {
  let requests = 0;
  const client = new AiGatewayClient({ fetchFn: () => { requests++; throw new Error('network forbidden'); } });
  assert.equal(normalizeGatewayUrl('http://127.0.0.1:17621'), 'http://127.0.0.1:17621');
  assert.equal(normalizeGatewayUrl('http://localhost:17621/'), 'http://localhost:17621');
  for (const forgedUrl of [
    'http://127.0.0.1:17621/?api_key=secret-fixture',
    'http://127.0.0.1:17621/#prompt-fixture',
    'http://localhost:17621/?token=fixture#fragment',
    'http://127.0.0.1:17621/health?token=fixture'
  ]) {
    assert.throws(() => normalizeGatewayUrl(forgedUrl), /cannot contain query or fragment/);
    await assert.rejects(client.health({ gatewayUrl:forgedUrl, timeoutSeconds:5 }), /cannot contain query or fragment/);
  }
  assert.equal(requests, 0);
});

test('explicit null prices cannot become free under price cap or after persistence', () => {
  const policy = { maxInputPricePerMillionUsd:0, maxOutputPricePerMillionUsd:0 };
  const candidate = { ...route, costClass:'free', locality:'local' };
  for (const priceKey of ['inputPricePerMillionUsd','outputPricePerMillionUsd']) {
    for (const invalid of [
      { ...candidate, [priceKey]:null },
      { ...candidate, [priceKey]:null, inputPriceKnown:false, outputPriceKnown:false }
    ]) {
      assert.throws(() => normalizeAiRoutePool([invalid]), /observed zero/);
      assert.throws(() => normalizeAiRoutePool(JSON.parse(JSON.stringify([invalid]))), /observed zero/);
    }
  }
  const unknown = normalizeAiRoutePool([candidate])[0];
  assert.equal(unknown.inputPriceKnown,false);
  assert.equal(unknown.outputPriceKnown,false);
  assert.deepEqual(selectAiRouteCandidates({routes:[candidate],policy,now:1}).eligibleRouteIds,[]);
  const known = { ...candidate, inputPricePerMillionUsd:0, outputPricePerMillionUsd:0 };
  assert.deepEqual(selectAiRouteCandidates({routes:[known],policy,now:1}).eligibleRouteIds,['primary']);
});

test('owner locality and route cost-class reject implicit coercion', () => {
  for (const invalid of [null, 0, false, []]) {
    assert.throws(() => normalizeAiRoutePolicy({locality:invalid}),/locality/);
    assert.throws(() => normalizeAiRoutePool([{...route,locality:invalid}]),/locality/);
    assert.throws(() => normalizeAiRoutePool([{...route,costClass:invalid}]),/costClass/);
  }
  assert.equal(normalizeAiRoutePolicy({locality:'local'}).locality,'local');
  assert.equal(normalizeAiRoutePool([route])[0].locality,'local');
});

test('remote Ollama must not inherit local-only FREE pricing across persistence and selection', () => {
  const remote = {routeId:'remote-ollama',provider:'ollama',model:'remote-model',locality:'remote'};
  const normalized = normalizeAiRoutePool([remote]);
  assert.equal(normalized[0].costClass, 'unknown');
  assert.equal(normalized[0].inputPriceKnown, false);
  assert.equal(normalized[0].outputPriceKnown, false);
  const restarted = JSON.parse(JSON.stringify(normalized));
  assert.deepEqual(selectAiRouteCandidates({routes:restarted,policy:{freeOnly:true},now:1}).eligibleRouteIds,[]);
  assert.deepEqual(selectAiRouteCandidates({routes:restarted,policy:{maxInputPricePerMillionUsd:0},now:1}).eligibleRouteIds,[]);
  const local = normalizeAiRoutePool([{...remote,routeId:'local-ollama',locality:'local'}]);
  assert.equal(local[0].costClass,'free');
  assert.deepEqual(selectAiRouteCandidates({routes:local,policy:{freeOnly:true},now:1}).eligibleRouteIds,['local-ollama']);
});

test('local adapter rejects query and fragment before fetch even when called directly', async () => {
  let requests = 0;
  const client = new LocalAiClient({fetchFn:async () => { requests += 1; throw Error('should never call network'); }});
  const resumedSettings = JSON.parse(JSON.stringify(normalizeLocalAiSettings(settings)));
  for (const url of [
    'http://127.0.0.1:11434/api/chat?token=private-fixture',
    'http://localhost:11434/api/tags#secret-fixture',
  ]) {
    await assert.rejects(client.request(resumedSettings,url),/without credentials/);
  }
  assert.equal(requests,0);
});

test('partial provider usage cannot claim fewer total tokens than any reported dimension', () => {
  for (const providerType of ['ollama','openai-compatible']) {
    const cases = providerType === 'ollama'
      ? [{prompt_eval_count:8,eval_count:7}]
      : [{usage:{prompt_tokens:9,total_tokens:8}}, {usage:{completion_tokens:9,total_tokens:8}}];
    if (providerType === 'ollama') {
      const observed = normalizeLocalAiUsage(providerType,cases[0]);
      assert.equal(observed.totalTokens,15);
      continue;
    }
    for (const usage of cases) {
      assert.throws(() => normalizeLocalAiUsage(providerType,usage),/token accounting mismatch/);
    }
  }
  const partial = normalizeLocalAiUsage('openai-compatible',{usage:{prompt_tokens:8,total_tokens:9}});
  assert.equal(partial.totalTokens,9);
  assert.equal(partial.outputTokens,null);
  assert.equal(partial.source,'PROVIDER_REPORTED');
});

// Plan 4 S1/S2: immutable identity evidence and no cross-service loopback request.
test('normalized route and policy ID arrays stay immutable after evidence selection and JSON restart', () => {
  const rawRoute = { ...route, roles:['planner'], capabilityIds:['read.page'] };
  const rawPolicy = { orderedRouteIds:['primary'], allowRouteIds:['primary'], denyRouteIds:[] };
  for (const persisted of [false, true]) {
    const source = persisted ? JSON.parse(JSON.stringify({ routes:[rawRoute], policy:rawPolicy })) : { routes:[rawRoute], policy:rawPolicy };
    const normalizedRoute = normalizeAiRoutePool(source.routes)[0];
    const normalizedPolicy = normalizeAiRoutePolicy(source.policy);
    for (const entries of [normalizedRoute.roles, normalizedRoute.capabilityIds,
      normalizedPolicy.orderedRouteIds, normalizedPolicy.allowRouteIds, normalizedPolicy.denyRouteIds]) {
      assert.equal(Object.isFrozen(entries), true);
      assert.throws(() => entries.push('attacker'), TypeError);
    }
    assert.deepEqual(normalizedRoute.roles, ['planner']);
    assert.deepEqual(normalizedPolicy.allowRouteIds, ['primary']);
    assert.deepEqual(selectAiRouteCandidates({ routes:[normalizedRoute], policy:normalizedPolicy, now:1 }).eligibleRouteIds,['primary']);
  }
});

test('local provider request cannot pivot to another loopback service or API path', async () => {
  let network = 0;
  const client = new LocalAiClient({ fetchFn:async () => { network++; throw new Error('not permitted in negative test'); } });
  for (const wrongTarget of [
    'http://127.0.0.1:17621/api/chat',
    'http://localhost:11434/api/chat',
    'http://127.0.0.1:11434/admin',
    'http://127.0.0.1:11434/api/chat/extra',
    'http://127.0.0.1:11434/api/tags?token=secret',
  ]) {
    await assert.rejects(client.request(settings,wrongTarget), /configured provider endpoint|without credentials/);
  }
  assert.equal(network,0);
  const ok = new LocalAiClient({ fetchFn:async url => {
    assert.equal(url,'http://127.0.0.1:11434/api/chat');
    return new Response(JSON.stringify({ message:{content:'ok'},prompt_eval_count:2,eval_count:1 }),{status:200});
  } });
  assert.equal((await ok.complete(settings,'fixture')).usage.totalTokens,3);
});

test('gateway keeps transport AUTH/RATE_LIMIT/UNAVAILABLE on oversized hostile error body', async () => {
  for (const [status,category,retryable] of [
    [401,'AUTH',false], [429,'RATE_LIMIT',true], [503,'UNAVAILABLE',true],
  ]) {
    let reads=0, cancels=0;
    const client = new AiGatewayClient({ fetchFn:async () => ({
      ok:false, status,
      headers:{ get:name => name === 'content-length' ? '999999999' : null },
      body:{cancel:async()=>{cancels++;}},
      text:async()=>{reads++;throw new Error('SECRET_ERROR_BODY_MUST_NOT_BE_READ');},
    }) });
    await assert.rejects(
      client.complete({provider:'openai-compatible',model:'fixture',prompt:'fixture'}),
      error=>error.status===status && error.category===category
        && error.retryable===retryable && error.code==='AI_GATEWAY_HTTP_'+status
        && !error.message.includes('SECRET_ERROR_BODY_MUST_NOT_BE_READ'),
    );
    assert.equal(cancels,1);
    assert.equal(reads,0);
  }
});

test('owner model-routing failover booleans reject coercion and accessor traps after restart', () => {
  for (const flag of ['enabled','carryStrongResultToPrimary','fallbackToStrongOnPrimaryError','keepPrimaryIfStrongFails']) {
    for (const forged of ['false','true',0,1,null,[],{}]) {
      assert.throws(() => normalizeAiRouterSettings({ [flag]:forged }), /must be boolean/);
    }
    const malicious = {};
    Object.defineProperty(malicious,flag,{enumerable:true,get(){throw new Error('forged getter evaluated');}});
    assert.throws(() => normalizeAiRouterSettings(malicious), /must be boolean/);
  }
  const denied = JSON.parse(JSON.stringify({
    enabled:true, carryStrongResultToPrimary:false,
    fallbackToStrongOnPrimaryError:false, keepPrimaryIfStrongFails:false,
  }));
  const restored = normalizeAiRouterSettings(denied);
  assert.equal(restored.enabled,true);
  assert.equal(restored.carryStrongResultToPrimary,false);
  assert.equal(restored.fallbackToStrongOnPrimaryError,false);
  assert.equal(restored.keepPrimaryIfStrongFails,false);
});


test('owner allow/deny/ordering lists never widen from explicit falsy input on cold or JSON restart', () => {
  const policyKeys = ['orderedRouteIds', 'allowRouteIds', 'denyRouteIds'];
  const routeKeys = ['roles', 'capabilityIds'];
  for (const invalid of [false, 0, '', null]) {
    for (const key of policyKeys) {
      const policy = { [key]:invalid };
      assert.throws(() => normalizeAiRoutePolicy(policy), /bounded array/);
      assert.throws(() => normalizeAiRoutePolicy(JSON.parse(JSON.stringify(policy))), /bounded array/);
    }
    for (const key of routeKeys) {
      const pool = [{...route, [key]:invalid}];
      assert.throws(() => normalizeAiRoutePool(pool), /bounded array/);
      assert.throws(() => normalizeAiRoutePool(JSON.parse(JSON.stringify(pool))), /bounded array/);
    }
    assert.throws(() => normalizeAiRouterSettings({routes:invalid}), /bounded array/);
    assert.throws(() => normalizeAiRouterSettings({routePolicy:invalid}), /plain data object/);
    assert.throws(() => normalizeAiRouterSettings({workerPolicy:invalid}), /object/);
  }
  assert.throws(() => selectAiRouteCandidates({
    routes:[route], policy:{}, capabilityIds:false, now:1,
  }), /bounded array/);
  assert.deepEqual(normalizeAiRoutePolicy({}).allowRouteIds, []);
  assert.deepEqual(normalizeAiRoutePool([route])[0].capabilityIds, []);
  const explicitlyDenied = normalizeAiRoutePolicy({denyRouteIds:['primary']});
  assert.deepEqual(selectAiRouteCandidates({
    routes:[route], policy:JSON.parse(JSON.stringify(explicitlyDenied)), now:1,
  }).eligibleRouteIds, []);
});

test('local AI transport rejects caller headers, unsafe HTTP methods, malformed and oversized requests before network', async () => {
  let networkCalls = 0;
  const client = new LocalAiClient({fetchFn:async () => {
    networkCalls += 1;
    throw new Error('network forbidden in negative tests');
  }});
  const chat = 'http://127.0.0.1:11434/api/chat';
  const models = 'http://127.0.0.1:11434/api/tags';
  const forbidden = [
    [chat,{headers:{Authorization:'Bearer secret'}}],
    [chat,{headers:{Cookie:'session=private'}}],
    [chat,{method:'DELETE'}],
    [chat,{method:'POST',body:'{broken'}],
    [chat,{method:'POST',body:JSON.stringify([1,2])}],
    [chat,{method:'POST',body:JSON.stringify({prompt:'x'.repeat(130000)})}],
    [models,{method:'POST',body:'{"prompt":"secret"}'}],
    [models,{method:'POST'}],
    [chat,{mode:'no-cors'}],
  ];
  for (const [url, init] of forbidden) {
    await assert.rejects(client.request(settings,url,init));
    await assert.rejects(client.request(JSON.parse(JSON.stringify(settings)),url,JSON.parse(JSON.stringify(init))));
  }
  let getterCalled = false;
  const hostile = {};
  Object.defineProperty(hostile, 'headers', {enumerable:true, get() {
    getterCalled = true;
    throw new Error('getter must not execute');
  }});
  await assert.rejects(client.request(settings,chat,hostile), /own data properties/);
  assert.equal(getterCalled,false);
  assert.equal(networkCalls,0);
});

test('local provider standard completion still posts JSON with bounded safe headers', async () => {
  let calls = 0;
  const client = new LocalAiClient({fetchFn:async (url, init) => {
    calls++;
    assert.equal(url,'http://127.0.0.1:11434/api/chat');
    assert.equal(init.method,'POST');
    assert.equal(init.redirect,'error');
    assert.equal(init.cache,'no-store');
    assert.equal(init.headers.Accept,'application/json');
    assert.equal(init.headers['Content-Type'],'application/json');
    assert.equal('Authorization' in init.headers,false);
    assert.equal(JSON.parse(init.body).messages[0].content,'fixture');
    return new Response(JSON.stringify({message:{content:'ok'},prompt_eval_count:2,eval_count:1}),{status:200});
  }});
  const result = await client.complete(settings,'fixture');
  assert.equal(result.text,'ok');
  assert.equal(result.usage.totalTokens,3);
  assert.equal(calls,1);
});
