import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
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

test('legacy HTTP/1.0 downgrade is denied before owner-token lookup or Core and HTTP/1.1 recovers', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  let tokenLookups = 0;
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => { tokenLookups++; return TOKEN; },
    dependencies: dependencies(counters),
  });
  try {
    const port = server.address().port;
    const body = JSON.stringify(request('http10-must-never-dispatch'));
    const socket = netConnect({ host: '127.0.0.1', port });
    socket.setTimeout(4_000, () => socket.destroy(new Error('legacy HTTP timeout')));
    socket.once('connect', () => socket.write([
      'POST /v1/control HTTP/1.0',
      'Host: 127.0.0.1:' + port,
      'Authorization: Bearer ' + TOKEN,
      'Content-Type: application/json',
      'Content-Length: ' + Buffer.byteLength(body),
      'Connection: close', '', '', 
    ].join('\\r\\n') + body));
    const chunks = [];
    for await (const chunk of socket) chunks.push(chunk);
    const response = Buffer.concat(chunks).toString('utf8');
    assert.match(response, /^HTTP\\/1\\.1 403\\b/u);
    assert.equal(tokenLookups, 0,
      'HTTP downgrade must not invoke trusted credential resolution');
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 },
      'HTTP downgrade must never reach Core authorization or effect dispatch');
    const client = createAutopilotLocalClientV1({ token: TOKEN, port });
    const recovered = await client.control(request('http11-clean-recovery'));
    assert.equal(recovered.status, 'RECEIVED');
    assert.equal(recovered.result.receipt.status, 'COMPLETED');
    assert.equal(tokenLookups, 3);
    assert.deepEqual(counters, { scopes: 1, dispatches: 1 },
      'HTTP/1.1 recovery dispatches through canonical Core only once');
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
});

test('Local API is opt-in and rejects missing runtime or short secrets', () => {
  assert.throws(() => createAutopilotLocalApiServerV1(), /high-entropy/u);
  assert.throws(() => createAutopilotLocalApiServerV1({token: TOKEN}), /Trusted canonical/u);
  assert.throws(() => createAutopilotLocalClientV1({token: TOKEN,port:0}), /port/u);
});

test('Local API listener rejects unsafe bind addresses and ambiguous Node overloads', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  const server = createAutopilotLocalApiServerV1({
    token: TOKEN, dependencies: dependencies(counters),
  });
  // Node's default omitted-host listen() can bind a wildcard socket.
  // A valid bearer must not make such a listener safe to expose.
  for (const args of [
    [0], [0, '0.0.0.0'], [0, '::'], [0, '::1'], [0, 'localhost'],
    [{ port: 0, host: '127.0.0.1' }], [65536, '127.0.0.1'],
    [-1, '127.0.0.1'], ['0', '127.0.0.1'],
  ]) {
    assert.throws(() => server.listen(...args),
      /explicit 127\.0\.0\.1 TCP binding/u);
    assert.equal(server.listening, false);
    assert.equal(server.address(), null);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const client = createAutopilotLocalClientV1({
      token: TOKEN, port: server.address().port,
    });
    const result = await client.control(request('listener-loopback-positive'));
    assert.equal(result.status, 'RECEIVED');
    assert.equal(result.result.receipt.status, 'COMPLETED');
    assert.deepEqual(counters, { scopes: 1, dispatches: 1 });
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
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


test('pre-dispatch slow owner-token lookup cannot dispatch after Core scope expiry, and fresh scope recovers', async () => {
  let clock = Date.parse('2026-10-08T11:02:00.000Z');
  let tokenLookups = 0;
  const counters = { scopes: 0, dispatches: 0 };
  const deps = {
    now() { return clock; },
    resolveTrustedScope({ request: r }) {
      counters.scopes += 1;
      return {
        schemaVersion: 1, scopeRevisionId: 'expiry-bound-scope',
        requestId: r.requestId, principalId: r.principalId,
        projectId: r.projectId, operation: r.operation, targetId: r.targetId,
        payloadArtifactId: null, payloadSha256: null, allowed: true,
        verifiedAt: new Date(clock).toISOString(),
        validThrough: new Date(clock + 1000).toISOString(),
      };
    },
    dispatchCanonicalControl({ request: r }) {
      counters.dispatches += 1;
      return {
        schemaVersion: 1, requestId: r.requestId,
        projectId: r.projectId, operation: r.operation,
        dispatchId: 'expiry-bound-dispatch', status: 'COMPLETED',
        resultArtifactRef: null, observedAt: new Date(clock).toISOString(),
      };
    },
  };
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => {
      tokenLookups += 1;
      // First request's final token lookup completes after the Core proof
      // already expired. Admission and pre-scope checks were both valid.
      if (tokenLookups === 3) clock += 2000;
      return TOKEN;
    },
    dependencies: deps,
  });
  try {
    const client = createAutopilotLocalClientV1({
      token: TOKEN, port: server.address().port,
    });
    const stale = await client.control(request('scope-expires-during-owner-token'));
    assert.equal(stale.status, 'UNKNOWN_NETWORK_RESULT');
    assert.equal(stale.httpStatus, 422);
    assert.equal(tokenLookups, 3);
    assert.deepEqual(counters, { scopes: 1, dispatches: 0 },
      'expired scope must not dispatch an effect or read-only command');
    // A new request obtains a new trusted proof and dispatches exactly once.
    const fresh = await client.control(request('scope-expiry-fresh-recovery'));
    assert.equal(fresh.status, 'RECEIVED');
    assert.equal(fresh.result.receipt.status, 'COMPLETED');
    assert.equal(tokenLookups, 6);
    assert.deepEqual(counters, { scopes: 2, dispatches: 1 });
  } finally {
    await new Promise((resolve, reject) => server.close(
      error => error ? reject(error) : resolve()));
  }
});

