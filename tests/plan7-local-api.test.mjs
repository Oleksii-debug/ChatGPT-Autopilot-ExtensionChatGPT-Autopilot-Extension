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


test('local API ingress suppresses overlapping same-ID SDK clients before second Core dispatch', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  let enteredDispatch, releaseDispatch;
  const entered = new Promise(resolve => { enteredDispatch = resolve; });
  const heldDispatch = new Promise(resolve => { releaseDispatch = resolve; });
  const deps = dependencies(counters);
  const delegate = deps.dispatchCanonicalControl;
  deps.dispatchCanonicalControl = async args => {
    const receipt = delegate(args);
    enteredDispatch();
    await heldDispatch;
    return receipt;
  };
  await withServer(async port => {
    const first = createAutopilotLocalClientV1({ token: TOKEN, port });
    const second = createAutopilotLocalClientV1({ token: TOKEN, port });
    const firstPromise = first.control(request('multi-client-race-1'));
    try {
      await entered;
      const duplicate = await second.control(request('multi-client-race-1'));
      assert.equal(duplicate.status, 'UNKNOWN_NETWORK_RESULT');
      assert.equal(duplicate.httpStatus, 409);
      assert.equal(counters.scopes, 1);
      assert.equal(counters.dispatches, 1);
    } finally {
      releaseDispatch();
    }
    const response = await firstPromise;
    assert.equal(response.status, 'RECEIVED');
  }, deps);
  assert.deepEqual(counters, { scopes: 1, dispatches: 1 });
});

test('local API concurrent distinct IDs preserve independent canonical dispatch', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  await withServer(async port => {
    const first = createAutopilotLocalClientV1({ token: TOKEN, port });
    const second = createAutopilotLocalClientV1({ token: TOKEN, port });
    const [one, two] = await Promise.all([
      first.control(request('multi-client-a')),
      second.control(request('multi-client-b')),
    ]);
    assert.equal(one.status, 'RECEIVED');
    assert.equal(two.status, 'RECEIVED');
  }, dependencies(counters));
  assert.deepEqual(counters, { scopes: 2, dispatches: 2 });
});


test('owner-injected token rotation revokes the old credential without Core dispatch', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  const freshToken = 'next-owner-credential-test-only-'.repeat(3);
  let activeToken = TOKEN;
  let lookups = 0;
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => {
      lookups += 1;
      return activeToken;
    },
    dependencies: dependencies(counters),
  });
  try {
    const port = server.address().port;
    const oldClient = createAutopilotLocalClientV1({ token: TOKEN, port });
    assert.equal((await oldClient.control(request('rotation-initial'))).status, 'RECEIVED');
    activeToken = freshToken;
    const retired = await oldClient.control(request('rotation-retired'));
    assert.equal(retired.status, 'UNKNOWN_NETWORK_RESULT');
    assert.equal(retired.httpStatus, 401);
    const currentClient = createAutopilotLocalClientV1({ token: freshToken, port });
    assert.equal((await currentClient.control(request('rotation-current'))).status, 'RECEIVED');
    activeToken = null;
    const missing = await currentClient.control(request('rotation-missing'));
    assert.equal(missing.status, 'UNKNOWN_NETWORK_RESULT');
    assert.equal(missing.httpStatus, 401);
    assert.deepEqual(counters, { scopes: 2, dispatches: 2 });
    assert.equal(lookups, 4);
  } finally {
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});

test('token rotation provider exceptions and conflicting static fallback fail closed', async () => {
  assert.throws(() => createAutopilotLocalApiServerV1({
    token: TOKEN, tokenProvider: () => TOKEN, dependencies: dependencies(),
  }), /either a static token or a trusted tokenProvider/u);
  const counters = { scopes: 0, dispatches: 0 };
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => { throw new Error('private owner credential failure'); },
    dependencies: dependencies(counters),
  });
  try {
    const client = createAutopilotLocalClientV1({ token: TOKEN, port: server.address().port });
    const result = await client.control(request('rotation-provider-error'));
    assert.equal(result.status, 'UNKNOWN_NETWORK_RESULT');
    assert.equal(result.httpStatus, 401);
    assert.equal(JSON.stringify(result).includes('private owner credential'), false);
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 });
  } finally {
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});


