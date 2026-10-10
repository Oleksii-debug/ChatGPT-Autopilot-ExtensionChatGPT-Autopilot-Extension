import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENHANDS_AGENT_SERVER_VERSION,
  OPENHANDS_CODING_PROVIDER_ID,
  OpenHandsCodingSpecialistClient,
} from '../src/core/coding-specialist-provider.js';
import {
  createOpenHandsSpecialistReadinessBindingV1,
  probeOpenHandsSpecialistProviderConfigV1,
} from '../src/core/openhands-specialist-readiness.js';
import {
  SpecialistProviderReadinessResolverV1,
} from '../src/core/specialist-provider-readiness-resolver.js';

const T0 = Date.parse('2026-09-27T13:00:00.000Z');
const T1 = T0 + 25;

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    serverUrl: 'http://127.0.0.1:3000',
    agentServerVersion: OPENHANDS_AGENT_SERVER_VERSION,
    agentProfileId: '11111111-1111-4111-8111-111111111111',
    agentProfileRevision: 2,
    workspacePath: 'C:\\Autopilot\\workspace',
    qualifiedCapabilityIds: ['code.write'],
    requestTimeoutSeconds: 10,
    maxExecutionSeconds: 300,
    pollIntervalMs: 500,
    maxIterations: 20,
    maxResponseBytes: 65_536,
    authMode: 'LOCAL_UNAUTHENTICATED',
    ...overrides,
  };
}

function selection(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'registry:openhands',
    registryRevision: 4,
    specialistId: 'openhands-coding',
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    definitionRevision: 2,
    executionPlane: 'LOCAL',
    requestedCapabilityIds: ['code.write'],
    grantedToolIds: [],
    resultContractId: 'coding-result',
    ...overrides,
  };
}

function jsonResponse(value, { status = 200 } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let delivered = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-length' ? String(bytes.byteLength) : null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
      async cancel() {},
    },
  };
}

function monotonicNow(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}


test('owner-config readiness probe is read-only, bounded, and grants no execution authority', async () => {
  const calls = [];
  const client = new OpenHandsCodingSpecialistClient({
    fetchFn: async (url, options) => {
      calls.push({ url, method: options.method, hasBody: Object.hasOwn(options, 'body') });
      return jsonResponse({
        info: {
          title: 'OpenHands Agent Server',
          version: OPENHANDS_AGENT_SERVER_VERSION,
        },
      });
    },
  });
  const result = await probeOpenHandsSpecialistProviderConfigV1({
    config: config(),
    client,
    now: monotonicNow([T0, T1]),
  });

  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:3000/openapi.json',
    method: 'GET',
    hasBody: false,
  }]);
  assert.equal(result.providerId, OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(result.providerState.health, 'READY');
  assert.equal(result.providerState.reasonCode, 'OPENHANDS_PROBE_READY');
  assert.equal(result.providerState.latencyMs, 25);
  assert.equal(result.authority.providerExecutionAuthorized, false);
  assert.equal(result.authority.completionAuthorized, false);
  assert.equal(result.authority.verificationAuthorized, false);
  assert.equal(result.authority.capacityReserved, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.authority), true);
  assert.equal(Object.isFrozen(result.providerState), true);
  assert.equal(JSON.stringify(result).includes('workspace'), false);
});

test('real OpenHands client readiness path performs only harmless GET /openapi.json and becomes executable through #454', async () => {
  const calls = [];
  const client = new OpenHandsCodingSpecialistClient({
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        info: {
          title: 'OpenHands Agent Server',
          version: OPENHANDS_AGENT_SERVER_VERSION,
        },
      });
    },
  });
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client,
    maxAgeMs: 5_000,
    now: monotonicNow([T0, T1]),
  });
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [binding],
    now: () => T1,
  });

  const result = await resolver.resolve(selection());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/openapi.json');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(Object.hasOwn(calls[0].options, 'body'), false);
  assert.equal(calls.some(call => call.url.includes('/api/conversations')), false);

  assert.equal(result.providerId, OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(result.readiness, 'READY');
  assert.equal(result.executable, true);
  assert.equal(result.ageMs, 0);
  assert.equal(result.inspection.checks[0].providerReadiness.pathKind, 'API');
  assert.equal(result.inspection.checks[0].providerReadiness.latencyMs, 25);
  assert.equal(result.inspection.checks[0].providerReadiness.reasonCode, 'OPENHANDS_PROBE_READY');
  assert.equal(result.authority.providerExecutionAuthorized, false);
  assert.equal(result.authority.capacityReserved, false);
  assert.equal(Object.isFrozen(binding), true);
});

