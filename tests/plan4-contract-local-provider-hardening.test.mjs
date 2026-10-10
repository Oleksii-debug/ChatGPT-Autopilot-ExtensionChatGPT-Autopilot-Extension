import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAiRoutePool, normalizeAiRoutePolicy, normalizeAiWorkerPolicy, createAiRouteRegistryEvidenceV1, selectAiRouteCandidates } from '../src/core/ai-route-pool.js';
import { LocalAiClient, normalizeLocalAiSettings, normalizeLocalAiBaseUrl, normalizeLocalAiUsage } from '../src/core/local-ai-provider.js';
import { AiGatewayClient, normalizeGatewayUrl } from '../src/core/ai-gateway-client.js';
import { AiOrchestrator, normalizeAiRouterSettings } from '../src/core/ai-orchestrator.js';

const route = { routeId:'primary', provider:'ollama', model:'llama3', locality:'local' };
const endpoint = { schemaVersion:1, profileId:'local.ollama', provider:'ollama', endpointId:'', locality:'local', origin:'http://127.0.0.1:11434/', credentialRef:'', credentialless:true };
const snapshot = { schemaVersion:1, registryRevision:4, routes:[route], endpointProfiles:[endpoint] };
const settings = { enabled:true, providerType:'ollama', model:'llama3', baseUrl:'http://127.0.0.1:11434', timeoutSeconds:5 };

test('route migration accepts versionless v1 and rejects unknown versions', () => {
  assert.equal(normalizeAiRoutePool([route])[0].schemaVersion,1);
  assert.throws(() => normalizeAiRoutePool([{...route,schemaVersion:'1'}]));
  assert.throws(() => normalizeAiRoutePool([{...route,schemaVersion:2}]));
});

test('Plan4 S1 owner router rejects unsupported versions and unknown policy fields before any provider effect', async () => {
  let providerEffects=0;
  const gatewayClient={async complete(){providerEffects++;throw new Error('must never send');}};
  const router=new AiOrchestrator({gatewayClient});
  const owner={enabled:true,mode:'primary',primary:{provider:'ollama',model:'fixture'},fallbackToStrongOnPrimaryError:false};
  const invalid=[
    ...[null,undefined,0,2,'1',true,{}].map(version=>({...owner,schemaVersion:version})),
    {...owner,providerCredential:'sk-sensitive-example'},
    {...owner,localOnly:true},
    {...owner,routePolciy:{locality:'local'}},
    JSON.parse(JSON.stringify({...owner,schemaVersion:2})),
    JSON.parse(JSON.stringify({...owner,localOnly:true})),
  ];
  for(const bad of invalid) {
    assert.throws(()=>normalizeAiRouterSettings(bad),/schemaVersion|unknown owner-controlled field/);
    await assert.rejects(router.run(bad,{},'approved prompt'),/schemaVersion|unknown owner-controlled field/);
  }
  const secretKey='sk-sensitive-untrusted-field';
  const hostile={...owner,[secretKey]:true};
  assert.throws(()=>normalizeAiRouterSettings(hostile), error=>
    !error.message.includes(secretKey) && /unknown owner-controlled field/.test(error.message));
  assert.equal(providerEffects,0);
  // Versionless v1 documents and exact explicit v1 retain the same route policy
  // after JSON-cold restart; no implicit account/locality promotion.
  const legacy=normalizeAiRouterSettings(JSON.parse(JSON.stringify(owner)));
  const declared=normalizeAiRouterSettings(JSON.parse(JSON.stringify({...owner,schemaVersion:1})));
  assert.deepEqual(declared,legacy);
  assert.equal(declared.primary.provider,'ollama');
  assert.equal(declared.fallbackToStrongOnPrimaryError,false);
});

test('Plan4 S1 persisted route and endpoint identity is exact, not a whitespace alias', async () => {
  for (const changed of [
    {...route,routeId:' primary '},
    {...route,routeId:'primary '},
    {...route,routeId:'\tprimary'},
    {...route,endpointId:' endpoint.local '},
    {...route,endpointId:'endpoint.local\n'},
  ]) {
    assert.throws(()=>normalizeAiRoutePool([changed]),/exact bounded identifier/);
    assert.throws(()=>normalizeAiRoutePool(JSON.parse(JSON.stringify([changed]))),/exact bounded identifier/);
  }
  for (const changed of [
    {...endpoint,profileId:' local.ollama '},
    {...endpoint,endpointId:' endpoint.local '},
    {...endpoint,credentialRef:' ref.local ' ,credentialless:false},
  ]) {
    await assert.rejects(
      createAiRouteRegistryEvidenceV1({...snapshot,endpointProfiles:[changed]}),
      /exact bounded identifier/,
    );
    await assert.rejects(
      createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify({...snapshot,endpointProfiles:[changed]}))),
      /exact bounded identifier/,
    );
  }
  const legitimate = {...snapshot,routes:[{...route,endpointId:'endpoint.local'}],
    endpointProfiles:[{...endpoint,endpointId:'endpoint.local'}]};
  const evidence=await createAiRouteRegistryEvidenceV1(legitimate);
  const cold=await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(legitimate)));
  assert.equal(evidence.configSha256,cold.configSha256);
  assert.equal(evidence.routeIdentities[0].endpointBinding,'MATCHED');
});

test('Plan4 S1 provider/model route identity never aliases by trimming before dispatch or after restart', async () => {
  let providerEffects = 0;
  const orchestrator = new AiOrchestrator({gatewayClient:{
    async complete() { providerEffects += 1; throw new Error('unexpected provider dispatch'); },
  }});
  const invalid = [
    {...route, provider:' ollama'},
    {...route, provider:'ollama '},
    {...route, provider:'ollama\\n'},
    {...route, model:' llama3'},
    {...route, model:'llama3 '},
    {...route, model:'llama3\\n'},
    {...route, model:''},
    {...route, model:null},
    {...route, model:'x'.repeat(301)},
  ].map(entry => ({...entry,
    provider:entry.provider.replaceAll('\\n','\n'),
    model:typeof entry.model === 'string' ? entry.model.replaceAll('\\n','\n') : entry.model,
  }));
  for (const bad of invalid) {
    for (const persisted of [[bad], JSON.parse(JSON.stringify([bad]))]) {
      assert.throws(() => normalizeAiRoutePool(persisted), /AI route provider|AI route model/);
      assert.throws(() => normalizeAiRouterSettings({enabled:true,mode:'primary',routes:persisted}),
        /AI route provider|AI route model/);
      await assert.rejects(orchestrator.run({enabled:true,mode:'primary',routes:persisted}, {}, 'approved prompt'),
        /AI route provider|AI route model/);
    }
    await assert.rejects(createAiRouteRegistryEvidenceV1({...snapshot,routes:[bad]}),
      /AI route provider|AI route model/);
  }
  assert.equal(providerEffects,0);
  const exact = {...route, model:'namespace/model:v1'};
  assert.equal(normalizeAiRoutePool([exact])[0].model,exact.model);
  const first = await createAiRouteRegistryEvidenceV1({...snapshot,routes:[exact]});
  const cold = await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify({...snapshot,routes:[exact]})));
  assert.equal(first.configSha256,cold.configSha256);
  assert.equal(first.routeIdentities[0].model,exact.model);
});

test('Plan4 S1 exact endpoint account and capability provenance is versioned, immutable, and advisory', async () => {
  const routed = {...route,endpointId:'loopback-1',capabilityIds:['tools.read']};
  const profile = {...endpoint,endpointId:'loopback-1',accountId:'owner.local-1',
    capabilityIds:['tools.read','vision.inspect']};
  const linked = {...snapshot,routes:[routed],endpointProfiles:[profile]};
  const accepted = await createAiRouteRegistryEvidenceV1(linked);
  const cold = await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(linked)));
  assert.equal(accepted.configSha256,cold.configSha256);
  assert.deepEqual(accepted.endpointProfiles[0].capabilityIds,['tools.read','vision.inspect']);
  assert.equal(accepted.endpointProfiles[0].accountId,'owner.local-1');
  assert.ok(Object.isFrozen(accepted.endpointProfiles[0].capabilityIds));
  assert.equal(accepted.routeIdentities[0].endpointBinding,'MATCHED');
  assert.equal(accepted.authority.canGrantPermission,false);
  assert.equal(accepted.authority.canReadCredentials,false);
  const older = await createAiRouteRegistryEvidenceV1({...linked,endpointProfiles:[{...endpoint,endpointId:'loopback-1'}]});
  const olderRestarted = await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify({
    ...linked,endpointProfiles:[{...endpoint,endpointId:'loopback-1'}],
  })));
  assert.equal(older.configSha256,olderRestarted.configSha256);
  assert.notEqual(older.configSha256,accepted.configSha256);
  for (const bad of [
    {...profile, accountId:' owner.local-1'},
    {...profile, accountId:''},
    {...profile, accountId:null},
    {...profile, capabilityIds:null},
    {...profile, capabilityIds:'tools.read'},
    {...profile, capabilityIds:['tools.read','tools.read']},
    {...profile, capabilityIds:['tools.read',false]},
    {...profile, capabilityIds:[]},
  ]) {
    await assert.rejects(createAiRouteRegistryEvidenceV1({...linked,endpointProfiles:[bad]}),
      /AI endpoint accountId|AI endpoint capabilityIds|claims a capability/);
    await assert.rejects(createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify({
      ...linked,endpointProfiles:[bad],
    }))), /AI endpoint accountId|AI endpoint capabilityIds|claims a capability/);
  }
  await assert.rejects(createAiRouteRegistryEvidenceV1({
    ...linked,routes:[{...routed,capabilityIds:['vision.inspect','unsupported.scope']}],
  }), /claims a capability/);
  await assert.rejects(createAiRouteRegistryEvidenceV1({
    ...linked,endpointProfiles:[{...profile,accountId:'owner.other'}],
    routes:[{...routed,capabilityIds:['unsupported.scope']}],
  }), /claims a capability/);
  const changedAccount = await createAiRouteRegistryEvidenceV1({
    ...linked,endpointProfiles:[{...profile,accountId:'owner.other'}],
  });
  assert.notEqual(changedAccount.configSha256,accepted.configSha256);
});

