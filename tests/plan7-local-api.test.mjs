import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startAutopilotLocalApiLoopbackV1, createAutopilotLocalApiServerV1 } from '../companion/local-api/server.mjs';
import { createAutopilotLocalClientV1 } from '../companion/local-api/client.mjs';

const TOKEN = 'test-only-not-a-real-secret-'.repeat(3);
const AT = '2026-10-08T11:02:00.000Z';

function request(requestId = 'test-request-1') {
  return {
    schemaVersion: 1, requestId, principalId: 'owner-1', projectId: 'project-1',
    operation: 'STATUS_GET', targetId: 'agent-1',
    payloadArtifactRef: null, requestedAt: '2026-10-08T11:00:00.000Z',
  };
}

function dependencies(counters = { scopes: 0, dispatches: 0 }) {
  return {
    now() { return Date.parse(AT); },
    resolveTrustedScope({ request: r }) {
      counters.scopes += 1;
      return {
        schemaVersion: 1, scopeRevisionId: 'revision-1',
        requestId: r.requestId, principalId: r.principalId, projectId: r.projectId,
        operation: r.operation, targetId: r.targetId,
        payloadArtifactId: null, payloadSha256: null, allowed: true,
        verifiedAt: '2026-10-08T11:01:00.000Z',
        validThrough: '2026-10-08T11:05:00.000Z',
      };
    },
    dispatchCanonicalControl({ request: r }) {
      counters.dispatches += 1;
      return {
        schemaVersion: 1, requestId: r.requestId,
        projectId: r.projectId, operation: r.operation,
        dispatchId: 'dispatch-1', status: 'COMPLETED',
        resultArtifactRef: null, observedAt: AT,
      };
    },
  };
}

async function withServer(run, deps = dependencies()) {
  const server = await startAutopilotLocalApiLoopbackV1({ token: TOKEN, dependencies: deps });
  try { return await run(server.address().port); }
  finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

test('Local API is opt-in and rejects missing runtime or short secrets', () => {
  assert.throws(() => createAutopilotLocalApiServerV1(), /high-entropy/u);
  assert.throws(() => createAutopilotLocalApiServerV1({token: TOKEN}), /Trusted canonical/u);
  assert.throws(() => createAutopilotLocalClientV1({token: TOKEN,port:0}), /port/u);
});

test('SDK authenticated loopback request dispatches only through canonical resolver', async () => {
  const counters = {scopes:0, dispatches:0};
  await withServer(async port => {
    const client = createAutopilotLocalClientV1({token:TOKEN,port});
    const result = await client.control(request());
    assert.equal(result.status,'RECEIVED');
    assert.equal(result.result.receipt.status,'COMPLETED');
    assert.equal(result.result.adapterGrantsAuthority,false);
    assert.equal(result.result.executionAuthorized,false);
    assert.equal(result.result.request.requestId,'test-request-1');
  }, dependencies(counters));
  assert.deepEqual(counters,{scopes:1,dispatches:1});
});

test('unauthenticated, wrong-host, origin and preflight requests do not reach Core', async () => {
  const counters={scopes:0, dispatches:0};
  await withServer(async port => {
    const url='http://127.0.0.1:'+port+'/v1/control';
    const noAuth=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request())});
    assert.equal(noAuth.status,401);
    assert.equal(noAuth.headers.get('access-control-allow-origin'),null);
    const wrong=await fetch(url,{method:'POST',headers:{
      Authorization:'Bearer '+'x'.repeat(64),'Content-Type':'application/json'},
      body:JSON.stringify(request())});
    assert.equal(wrong.status,401);
    const injected=await fetch(url,{method:'POST',headers:{
      Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',Origin:'https://attacker.invalid'},
      body:JSON.stringify(request())});
    assert.equal(injected.status,403);
    const preflight=await fetch(url,{method:'OPTIONS',headers:{
      Authorization:'Bearer '+TOKEN,'Access-Control-Request-Method':'POST'}});
    assert.equal(preflight.status,403);
    const rebinding=await fetch(url,{method:'POST',headers:{
      Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',
      Host:'attacker.invalid'},body:JSON.stringify(request())});
    assert.equal(rebinding.status,403);
  },dependencies(counters));
  assert.deepEqual(counters,{scopes:0,dispatches:0});
});

test('oversize, unknown protocol and malformed JSON fail closed without Core effects', async () => {
  const counters={scopes:0,dispatches:0};
  await withServer(async port => {
    const url='http://127.0.0.1:'+port+'/v1/control';
    const headers={Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'};
    const invalid=await fetch(url,{method:'POST',headers,body:'{invalid'});
    assert.equal(invalid.status,422);
    const large=await fetch(url,{method:'POST',headers,body:JSON.stringify({padding:'x'.repeat(66_000)})});
    assert.equal(large.status,413);
    const route=await fetch('http://127.0.0.1:'+port+'/v2/control',{method:'POST',headers,body:'{}'});
    assert.equal(route.status,404);
    const bad=await fetch(url,{method:'POST',headers,body:JSON.stringify({...request(),schemaVersion:2})});
    assert.equal(bad.status,422);
  },dependencies(counters));
  assert.deepEqual(counters,{scopes:0,dispatches:0});
});

test('network uncertainty cannot cause an automatic replay', async () => {
  let dispatches=0;
  const client=createAutopilotLocalClientV1({token:TOKEN,port:12345,fetchImpl:async()=>{
    dispatches+=1;
    throw new Error('secret upstream error');
  }});
  const result=await client.control(request('uncertain-1'));
  assert.equal(result.status,'UNKNOWN_NETWORK_RESULT');
  assert.match(result.instruction,/Reconcile/);
  assert.equal(dispatches,1);
  assert.equal(JSON.stringify(result).includes('secret'),false);
});

test('client rejects forged success response and never treats it as acknowledged', async () => {
  const client=createAutopilotLocalClientV1({token:TOKEN,port:12345,fetchImpl:async()=>({
    ok:true,json:async()=>({schemaVersion:1,status:'RECEIVED',result:{request:{requestId:'wrong'}}}),
  })});
  const result=await client.control(request());
  assert.equal(result.status,'UNKNOWN_NETWORK_RESULT');
});
