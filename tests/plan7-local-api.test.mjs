import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
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
    const rebindingStatus=await new Promise((resolve,reject)=>{
      const raw=httpRequest({hostname:'127.0.0.1',port,path:'/v1/control',method:'POST',
        headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',
          Host:'attacker.invalid'}},res=>{
        res.resume();res.on('end',()=>resolve(res.statusCode));
      });
      raw.once('error',reject);
      raw.end(JSON.stringify(request()));
    });
    assert.equal(rebindingStatus,403);
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


test('server-after-dispatch receipt failure remains ambiguous and never auto-resends', async () => {
  let effects=0;
  const broken = dependencies();
  broken.dispatchCanonicalControl = () => { effects += 1; throw new Error('private provider failure'); };
  await withServer(async port => {
    const client=createAutopilotLocalClientV1({token:TOKEN,port});
    const first=await client.control(request('uncertain-http-request'));
    assert.equal(first.status,'UNKNOWN_NETWORK_RESULT');
    assert.equal(first.httpStatus,422);
    assert.equal(effects,1);
    assert.equal(JSON.stringify(first).includes('private'),false);
  },broken);
});

test('transport cannot treat any non-2xx response as proof an effect did not occur', async () => {
  let invocations=0;
  const client=createAutopilotLocalClientV1({token:TOKEN,port:12345,fetchImpl:async()=>{
    invocations++;
    return {ok:false,status:500};
  }});
  const value=await client.control(request('mutating-request-1'));
  assert.equal(value.status,'UNKNOWN_NETWORK_RESULT');
  assert.equal(value.httpStatus,500);
  assert.equal(invocations,1);
});


test('SDK rejects extra, accessor, symbol and nonenumerable transport envelope fields before RECEIVED', async () => {
  await withServer(async port => {
    const originalRequest = request('envelope-shape-1');
    const raw = await fetch('http://127.0.0.1:' + port + '/v1/control', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(originalRequest),
    });
    assert.equal(raw.ok, true);
    const valid = await raw.json();
    let getterCalls = 0;
    const mutations = [
      value => ({ ...value, unexpectedCredential: 'DO_NOT_EXPOSE' }),
      value => ({ ...value, result: { ...value.result, grantAuthority: true } }),
      value => ({ ...value, result: {
        ...value.result, request: { ...value.result.request, hiddenToken: 'DO_NOT_EXPOSE' },
      } }),
      value => ({ ...value, result: {
        ...value.result, scopeProof: { ...value.result.scopeProof, bypass: true },
      } }),
      value => ({ ...value, result: {
        ...value.result, receipt: { ...value.result.receipt, retry: true },
      } }),
      value => {
        const copy = { ...value };
        copy[Symbol('injected')] = true;
        return copy;
      },
      value => {
        const copy = { ...value };
        Object.defineProperty(copy, 'hidden', { value: 'DO_NOT_EXPOSE' });
        return copy;
      },
      value => {
        const copy = { ...value, result: { ...value.result } };
        Object.defineProperty(copy.result, 'receipt', {
          enumerable: true,
          get() { getterCalls += 1; return value.result.receipt; },
        });
        return copy;
      },
    ];
    let calls = 0;
    for (const mutate of mutations) {
      const forged = mutate(valid);
      const client = createAutopilotLocalClientV1({
        token: TOKEN, port, fetchImpl: async () => {
          calls += 1;
          return { ok: true, json: async () => forged };
        },
      });
      const answer = await client.control(originalRequest);
      assert.equal(answer.status, 'UNKNOWN_NETWORK_RESULT');
      assert.equal(JSON.stringify(answer).includes('DO_NOT_EXPOSE'), false);
      assert.equal(JSON.stringify(answer).includes('SECRET_GETTER_EXECUTED'), false);
    }
    assert.equal(calls, mutations.length, 'no automatic resends after forged receipts');
    assert.equal(getterCalls, 0, 'accessors must never run during transport response validation');
    const correct = createAutopilotLocalClientV1({
      token: TOKEN, port, fetchImpl: async () => ({ ok: true, json: async () => valid }),
    });
    assert.equal((await correct.control(originalRequest)).status, 'RECEIVED');
  });
});

test('SDK binds read-only vs mutating receipt classification to canonical operation', async () => {
  await withServer(async port => {
    const originalRequest = request('classification-1');
    const raw = await fetch('http://127.0.0.1:' + port + '/v1/control', {
      method:'POST',
      headers:{Authorization:'Bearer ' + TOKEN,'Content-Type':'application/json'},
      body:JSON.stringify(originalRequest),
    });
    assert.equal(raw.ok,true);
    const valid = await raw.json();
    assert.equal(valid.result.readOnly,true);
    assert.equal(valid.result.downstreamAuthorityRequired,false);
    for (const patch of [
      {readOnly:false},
      {downstreamAuthorityRequired:true},
      {readOnly:false,downstreamAuthorityRequired:true},
    ]) {
      const forged = { ...valid, result:{ ...valid.result, ...patch } };
      let calls=0;
      const client = createAutopilotLocalClientV1({
        token:TOKEN,port,fetchImpl:async()=>{calls++;return {ok:true,json:async()=>forged};},
      });
      assert.equal((await client.control(originalRequest)).status,'UNKNOWN_NETWORK_RESULT');
      assert.equal(calls,1);
    }
  });
});