test('duplicate Host or Authorization headers fail closed before token lookup or Core dispatch', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  let tokenLookups = 0;
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => { tokenLookups++; return TOKEN; },
    dependencies: dependencies(counters),
  });
  try {
    const port = server.address().port;
    const validHost = '127.0.0.1:' + port;
    const validAuth = 'Bearer ' + TOKEN;
    const invalidAuth = 'Bearer ' + 'x'.repeat(64);
    const cases = [
      ['Host', validHost, 'Authorization', validAuth, 'Authorization', invalidAuth],
      ['Host', validHost, 'Authorization', invalidAuth, 'Authorization', validAuth],
      ['Host', validHost, 'Host', 'attacker.invalid', 'Authorization', validAuth],
      ['Host', 'attacker.invalid', 'Host', validHost, 'Authorization', validAuth],
    ];
    for (const headerFields of cases) {
      const status = await new Promise((resolve, reject) => {
        const raw = httpRequest({
          hostname: '127.0.0.1', port, path: '/v1/control', method: 'POST',
          headers: [...headerFields, 'Content-Type', 'application/json'],
        }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        raw.once('error', reject);
        raw.end(JSON.stringify(request('duplicated-security-header')));
      });
      assert.equal(status, 403);
    }
    assert.equal(tokenLookups, 0, 'ambiguous requests may not consult the owner secret provider');
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 });
    const client = createAutopilotLocalClientV1({ token: TOKEN, port });
    assert.equal((await client.control(request('clean-header-recovery'))).status, 'RECEIVED');
    assert.equal(tokenLookups, 3);
    assert.deepEqual(counters, { scopes: 1, dispatches: 1 });
  } finally {
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});


