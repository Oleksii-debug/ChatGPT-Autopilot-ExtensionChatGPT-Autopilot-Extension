import test from 'node:test';
import assert from 'node:assert/strict';

import { SpecialistProviderReadinessResolverV1 } from '../src/core/specialist-provider-readiness-resolver.js';

const NOW = '2026-09-27T12:40:00.000Z';
const NOW_MS = Date.parse(NOW);

function selection(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'registry:agents',
    registryRevision: 7,
    specialistId: 'coding.local',
    providerId: 'provider.local',
    definitionRevision: 3,
    executionPlane: 'LOCAL',
    requestedCapabilityIds: ['code.write'],
    grantedToolIds: ['fs.read', 'fs.write'],
    resultContractId: 'result:code',
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: 'provider.local',
    toolId: '',
    health: 'READY',
    installationRequired: false,
    installed: true,
    authenticationRequired: false,
    authenticated: true,
    pathKind: 'CLI',
    latencyMs: 12,
    reasonCode: '',
    ...overrides,
  };
}

function binding(resolveReadiness, overrides = {}) {
  return {
    providerId: 'provider.local',
    maxAgeMs: 30_000,
    resolveReadiness,
    ...overrides,
  };
}

function runtime(bindings) {
  return new SpecialistProviderReadinessResolverV1({
    bindings,
    now: () => NOW_MS,
  });
}

test('owner-injected resolver is invoked at admission time and #450 readiness result remains non-authorizing', async () => {
  let calls = 0;
  let seenRequest = null;
  const resolver = runtime([binding(async request => {
    calls += 1;
    seenRequest = request;
    return { observedAt: NOW, providerStates: [state()] };
  })]);

  const result = await resolver.resolve(selection());

  assert.equal(calls, 1);
  assert.equal(result.readiness, 'READY');
  assert.equal(result.executable, true);
  assert.equal(result.observedAt, NOW);
  assert.equal(result.resolvedAt, NOW);
  assert.equal(result.ageMs, 0);
  assert.equal(result.trustedResolverInvoked, true);
  assert.equal(result.callerReadinessAccepted, false);
  assert.equal(result.inspection.requiresFreshTrustedResolution, true);
  assert.deepEqual(result.authority, {
    providerExecutionAuthorized: false,
    toolExecutionAuthorized: false,
    policyAuthorized: false,
    schedulingAuthorized: false,
    recoveryAuthorized: false,
    credentialAuthorized: false,
    completionAuthorized: false,
    verificationAuthorized: false,
    capacityReserved: false,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.inspection), true);

  assert.deepEqual(Object.keys(seenRequest).sort(), [
    'asOf',
    'definitionRevision',
    'executionPlane',
    'providerId',
    'registryId',
    'registryRevision',
    'requestedCapabilityIds',
    'requestedToolIds',
    'schemaVersion',
    'specialistId',
  ]);
  assert.equal(seenRequest.providerId, 'provider.local');
  assert.deepEqual(seenRequest.requestedCapabilityIds, ['code.write']);
  assert.deepEqual(seenRequest.requestedToolIds, ['fs.read', 'fs.write']);
  assert.equal(Object.isFrozen(seenRequest), true);
  assert.equal(Object.isFrozen(seenRequest.requestedCapabilityIds), true);
  assert.equal(Object.isFrozen(seenRequest.requestedToolIds), true);
  assert.equal('providerStates' in seenRequest, false);
  assert.equal('credentialRefs' in seenRequest, false);
  assert.equal('handoff' in seenRequest, false);
});

