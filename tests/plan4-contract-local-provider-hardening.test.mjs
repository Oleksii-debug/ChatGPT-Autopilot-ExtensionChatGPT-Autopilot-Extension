import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAiRoutePool, createAiRouteRegistryEvidenceV1 } from '../src/core/ai-route-pool.js';
import { LocalAiClient, normalizeLocalAiSettings, normalizeLocalAiBaseUrl, normalizeLocalAiUsage } from '../src/core/local-ai-provider.js';

const route = { routeId:'primary', provider:'ollama', model:'llama3', locality:'local' };
const endpoint = { schemaVersion:1, profileId:'local.ollama', provider:'ollama', endpointId:'', locality:'local', origin:'http://127.0.0.1:11434/', credentialRef:'', credentialless:true };
const snapshot = { schemaVersion:1, registryRevision:4, routes:[route], endpointProfiles:[endpoint] };
const settings = { enabled:true, providerType:'ollama', model:'llama3', baseUrl:'http://127.0.0.1:11434', timeoutSeconds:5 };

test('route migration accepts versionless v1 and rejects unknown versions', () => {
  assert.equal(normalizeAiRoutePool([route])[0].schemaVersion,1);
  assert.throws(() => normalizeAiRoutePool([{...route,schemaVersion:'1'}]));
  assert.throws(() => normalizeAiRoutePool([{...route,schemaVersion:2}]));
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