test('duplicate Content-Type is denied before owner token lookup or canonical Core dispatch', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  let tokenLookups = 0;
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => { tokenLookups += 1; return TOKEN; },
    dependencies: dependencies(counters),
  });
  try {
    const port = server.address().port;
    const duplicateTypes = [
      ['application/json', 'application/json'],
      ['application/json', 'text/plain'],
      ['text/plain', 'application/json'],
    ];
    for (const [first, second] of duplicateTypes) {
      const status = await new Promise((resolve, reject) => {
        const raw = httpRequest({
          hostname: '127.0.0.1', port, path: '/v1/control', method: 'POST',
          headers: [
            'Host', '127.0.0.1:' + port,
            'Authorization', 'Bearer ' + TOKEN,
            'Content-Type', first, 'Content-Type', second,
          ],
        }, res => {
          res.resume();
          res.once('end', () => resolve(res.statusCode));
        });
        raw.once('error', reject);
        raw.end(JSON.stringify(request('duplicate-body-header-' + first + '-' + second)));
      });
      assert.equal(status, 403, 'no intermediary-dependent choice of JSON media type');
    }
    assert.equal(tokenLookups, 0, 'ambiguous body framing must not invoke Companion credentials');
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 });
    const client = createAutopilotLocalClientV1({ token: TOKEN, port });
    const clean = await client.control(request('duplicate-body-header-clean-recovery'));
    assert.equal(clean.status, 'RECEIVED');
    assert.equal(clean.result.receipt.status, 'COMPLETED');
    assert.equal(tokenLookups, 3, 'clean request is authenticated at admission, body, and dispatch');
    assert.deepEqual(counters, { scopes: 1, dispatches: 1 });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('Local API bounds concurrent authenticated slow uploads before owner broker or Core', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  let ownerLookups = 0, notifyFull;
  const allHeld = new Promise(resolve => { notifyFull = resolve; });
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => {
      ownerLookups += 1;
      if (ownerLookups === 64) notifyFull();
      return TOKEN;
    },
    dependencies: dependencies(counters),
  });
  const held = [];
  try {
    const port = server.address().port;
    // Hold headers open without submitting a JSON body. Previously distinct
    // request IDs bypassed the transport's later, Core-only inFlight limit.
    for (let n = 0; n < 64; n += 1) {
      const req = httpRequest({
        hostname: '127.0.0.1', port, path: '/v1/control', method: 'POST',
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
          'Content-Length': '1',
        },
      });
      req.on('error', () => {});
      req.on('response', response => response.resume());
      held.push(req);
      req.flushHeaders();
    }
    let readinessTimer;
    try {
      await Promise.race([
        allHeld,
        new Promise((_, reject) => {
          readinessTimer = setTimeout(
            () => reject(new Error('Local API admission fixtures did not enter')), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(readinessTimer);
    }
    const overload = await fetch('http://127.0.0.1:' + port + '/v1/control', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(request('transport-overload-no-core')),
    });
    assert.equal(overload.status, 503);
    assert.deepEqual(await overload.json(), { schemaVersion: 1, status: 'UNAVAILABLE' });
    assert.equal(ownerLookups, 64, 'overload must be rejected before resolving a 65th token');
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 });
  } finally {
    for (const req of held) req.destroy();
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      const client = createAutopilotLocalClientV1({
        token: TOKEN, port: server.address().port,
      });
      const recovered = await client.control(request('transport-capacity-recovered'));
      assert.equal(recovered.status, 'RECEIVED', 'aborted uploads release admission');
      assert.deepEqual(counters, { scopes: 1, dispatches: 1 });
    } finally {
      await new Promise((resolve, reject) => server.close(
        error => error ? reject(error) : resolve()));
    }
  }
});