test('Plan4 S1 endpoint registry preserves exact provider/account identity after cold restart', async () => {
  const bound = {...route, endpointId:'owner.loopback'};
  const boundProfile = {...endpoint, endpointId:'owner.loopback'};
  const valid = {...snapshot, routes:[bound], endpointProfiles:[boundProfile]};
  const accepted = await createAiRouteRegistryEvidenceV1(valid);
  const restored = await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(valid)));
  assert.equal(accepted.routeIdentities[0].endpointBinding, 'MATCHED');
  assert.equal(accepted.configSha256, restored.configSha256);
  for (const provider of [' ollama', 'ollama ', '\tollama', 'ollama\n', 'OpenAI', null, 0]) {
    const changed = {...valid, endpointProfiles:[{...boundProfile, provider}]};
    await assert.rejects(createAiRouteRegistryEvidenceV1(changed), /AI endpoint provider/);
    await assert.rejects(
      createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(changed))),
      /AI endpoint provider/,
    );
  }
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
    error=>error.code==='AI_GATEWAY_RESPONSE_UNVERIFIED' && error.category==='UNAVAILABLE'
      && error.retryable===false && !error.message.includes('sk-transport-secret'));
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
    error=>error.code==='AI_GATEWAY_RESPONSE_UNVERIFIED' && error.retryable===false
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
    // Descriptor admission rejects the accessor before reading it; no getter executes.
    assert.throws(() => normalizeAiRouterSettings(malicious), /must be enumerable own data properties/);
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
    assert.throws(() => normalizeAiRouterSettings({routePolicy:invalid}), /must be an object|plain data object/);
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


// Plan 4 Sections 1–2: authoritative owner intent and exact provider effects.
test('owner model mode and slot identity never silently fall back to another provider', () => {
  const valid = normalizeAiRouterSettings({
    enabled:true,
    mode:'primary',
    primary:{provider:'openai-compatible',model:'fixture-exact'},
  });
  assert.equal(valid.mode,'primary');
  assert.equal(valid.primary.provider,'openai-compatible');
  const restored = normalizeAiRouterSettings(JSON.parse(JSON.stringify(valid)));
  assert.equal(restored.primary.model,'fixture-exact');
  assert.equal(restored.primary.provider,'openai-compatible');
  for (const invalid of [null,false,0,{},[],42,'unknown',undefined]) {
    assert.throws(() => normalizeAiRouterSettings({mode:invalid}), /AI router mode is invalid/);
  }
  for (const slot of ['primary','strong']) {
    for (const invalidProvider of [null,false,0,{},'remote-unapproved',undefined]) {
      assert.throws(() => normalizeAiRouterSettings({
        [slot]:{provider:invalidProvider,model:'fixture'},
      }), /AI model slot provider is invalid/);
    }
    for (const invalidModel of [null,0,false,{},'  unexpected  ']) {
      assert.throws(() => normalizeAiRouterSettings({
        [slot]:{provider:'ollama',model:invalidModel},
      }), /AI model slot name must be exact trimmed text/);
    }
  }
  for (const key of ['mode','primary','strong']) {
    let accessCount = 0;
    const settingsWithGetter = {};
    Object.defineProperty(settingsWithGetter,key,{
      enumerable:true,
      get() { accessCount++; throw new Error('malicious getter evaluated'); },
    });
    assert.throws(() => normalizeAiRouterSettings(settingsWithGetter), /own data properties/);
    assert.equal(accessCount,0);
  }
  assert.equal(normalizeAiRouterSettings({}).mode,'primary');
  assert.equal(normalizeAiRouterSettings({}).primary.provider,'ollama');
});

test('local provider discovery and chat endpoints enforce exact HTTP methods before network', async () => {
  const clientSettings = JSON.parse(JSON.stringify(settings));
  const chat = 'http://127.0.0.1:11434/api/chat';
  const discovery = 'http://127.0.0.1:11434/api/tags';
  let networkCalls = 0;
  const deniedClient = new LocalAiClient({ fetchFn:async () => {
    networkCalls++;
    throw new Error('method must be checked before network');
  } });
  for (const [url, init] of [
    [chat,{}],
    [chat,{method:'GET'}],
    [chat,{method:'POST'}],
    [discovery,{method:'POST',body:'{}'}],
    [discovery,{method:'POST'}],
    [discovery,{method:'GET',body:'{}'}],
    [discovery,{method:'PUT'}],
  ]) {
    await assert.rejects(deniedClient.request(clientSettings,url,init),
      /GET-only|requires (?:an )?explicit POST|method is not allowed/);
    await assert.rejects(deniedClient.request(
      JSON.parse(JSON.stringify(clientSettings)),url,JSON.parse(JSON.stringify(init))),
      /GET-only|requires (?:an )?explicit POST|method is not allowed/);
  }
  assert.equal(networkCalls,0);
  const calls = [];
  const permittedClient = new LocalAiClient({ fetchFn:async (url, init) => {
    calls.push({url,method:init.method,redirect:init.redirect});
    if (url===discovery) {
      return new Response(JSON.stringify({models:[{name:'fixture'}]}),{status:200});
    }
    return new Response(JSON.stringify({
      message:{content:'verified'},prompt_eval_count:3,eval_count:2,
    }),{status:200});
  } });
  const models = await permittedClient.listModels(clientSettings);
  assert.deepEqual(models.models,['fixture']);
  const completed = await permittedClient.complete(clientSettings,'fixture');
  assert.equal(completed.text,'verified');
  assert.equal(completed.usage.totalTokens,5);
  assert.deepEqual(calls.map(x=>x.method),[undefined,'POST']);
  assert.ok(calls.every(x=>x.redirect==='error'));
});


// Plan 4 S2: the canonical gateway must not become an arbitrary loopback proxy.
test('gateway transport cannot pivot to arbitrary loopback paths, headers or methods', async () => {
  const gatewayUrl = 'http://127.0.0.1:17621';
  let networkCalls = 0;
  const client = new AiGatewayClient({fetchFn:async () => {
    networkCalls++;
    throw new Error('network not permitted');
  }});
  for (const [path, init] of [
    ['/admin',{}],
    ['//another-service',{}],
    ['/health',{method:'POST',body:'{}'}],
    ['/status',{headers:{Authorization:'Bearer secret'}}],
    ['/models?provider=ollama',{method:'POST',body:'{}'}],
    ['/models?provider=ollama&unexpected=1',{}],
    ['/complete',{}],
    ['/complete',{method:'GET'}],
    ['/complete',{method:'POST',body:'{broken'}],
    ['/complete',{method:'POST',body:JSON.stringify([1,2])}],
    ['/complete',{method:'POST',body:'{}',credentials:'include'}],
  ]) {
    await assert.rejects(client.request(gatewayUrl,5,path,init));
    await assert.rejects(client.request(gatewayUrl,5,path,JSON.parse(JSON.stringify(init))));
  }
  const poisoned = {};
  let getterCount=0;
  Object.defineProperty(poisoned,'headers',{enumerable:true,get() {
    getterCount++;
    throw new Error('secret-bearing injected getter');
  }});
  await assert.rejects(client.request(gatewayUrl,5,'/status',poisoned),/own data properties/);
  assert.equal(getterCount,0);
  assert.equal(networkCalls,0);

  const requests=[];
  const valid = new AiGatewayClient({fetchFn:async (url,init) => {
    requests.push({url,init});
    return new Response(JSON.stringify({ok:true,usage:{inputTokens:3,outputTokens:2}}),{status:200});
  }});
  await valid.health();
  await valid.status();
  await valid.listModels({provider:'ollama',endpointId:'local.ollama'});
  await valid.complete({provider:'ollama',model:'fixture',prompt:'owner approved'});
  assert.deepEqual(requests.map(({init})=>init.method),[undefined,undefined,undefined,'POST']);
  assert.equal(requests.length,4);
  assert.ok(requests.every(({init})=>init.redirect==='error' && init.cache==='no-store'));
  assert.ok(requests.every(({init})=>!Object.hasOwn(init.headers,'Authorization') && !Object.hasOwn(init.headers,'Cookie')));
  assert.ok(requests.every(({url})=>url.startsWith(gatewayUrl+'/')));
});


test('owner numeric model-routing controls reject forged coercion and survive reload', () => {
  const fields = ['timeoutSeconds','strongEveryNRequests','strongEveryMinutes',
    'handoffMaxChars','strongMinGapMinutes','strongMaxPerHour'];
  for (const field of fields) {
    for (const malformed of [null,false,true,[],[1],{},'', '  ']) {
      assert.throws(() => normalizeAiRouterSettings({[field]:malformed}),/numeric owner setting/);
      assert.throws(() => normalizeAiRouterSettings(
        JSON.parse(JSON.stringify({[field]:malformed}))),/numeric owner setting/);
    }
    let coerced=0;
    assert.throws(() => normalizeAiRouterSettings({
      [field]:{valueOf() { coerced++; throw new Error('must not coerce'); }},
    }),/numeric owner setting/);
    assert.equal(coerced,0);
  }
  const allowed = {
    enabled:true,mode:'primary',primary:{provider:'ollama',model:'fixture'},
    timeoutSeconds:' 180 ',strongEveryNRequests:'10',strongEveryMinutes:'120',
    handoffMaxChars:'12000',strongMinGapMinutes:'0',strongMaxPerHour:'0',
  };
  const active=normalizeAiRouterSettings(allowed);
  const persisted=normalizeAiRouterSettings(JSON.parse(JSON.stringify(allowed)));
  assert.equal(active.timeoutSeconds,180);
  assert.equal(active.strongEveryNRequests,10);
  assert.equal(persisted.strongMinGapMinutes,0);
  assert.equal(persisted.strongMaxPerHour,0);
  assert.equal(normalizeAiRouterSettings({}).timeoutSeconds,180);
});


test('route failover preserves model-budget reservation settlement and JSON restart backoff', async () => {
  const reservations = [];
  const settlements = [];
  const calls = [];
  const routes = [
    { routeId:'fast',provider:'ollama',model:'first',locality:'local',costClass:'free',priority:10 },
    { routeId:'backup',provider:'ollama',model:'second',locality:'local',costClass:'free',priority:5 },
  ];
  let now=1_000;
  let failFirst=true;
  const client = {
    async complete(request) {
      calls.push(request.model);
      if (request.model==='first' && failFirst) {
        const unavailable=new Error('fixture provider offline');
        unavailable.status=503;
        throw unavailable;
      }
      return { text:'answer',usage:{inputTokens:3,outputTokens:2,totalTokens:5} };
    },
  };
  const lifecycle = {
    async beforeProviderCall({route,maxOutputTokens,callNumber}) {
      assert.equal(maxOutputTokens,12);
      const reservationId='fixture-reservation-'+callNumber;
      reservations.push({reservationId,routeId:route.routeId});
      return {reservationId};
    },
    async afterProviderCall({route,reservation,ok}) {
      settlements.push({routeId:route.routeId,reservationId:reservation.reservationId,ok});
      return {settled:true};
    },
  };
  const orchestrator=new AiOrchestrator({gatewayClient:client,now:()=>now,providerCallLifecycle:lifecycle});
  const config={
    enabled:true,mode:'primary',fallbackToStrongOnPrimaryError:false,
    routes,routePolicy:{autoSwitch:true},
  };
  const options={
    providerCallBudgetContext:{jobId:'fixture'},
    maxModelCallsForRequest:2,maxOutputTokens:12,
  };
  const first=await orchestrator.run(config,{},'owner prompt',options);
  assert.equal(first.routing.selectedRouteId,'backup');
  assert.equal(first.usage.modelCalls,2);
  assert.deepEqual(reservations.map(x=>x.routeId),['fast','backup']);
  assert.deepEqual(settlements.map(x=>x.ok),[false,true]);
  assert.deepEqual(settlements.map(x=>x.reservationId),
    ['fixture-reservation-1','fixture-reservation-2']);
  assert.equal(first.routing.failoverChain.length,2);
  const resumed=JSON.parse(JSON.stringify(first.runtime));
  reservations.length=0;
  settlements.length=0;
  calls.length=0;
  failFirst=false;
  now=1100;
  const second=await orchestrator.run(config,resumed,'owner prompt',options);
  assert.equal(second.routing.selectedRouteId,'backup');
  assert.equal(second.usage.modelCalls,1);
  assert.deepEqual(calls,['second']);
  assert.deepEqual(settlements.map(x=>x.ok),[true]);
});