test('wrong OpenHands service identity is a stable UNAVAILABLE observation, never an executable fallback', async () => {
  const client = new OpenHandsCodingSpecialistClient({
    fetchFn: async () => jsonResponse({
      info: {
        title: 'Not OpenHands',
        version: OPENHANDS_AGENT_SERVER_VERSION,
      },
    }),
  });
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client,
    now: monotonicNow([T0, T1]),
  });
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [binding],
    now: () => T1,
  });

  const result = await resolver.resolve(selection());
  assert.equal(result.readiness, 'UNAVAILABLE');
  assert.equal(result.executable, false);
  assert.equal(
    result.inspection.checks[0].providerReadiness.reasonCode,
    'OPENHANDS_SERVER_IDENTITY_MISMATCH',
  );
  assert.equal(result.inspection.checks[0].providerReadiness.installed, true);
});

test('wrong admitted OpenHands version is UNAVAILABLE and does not start a conversation', async () => {
  const calls = [];
  const client = new OpenHandsCodingSpecialistClient({
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        info: {
          title: 'OpenHands Agent Server',
          version: '0.0.0',
        },
      });
    },
  });
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client,
    now: monotonicNow([T0, T1]),
  });
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [binding],
    now: () => T1,
  });

  const result = await resolver.resolve(selection());
  assert.equal(result.readiness, 'UNAVAILABLE');
  assert.equal(result.executable, false);
  assert.equal(
    result.inspection.checks[0].providerReadiness.reasonCode,
    'OPENHANDS_SERVER_VERSION_MISMATCH',
  );
  assert.deepEqual(calls.map(call => call.options.method), ['GET']);
  assert.equal(calls.some(call => call.url.includes('/api/conversations')), false);
});

test('transport failure is a fresh non-executable UNAVAILABLE observation without leaking remote text', async () => {
  const client = new OpenHandsCodingSpecialistClient({
    fetchFn: async () => {
      throw new Error('SECRET remote failure detail C:\\Users\\owner\\private');
    },
  });
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client,
    now: monotonicNow([T0, T1]),
  });
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [binding],
    now: () => T1,
  });

  const result = await resolver.resolve(selection());
  const providerState = result.inspection.checks[0].providerReadiness;
  assert.equal(result.readiness, 'UNAVAILABLE');
  assert.equal(result.executable, false);
  assert.equal(providerState.reasonCode, 'OPENHANDS_TRANSPORT_FAILURE');
  assert.equal(providerState.installed, false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('Users'), false);
});

test('real OpenHands HTTP failure becomes bounded UNAVAILABLE readiness without response-body leakage', async () => {
  const client = new OpenHandsCodingSpecialistClient({
    fetchFn: async () => jsonResponse({ detail: 'SECRET remote diagnostic' }, { status: 503 }),
  });
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client,
    now: monotonicNow([T0, T1]),
  });
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [binding],
    now: () => T1,
  });

  const result = await resolver.resolve(selection());
  const providerState = result.inspection.checks[0].providerReadiness;
  assert.equal(result.readiness, 'UNAVAILABLE');
  assert.equal(result.executable, false);
  assert.equal(providerState.reasonCode, 'OPENHANDS_HTTP_503');
  assert.equal(providerState.installed, true);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('real OpenHands timeout becomes bounded UNAVAILABLE readiness before any execution path', async () => {
  const calls = [];
  const client = new OpenHandsCodingSpecialistClient({
    setTimeoutFn(callback) {
      callback();
      return 1;
    },
    clearTimeoutFn() {},
    fetchFn: async (url, options) => {
      calls.push({ url, method: options.method, aborted: options.signal.aborted });
      throw new Error('SECRET timeout transport detail');
    },
  });
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client,
    now: monotonicNow([T0, T1]),
  });
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [binding],
    now: () => T1,
  });

  const result = await resolver.resolve(selection());
  const providerState = result.inspection.checks[0].providerReadiness;
  assert.equal(result.readiness, 'UNAVAILABLE');
  assert.equal(result.executable, false);
  assert.equal(providerState.reasonCode, 'OPENHANDS_REQUEST_TIMEOUT');
  assert.equal(providerState.installed, true);
  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:3000/openapi.json',
    method: 'GET',
    aborted: true,
  }]);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(calls.some(call => call.url.includes('/api/conversations')), false);
});