test('Expect 100-continue is rejected before pre-auth body upload, token and Core dispatch', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  let tokenLookups = 0;
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => { tokenLookups += 1; return TOKEN; },
    dependencies: dependencies(counters),
  });
  try {
    const port = server.address().port;
    let continueEvents = 0;
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port, path: '/v1/control', method: 'POST',
        headers: {
          Host: '127.0.0.1:' + port,
          Authorization: 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
          Expect: '100-continue',
        },
      }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('continue', () => { continueEvents += 1; });
      req.once('error', reject);
      req.end(JSON.stringify(request('no-continue-auth-leak')));
    });
    assert.equal(status, 417);
    assert.equal(continueEvents, 0, 'pre-auth request must not receive a 100 Continue');
    assert.equal(tokenLookups, 0, 'rejected handshake must not consult owner credential broker');
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 });
    const client = createAutopilotLocalClientV1({ token: TOKEN, port });
    assert.equal((await client.control(request('continue-fence-recovery'))).status, 'RECEIVED');
    assert.equal(tokenLookups, 3);
    assert.deepEqual(counters, { scopes: 1, dispatches: 1 });
  } finally {
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
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


test('SDK rejects mismatched HTTP status even with forged ok=true and a real receipt; fresh request recovers', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  await withServer(async port => {
    for (const [index, forgedStatus] of [401, 204, '200', undefined].entries()) {
      let transfers = 0;
      const fetchImpl = async (...args) => {
        transfers += 1;
        const actual = await fetch(...args);
        assert.equal(actual.status, 200, 'the trusted server did dispatch');
        // A buggy or hostile custom adapter misreports success. Even though
        // a genuine receipt was available, this cannot become SDK RECEIVED.
        return { ok: true, status: forgedStatus, json: () => actual.json() };
      };
      const client = createAutopilotLocalClientV1({ token: TOKEN, port, fetchImpl });
      const result = await client.control(request('forged-http-ok-' + index));
      assert.equal(result.status, 'UNKNOWN_NETWORK_RESULT');
      assert.equal(result.httpStatus, Number.isInteger(forgedStatus) ? forgedStatus : null);
      assert.equal(transfers, 1, 'no blind replay of an ambiguous effect');
      assert.equal(counters.dispatches, index + 1,
        'each intentionally sent test request dispatches exactly once');
    }
    const canonicalClient = createAutopilotLocalClientV1({ token: TOKEN, port });
    const recovered = await canonicalClient.control(request('strict-http-status-recovery'));
    assert.equal(recovered.status, 'RECEIVED');
    assert.equal(recovered.result.receipt.status, 'COMPLETED');
    assert.deepEqual(counters, { scopes: 5, dispatches: 5 });
  }, dependencies(counters));
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
    ok:true, status: 200, json:async()=>({schemaVersion:1,status:'RECEIVED',result:{request:{requestId:'wrong'}}}),
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
          return { ok: true, status: 200, json: async () => forged };
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
      token: TOKEN, port, fetchImpl: async () => ({ ok: true, status: 200, json: async () => valid }),
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
        token:TOKEN,port,fetchImpl:async()=>{calls++;return {ok:true, status: 200, json:async()=>forged};},
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


test('owner token revoked while HTTP body is pending cannot reach canonical Core', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  const newToken = 'post-body-owner-token-replacement-test-'.repeat(2);
  let currentToken = TOKEN;
  let lookups = 0;
  let notifyInitialLookup;
  const firstLookup = new Promise(resolve => { notifyInitialLookup = resolve; });
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => {
      lookups += 1;
      const observed = currentToken;
      if (lookups === 1) notifyInitialLookup();
      return observed;
    },
    dependencies: dependencies(counters),
  });
  try {
    const port = server.address().port;
    const body = JSON.stringify(request('revoked-mid-body'));
    let outgoing;
    const result = new Promise((resolve, reject) => {
      outgoing = httpRequest({
        hostname: '127.0.0.1', port, path: '/v1/control', method: 'POST',
        headers: {
          Host: '127.0.0.1:' + port,
          Authorization: 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          try {
            resolve({ code: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (error) { reject(error); }
        });
      });
      outgoing.once('error', reject);
      outgoing.write(body.slice(0, 12));
    });
    await firstLookup;
    assert.equal(lookups, 1, 'first authentication saw the old current token');
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 });
    currentToken = newToken;
    outgoing.end(body.slice(12));
    const denied = await result;
    assert.equal(denied.code, 401);
    assert.equal(denied.body.status, 'DENIED');
    assert.equal(lookups, 2, 'post-body revocation lookup is mandatory');
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 },
      'a revoked but initially valid bearer cannot enter canonical scope or effects');
    const freshClient = createAutopilotLocalClientV1({ token: newToken, port });
    assert.equal((await freshClient.control(request('revocation-recovery'))).status, 'RECEIVED');
    assert.equal(lookups, 5);
    assert.deepEqual(counters, { scopes: 1, dispatches: 1 });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
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
    assert.equal(lookups, 8);
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
    assert.equal(tokenLookups, 3);
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