test('budgeted model dispatch fails closed without canonical lifecycle, including JSON restart', async () => {
  let networkCalls = 0;
  const client = { async complete() { networkCalls++; throw new Error('must not dispatch'); } };
  const orchestrator = new AiOrchestrator({ gatewayClient:client });
  const config = {
    enabled:true, mode:'primary', primary:{provider:'ollama',model:'fixture'},
    fallbackToStrongOnPrimaryError:false,
  };
  for (const context of [{jobId:'fixture'}, JSON.parse('{"jobId":"fixture"}')]) {
    await assert.rejects(
      orchestrator.run(config, {}, 'owner-approved prompt', {providerCallBudgetContext:context}),
      error => error.code === 'AI_MODEL_BUDGET_LIFECYCLE_REQUIRED',
    );
  }
  for (const context of [false, 0, '', 'untrusted', []]) {
    await assert.rejects(
      orchestrator.run(config, {}, 'owner-approved prompt', {providerCallBudgetContext:context}),
      /budget context must be a data object/,
    );
  }
  assert.equal(networkCalls,0);
});

test('malformed per-request model budget cannot become unlimited before provider dispatch', async () => {
  let networkCalls=0;
  const client = {async complete() {
    networkCalls++;
    return {text:'fixture',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
  }};
  const orchestrator=new AiOrchestrator({gatewayClient:client,now:()=>1000});
  const config={enabled:true,mode:'primary',primary:{provider:'ollama',model:'fixture'}};
  for (const field of ['maxOutputTokens','maxModelCallsForRequest']) {
    for (const malformed of [-1,1.2,'0','5',false,true,null,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,{},[]]) {
      await assert.rejects(
        orchestrator.run(config,{},'owner-approved prompt',{[field]:malformed}),
        /must be a non-negative safe integer/,
      );
    }
    for (const malformed of [-1,'0',false,null,1.2]) {
      await assert.rejects(
        orchestrator.run(config,{},'owner-approved prompt',
          JSON.parse(JSON.stringify({[field]:malformed}))),
        /must be a non-negative safe integer/,
      );
    }
  }
  assert.equal(networkCalls,0);
  await orchestrator.run(config,{},'owner-approved prompt',{maxModelCallsForRequest:1,maxOutputTokens:5});
  assert.equal(networkCalls,1);
});


test('UNKNOWN budget settlement forbids failover even after transient provider or broker errors', async () => {
  const config = {
    enabled:true,mode:'primary',fallbackToStrongOnPrimaryError:true,
    routes:[
      {routeId:'fast',provider:'ollama',model:'first',locality:'local',costClass:'free',priority:10},
      {routeId:'backup',provider:'ollama',model:'second',locality:'local',costClass:'free',priority:5},
    ],
    routePolicy:{autoSwitch:true},
  };
  for (const providerFailed of [false,true]) {
    const calls=[];
    const settlements=[];
    const client={async complete({model}) {
      calls.push(model);
      if (providerFailed) {
        const error=new Error('provider timeout');
        error.status=503;
        throw error;
      }
      return {text:'reply',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
    }};
    const lifecycle={
      async beforeProviderCall({callNumber}) {return {reservationId:'res-'+callNumber};},
      async afterProviderCall({reservation}) {
        settlements.push(reservation.reservationId);
        const error=new Error('transient broker unavailable');
        error.status=503;
        throw error;
      },
    };
    const orchestrator=new AiOrchestrator({
      gatewayClient:client,providerCallLifecycle:lifecycle,now:()=>1000,
    });
    await assert.rejects(
      orchestrator.run(config,{},'owner prompt',{
        maxModelCallsForRequest:2,maxOutputTokens:12,
        providerCallBudgetContext:{jobId:'fixture'},
      }),
      error => error.code === 'AI_MODEL_BUDGET_SETTLEMENT_UNKNOWN'
        && error.routeFailureClassification.retryable === false
        && error.modelCallsUsed === 1
        && error.routeAttempts.length === 1
        && error.routeAttempts[0].outcome === 'UNKNOWN',
    );
    assert.deepEqual(calls,['first'],'an unknown provider effect must never try the backup');
    assert.deepEqual(settlements,['res-1']);
  }
});


test('legacy primary/strong routing never retries an UNKNOWN model settlement', async () => {
  const calls=[];
  const client={async complete({model}) {
    calls.push(model);
    return {text:'model answer',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
  }};
  const lifecycle={
    async beforeProviderCall() {return {reservationId:'unsettled'};},
    async afterProviderCall() {
      const error=new Error('broker 503; status cannot prove reservation settled');
      error.status=503;
      throw error;
    },
  };
  const orchestrator=new AiOrchestrator({
    gatewayClient:client,providerCallLifecycle:lifecycle,now:()=>1000,
  });
  const config={
    enabled:true,mode:'primary',fallbackToStrongOnPrimaryError:true,
    primary:{provider:'ollama',model:'first'},
    strong:{provider:'openai',model:'backup'},
  };
  await assert.rejects(orchestrator.run(config,{},'prompt',{
    maxOutputTokens:12,maxModelCallsForRequest:2,
    providerCallBudgetContext:{jobId:'legacy'},
  }),error => error.code==='AI_MODEL_BUDGET_SETTLEMENT_UNKNOWN' && error.modelCallsUsed===1);
  assert.deepEqual(calls,['first']);
});

test('hybrid strong review cannot downgrade an UNKNOWN settlement to a successful primary result', async () => {
  const calls=[];
  let settles=0;
  const client={async complete({model}) {
    calls.push(model);
    return {text:model==='first'?'[[ESCALATE]] review':'strong answer',
      usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
  }};
  const lifecycle={
    async beforeProviderCall({callNumber}) {return {reservationId:'res-'+callNumber};},
    async afterProviderCall() {
      settles++;
      if (settles===2) {
        const error=new Error('broker timeout');
        error.status=503;
        throw error;
      }
      // Primary settlement must be positively acknowledged before the
      // second (strong-model) attempt may execute at all.
      return {settled:true};
    },
  };
  const orchestrator=new AiOrchestrator({
    gatewayClient:client,providerCallLifecycle:lifecycle,now:()=>1000,
  });
  const config={
    enabled:true,mode:'hybrid-auto',keepPrimaryIfStrongFails:true,
    primary:{provider:'ollama',model:'first'},
    strong:{provider:'openai',model:'review'},
  };
  await assert.rejects(orchestrator.run(config,{},'owner prompt',{
    maxOutputTokens:12,maxModelCallsForRequest:2,
    providerCallBudgetContext:{jobId:'hybrid'},
  }),error => error.code==='AI_MODEL_BUDGET_SETTLEMENT_UNKNOWN' && error.modelCallsUsed===2);
  assert.deepEqual(calls,['first','review']);
  assert.equal(settles,2);
});


test('Plan 4 S1: route price and owner cap reject coercible zero values across persistence', () => {
  const invalid = ['', ' ', ' 0 ', '0x0', '0b0', '0o0', '+0', '-0', '00', 'NaN', '0_0', '1e-9999', '0.00000000001e-9999'];
  for (const value of invalid) {
    const candidate = [{...route,inputPricePerMillionUsd:value,outputPricePerMillionUsd:0}];
    assert.throws(() => normalizeAiRoutePool(candidate), /price.*invalid/i);
    assert.throws(() => normalizeAiRoutePool(JSON.parse(JSON.stringify(candidate))), /price.*invalid/i);
    assert.throws(() => normalizeAiRoutePolicy({maxInputPricePerMillionUsd:value}), /price.*invalid/i);
  }
  const exact = normalizeAiRoutePool([{...route,inputPricePerMillionUsd:'0',outputPricePerMillionUsd:'0.0005'}])[0];
  assert.equal(exact.inputPriceKnown,true);
  assert.equal(exact.inputPricePerMillionUsd,0);
  assert.equal(exact.outputPricePerMillionUsd,0.0005);
  assert.equal(normalizeAiRoutePolicy({maxInputPricePerMillionUsd:'0'}).maxInputPricePerMillionUsd,0);
});

test('Plan 4 S2: explicit corrupt local URL and timeout cannot silently select defaults after restart', () => {
  for (const badBaseUrl of ['', '   ']) {
    const config = {...settings,baseUrl:badBaseUrl};
    assert.throws(() => normalizeLocalAiSettings(config), /URL cannot be empty/);
    assert.throws(() => normalizeLocalAiSettings(JSON.parse(JSON.stringify(config))), /URL cannot be empty/);
    assert.throws(() => normalizeLocalAiBaseUrl(badBaseUrl), /URL cannot be empty/);
  }
  const corrupt = {...settings,timeoutSeconds:null};
  assert.throws(() => normalizeLocalAiSettings(corrupt), /timeout/);
  assert.throws(() => normalizeLocalAiSettings(JSON.parse(JSON.stringify(corrupt))), /timeout/);
  const legacy = {...settings};
  delete legacy.baseUrl;
  delete legacy.timeoutSeconds;
  assert.equal(normalizeLocalAiSettings(legacy).timeoutSeconds,90);
  assert.equal(normalizeLocalAiSettings(legacy).baseUrl,'http://127.0.0.1:11434');
  assert.equal(normalizeLocalAiSettings(settings).timeoutSeconds,5);
});


test('Plan 4 S1: explicit null endpoint identities and profile list never downgrade to unbound legacy evidence', async () => {
  const boundRoute = {...route, endpointId:'loopback.1'};
  const boundProfile = {...endpoint, endpointId:'loopback.1'};
  const bound = {...snapshot, routes:[boundRoute], endpointProfiles:[boundProfile]};
  const valid = await createAiRouteRegistryEvidenceV1(bound);
  assert.equal(valid.routeIdentities[0].endpointBinding,'MATCHED');
  for (const corrupt of [
    {...bound, routes:[{...boundRoute,endpointId:null}]},
    {...bound, routes:[{...boundRoute,endpointId:undefined}]},
    {...bound, endpointProfiles:null},
    {...bound, endpointProfiles:undefined},
    {...bound, endpointProfiles:[{...boundProfile,endpointId:null}]},
    {...bound, endpointProfiles:[{...boundProfile,credentialRef:null}]},
  ]) {
    await assert.rejects(createAiRouteRegistryEvidenceV1(corrupt), /endpoint|credential/i);
    // JSON round trips preserve null but erase undefined keys, which is
    // genuine legacy absence; do not fabricate a bound identity after restore.
    const restarted = JSON.parse(JSON.stringify(corrupt));
    if (restarted.routes[0].endpointId === null || restarted.endpointProfiles === null || restarted.endpointProfiles?.[0]?.endpointId === null || restarted.endpointProfiles?.[0]?.credentialRef === null) {
      await assert.rejects(createAiRouteRegistryEvidenceV1(restarted), /endpoint|credential/i);
    }
  }
  const legacy = await createAiRouteRegistryEvidenceV1(snapshot);
  assert.equal(legacy.routeIdentities[0].endpointBinding,'UNRESOLVED_LEGACY');
  assert.equal((await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(bound)))).configSha256,valid.configSha256);
});

test('Plan 4 S2: gateway identity and provider output ceiling reject malformed explicit owner values before network', async () => {
  let requests = 0;
  let admitted = null;
  const client = new AiGatewayClient({fetchFn:async (url,init) => {
    requests += 1;
    admitted = {url,body:JSON.parse(init.body)};
    return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({ok:true,text:'ok'})};
  }});
  const base = {provider:'ollama',model:'llama3',prompt:'approved task'};
  for (const invalidUrl of [null,'','  ',false]) {
    assert.throws(() => normalizeGatewayUrl(invalidUrl), /URL/);
    await assert.rejects(client.complete({...base,gatewayUrl:invalidUrl}), /Gateway URL/);
  }
  for (const bad of [1.5,0.5,-0,-1,null,false,'8',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(client.complete({...base,maxOutputTokens:bad}), /non-negative safe integer/);
  }
  assert.equal(requests,0,'invalid endpoints and budget may not dispatch');
  assert.equal(normalizeGatewayUrl(undefined),'http://127.0.0.1:17621');
  await client.complete({...base,maxOutputTokens:7});
  assert.equal(requests,1);
  assert.equal(admitted.body.maxOutputTokens,7);
  assert.equal(admitted.body.model,'llama3');
  const replay = JSON.parse(JSON.stringify({...base,maxOutputTokens:7}));
  await client.complete(replay);
  assert.equal(requests,2);
  assert.equal(admitted.body.maxOutputTokens,7);
});

test('Plan4 S1: explicitly undefined owner route ceilings and failover knobs never inherit defaults', () => {
  const unsafe = [
    ['autoSwitch', undefined], ['freeOnly', undefined],
    ['orderedRouteIds', undefined], ['allowRouteIds', undefined],
    ['denyRouteIds', undefined],
    ['maxInputPricePerMillionUsd', undefined],
    ['maxOutputPricePerMillionUsd', undefined],
    ['retryBackoffSeconds', undefined],
    ['circuitBreakerFailures', undefined],
    ['circuitBreakerSeconds', undefined],
  ];
  for (const [field, value] of unsafe) {
    assert.throws(
      () => normalizeAiRoutePolicy({ [field]: value }),
      undefined,
      `explicitly erased owner route policy ${field} must fail closed`,
    );
  }
  assert.throws(() => normalizeAiRoutePool([{ ...route, enabled:undefined }]));
  assert.throws(() => normalizeAiRoutePool([{ ...route, supportsVision:undefined }]));
  assert.throws(() => selectAiRouteCandidates({
    routes:[route], policy:{ autoSwitch:undefined }, now:1,
  }));
  const accepted = {
    autoSwitch:false, freeOnly:false,
    maxInputPricePerMillionUsd:0,
    maxOutputPricePerMillionUsd:null,
    retryBackoffSeconds:30, circuitBreakerFailures:2, circuitBreakerSeconds:60,
  };
  const restored = normalizeAiRoutePolicy(JSON.parse(JSON.stringify(accepted)));
  assert.equal(restored.autoSwitch, false);
  assert.equal(restored.maxInputPricePerMillionUsd, 0);
  assert.equal(restored.maxOutputPricePerMillionUsd, null);
  assert.equal(restored.retryBackoffSeconds, 30);
  assert.deepEqual(normalizeAiRoutePolicy({}).orderedRouteIds, []);
});

test('Plan4 S2: erased local provider/origin does not dispatch to a different service', async () => {
  let fetchCount = 0;
  const client = new LocalAiClient({
    fetchFn:async () => { fetchCount += 1; throw new Error('must not connect'); },
    setTimeoutFn:() => 1,
    clearTimeoutFn:() => {},
  });
  for (const [field, value] of [
    ['providerType', undefined], ['baseUrl', undefined],
    ['providerType', null], ['baseUrl', null],
  ]) {
    const corrupted = { ...settings, [field]:value };
    assert.throws(() => normalizeLocalAiSettings(corrupted));
    await assert.rejects(() => client.complete(corrupted, 'no outbound effect'));
  }
  assert.equal(fetchCount, 0);
  const legacy = normalizeLocalAiSettings({
    enabled:true, model:'llama3', timeoutSeconds:5,
  });
  assert.equal(legacy.providerType, 'ollama');
  assert.equal(legacy.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(normalizeLocalAiSettings(JSON.parse(JSON.stringify(settings))).model, 'llama3');
});


test('Plan4 S1: numeric route caps and worker allocation cannot be silently erased or coerced', () => {
  for (const field of ['priority', 'maxWorkers']) {
    for (const bad of [null, undefined]) {
      assert.throws(() => normalizeAiRoutePool([{...route, [field]:bad}]), /invalid/);
    }
  }
  for (const bad of ['', '  ', '0x0', '0b1', '1e1', '00', '-0', '+0', ' 1 ']) {
    assert.throws(() => normalizeAiRoutePool([{...route, priority:bad}]), /invalid/);
    assert.throws(() => normalizeAiRoutePolicy({retryBackoffSeconds:bad}), /invalid/);
  }
  for (const [field, bad] of [
    ['allocationMode',undefined], ['minWorkers',null], ['minWorkers',undefined],
    ['maxParallelWorkers',null], ['maxParallelWorkers',undefined],
    ['manualRouteWorkers',null], ['manualRouteWorkers',undefined],
  ]) {
    assert.throws(() => normalizeAiWorkerPolicy({[field]:bad}, [route]));
  }
  const valid = normalizeAiRoutePool([{...route, priority:'12', maxWorkers:2}])[0];
  assert.equal(valid.priority,12);
  assert.equal(valid.maxWorkers,2);
  assert.equal(normalizeAiRoutePolicy({retryBackoffSeconds:'30'}).retryBackoffSeconds,30);
  const worker = normalizeAiWorkerPolicy(
    JSON.parse(JSON.stringify({allocationMode:'manual',minWorkers:1,maxParallelWorkers:2,manualRouteWorkers:{[route.routeId]:1}})),
    [valid],
  );
  assert.equal(worker.manualRouteWorkers[route.routeId],1);
  assert.equal(normalizeAiRoutePool([route])[0].maxWorkers,0);
});

test('Plan4 S2: explicit undefined local model, enablement and timeout fail before provider effect', async () => {
  let effects=0;
  const client = new LocalAiClient({
    fetchFn:async()=>{effects++; throw Error('unexpected outbound effect');},
    setTimeoutFn:()=>1,
    clearTimeoutFn:()=>{},
  });
  for (const field of ['enabled','model','timeoutSeconds']) {
    const corrupted={...settings,[field]:undefined};
    assert.throws(()=>normalizeLocalAiSettings(corrupted), /cannot be undefined/);
    await assert.rejects(client.complete(corrupted,'do not dispatch'), /cannot be undefined/);
  }
  assert.equal(effects,0);
  const restored=normalizeLocalAiSettings(JSON.parse(JSON.stringify(settings)));
  assert.equal(restored.model,'llama3');
  assert.equal(restored.timeoutSeconds,5);
  const legacy=normalizeLocalAiSettings({});
  assert.equal(legacy.enabled,false);
  assert.equal(legacy.model,'');
  assert.equal(legacy.timeoutSeconds,90);
});

test('Plan4 S1: explicitly erased router ownership fields must not trigger default provider dispatch', async () => {
  const owner = {
    enabled: true, mode:'primary', gatewayUrl:'http://127.0.0.1:17621',
    primary:{provider:'ollama', model:'llama3'}, strong:{provider:'openai',model:'strong-fixture'},
    routes:[route], routePolicy:{locality:'local',autoSwitch:false}, workerPolicy:{allocationMode:'auto'},
  };
  let effects=0;
  const orchestrator=new AiOrchestrator({gatewayClient:{complete:async()=>{effects++;return {text:'unexpected model response'};}}});
  for (const field of ['gatewayUrl','primary','strong','routes','routePolicy','workerPolicy']) {
    const corrupt={...owner,[field]:undefined};
    assert.throws(()=>normalizeAiRouterSettings(corrupt), /cannot be undefined when explicitly supplied/);
    await assert.rejects(orchestrator.run(corrupt,{},'Do not dispatch'), /cannot be undefined when explicitly supplied/);
  }
  assert.equal(effects,0);
  const valid=normalizeAiRouterSettings(JSON.parse(JSON.stringify(owner)));
  assert.equal(valid.routes[0].routeId,route.routeId);
  assert.equal(valid.routePolicy.locality,'local');
  assert.equal(normalizeAiRouterSettings({}).routes.length,0);
});

test('Plan4 S2: timed-out local fetch must reject late resolved response', async () => {
  let expiry;
  const client=new LocalAiClient({
    fetchFn:async()=>{expiry();return {ok:true,status:200};},
    setTimeoutFn:callback=>{expiry=callback;return 1;},
    clearTimeoutFn:()=>{},
  });
  await assert.rejects(
    client.request(settings,'http://127.0.0.1:11434/api/tags',{},async()=>({models:['stale']})),
    error=>{assert.equal(error.code,'LOCAL_AI_TIMEOUT');assert.equal(error.category,'TIMEOUT');return true;},
  );
});

test('Plan4 S2: timed-out local body must not publish late success, normal response still works', async () => {
  let expiry;
  let networkRequests=0;
  const client=new LocalAiClient({
    fetchFn:async()=>{networkRequests++;return {ok:true,status:200};},
    setTimeoutFn:callback=>{expiry=callback;return 2;},
    clearTimeoutFn:()=>{},
  });
  await assert.rejects(
    client.request(settings,'http://127.0.0.1:11434/api/tags',{},async()=>{expiry();return {models:['stale']};}),
    error=>{assert.equal(error.code,'LOCAL_AI_TIMEOUT');assert.equal(error.category,'TIMEOUT');return true;},
  );
  const restored=JSON.parse(JSON.stringify(settings));
  const allowed=await client.request(restored,'http://127.0.0.1:11434/api/tags',{},async()=>({models:['allowed']}));
  assert.deepEqual(allowed,{models:['allowed']});
  assert.equal(networkRequests,2);
});

test('Plan4 S2: AI Gateway rejects late fetch completion after its deadline without retrying', async () => {
  let expire;
  let requests=0;
  const client = new AiGatewayClient({
    fetchFn:async () => { requests++; expire(); return {ok:true,status:200,text:async()=>JSON.stringify({text:'stale'})}; },
    setTimeoutFn:callback=>{expire=callback;return 1;},
    clearTimeoutFn:()=>{},
  });
  await assert.rejects(
    client.complete({provider:'openai-compatible',model:'fixture',prompt:'do not publish stale output',timeoutSeconds:5}),
    error => error.code === 'AI_GATEWAY_RESPONSE_UNVERIFIED' && error.category === 'UNAVAILABLE' && error.retryable === false,
  );
  assert.equal(requests,1);
});

test('Plan4 S2: AI Gateway body expiry fails closed, bounded rejection keeps its typed code, restart succeeds', async () => {
  let expire;
  let mode='late-body';
  let requests=0;
  const client = new AiGatewayClient({
    fetchFn:async () => {
      requests++;
      if (mode === 'oversized') return {
        ok:true,status:200,headers:{get:()=>String(4_000_001)},body:{cancel:async()=>{}},
      };
      return {
        ok:true,status:200,
        text:async()=>{if(mode==='late-body')expire();return JSON.stringify({text:'safe reply'});},
      };
    },
    setTimeoutFn:callback=>{expire=callback;return 2;},
    clearTimeoutFn:()=>{},
  });
  const input={provider:'openai-compatible',model:'fixture',prompt:'bounded',timeoutSeconds:5};
  await assert.rejects(client.complete(input),
    error=>error.code==='AI_GATEWAY_RESPONSE_UNVERIFIED' && error.retryable===false);
  mode='oversized';
  await assert.rejects(client.complete(input),
    error=>error.code==='AI_GATEWAY_RESPONSE_TOO_LARGE');
  mode='allowed';
  const valid=await client.complete(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(valid,{text:'safe reply'});
  assert.equal(requests,3);
});

test('Plan4 S1: exact endpoint identity cannot be erased or aliased at gateway dispatch/discovery', async () => {
  let effects=0;
  const seen=[];
  const client=new AiGatewayClient({
    fetchFn:async (url,init) => {
      effects++;
      seen.push({url,body:init.body});
      return {ok:true,status:200,text:async()=>JSON.stringify({text:'fixture',models:[]})};
    },
  });
  const input={provider:'openai-compatible',model:'fixture',prompt:'account-bound',timeoutSeconds:5};
  const corrupt=[undefined,null,'',' ',' endpoint','endpoint ','bad?query','bad#hash','bad&value','a'.repeat(181),42,{},new String('endpoint')];
  for (const endpointId of corrupt) {
    await assert.rejects(client.complete({...input,endpointId}),/endpointId must be an exact bounded identity/);
    await assert.rejects(client.listModels({provider:'openai-compatible',endpointId,timeoutSeconds:5}),/endpointId must be an exact bounded identity/);
  }
  assert.equal(effects,0,'corrupted endpoint identity may not dispatch or discover models');
  await client.complete({...input,endpointId:'local.profile-1'});
  await client.listModels({provider:'openai-compatible',endpointId:'local.profile-1',timeoutSeconds:5});
  assert.equal(JSON.parse(seen[0].body).endpointId,'local.profile-1');
  assert.match(seen[1].url,/endpointId=local.profile-1/);
  assert.equal(effects,2);
});

test('Plan4 S1: persisted null/undefined owner pin never broadens model routing', () => {
  const ownerRoutes = [
    {...route,routeId:'owner.primary',priority:1},
    {...route,routeId:'other.account',priority:100},
  ];
  for (const invalid of [null,undefined,false,0,{},[]]) {
    assert.throws(
      () => normalizeAiRoutePolicy({pinnedRouteId:invalid}),
      /pinnedRouteId must be exact text/,
    );
  }
  const resumed = JSON.parse(JSON.stringify({pinnedRouteId:null}));
  assert.throws(() => normalizeAiRoutePolicy(resumed), /pinnedRouteId must be exact text/);
  assert.deepEqual(
    selectAiRouteCandidates({
      routes:ownerRoutes, policy:{pinnedRouteId:'owner.primary'}, now:1,
    }).candidates.map(candidate => candidate.routeId),
    ['owner.primary'],
  );
  // Only an explicitly empty string can deliberately clear the pin.
  assert.equal(normalizeAiRoutePolicy({pinnedRouteId:''}).pinnedRouteId,'');
  assert.equal(normalizeAiRoutePolicy({}).pinnedRouteId,'');
});

test('Plan4 S2: forged Gateway diagnostic prefixes cannot leak transport secrets', async () => {
  const request = {provider:'openai-compatible',model:'fixture',prompt:'safe',timeoutSeconds:5};
  for (const forgedMessage of [
    'AI Gateway returned sk-sentinel-transport-exception',
    'AI Gateway error sk-sentinel-transport-exception',
  ]) {
    const gateway = new AiGatewayClient({
      fetchFn: async () => { throw new Error(forgedMessage); },
    });
    await assert.rejects(gateway.complete(request), error =>
      error.code === 'AI_GATEWAY_RESPONSE_UNVERIFIED'
      && error.category === 'UNAVAILABLE'
      && error.retryable === false
      && !String(error.message).includes('sk-sentinel'));
  }
  const forgedBody = new AiGatewayClient({
    fetchFn:async () => ({
      ok:true,status:200,
      text:async () => { throw new Error('AI Gateway returned sk-sentinel-body-reader'); },
    }),
  });
  await assert.rejects(forgedBody.complete(request), error =>
    error.code === 'AI_GATEWAY_RESPONSE_UNVERIFIED'
    && error.retryable === false
    && !String(error.message).includes('sk-sentinel'));
  const forgedCode = new AiGatewayClient({
    fetchFn:async () => {
      const failure = new Error('sk-sentinel-fake-code');
      failure.code = 'AI_GATEWAY_RESPONSE_TOO_LARGE';
      throw failure;
    },
  });
  await assert.rejects(forgedCode.complete(request), error =>
    error.code === 'AI_GATEWAY_RESPONSE_UNVERIFIED'
    && error.retryable === false
    && !String(error.message).includes('sk-sentinel'));
  // Internally generated HTTP classification is still preserved.
  const genuine = new AiGatewayClient({
    fetchFn:async () => new Response('sk-sentinel-http-body',{status:429}),
  });
  await assert.rejects(genuine.complete(request), error =>
    error.status === 429 && error.category === 'RATE_LIMIT'
    && error.retryable === true && !String(error.message).includes('sk-sentinel'));
});

test('Plan4 S1/S2: budgeted dispatch refuses missing or forged durable reservation before provider I/O', async () => {
  const seen=[];
  let effects=0;
  const owner={enabled:true,mode:'primary',
    primary:{provider:'ollama',model:'fixture'},fallbackToStrongOnPrimaryError:false};
  const budget={kind:'browser-agent',jobId:'job',controlEpoch:1};
  const forged=[
    null, undefined, false, {},
    {reservationId:''},{reservationId:42},
    Object.defineProperty({},'reservationId',{get(){throw Error('sk-private-accessor');},enumerable:true}),
  ];
  for(const fake of forged) {
    const router=new AiOrchestrator({
      gatewayClient:{async complete(){effects++;return {text:'unsafe'};}},
      providerCallLifecycle:{
        async beforeProviderCall(){seen.push('before');return fake;},
        async afterProviderCall(){seen.push('after');},
      },
    });
    await assert.rejects(router.run(owner,{},'owner approved',{
      providerCallBudgetContext:budget,maxOutputTokens:128,maxModelCallsForRequest:1,
    }),error=>error.code==='AI_MODEL_BUDGET_RESERVATION_REQUIRED'
      && !String(error.message).includes('sk-private'));
  }
  assert.equal(effects,0);
  assert.deepEqual(seen,Array(forged.length).fill('before'));
  const admitted=new AiOrchestrator({
    gatewayClient:{async complete(){effects++;return {text:'safe',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}},
    providerCallLifecycle:{
      async beforeProviderCall(){return {reservationId:'job:model-budget:1'};},
      async afterProviderCall(){return {settled:true};},
    },
  });
  const result=await admitted.run(owner,{},'owner approved',{
    providerCallBudgetContext:JSON.parse(JSON.stringify(budget)),
    maxOutputTokens:128,maxModelCallsForRequest:1,
  });
  assert.equal(result.usage.modelCalls,1);
  assert.equal(effects,1);
});

test('Plan4 S2: canonical service-worker lifecycle requires settled durable owner receipt', async () => {
  // Git checkout on Windows may use CRLF. Parse the same source on both CI OSes.
  const serviceWorkerSource = (await readFile(new URL('../src/background/service-worker.js', import.meta.url),'utf8')).replace(/\r\n/gu, '\n');
  const marker='providerCallLifecycle: {';
  const start=serviceWorkerSource.indexOf(marker);
  const end=serviceWorkerSource.indexOf('\n  },\n});',start);
  assert.ok(start >= 0 && end > start,'existing canonical lifecycle must be wired');
  const body=serviceWorkerSource.slice(start+marker.length,end);
  const createLifecycle=new Function('browserAgentLifecycle', 'return ({' + body + '\n  });');
  const context={kind:'browser-agent',jobId:'test-job',controlEpoch:2};
  const reservation={reservationId:'test-job:model-budget:1'};
  const withoutOwner=createLifecycle({current:null});
  await assert.rejects(withoutOwner.beforeProviderCall({context}),error =>
    error.code==='AI_MODEL_BUDGET_LIFECYCLE_REQUIRED');
  await assert.rejects(withoutOwner.afterProviderCall({context,reservation,ok:true}),error =>
    error.code==='AI_MODEL_BUDGET_SETTLEMENT_UNKNOWN');

  let reserveCalls=0;
  let settleCalls=0;
  const current={
    async reserveProviderModelBudget(){reserveCalls++;return reservation;},
    async settleProviderModelBudget(){settleCalls++;return {settled:false};},
  };
  const lifecycle=createLifecycle({current});
  assert.deepEqual(await lifecycle.beforeProviderCall({
    context,route:{routeId:'r'},prompt:'prompt',maxOutputTokens:128,callNumber:1,
  }),reservation);
  await assert.rejects(lifecycle.afterProviderCall({context,reservation,ok:true}),
    error=>error.code==='AI_MODEL_BUDGET_SETTLEMENT_UNKNOWN');
  current.settleProviderModelBudget=async()=>{settleCalls++;return {settled:true};};
  assert.deepEqual(await lifecycle.afterProviderCall({context,reservation,ok:true}),{settled:true});
  await assert.rejects(lifecycle.beforeProviderCall({
    context:{...context,kind:'untrusted'},
  }),error=>error.code==='AI_MODEL_BUDGET_LIFECYCLE_REQUIRED');
  assert.equal(reserveCalls,1);
  assert.equal(settleCalls,2);
});


test('Plan4 S2: forged local response readers are redacted and never authorize blind POST retry', async () => {
  let effects = 0;
  let mode = 'reader-error';
  const client = new LocalAiClient({
    fetchFn: async () => {
      effects++;
      if (mode === 'success') return new Response(JSON.stringify({
        message:{content:'safe response'}, prompt_eval_count:2, eval_count:1,
      }), {status:200});
      return {ok:true,status:200,text:async () => {
        const forged = new Error('sk-private-local-response-reader');
        forged.code = 'LOCAL_AI_AUTH';
        forged.category = 'AUTH';
        forged.retryable = true;
        if (mode === 'fake-abort') forged.name = 'AbortError';
        throw forged;
      }};
    },
  });
  const restored = JSON.parse(JSON.stringify(settings));
  for (let i = 0; i < 2; i++) {
    mode = i === 0 ? 'reader-error' : 'fake-abort';
    await assert.rejects(client.complete(restored,'owner approved'), error =>
      error.code === 'LOCAL_AI_RESPONSE_UNVERIFIED'
      && error.category === 'UNAVAILABLE'
      && error.retryable === false
      && !String(error.message).includes('sk-private')
      && !String(error.message).includes('LOCAL_AI_AUTH'));
    assert.equal(effects,i+1,'no automatic resend or alternate provider');
  }
  mode = 'success';
  const recovered = await client.complete(restored,'owner approved');
  assert.equal(recovered.text,'safe response');
  assert.equal(recovered.usage.totalTokens,3);
  assert.equal(effects,3);
});

test('Plan4 S1: explicitly undefined owner locality and route cost class fail closed before routing', () => {
  const base = {routeId:'owner.local',provider:'ollama',model:'fixture'};
  for (const invalid of [
    {...base,locality:undefined},
    {...base,costClass:undefined},
    {...base,locality:'remote',costClass:undefined},
  ]) {
    assert.throws(() => normalizeAiRoutePool([invalid]),/locality|costClass.*undefined/);
    assert.throws(() => selectAiRouteCandidates({
      routes:[invalid],policy:{locality:'local'},now:1,
    }),/locality|costClass.*undefined/);
  }
  assert.throws(
    () => normalizeAiRoutePolicy({locality:undefined}),
    /AI route policy locality cannot be undefined/,
  );
  assert.throws(
    () => selectAiRouteCandidates({routes:[base],policy:{locality:undefined},now:1}),
    /AI route policy locality cannot be undefined/,
  );
  // JSON null is not a safe substitute for lost owner locality or route class.
  for (const field of ['locality','costClass']) {
    const corrupt = JSON.parse(JSON.stringify({...base,[field]:null}));
    assert.throws(() => normalizeAiRoutePool([corrupt]),/locality|costClass/);
  }
  assert.throws(() => normalizeAiRoutePolicy(
    JSON.parse(JSON.stringify({locality:null}))),/locality/);
  // Genuine omission preserves legacy defaults and valid, explicitly pinned
  // local routing survives a persisted JSON round trip.
  const legacy = normalizeAiRoutePool([base])[0];
  assert.equal(legacy.locality,'local');
  assert.equal(legacy.costClass,'free');
  const persisted=JSON.parse(JSON.stringify({
    routes:[{...base,locality:'local',costClass:'free'}],
    policy:{locality:'local',pinnedRouteId:'owner.local'},
  }));
  assert.deepEqual(selectAiRouteCandidates({...persisted,now:1})
    .candidates.map(candidate=>candidate.routeId),['owner.local']);
});

test('Plan4 S2: forged gateway body AbortError cannot trigger route failover or leak data', async () => {
  let effects=0;
  let mode='unverified';
  const gateway=new AiGatewayClient({
    fetchFn:async()=>{
      effects++;
      return {ok:true,status:200,text:async()=>{
        if(mode==='valid') return JSON.stringify({text:'verified',usage:{inputTokens:2,outputTokens:1}});
        const forged=new Error('sk-private-gateway-body');
        forged.name='AbortError';
        forged.code='AI_GATEWAY_TIMEOUT';
        forged.retryable=true;
        throw forged;
      }};
    },
  });
  const routeA={routeId:'owner.primary',provider:'ollama',model:'local-a',locality:'local',priority:2};
  const routeB={routeId:'backup',provider:'ollama',model:'local-b',locality:'local',priority:1};
  const router=new AiOrchestrator({gatewayClient:gateway});
  const owner={
    enabled:true,mode:'primary',primary:{provider:'ollama',model:'local-a'},
    fallbackToStrongOnPrimaryError:false,routePolicy:{autoSwitch:true},routes:[routeA,routeB],
  };
  await assert.rejects(
    router.run(owner,{},'approved work',{maxModelCallsForRequest:2}),
    error=>error.code==='AI_GATEWAY_RESPONSE_UNVERIFIED'
      && error.retryable===false
      && !String(error.message).includes('sk-private'),
  );
  assert.equal(effects,1,'unverified first provider result must not invoke backup');
  mode='valid';
  const recovered=await gateway.complete(JSON.parse(JSON.stringify({
    provider:'ollama',model:'local-a',prompt:'approved work',timeoutSeconds:5,
  })));
  assert.equal(recovered.text,'verified');
  assert.equal(effects,2);
});

test('Plan4 S1 wrong provider/model/endpoint receipts settle consumption but never publish or retry a second route', async () => {
  const owner={enabled:true,mode:'primary',
    primary:{provider:'openai-compatible',model:'fixture'},
    fallbackToStrongOnPrimaryError:true,
    routePolicy:{autoSwitch:true},
    routes:[
      {routeId:'owner.primary',provider:'openai-compatible',model:'fixture',endpointId:'owner.local',priority:10,locality:'local',costClass:'free'},
      {routeId:'backup',provider:'openai-compatible',model:'backup',endpointId:'backup.local',priority:1,locality:'local',costClass:'free'},
    ],
  };
  const budgetContext={kind:'browser-agent',jobId:'job-a',controlEpoch:1};
  const options={providerCallBudgetContext:budgetContext,maxOutputTokens:128,maxModelCallsForRequest:2};
  const mismatches=[
    {text:'untrusted',provider:'openai',model:'fixture',endpointId:'owner.local'},
    {text:'untrusted',provider:'openai-compatible',model:'other-model',endpointId:'owner.local'},
    {text:'untrusted',provider:'openai-compatible',model:'fixture',endpointId:'other.account'},
    Object.defineProperty({text:'untrusted',provider:'openai-compatible',endpointId:'owner.local'},
      'model',{enumerable:true,get(){throw new Error('sk-secret-receipt-accessor');}}),
  ];
  for (const value of mismatches) {
    let networkEffects=0;
    const settlements=[];
    const gatewayClient={async complete(){networkEffects++;return value;}};
    const providerCallLifecycle={
      async beforeProviderCall(){return {reservationId:'job-a:model-budget:1'};},
      async afterProviderCall(receipt){settlements.push(receipt.ok);return {settled:true};},
    };
    const router=new AiOrchestrator({gatewayClient,providerCallLifecycle});
    await assert.rejects(router.run(owner,{},'approved',options),error =>
      error.code==='AI_PROVIDER_RECEIPT_IDENTITY_UNVERIFIED'
      && error.retryable===false
      && !String(error.message).includes('sk-secret')
      && error.routeAttempts?.[0]?.outcome === 'UNKNOWN');
    assert.equal(networkEffects,1,'identity mismatch cannot invoke the backup account');
    assert.deepEqual(settlements,[true],'consumed provider call is settled exactly once before rejection');
  }
  let effects=0;
  const admitted=new AiOrchestrator({
    gatewayClient:{async complete(){effects++;return {
      provider:'openai-compatible',model:'fixture',endpointId:'owner.local',
      text:'verified',usage:{inputTokens:1,outputTokens:1,totalTokens:2},
    };}},
    providerCallLifecycle:{
      async beforeProviderCall(){return {reservationId:'job-a:model-budget:1'};},
      async afterProviderCall(){return {settled:true};},
    },
  });
  const recovered=await admitted.run(JSON.parse(JSON.stringify(owner)),{},'approved',options);
  assert.equal(recovered.routing.selectedRouteId,'owner.primary');
  assert.equal(recovered.text,'verified');
  assert.equal(effects,1);
});


test('Plan4 S1 requires complete identity receipts for endpoint-bound provider dispatch', async () => {
  const owner = JSON.parse(JSON.stringify({
    enabled:true, mode:'primary', fallbackToStrongOnPrimaryError:false,
    primary:{provider:'openai-compatible',model:'fixture'},
    routePolicy:{autoSwitch:true,pinnedRouteId:'account.bound'},
    routes:[{routeId:'account.bound',provider:'openai-compatible',model:'fixture',
      endpointId:'account.endpoint',locality:'local',costClass:'free'}],
  }));
  const options = {
    providerCallBudgetContext:{kind:'browser-agent',jobId:'account-bound-job',controlEpoch:1},
    maxModelCallsForRequest:2, maxOutputTokens:128,
  };
  const incomplete = [
    null, [], {text:'unsafe'},
    {text:'unsafe',provider:'openai-compatible'},
    {text:'unsafe',provider:'openai-compatible',model:'fixture'},
    {text:'unsafe',provider:'openai-compatible',endpointId:'account.endpoint'},
    {text:'unsafe',model:'fixture',endpointId:'account.endpoint'},
    Object.defineProperty({
      text:'unsafe',provider:'openai-compatible',model:'fixture'
    },'endpointId',{enumerable:true,get(){throw new Error('secret accessor');}}),
  ];
  for (const unsafe of incomplete) {
    let sends = 0;
    const settlements = [];
    const router = new AiOrchestrator({
      gatewayClient:{async complete(){sends++;return unsafe;}},
      providerCallLifecycle:{
        async beforeProviderCall(){return {reservationId:'account-bound-job:reservation:1'};},
        async afterProviderCall({ok}){settlements.push(ok);return {settled:true};},
      },
    });
    await assert.rejects(router.run(owner,{},'approved after restart',options),
      error => error.code === 'AI_PROVIDER_RECEIPT_IDENTITY_UNVERIFIED'
        && error.retryable === false
        && error.routeAttempts?.[0]?.outcome === 'UNKNOWN'
        && !String(error.message).includes('secret'));
    assert.equal(sends,1,'no blind resend after unknown account receipt');
    assert.deepEqual(settlements,[true],'account usage still settled once');
  }
  let sends = 0;
  const admitted = new AiOrchestrator({
    gatewayClient:{async complete(){sends++;return {
      text:'verified',provider:'openai-compatible',model:'fixture',
      endpointId:'account.endpoint',usage:{inputTokens:1,outputTokens:1,totalTokens:2},
    };}},
    providerCallLifecycle:{
      async beforeProviderCall(){return {reservationId:'account-bound-job:reservation:2'};},
      async afterProviderCall(){return {settled:true};},
    },
  });
  const response=await admitted.run(JSON.parse(JSON.stringify(owner)),{},'approved after restart',options);
  assert.equal(response.text,'verified');
  assert.equal(response.routing.selectedRouteId,'account.bound');
  assert.equal(sends,1);
});

test('Plan4 S1: direct gateway dispatch never aliases provider/model identities after cold restart', async () => {
  let outbound = 0;
  const sent = [];
  const gateway = new AiGatewayClient({fetchFn:async (url, init) => {
    outbound += 1;
    sent.push({url, body:init.body});
    return {
      ok:true, status:200, headers:{get:()=>null},
      text:async () => JSON.stringify({text:'verified',models:[]}),
    };
  }});
  const base = {provider:'ollama',model:'namespace/model:v1',prompt:'approved fixture'};
  const invalidIds = [null, undefined, 7, false, {}, [], new String('ollama'),
    '', ' ', ' ollama', 'ollama ', '\tollama', 'ollama\n', 'x'.repeat(81)];
  for (const invalid of invalidIds) {
    for (const persisted of [false, true]) {
      // undefined is not JSON-serializable; boxed String serializes to a
      // different primitive identity and is not a persisted-invalid case.
      if (persisted && (invalid === undefined || invalid instanceof String)) continue;
      const value = persisted ? JSON.parse(JSON.stringify(invalid)) : invalid;
      await assert.rejects(gateway.complete({...base,provider:value}), /AI provider must be an exact bounded identity/);
      await assert.rejects(gateway.listModels({provider:value}), /AI provider must be an exact bounded identity/);
    }
  }
  for (const invalid of [null, undefined, 7, false, {}, [], new String('model'),
    '', ' ', ' name', 'name ', 'model\t', 'model\n', 'x'.repeat(301)]) {
    for (const persisted of [false, true]) {
      // undefined is not JSON-serializable; boxed String serializes to a
      // different primitive identity and is not a persisted-invalid case.
      if (persisted && (invalid === undefined || invalid instanceof String)) continue;
      const value = persisted ? JSON.parse(JSON.stringify(invalid)) : invalid;
      await assert.rejects(gateway.complete({...base,model:value}), /AI model must be an exact bounded identity/);
    }
  }
  assert.equal(outbound,0,'invalid provider/model identities cannot reach the network');
  const restarted = JSON.parse(JSON.stringify(base));
  const completion = await gateway.complete(restarted);
  await gateway.listModels({provider:restarted.provider});
  assert.equal(completion.text,'verified');
  assert.equal(outbound,2);
  assert.equal(JSON.parse(sent[0].body).provider,restarted.provider);
  assert.equal(JSON.parse(sent[0].body).model,restarted.model);
  assert.match(sent[1].url,/provider=ollama/);
});

test('Plan4 S1: endpoint model catalog remains exact and immutable across JSON restart', async () => {
  const bound = {
    schemaVersion:1, registryRevision:9,
    routes:[{...route, endpointId:'local-model-1'}],
    endpointProfiles:[{...endpoint, endpointId:'local-model-1', modelIds:['llama3']}],
  };
  const admitted = await createAiRouteRegistryEvidenceV1(bound);
  const restored = await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(bound)));
  assert.equal(admitted.configSha256, restored.configSha256);
  assert.equal(admitted.routeIdentities[0].endpointBinding,'MATCHED');
  assert.deepEqual(admitted.endpointProfiles[0].modelIds,['llama3']);
  assert.equal(Object.isFrozen(admitted.endpointProfiles[0].modelIds),true);
  for (const invalid of [
    [], ['other-model'], [' llama3'], ['llama3 '], ['llama3','llama3'],
    null, false, 0, 'llama3',
  ]) {
    const mismatch = {...bound,endpointProfiles:[{...bound.endpointProfiles[0],modelIds:invalid}]};
    for (const value of [mismatch,JSON.parse(JSON.stringify(mismatch))]) {
      await assert.rejects(createAiRouteRegistryEvidenceV1(value),
        /modelIds|model is absent|bounded array|exact bounded identifier|duplicates/);
    }
  }
  const legacy = {...bound,routes:[{...route}],endpointProfiles:[endpoint]};
  // No endpoint model claim is invented in a legacy unbound profile.
  assert.equal((await createAiRouteRegistryEvidenceV1(legacy)).routeIdentities[0].endpointBinding,
    'UNRESOLVED_LEGACY');
  const withoutCatalog = {...bound,endpointProfiles:[{...endpoint,endpointId:'local-model-1'}]};
  const legacyBound = await createAiRouteRegistryEvidenceV1(withoutCatalog);
  assert.equal(legacyBound.routeIdentities[0].endpointBinding,'MATCHED');
  assert.equal(Object.hasOwn(legacyBound.endpointProfiles[0],'modelIds'),false);
  assert.notEqual(admitted.configSha256,legacyBound.configSha256);
});


test('Plan4 S1 endpoint catalog accepts the same exact safe Unicode model identity as its route', async () => {
  const multilingual = 'модель/ο3-🚀';
  const input = {
    schemaVersion:1, registryRevision:22,
    routes:[{...route, model:multilingual, endpointId:'local-unicode-1'}],
    endpointProfiles:[{...endpoint, endpointId:'local-unicode-1', modelIds:[multilingual]}],
  };
  const live = await createAiRouteRegistryEvidenceV1(input);
  const cold = await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(input)));
  assert.equal(live.routeIdentities[0].endpointBinding,'MATCHED');
  assert.equal(live.routeIdentities[0].model,multilingual);
  assert.deepEqual(live.endpointProfiles[0].modelIds,[multilingual]);
  assert.equal(Object.isFrozen(live.endpointProfiles[0].modelIds),true);
  assert.equal(live.configSha256,cold.configSha256);
  assert.match(live.configSha256,/^[a-f0-9]{64}$/);

  // Catalog identity is neither coerced to ASCII nor trimmed into another
  // authorized model; malformed characters are rejected before any effect.
  const unsafe = [
    ' ' + multilingual, multilingual + ' ',
    multilingual + '\n', multilingual + '\u202e', multilingual + '\ud800',
    '', 0, {}, null,
  ];
  for (const modelId of unsafe) {
    const corrupted = {...input,endpointProfiles:[{...input.endpointProfiles[0], modelIds:[modelId]}]};
    await assert.rejects(createAiRouteRegistryEvidenceV1(corrupted),/modelIds|model identity/);
    if (typeof modelId === 'string' && !modelId.includes('\ud800')) {
      await assert.rejects(createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(corrupted))),/modelIds|model identity/);
    }
  }
  const duplicates = {...input,endpointProfiles:[{...input.endpointProfiles[0],modelIds:[multilingual,multilingual]}]};
  await assert.rejects(createAiRouteRegistryEvidenceV1(duplicates),/duplicates/);
  await assert.rejects(createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(duplicates))),/duplicates/);
  const notAuthorized = {...input, endpointProfiles:[{...endpoint,endpointId:'local-unicode-1',modelIds:['інша-модель']}]};
  await assert.rejects(createAiRouteRegistryEvidenceV1(notAuthorized),/model is absent/);
});

