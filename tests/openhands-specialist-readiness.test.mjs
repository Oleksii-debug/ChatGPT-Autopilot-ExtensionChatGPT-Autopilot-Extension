import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENHANDS_AGENT_SERVER_VERSION,
  OPENHANDS_CODING_PROVIDER_ID,
  OpenHandsCodingSpecialistClient,
} from '../src/core/coding-specialist-provider.js';
import {
  createOpenHandsSpecialistReadinessBindingV1,
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
    requestedToolIds: [],
    asOf: '2026-09-27T13:00:00.025Z',
  };
  await assert.rejects(binding.resolveReadiness(request), /targets another provider/u);
  assert.equal(probes, 0);

  await assert.rejects(
    binding.resolveReadiness({ ...request, providerId: OPENHANDS_CODING_PROVIDER_ID, executionAuthorized: true }),
    /unknown field/u,
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