test('owner bearer revoked during async Core scope lookup is denied before dispatch', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  const freshToken = 'scope-rotation-new-token-test-only-'.repeat(3);
  let activeToken = TOKEN;
  let notifyScope, releaseScope;
  const scopeEntered = new Promise(resolve => { notifyScope = resolve; });
  const scopeReleased = new Promise(resolve => { releaseScope = resolve; });
  const deps = dependencies(counters);
  const canonicalResolve = deps.resolveTrustedScope;
  let heldOnce = false;
  deps.resolveTrustedScope = async lookup => {
    const proof = canonicalResolve(lookup);
    if (!heldOnce) {
      heldOnce = true;
      notifyScope();
      await scopeReleased;
    }
    return proof;
  };
  let lookups = 0;
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => { lookups += 1; return activeToken; },
    dependencies: deps,
  });
  try {
    const port = server.address().port;
    const oldClient = createAutopilotLocalClientV1({ token: TOKEN, port });
    const pending = oldClient.control(request('owner-revoked-during-scope'));
    await scopeEntered;
    assert.deepEqual(counters, { scopes: 1, dispatches: 0 });
    activeToken = freshToken;
    releaseScope();
    const refused = await pending;
    assert.equal(refused.status, 'UNKNOWN_NETWORK_RESULT');
    assert.equal(refused.httpStatus, 401);
    assert.deepEqual(counters, { scopes: 1, dispatches: 0 },
      'scope verified under a retired bearer must not reach canonical dispatch');
    assert.equal(lookups, 3, 'authorization is checked before body, after body and after scope');
    const newClient = createAutopilotLocalClientV1({ token: freshToken, port });
    const recovered = await newClient.control(request('after-scope-token-rotation'));
    assert.equal(recovered.status, 'RECEIVED');
    assert.deepEqual(counters, { scopes: 2, dispatches: 1 });
    assert.equal(lookups, 6);
  } finally {
    releaseScope?.();
    await new Promise((resolve, reject) => server.close(
      error => error ? reject(error) : resolve()));
  }
});


test('disconnect during async scope cannot dispatch a new Core effect; clean owner request recovers', async () => {
  for (const ownerTokenProvider of [false, true]) {
    const counters = { scopes: 0, dispatches: 0 };
    let enterScope, releaseScope;
    const scopeEntered = new Promise(resolve => { enterScope = resolve; });
    const scopeReleased = new Promise(resolve => { releaseScope = resolve; });
    const deps = dependencies(counters);
    const trustedScope = deps.resolveTrustedScope;
    let first = true;
    deps.resolveTrustedScope = async lookup => {
      const proof = trustedScope(lookup);
      if (first) {
        first = false;
        enterScope();
        await scopeReleased;
      }
      return proof;
    };
    let tokenLookups = 0;
    const auth = ownerTokenProvider
      ? { tokenProvider: async () => { tokenLookups += 1; return TOKEN; } }
      : { token: TOKEN };
    const server = await startAutopilotLocalApiLoopbackV1({
      ...auth, dependencies: deps,
    });
    let abandoned;
    try {
      const port = server.address().port;
      const body = JSON.stringify({
        ...request('disconnected-during-scope-' + ownerTokenProvider),
        operation: 'AGENT_STOP',
      });
      abandoned = httpRequest({
        hostname: '127.0.0.1', port, path: '/v1/control', method: 'POST',
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, response => response.resume());
      abandoned.on('error', () => {});
      abandoned.end(body);
      await scopeEntered;
      assert.deepEqual(counters, { scopes: 1, dispatches: 0 });
      const socketClosed = new Promise(resolve => abandoned.once('close', resolve));
      abandoned.destroy();
      await socketClosed;
      // Give the server a turn to observe the TCP disconnect before releasing
      // the held trusted Core scope operation.
      await new Promise(resolve => setTimeout(resolve, 30));
      releaseScope();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(counters, { scopes: 1, dispatches: 0 },
        'an abandoned connection cannot initiate a consequential Core dispatch');
      const client = createAutopilotLocalClientV1({ token: TOKEN, port });
      const recovery = await client.control(request('scope-disconnect-recovery-' + ownerTokenProvider));
      assert.equal(recovery.status, 'RECEIVED');
      assert.deepEqual(counters, { scopes: 2, dispatches: 1 });
      assert.equal(tokenLookups, ownerTokenProvider ? 5 : 0,
        'only a surviving owner request completes the final token check');
    } finally {
      releaseScope?.();
      abandoned?.destroy();
      await new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
    }
  }
});


test('duplicate JSON control member identities fail closed before canonical Core; clean request recovers', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  let tokenLookups = 0;
  const server = await startAutopilotLocalApiLoopbackV1({
    tokenProvider: async () => { tokenLookups++; return TOKEN; },
    dependencies: dependencies(counters),
  });
  try {
    const port = server.address().port;
    const original = JSON.stringify(request('unique-valid-identity'));
    const idKey = '"requestId":"unique-valid-identity"';
    assert.ok(original.includes(idKey));
    const cases = [
      original.replace(idKey, '"requestId":"forged-first","requestId":"unique-valid-identity"'),
      original.replace(idKey, '"requestId":"unique-valid-identity","requestId":"forged-last"'),
      original.replace(idKey, '"requestId":"forged-escaped","\\u0072equestId":"unique-valid-identity"'),
      original.replace('"principalId":"owner-1"',
        '"principalId":"other-owner","principalId":"owner-1"'),
    ];
    for (const [index, body] of cases.entries()) {
      const response = await fetch('http://127.0.0.1:' + port + '/v1/control', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
        },
        body,
      });
      assert.equal(response.status, 422, 'ambiguous identity case ' + index);
      assert.deepEqual(await response.json(), { schemaVersion: 1, status: 'UNAVAILABLE' });
      assert.deepEqual(counters, { scopes: 0, dispatches: 0 },
        'duplicate JSON members must not reach the canonical Core');
    }
    assert.equal(tokenLookups, 4, 'owner authentication occurs but no Core authority invoked');
    const client = createAutopilotLocalClientV1({ token: TOKEN, port });
    assert.equal((await client.control(request('json-identity-recovered'))).status, 'RECEIVED');
    assert.deepEqual(counters, { scopes: 1, dispatches: 1 });
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
});