test('unexpected probe errors remain UNKNOWN rather than being promoted or mislabeled as installation failure', async () => {
  const client = {
    async probe() {
      const error = new Error('unexpected internal adapter failure');
      error.code = 'UNEXPECTED_INTERNAL';
      throw error;
    },
  };
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client,
    now: monotonicNow([T0, T1]),
  });
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [binding],
    now: () => T1,
  });

  const result = await resolver.resolve(selection());
  const providerState = result.inspection.checks[0].providerReadiness;
  assert.equal(result.readiness, 'NEEDS_HEALTH_CHECK');
  assert.equal(result.executable, false);
  assert.equal(providerState.health, 'UNKNOWN');
  assert.equal(providerState.reasonCode, 'OPENHANDS_PROBE_UNKNOWN');
  assert.equal(providerState.installed, true);
});

test('owner-qualified config is normalized before any probe and remote OpenHands endpoints are rejected', () => {
  let probes = 0;
  const client = {
    async probe() {
      probes += 1;
    },
  };
  assert.throws(
    () => createOpenHandsSpecialistReadinessBindingV1({
      config: config({ serverUrl: 'https://example.com:3000' }),
      client,
    }),
    /bound to localhost|local http/u,
  );
  assert.equal(probes, 0);

  assert.throws(
    () => createOpenHandsSpecialistReadinessBindingV1({
      config: config({ agentServerVersion: '999.0.0' }),
      client,
    }),
    /version must be exactly/u,
  );
  assert.equal(probes, 0);
});

test('binding rejects another provider identity and caller authority fields before probing', async () => {
  let probes = 0;
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client: { async probe() { probes += 1; } },
    now: monotonicNow([T0, T1]),
  });

  const request = {
    schemaVersion: 1,
    registryId: 'registry:openhands',
    registryRevision: 1,
    specialistId: 'openhands-coding',
    providerId: 'provider.other',
    definitionRevision: 1,
    executionPlane: 'LOCAL',
    requestedCapabilityIds: ['code.write'],
    requestedToolIds: [],
    asOf: '2026-09-27T13:00:00.025Z',
  };
  await assert.rejects(binding.resolveReadiness(request), /targets another provider/u);
  assert.equal(probes, 0);

  await assert.rejects(
    binding.resolveReadiness({
      ...request,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      specialistId: 'other-specialist',
    }),
    /targets another specialist/u,
  );
  assert.equal(probes, 0);

  await assert.rejects(
    binding.resolveReadiness({
      ...request,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      executionPlane: 'REMOTE',
    }),
    /requires LOCAL execution plane/u,
  );
  assert.equal(probes, 0);

  await assert.rejects(
    binding.resolveReadiness({ ...request, providerId: OPENHANDS_CODING_PROVIDER_ID, executionAuthorized: true }),
    /unknown field/u,
  );
  assert.equal(probes, 0);
});

test('readiness capability scope must exactly match the owner-qualified OpenHands profile before probing', async () => {
  let probes = 0;
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client: { async probe() { probes += 1; } },
    now: monotonicNow([T0, T1]),
  });
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [binding],
    now: () => T1,
  });

  await assert.rejects(
    resolver.resolve(selection({ requestedCapabilityIds: ['code.review'] })),
    /capability scope does not match qualified profile/u,
  );
  assert.equal(probes, 0);
});

test('clock regression and invalid owner dependencies fail closed', async () => {
  const backward = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client: { async probe() {} },
    now: monotonicNow([T1, T0]),
  });
  const request = {
    schemaVersion: 1,
    registryId: 'registry:openhands',
    registryRevision: 1,
    specialistId: 'openhands-coding',
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    definitionRevision: 1,
    executionPlane: 'LOCAL',
    requestedCapabilityIds: ['code.write'],
    requestedToolIds: [],
    asOf: '2026-09-27T13:00:00.025Z',
  };
  await assert.rejects(backward.resolveReadiness(request), /clock moved backwards/u);

  assert.throws(
    () => createOpenHandsSpecialistReadinessBindingV1({
      config: config(),
      client: {},
    }),
    /client with probe/u,
  );
  assert.throws(
    () => createOpenHandsSpecialistReadinessBindingV1({
      config: config(),
      client: { async probe() {} },
      maxAgeMs: 0,
    }),
    /maxAgeMs is invalid/u,
  );
});