test('resolver bindings are exact, immutable after construction, deterministically listed, and duplicate providers fail closed', () => {
  const noop = async () => ({ observedAt: NOW, providerStates: [] });
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [
      binding(noop, { providerId: 'provider.z' }),
      binding(noop, { providerId: 'provider.a' }),
    ],
    now: () => NOW_MS,
  });
  assert.deepEqual(resolver.listProviderIds(), ['provider.a', 'provider.z']);
  assert.equal(Object.isFrozen(resolver), true);
  assert.equal(Object.isFrozen(resolver.listProviderIds()), true);

  assert.throws(() => new SpecialistProviderReadinessResolverV1({
    bindings: [binding(noop), binding(noop)],
  }), /duplicate providerId/u);
  assert.throws(() => new SpecialistProviderReadinessResolverV1({
    bindings: [binding(noop, { providerId: ' provider.local ' })],
  }), /exact canonical identity/u);
  assert.throws(() => new SpecialistProviderReadinessResolverV1({
    bindings: [binding('not-a-function')],
  }), /must be a function/u);
});

test('an unbound provider cannot be made executable by caller-shaped readiness', async () => {
  const resolver = runtime([]);
  await assert.rejects(
    resolver.resolve(selection()),
    /No trusted readiness resolver is bound/u,
  );
  await assert.rejects(
    resolver.resolve({ ...selection(), providerStates: [state()] }),
    /unknown field/u,
  );
});

test('async live observation may occur after admission start and freshness is measured at resolution completion', async () => {
  const start = Date.parse('2026-09-27T12:40:00.000Z');
  const end = start + 25;
  const ticks = [start, end];
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [binding(async request => {
      assert.equal(request.asOf, '2026-09-27T12:40:00.000Z');
      return {
        observedAt: '2026-09-27T12:40:00.025Z',
        providerStates: [state()],
      };
    })],
    now: () => ticks.shift(),
  });

  const result = await resolver.resolve(selection());
  assert.equal(result.observedAt, '2026-09-27T12:40:00.025Z');
  assert.equal(result.resolvedAt, '2026-09-27T12:40:00.025Z');
  assert.equal(result.ageMs, 0);
  assert.equal(result.executable, true);
});

test('resolver output must be fresh, canonical, and not from the future', async () => {
  const stale = runtime([binding(async () => ({
    observedAt: '2026-09-27T12:39:29.999Z',
    providerStates: [state()],
  }))]);
  await assert.rejects(stale.resolve(selection()), /observation is stale/u);

  const future = runtime([binding(async () => ({
    observedAt: '2026-09-27T12:40:00.001Z',
    providerStates: [state()],
  }))]);
  await assert.rejects(future.resolve(selection()), /from the future/u);

  const alias = runtime([binding(async () => ({
    observedAt: '2026-09-27T12:40:00Z',
    providerStates: [state()],
  }))]);
  await assert.rejects(alias.resolve(selection()), /canonical ISO-8601 UTC/u);

  const exactBoundary = runtime([binding(async () => ({
    observedAt: '2026-09-27T12:39:30.000Z',
    providerStates: [state()],
  }))]);
  const result = await exactBoundary.resolve(selection());
  assert.equal(result.ageMs, 30_000);
});

test('resolver may return only the selected provider and selected tool scope', async () => {
  const wrongProvider = runtime([binding(async () => ({
    observedAt: NOW,
    providerStates: [state({ providerId: 'provider.other' })],
  }))]);
  await assert.rejects(wrongProvider.resolve(selection()), /does not belong to selected provider/u);

  const extraTool = runtime([binding(async () => ({
    observedAt: NOW,
    providerStates: [state({ toolId: 'fs.delete' })],
  }))]);
  await assert.rejects(extraTool.resolve(selection()), /outside selected tool scope/u);

  const exactTools = runtime([binding(async () => ({
    observedAt: NOW,
    providerStates: [
      state({ toolId: 'fs.read', health: 'READY' }),
      state({ toolId: 'fs.write', health: 'DEGRADED', reasonCode: 'slow' }),
    ],
  }))]);
  const result = await exactTools.resolve(selection());
  assert.equal(result.readiness, 'DEGRADED');
  assert.equal(result.executable, true);
});