test('Plan4 S1 model identity rejects controls, bidi and invalid Unicode before network and after JSON restart', async () => {
  let effects = 0;
  const router = new AiOrchestrator({ gatewayClient: { async complete() {
    effects++;
    throw new Error('unexpected provider effect');
  } } });
  const dangerous = [0, 10, 13, 127, 0x80, 0x61c, 0x200e, 0x202e, 0x2028, 0x2066, 0xd800, 0xdc00];
  for (const codePoint of dangerous) {
    const corrupted = [{...route, model:'fixture' + String.fromCharCode(codePoint) + 'injected'}];
    for (const persisted of [corrupted, JSON.parse(JSON.stringify(corrupted))]) {
      assert.throws(() => normalizeAiRoutePool(persisted), /exact bounded identity/);
      assert.throws(() => normalizeAiRouterSettings({enabled:true, mode:'primary', routes:persisted}),
        /exact bounded identity/);
      await assert.rejects(router.run({enabled:true, mode:'primary', routes:persisted}, {}, 'approved prompt'),
        /exact bounded identity/);
      await assert.rejects(createAiRouteRegistryEvidenceV1({...snapshot, routes:persisted}),
        /exact bounded identity/);
    }
  }
  assert.equal(effects, 0);
  // Preserve actual Unicode model IDs, including valid surrogate pairs, unchanged.
  const accepted = {...route, model:'family/модель-测试-🤖'};
  assert.equal(normalizeAiRoutePool(JSON.parse(JSON.stringify([accepted])))[0].model, accepted.model);
  const first = await createAiRouteRegistryEvidenceV1({...snapshot, routes:[accepted]});
  const restarted = await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify({...snapshot, routes:[accepted]})));
  assert.equal(first.configSha256, restarted.configSha256);
});