test('hostile provider failure descriptor becomes UNKNOWN without leaking remote exception text', async () => {
  let probeCalls = 0;
  let descriptorTraps = 0;
  const remoteError = new Proxy(new Error('SECRET_REMOTE_DIAGNOSTIC'), {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'code') {
        descriptorTraps += 1;
        throw new Error('SECRET_REMOTE_DESCRIPTOR');
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const result = await probeOpenHandsSpecialistProviderConfigV1({
    config: config(),
    client: { async probe() { probeCalls += 1; throw remoteError; } },
    now: monotonicNow([T0, T1]),
  });
  assert.equal(probeCalls, 1);
  assert.equal(descriptorTraps, 1);
  assert.equal(result.providerState.health, 'UNKNOWN');
  assert.equal(result.providerState.reasonCode, 'OPENHANDS_PROBE_UNKNOWN');
  assert.equal(result.authority.providerExecutionAuthorized, false);
  assert.equal(result.authority.verificationAuthorized, false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('hostile OpenHands probe options and unknown secret-named keys fail closed before provider I/O', async () => {
  let calls = 0;
  const client = { async probe() { calls += 1; } };
  const hostile = new Proxy({ config: config(), client }, {
    ownKeys() { throw new Error('SECRET_OPTIONS_TRAP'); },
  });
  await assert.rejects(
    () => probeOpenHandsSpecialistProviderConfigV1(hostile),
    error => error.message.includes('cannot be inspected safely')
      && !error.message.includes('SECRET'),
  );
  await assert.rejects(
    () => probeOpenHandsSpecialistProviderConfigV1({
      config: config(), client, SECRET_OWNER_PASSWORD_CANARY: 'private',
    }),
    error => error.message.includes('unknown field')
      && !error.message.includes('SECRET_OWNER_PASSWORD_CANARY'),
  );
  assert.equal(calls, 0);
});

test('hostile readiness capability-array reflection fails before the OpenHands provider effect', async () => {
  let calls = 0;
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(),
    client: { async probe() { calls += 1; } },
    now: monotonicNow([T0, T1]),
  });
  // Call the provider binding directly to isolate its own hostile-array boundary.
  // The canonical resolver has a separate selection-normalization contract.
  const caps = new Proxy(['code.write'], {
    ownKeys() { throw new Error('SECRET_ARRAY_TRAP'); },
  });
  await assert.rejects(
    () => binding.resolveReadiness({
      schemaVersion: 1,
      registryId: 'registry:openhands',
      registryRevision: 4,
      specialistId: 'openhands-coding',
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      definitionRevision: 2,
      executionPlane: 'LOCAL',
      requestedCapabilityIds: caps,
      requestedToolIds: [],
      asOf: new Date(T0).toISOString(),
    }),
    error => error.message.includes('cannot be inspected safely')
      && !error.message.includes('SECRET_ARRAY_TRAP'),
  );
  assert.equal(calls, 0);
});

test('hostile client probe accessor and Proxy reflection traps cannot authorize readiness or leak diagnostics', async () => {
  let getterCalls = 0;
  let providerEffects = 0;
  const accessorClient = {};
  Object.defineProperty(accessorClient, 'probe', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('SECRET_CLIENT_GETTER');
    },
  });
  const trapClient = new Proxy({
    async probe() { providerEffects += 1; },
  }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'probe') throw new Error('SECRET_CLIENT_DESCRIPTOR_TRAP');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  for (const client of [accessorClient, trapClient]) {
    await assert.rejects(
      () => probeOpenHandsSpecialistProviderConfigV1({
        config: config(), client, now: monotonicNow([T0, T1]),
      }),
      error => error.message.includes('cannot be inspected safely')
        && !error.message.includes('SECRET'),
    );
    assert.throws(
      () => createOpenHandsSpecialistReadinessBindingV1({
        config: config(), client, now: monotonicNow([T0, T1]),
      }),
      error => error.message.includes('cannot be inspected safely')
        && !error.message.includes('SECRET'),
    );
  }
  assert.equal(getterCalls, 0, 'probe getters must not execute at admission');
  assert.equal(providerEffects, 0, 'hostile clients must not perform provider I/O');
});

test('binding holds admitted OpenHands probe identity across later client method replacement', async () => {
  let originalCalls = 0;
  let replacementCalls = 0;
  const client = {
    async probe() { originalCalls += 1; },
  };
  const binding = createOpenHandsSpecialistReadinessBindingV1({
    config: config(), client, now: monotonicNow([T0, T1]),
  });
  client.probe = async () => {
    replacementCalls += 1;
    throw new Error('SECRET_REPLACED_PROVIDER');
  };
  const observation = await binding.resolveReadiness({
    schemaVersion: 1,
    registryId: 'registry:openhands',
    registryRevision: 4,
    specialistId: 'openhands-coding',
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    definitionRevision: 2,
    executionPlane: 'LOCAL',
    requestedCapabilityIds: ['code.write'],
    requestedToolIds: [],
    asOf: new Date(T0).toISOString(),
  });
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
  assert.equal(observation.providerStates[0].health, 'READY');
  assert.equal(JSON.stringify(observation).includes('SECRET'), false);
});