test('duplicate provider/tool facts still fail through canonical #450 binding', async () => {
  const resolver = runtime([binding(async () => ({
    observedAt: NOW,
    providerStates: [state(), state({ health: 'DEGRADED', reasonCode: 'slow' })],
  }))]);
  await assert.rejects(resolver.resolve(selection()), /duplicate provider\/tool readiness identity/u);
});

test('unknown, auth-blocked, install-blocked and unavailable facts remain non-executable through #450', async () => {
  for (const [overrides, expected] of [
    [{ health: 'UNKNOWN', reasonCode: 'not-probed' }, 'NEEDS_HEALTH_CHECK'],
    [{ installationRequired: true, installed: false }, 'NEEDS_INSTALL'],
    [{ authenticationRequired: true, authenticated: false }, 'NEEDS_AUTH'],
    [{ health: 'UNAVAILABLE', reasonCode: 'down' }, 'UNAVAILABLE'],
  ]) {
    const resolver = runtime([binding(async () => ({
      observedAt: NOW,
      providerStates: [state(overrides)],
    }))]);
    const result = await resolver.resolve(selection({ grantedToolIds: ['fs.read'] }));
    assert.equal(result.readiness, expected);
    assert.equal(result.executable, false);
  }
});

test('resolver result boundary rejects accessors, sparse arrays and hidden authority without executing field getters', async () => {
  let reads = 0;
  const accessorResult = {};
  Object.defineProperty(accessorResult, 'observedAt', {
    enumerable: true,
    get() {
      reads += 1;
      return NOW;
    },
  });
  accessorResult.providerStates = [state()];
  const accessor = runtime([binding(async () => accessorResult)]);
  await assert.rejects(accessor.resolve(selection()), /enumerable own data property/u);
  assert.equal(reads, 0);

  const sparse = new Array(1);
  const sparseResolver = runtime([binding(async () => ({ observedAt: NOW, providerStates: sparse }))]);
  await assert.rejects(sparseResolver.resolve(selection()), /enumerable own data property/u);

  const authority = runtime([binding(async () => ({
    observedAt: NOW,
    providerStates: [state()],
    executionAuthorized: true,
  }))]);
  await assert.rejects(authority.resolve(selection()), /unknown field/u);
});

test('selection boundary and injected clock are exact and non-coercive', async () => {
  let coercions = 0;
  const coercive = { toString() { coercions += 1; return 'provider.local'; } };
  const resolver = runtime([binding(async () => ({ observedAt: NOW, providerStates: [state()] }))]);
  await assert.rejects(
    resolver.resolve(selection({ providerId: coercive })),
    /exact canonical identity/u,
  );
  assert.equal(coercions, 0);

  const badClock = new SpecialistProviderReadinessResolverV1({
    bindings: [binding(async () => ({ observedAt: NOW, providerStates: [state()] }))],
    now: () => 'not-a-number',
  });
  await assert.rejects(badClock.resolve(selection()), /clock returned an invalid time/u);

  const outOfDateRangeClock = new SpecialistProviderReadinessResolverV1({
    bindings: [binding(async () => ({ observedAt: NOW, providerStates: [state()] }))],
    now: () => 8_640_000_000_000_001,
  });
  await assert.rejects(outOfDateRangeClock.resolve(selection()), /clock returned an invalid time/u);

  const backwardTicks = [NOW_MS, NOW_MS - 1];
  const backwardClock = new SpecialistProviderReadinessResolverV1({
    bindings: [binding(async () => ({ observedAt: NOW, providerStates: [state()] }))],
    now: () => backwardTicks.shift(),
  });
  await assert.rejects(backwardClock.resolve(selection()), /clock moved backwards/u);
});

test('trusted resolver failures propagate and cannot be converted into READY fallback', async () => {
  const resolver = runtime([binding(async () => {
    throw new Error('provider probe failed');
  })]);
  await assert.rejects(resolver.resolve(selection()), /provider probe failed/u);
});