test('Plan4 S1: durable settlement requires explicit data receipt before publication or failover', async () => {
  const owner=JSON.parse(JSON.stringify({
    enabled:true,mode:'primary',fallbackToStrongOnPrimaryError:true,
    primary:{provider:'openai-compatible',model:'fixture'},
    routePolicy:{autoSwitch:true},
    routes:[
      {routeId:'primary',provider:'openai-compatible',model:'fixture',locality:'local',costClass:'free',priority:10},
      {routeId:'backup',provider:'openai-compatible',model:'backup',locality:'local',costClass:'free',priority:1},
    ],
  }));
  const context={kind:'browser-agent',jobId:'explicit-settlement',controlEpoch:1};
  const options={providerCallBudgetContext:context,maxOutputTokens:128,maxModelCallsForRequest:2};
  const invalidReceipts=[undefined,null,false,{}, {settled:false}, {settled:0},
    Object.defineProperty({},'settled',{enumerable:true,get(){throw new Error('private-ledger-token');}}),
  ];
  for (const transportFails of [false,true]) {
    for (const receipt of invalidReceipts) {
      let sends=0;
      let settlements=0;
      const router=new AiOrchestrator({
        gatewayClient:{async complete(){
          sends++;
          if (transportFails) throw new Error('provider transient failure');
          return {text:'must-not-publish',provider:'openai-compatible',model:'fixture'};
        }},
        providerCallLifecycle:{
          async beforeProviderCall(){return {reservationId:'explicit-settlement:1'};},
          async afterProviderCall(){settlements++;return receipt;},
        },
      });
      await assert.rejects(router.run(JSON.parse(JSON.stringify(owner)),{},'approved',options),
        error=>error.code==='AI_MODEL_BUDGET_SETTLEMENT_UNKNOWN'
          && error.routeAttempts?.[0]?.outcome==='UNKNOWN'
          && !String(error.message).includes('private-ledger-token'));
      assert.equal(sends,1,'UNKNOWN must never invoke backup provider');
      assert.equal(settlements,1,'one attempted effect must have one settlement call');
    }
  }
  let sends=0;
  const admitted=new AiOrchestrator({
    gatewayClient:{async complete(){sends++;return {text:'verified',provider:'openai-compatible',model:'fixture'};}},
    providerCallLifecycle:{
      async beforeProviderCall(){return {reservationId:'explicit-settlement:2'};},
      async afterProviderCall(){return {settled:true};},
    },
  });
  const response=await admitted.run(JSON.parse(JSON.stringify(owner)),{},'approved',options);
  assert.equal(response.text,'verified');
  assert.equal(sends,1);
});