test('BOM-prefixed HTTP control JSON fails closed before Core; clean SDK request recovers', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  const server = await startAutopilotLocalApiLoopbackV1({
    token: TOKEN, dependencies: dependencies(counters),
  });
  try {
    const port = server.address().port;
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(request('bom-raw-http')), 'utf8'),
    ]);
    const response = await fetch('http://127.0.0.1:' + port + '/v1/control', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: raw,
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { schemaVersion: 1, status: 'UNAVAILABLE' });
    assert.deepEqual(counters, { scopes: 0, dispatches: 0 },
      'UTF-8 BOM must not turn an ambiguous body into canonical Core work');
    const client = createAutopilotLocalClientV1({ token: TOKEN, port });
    const clean = await client.control(request('bom-clean-recovered'));
    assert.equal(clean.status, 'RECEIVED');
    assert.deepEqual(counters, { scopes: 1, dispatches: 1 },
      'later canonical request must remain recoverable without duplicate work');
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
});


test('Companion graceful shutdown prevents NEW Core dispatch after pending scope; restart remains healthy', async () => {
  const counters = { scopes: 0, dispatches: 0 };
  const canonical = dependencies(counters);
  let enteredScope, allowScope;
  const scopeEntered = new Promise(resolve => { enteredScope = resolve; });
  const scopeGate = new Promise(resolve => { allowScope = resolve; });
  const deps = {
    now: canonical.now,
    async resolveTrustedScope(lookup) {
      enteredScope();
      await scopeGate;
      return canonical.resolveTrustedScope(lookup);
    },
    dispatchCanonicalControl: canonical.dispatchCanonicalControl,
  };
  const server = await startAutopilotLocalApiLoopbackV1({
    token: TOKEN, dependencies: deps,
  });
  const client = createAutopilotLocalClientV1({
    token: TOKEN, port: server.address().port,
  });
  // The owner initiates a graceful shutdown while the request is already
  // authenticated and waiting for canonical scope, not after dispatch.
  const pending = client.control(request('owner-close-pending-scope'));
  await scopeEntered;
  const closed = new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
  allowScope();
  const outcome = await pending;
  assert.equal(outcome.status, 'UNKNOWN_NETWORK_RESULT');
  assert.equal(outcome.httpStatus, 503);
  assert.deepEqual(counters, { scopes: 1, dispatches: 0 },
    'closing Companion must not initiate any new Core work');
  await closed;
  // A subsequent opt-in Companion lifecycle may still accept an independent
  // request using the same canonical Core authority; no cached denial state.
  const recovered = await startAutopilotLocalApiLoopbackV1({
    token: TOKEN, dependencies: canonical,
  });
  try {
    const next = createAutopilotLocalClientV1({
      token: TOKEN, port: recovered.address().port,
    });
    const receipt = await next.control(request('owner-close-restart-recovery'));
    assert.equal(receipt.status, 'RECEIVED');
    assert.equal(receipt.result.receipt.status, 'COMPLETED');
    assert.deepEqual(counters, { scopes: 2, dispatches: 1 });
  } finally {
    await new Promise((resolve, reject) =>
      recovered.close(error => error ? reject(error) : resolve()));
  }
});