test('malformed bearer credentials never invoke the trusted owner token resolver', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  let tokenLookups = 0;
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => { tokenLookups += 1; return TOKEN; },
    dependencies: dependencies(counters),
  });
  try {
    const port = server.address().port;
    for (const credential of ['', 'short', 'x'.repeat(513)]) {
      const res = await fetch('http://127.0.0.1:' + port + '/v1/control', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
        body: JSON.stringify(request('bad-token-' + credential.length)),
      });
      assert.equal(res.status, 401);
    }
    assert.equal(tokenLookups, 0, 'bad bearer syntax must not touch the owner credential broker');
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 });
    const valid = createAutopilotLocalClientV1({ token: TOKEN, port });
    assert.equal((await valid.control(request('after-invalid-token'))).status, 'RECEIVED');
    assert.equal(tokenLookups, 1);
    assert.deepEqual(counters, { scopes: 1, dispatches: 1 });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('owner token resolver timeout fails closed and a late resolution cannot dispatch', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  let unlock, activeProvider = () => new Promise(resolve => { unlock = resolve; });
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: () => activeProvider(),
    dependencies: dependencies(counters),
  });
  try {
    const client = createAutopilotLocalClientV1({ token: TOKEN, port: server.address().port });
    const ambiguous = await client.control(request('hung-provider-no-dispatch'));
    assert.equal(ambiguous.status, 'UNKNOWN_NETWORK_RESULT');
    assert.equal(ambiguous.httpStatus, 401);
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 });
    unlock(TOKEN);
    await Promise.resolve();
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 },
      'late token cannot authorize the already denied HTTP request');
    activeProvider = async () => TOKEN;
    assert.equal((await client.control(request('provider-recovers-next-request'))).status, 'RECEIVED');
    assert.deepEqual(counters, { scopes: 1, dispatches: 1 });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});


test('Local API pins canonical Core scope/dispatch/clock despite owner object mutation', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  const original = dependencies(counters);
  let swappedScope = 0, swappedDispatch = 0, swappedClock = 0;
  await withServer(async port => {
    // Attacker/accidental mutation of an injected container after listen
    // must not replace the functions admitted during Companion creation.
    original.resolveTrustedScope = () => {
      swappedScope += 1;
      throw new Error('UNTRUSTED_SCOPE_REPLACEMENT');
    };
    original.dispatchCanonicalControl = () => {
      swappedDispatch += 1;
      throw new Error('UNTRUSTED_EFFECT_DISPATCH_REPLACEMENT');
    };
    original.now = () => {
      swappedClock += 1;
      throw new Error('UNTRUSTED_CLOCK_REPLACEMENT');
    };
    const client = createAutopilotLocalClientV1({ token: TOKEN, port });
    for (const id of ['pinned-core-1', 'pinned-core-2']) {
      const answer = await client.control(request(id));
      assert.equal(answer.status, 'RECEIVED');
      assert.equal(answer.result.adapterGrantsAuthority, false);
      assert.equal(answer.result.exactEffectAuthority, false);
    }
  }, original);
  assert.deepEqual(counters, { scopes: 2, dispatches: 2 });
  assert.deepEqual([swappedScope, swappedDispatch, swappedClock], [0, 0, 0],
    'post-construction dependency replacement must never gain control authority');
});

test('Local API refuses accessor, inherited, symbol and Proxy dependency injection before listen', () => {
  const base = dependencies();
  let getterCalls = 0;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'dispatchCanonicalControl', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('SECRET_DEPENDENCY_GETTER');
    },
  });
  const symbol = { ...base };
  symbol[Symbol('extra authority')] = () => {};
  const inherited = Object.create({
    dispatchCanonicalControl: base.dispatchCanonicalControl,
  });
  inherited.now = base.now;
  inherited.resolveTrustedScope = base.resolveTrustedScope;
  const extra = { ...base, grantEffects: () => true };
  const hidden = { ...base };
  Object.defineProperty(hidden, 'hiddenCredential', { value: 'DO_NOT_DISCLOSE' });
  let proxyGets = 0;
  const hostile = new Proxy({ ...base }, {
    get() {
      proxyGets += 1;
      throw new Error('SECRET_DEPENDENCY_GET_TRAP');
    },
  });
  const trapped = new Proxy({ ...base }, {
    ownKeys() {
      throw new Error('SECRET_DEPENDENCY_OWNKEYS_TRAP');
    },
  });
  for (const input of [accessor, symbol, inherited, extra, hidden, trapped]) {
    assert.throws(() => createAutopilotLocalApiServerV1({
      token: TOKEN, dependencies: input,
    }), /Trusted canonical control dependencies/u);
  }
  const server = createAutopilotLocalApiServerV1({
    token: TOKEN, dependencies: hostile,
  });
  assert.equal(proxyGets, 0, 'admitted data descriptors cannot execute Proxy get');
  server.close();
  assert.equal(getterCalls, 0, 'malicious getter must not execute');
  assert.equal(proxyGets, 0, 'admission must pin descriptor values without property reads');
});