test('Plan4 S1: ambiguous pre-header completion effects never fail over or leak transport diagnostics', async () => {
  let effects=0;
  const gateway=new AiGatewayClient({fetchFn:async (_url,init) => {
    assert.equal(init.method,'POST');
    effects++;
    throw Object.assign(new Error('sk-private-lost-connection'),{name:'AbortError'});
  }});
  const candidates=[
    {routeId:'local.main',provider:'ollama',model:'fixture-a',locality:'local',priority:2},
    {routeId:'local.backup',provider:'ollama',model:'fixture-b',locality:'local',priority:1},
  ];
  const router=new AiOrchestrator({gatewayClient:gateway});
  const owner={enabled:true,mode:'primary',routes:candidates,routePolicy:{autoSwitch:true}};
  await assert.rejects(router.run(JSON.parse(JSON.stringify(owner)),{},'approved instruction',
    {maxModelCallsForRequest:2}),error=>
    error.code==='AI_GATEWAY_RESPONSE_UNVERIFIED'
      && error.modelCallsUsed===1
      && error.routeAttempts?.length===1
      && error.routeAttempts[0].routeId==='local.main'
      && !String(error.message).includes('sk-private-lost-connection'));
  assert.equal(effects,1,'unknown first effect cannot dispatch the backup');
});

test('Plan4 S1: pre-header errors stay UNKNOWN for POST; read-only probes remain retryable', async () => {
  for(const failure of [new Error('sk-private-network'),Object.assign(new Error('sk-private-deadline'),{name:'AbortError'})]){
    let requests=0;
    const gateway=new AiGatewayClient({fetchFn:async()=>{requests++;throw failure;}});
    const request=JSON.parse(JSON.stringify({provider:'ollama',model:'fixture',prompt:'approved'}));
    await assert.rejects(gateway.complete(request),error=>
      error.code==='AI_GATEWAY_RESPONSE_UNVERIFIED'
      && error.category==='UNAVAILABLE'
      && error.retryable===false
      && !error.message.includes('sk-private'));
    assert.equal(requests,1);
  }
  const readOnly=new AiGatewayClient({fetchFn:async()=>{throw Object.assign(
    new Error('sk-private-probe'),{name:'AbortError'});}});
  await assert.rejects(readOnly.health({timeoutSeconds:5}),error=>
    error.code==='AI_GATEWAY_TIMEOUT' && error.category==='TIMEOUT'
    && error.retryable===true && !error.message.includes('sk-private'));
});


test('Plan4 S1: legacy slots and direct gateway reject hostile Unicode identities without network or fallback', async () => {
  let outbound = 0;
  const gateway = new AiGatewayClient({fetchFn:async () => {
    outbound += 1;
    return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({text:'verified'})};
  }});
  const owner = {enabled:true,mode:'primary',
    primary:{provider:'ollama',model:'fixture'},fallbackToStrongOnPrimaryError:true};
  const dangerous = [0,10,127,0x80,0x61c,0x200e,0x202e,0x2028,0x2066,0xd800,0xdc00];
  for (const point of dangerous) {
    const hostile = 'model-' + String.fromCharCode(point) + '-identity';
    for (const model of [hostile,JSON.parse(JSON.stringify(hostile))]) {
      assert.throws(()=>normalizeAiRouterSettings({...owner,primary:{provider:'ollama',model}}),
        /AI model slot name must be exact trimmed text/);
      assert.throws(()=>normalizeAiRouterSettings({...owner,strong:{provider:'openai',model}}),
        /AI model slot name must be exact trimmed text/);
      await assert.rejects(gateway.complete({provider:'ollama',model,prompt:'approved'}),
        /AI model must be an exact bounded identity/);
    }
    for (const provider of [hostile,JSON.parse(JSON.stringify(hostile))]) {
      await assert.rejects(gateway.complete({provider,model:'fixture',prompt:'approved'}),
        /AI provider must be an exact bounded identity/);
      await assert.rejects(gateway.listModels({provider}),
        /AI provider must be an exact bounded identity/);
    }
  }
  assert.equal(outbound,0,'malformed identity must be rejected before model/health transport');
});

test('Plan4 S1: verified Unicode model identity remains unchanged in legacy-slot and gateway dispatch', async () => {
  const good = 'Київ/模型:v2';
  const owner = JSON.parse(JSON.stringify({enabled:true,mode:'primary',
    primary:{provider:'ollama',model:good},fallbackToStrongOnPrimaryError:false}));
  assert.equal(normalizeAiRouterSettings(owner).primary.model,good);
  const sent = [];
  const gateway = new AiGatewayClient({fetchFn:async (url,init) => {
    sent.push({url,body:JSON.parse(init.body)});
    return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({text:'verified'})};
  }});
  const completed = await gateway.complete({provider:'ollama',model:good,prompt:'approved'});
  assert.equal(completed.text,'verified');
  assert.equal(sent.length,1);
  assert.equal(sent[0].body.model,good);
  let modelCalls=0;
  const router = new AiOrchestrator({gatewayClient:{async complete(request) {
    modelCalls += 1;
    assert.equal(request.model,good);
    return {text:'verified',provider:'ollama',model:good};
  }}});
  const routed=await router.run(owner,{},'approved');
  assert.equal(routed.text,'verified');
  assert.equal(modelCalls,1);
});


test('Plan4 S1 endpoint evidence round-trips canonical origin through JSON cold restart', async () => {
  // Regression: the original normalizer accepted a canonical origin ending in
  // '/' but emitted parsed.origin without '/', so its own evidence failed
  // validation on the next cold restart.
  for (const candidate of [
    {
      boundRoute: {...route,endpointId:'local.loopback'},
      boundEndpoint: {...endpoint,endpointId:'local.loopback'},
    },
    {
      boundRoute: {routeId:'remote',provider:'openai-compatible',model:'fixture',
        endpointId:'remote.compatible',locality:'remote'},
      boundEndpoint: {schemaVersion:1,profileId:'remote.profile',
        provider:'openai-compatible',endpointId:'remote.compatible',
        locality:'remote',origin:'https://models.example/',
        credentialRef:'opaque.remote',credentialless:false,accountId:'account.fixture',
        modelIds:['fixture']},
    },
  ]) {
    const owner = {schemaVersion:1,registryRevision:4,
      routes:[candidate.boundRoute],endpointProfiles:[candidate.boundEndpoint]};
    const before = await createAiRouteRegistryEvidenceV1(JSON.parse(JSON.stringify(owner)));
    assert.equal(before.endpointProfiles[0].origin,candidate.boundEndpoint.origin);
    assert.equal(before.routeIdentities[0].endpointBinding,'MATCHED');
    const restarted = JSON.parse(JSON.stringify({
      ...owner, endpointProfiles:before.endpointProfiles,
    }));
    const after = await createAiRouteRegistryEvidenceV1(restarted);
    assert.equal(after.configSha256,before.configSha256,
      'evidence hash must be identical after persisted normalized-profile reload');
    assert.equal(after.endpointProfiles[0].origin,candidate.boundEndpoint.origin);
    assert.equal(after.routeIdentities[0].endpointBinding,'MATCHED');
    for (const origin of [
      candidate.boundEndpoint.origin.slice(0,-1),
      candidate.boundEndpoint.origin + '?token=private',
      candidate.boundEndpoint.origin + '#private',
    ]) {
      await assert.rejects(
        createAiRouteRegistryEvidenceV1({
          ...restarted,
          endpointProfiles:[{...restarted.endpointProfiles[0],origin}],
        }),/AI endpoint origin/,
        'noncanonical or secret-bearing origin must fail closed');
    }
  }
});

test('Plan4 S1 owner no-auto-switch never selects an alternative during durable backoff; restart and recovery', async () => {
  const primary = {...route, priority:100};
  const secondary = {...route, routeId:'secondary', model:'llama-alternative', priority:1};
  const routes = [primary, secondary];
  const routeStates = {primary:{backoffUntil:10_000}};
  const policy = {autoSwitch:false};
  const selected = selectAiRouteCandidates({routes, policy, routeStates, now:100});
  assert.deepEqual(selected.eligibleRouteIds, ['primary','secondary']);
  assert.deepEqual(selected.candidates, []);
  assert.equal(selected.retryAt,10_000);

  const cold = JSON.parse(JSON.stringify({routes,policy,routeStates}));
  const restored = selectAiRouteCandidates({...cold,now:100});
  assert.deepEqual(restored.candidates, []);
  assert.equal(restored.retryAt,10_000);
  assert.deepEqual(selectAiRouteCandidates({routes,policy:{autoSwitch:true},routeStates,now:100})
    .candidates.map(item => item.routeId),['secondary']);

  let providerCalls=0;
  const gatewayClient = {async complete(request) {
    providerCalls += 1;
    return {text:'fixture result', provider:request.provider, model:request.model,
      usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
  }};
  const guarded = new AiOrchestrator({gatewayClient,now:()=>100});
  const routerSettings = {enabled:true,mode:'primary',routes,
    routePolicy:policy,fallbackToStrongOnPrimaryError:false};
  await assert.rejects(
    guarded.run(routerSettings,{routeStates:cold.routeStates},'approved fixture prompt'),
    error => error.code === 'AI_ROUTE_POOL_EXHAUSTED' && error.retryAt === 10_000,
  );
  assert.equal(providerCalls,0,'no provider or alternate model may be called during owner-pinned backoff');

  const recovered = new AiOrchestrator({gatewayClient,now:()=>10_000});
  const result = await recovered.run(JSON.parse(JSON.stringify(routerSettings)),
    {routeStates:JSON.parse(JSON.stringify(routeStates))},'approved fixture prompt');
  assert.equal(providerCalls,1);
  assert.equal(result.routing.selectedRouteId,'primary');
  assert.equal(result.routing.selectedModel,'llama3');
});
