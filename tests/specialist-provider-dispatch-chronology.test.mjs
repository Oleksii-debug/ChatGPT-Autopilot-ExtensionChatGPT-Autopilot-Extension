import test from 'node:test';
import assert from 'node:assert/strict';
import { SpecialistProviderDispatcherV1 } from '../src/core/specialist-provider-dispatcher.js';
import { SpecialistProviderReadinessResolverV1 } from '../src/core/specialist-provider-readiness-resolver.js';
import { createExecutionOwnershipV1, claimExecutionOwnershipV1 } from '../src/core/execution-plane-ownership.js';

const T0 = Date.parse('2026-10-08T15:00:00.000Z');
const ts = value => new Date(value).toISOString();

function fixture() {
  let nowMs = T0;
  let providerCalls = 0;
  const selection = {
    schemaVersion: 1, registryId: 'registry.test', registryRevision: 2,
    specialistId: 'specialist.read', providerId: 'provider.local',
    definitionRevision: 1, executionPlane: 'LOCAL',
    requestedCapabilityIds: ['data.read'], grantedToolIds: ['fs.read'],
    resultContractId: 'result.read',
  };
  const handoff = {
    schemaVersion: 1, handoffId: 'handoff.read', specialistId: selection.specialistId,
    goal: 'Read the authorized input.', requestedCapabilityIds: ['data.read'],
    artifactRefs: [], credentialRefs: [], maxModelCalls: 1,
    maxRuntimeSeconds: 120, maxCostUsdMicros: 0,
    createdAt: ts(T0), parentInvocationId: '',
  };
  const ownership = claimExecutionOwnershipV1(
    createExecutionOwnershipV1({
      taskId: 'task.read', planId: 'plan.read', nodeId: 'node.read',
      effectId: 'effect.read', policyEnvelopeId: 'policy.read', at: ts(T0),
    }), {
      plane: 'LOCAL', ownerId: 'owner.read', leaseId: 'lease.read',
      leaseUntil: ts(T0 + 600_000), at: ts(T0),
    },
  );
  const trustedResolver = new SpecialistProviderReadinessResolverV1({
    now: () => nowMs,
    bindings: [{
      providerId: 'provider.local', maxAgeMs: 300_000,
      resolveReadiness: () => ({
        observedAt: ts(T0),
        providerStates: [{
          schemaVersion: 1, providerId: 'provider.local', toolId: 'fs.read',
          health: 'READY', installationRequired: false, installed: true,
          authenticationRequired: false, authenticated: true,
          pathKind: 'CLI', latencyMs: 1, reasonCode: '',
        }],
      }),
    }],
  });
  const newDispatcher = () => new SpecialistProviderDispatcherV1({
    now: () => nowMs,
    bindings: [{
      providerId: 'provider.local',
      execute: async () => { providerCalls += 1; throw Error('SENTINEL_PROVIDER_REACHED'); },
    }],
  });
  const request = readiness => ({
    selection, handoff, executionOwnership: ownership,
    leaseId: 'lease.read', readiness,
  });
  return {
    trustedResolver, newDispatcher, request, selection,
    get providerCalls() { return providerCalls; },
    set nowMs(value) { nowMs = value; },
  };
}

test('fresh resolver evidence still reaches the existing provider boundary under its canonical lease', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  await assert.rejects(f.newDispatcher().execute(f.request(readiness)), /Specialist provider outcome is UNKNOWN/u);
  assert.equal(f.providerCalls, 1);
});

test('future observation cannot become phantom READY at the provider effect edge', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  await assert.rejects(f.newDispatcher().execute(f.request({
    ...valid, observedAt: ts(T0 + 120_000), resolvedAt: ts(T0 + 120_000), ageMs: 0,
  })), /chronology/u);
  assert.equal(f.providerCalls, 0);
});

test('future resolution, reversed timestamps and invalid age reject before provider execution', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  for (const patch of [
    { resolvedAt: ts(T0 + 120_000) },
    { resolvedAt: ts(T0 - 60_000) },
    { ageMs: -1 },
    { ageMs: 120_000 },
    { ageMs: NaN },
  ]) {
    await assert.rejects(f.newDispatcher().execute(f.request({ ...valid, ...patch })), /chronology|observation age/u);
  }
  assert.equal(f.providerCalls, 0);
});

test('restart preserves the original observation age and rejects stale durable readiness', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  const saved = JSON.parse(JSON.stringify(readiness));
  f.nowMs = T0 + 301_000;
  await assert.rejects(f.newDispatcher().execute(f.request(saved)), /stale/u);
  assert.equal(f.providerCalls, 0);
});

test('the existing canonical lease and scope gates remain in force', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  const request = f.request(readiness);
  await assert.rejects(f.newDispatcher().execute({ ...request, leaseId: 'lease.forged' }), /canonical execution lease/u);
  await assert.rejects(f.newDispatcher().execute({
    ...request, selection: { ...f.selection, registryRevision: 3 },
  }), /revision does not match selection/u);
  assert.equal(f.providerCalls, 0);
});

test('hostile binding array accessors and holes are rejected before any callback fires', () => {
  let getterCalls = 0;
  const forged = [];
  Object.defineProperty(forged, '0', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return { providerId: 'provider.forged', execute: async () => ({}) };
    },
  });
  forged.length = 1;
  assert.throws(
    () => new SpecialistProviderDispatcherV1({ bindings: forged }),
    /enumerable own data property/u,
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () => new SpecialistProviderDispatcherV1({ bindings: new Array(1) }),
    /enumerable own data property/u,
  );
});

test('durable readiness cannot extend the trusted five-minute resolver cap', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  for (const maxAgeMs of [300_001, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(f.newDispatcher().execute(f.request({
      ...valid, maxAgeMs,
    })), /stale/u);
  }
  assert.equal(f.providerCalls, 0);
});


test('untrusted nested readiness accessor cannot execute getter or dispatch provider', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  let getterCalls = 0;
  const forgedCheck = { ...valid.inspection.checks[0] };
  Object.defineProperty(forgedCheck, 'providerReadiness', {
    enumerable: true,
    get() { getterCalls++; throw new Error('SECRET_LEAK_CANARY'); },
  });
  const forged = { ...valid, inspection: { ...valid.inspection, checks: [forgedCheck] } };
  await assert.rejects(f.newDispatcher().execute(f.request(forged)), /own data property/u);
  assert.equal(getterCalls, 0);
  assert.equal(f.providerCalls, 0);
});

test('sparse nested specialist inspection arrays fail closed before provider effects', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  const forged = { ...valid, inspection: { ...valid.inspection, checks: new Array(1) } };
  await assert.rejects(f.newDispatcher().execute(f.request(forged)), /own data property/u);
  assert.equal(f.providerCalls, 0);
});

test('no readiness or nested inspection can grant provider or policy authority', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  const forged = [
    { ...valid, authority: { ...valid.authority, providerExecutionAuthorized: true } },
    { ...valid, inspection: {
      ...valid.inspection, authority: { ...valid.inspection.authority, policyAuthorized: true },
    } },
  ];
  for (const item of forged) {
    await assert.rejects(f.newDispatcher().execute(f.request(item)), /cannot grant execution authority/u);
  }
  assert.equal(f.providerCalls, 0);
});

test('mismatched or secret-bearing nested specialist inspection cannot reach provider', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  const forged = [
    { ...valid, inspection: { ...valid.inspection, executable: false } },
    { ...valid, inspection: { ...valid.inspection, specialistId: 'specialist.forged' } },
    { ...valid, inspection: { ...valid.inspection, extraSecret: 'NEVER_LOG_ME' } },
  ];
  for (const item of forged) {
    await assert.rejects(f.newDispatcher().execute(f.request(item)), error =>
      error instanceof Error && !error.message.includes('NEVER_LOG_ME'));
  }
  assert.equal(f.providerCalls, 0);
});

test('canonical provider health rejects contradictory nested READY claims before effects', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  const nested = structuredClone(valid.inspection);
  nested.checks[0].providerReadiness.health = 'UNAVAILABLE';
  await assert.rejects(
    f.newDispatcher().execute(f.request({
      ...valid, inspection: nested,
    })),
    /canonical provider health|inconsistent provider evidence/u,
  );
  assert.equal(f.providerCalls, 0);
});

test('nested inspection cannot silently narrow or expand selected Specialist tool scope', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  for (const mutation of [
    inspection => { inspection.requiredToolIds = []; },
    inspection => { inspection.requiredToolIds = ['fs.write']; },
    inspection => { inspection.checks[0].toolId = 'fs.write'; },
    inspection => { inspection.checks = []; },
    inspection => { inspection.checks[0].readiness = 'NEEDS_AUTH'; },
    inspection => { inspection.checks[0].source = 'MISSING'; },
  ]) {
    const inspection = structuredClone(valid.inspection);
    mutation(inspection);
    await assert.rejects(f.newDispatcher().execute(f.request({ ...valid, inspection })),
      /readiness inspection/u);
  }
  assert.equal(f.providerCalls, 0);
});

test('persisted nested provider inspection remains valid on exact same lease and provider', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  const recovered = JSON.parse(JSON.stringify(valid));
  await assert.rejects(
    f.newDispatcher().execute(f.request(recovered)),
    /Specialist provider outcome is UNKNOWN/u,
  );
  assert.equal(f.providerCalls, 1);
});


test('untrusted Specialist result artifact metadata never invokes a provider-supplied getter', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  let getterCalls = 0;
  let dispatches = 0;
  const maliciousArtifact = { schemaVersion: 1 };
  Object.defineProperty(maliciousArtifact, 'artifactId', {
    enumerable: true,
    get() { getterCalls += 1; throw Error('SECRET_RESULT_GETTER_CANARY'); },
  });
  const dispatcher = new SpecialistProviderDispatcherV1({
    now: () => T0 + 1,
    bindings: [{
      providerId: 'provider.local',
      execute: async () => {
        dispatches += 1;
        return {
          providerReceiptId: 'receipt.local',
          observedAt: ts(T0 + 1),
          resultArtifactRefs: [maliciousArtifact],
        };
      },
    }],
  });
  await assert.rejects(
    dispatcher.execute(f.request(readiness)),
    error => error instanceof Error
      && error.code === 'SPECIALIST_PROVIDER_OUTCOME_UNKNOWN'
      && /reconcile the canonical effect/u.test(error.message)
      && !error.message.includes('SECRET_RESULT_GETTER_CANARY'),
  );
  assert.equal(dispatches, 1, 'this is a post-provider receipt validation fence');
  assert.equal(getterCalls, 0, 'receipt accessors must never execute');
});

test('valid persisted Specialist receipt still yields evidence with no self-issued completion authority', async () => {
  const f = fixture();
  const readiness = JSON.parse(JSON.stringify(
    await f.trustedResolver.resolve(f.selection),
  ));
  const dispatcher = new SpecialistProviderDispatcherV1({
    now: () => T0 + 1,
    bindings: [{
      providerId: 'provider.local',
      execute: async () => ({
        providerReceiptId: 'receipt.local',
        observedAt: ts(T0 + 1),
        resultArtifactRefs: [{
          schemaVersion: 1,
          artifactId: 'artifact.local',
          kind: 'report',
          uri: 'artifact://local/report',
          mediaType: 'application/json',
          sha256: 'a'.repeat(64),
          sizeBytes: 123,
          createdAt: ts(T0 + 1),
          producerInvocationId: 'lease.read',
          sensitive: false,
        }],
      }),
    }],
  });
  const result = await dispatcher.execute(f.request(readiness));
  assert.equal(result.executionId, 'lease.read');
  assert.equal(result.resultArtifactRefs.length, 1);
  assert.equal(result.resultArtifactRefs[0].sha256, 'a'.repeat(64));
  assert.equal(result.completionAuthorized, false);
  assert.equal(result.verificationRequired, true);
});

test('unknown top-level readiness schemaVersion is denied before provider effects', async () => {
  const f = fixture();
  const ready = await f.trustedResolver.resolve(f.selection);
  await assert.rejects(
    f.newDispatcher().execute(f.request({ ...ready, schemaVersion: 999 })),
    /readiness schemaVersion is not supported/u,
  );
  assert.equal(f.providerCalls, 0);
});

test('unknown nested inspection schemaVersion is denied before provider effects', async () => {
  const f = fixture();
  const ready = await f.trustedResolver.resolve(f.selection);
  await assert.rejects(
    f.newDispatcher().execute(f.request({
      ...ready, inspection: { ...ready.inspection, schemaVersion: 999 },
    })),
    /readiness inspection schemaVersion is not supported/u,
  );
  assert.equal(f.providerCalls, 0);
});

test('provider effect-edge check rejects lease and readiness expiry during preparation', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  const scenarios = [
    { name: 'expired execution lease', edge: T0 + 601_000, pattern: /lease expired before provider effect/u },
    { name: 'readiness TTL crossed', edge: T0 + 300_001, pattern: /readiness is stale before provider effect/u },
    { name: 'clock rollback', edge: T0 - 1, pattern: /clock moved backwards before effect/u },
  ];
  for (const scenario of scenarios) {
    let clockReads = 0;
    let effects = 0;
    const dispatcher = new SpecialistProviderDispatcherV1({
      now: () => (++clockReads === 1 ? T0 : scenario.edge),
      bindings: [{
        providerId: 'provider.local',
        execute: async () => { effects += 1; throw new Error('FORBIDDEN_PROVIDER_EFFECT'); },
      }],
    });
    await assert.rejects(
      dispatcher.execute(f.request(valid)),
      scenario.pattern,
      scenario.name,
    );
    assert.equal(clockReads, 2, scenario.name);
    assert.equal(effects, 0, scenario.name);
  }
});

test('provider effect-edge revalidation still permits an unexpired canonical dispatch', async () => {
  const f = fixture();
  const valid = await f.trustedResolver.resolve(f.selection);
  let reads = 0;
  let effects = 0;
  const dispatcher = new SpecialistProviderDispatcherV1({
    now: () => { reads += 1; return T0; },
    bindings: [{
      providerId: 'provider.local',
      execute: async () => { effects += 1; throw new Error('EXPECTED_PROVIDER_EFFECT'); },
    }],
  });
  await assert.rejects(dispatcher.execute(f.request(valid)), /Specialist provider outcome is UNKNOWN/u);
  assert.equal(reads, 2);
  assert.equal(effects, 1);
});

test('section 1: unknown attacker-controlled field names are redacted before provider effects', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  const secret = 'PRIVATE_CREDENTIAL_MUST_NOT_ECHO_731';
  const hostile = { ...f.request(readiness), [secret]: 'value' };
  await assert.rejects(f.newDispatcher().execute(hostile), error =>
    error instanceof Error && /unknown field/u.test(error.message) && !error.message.includes(secret));
  assert.equal(f.providerCalls, 0, 'invalid request must not invoke provider');
  assert.throws(
    () => new SpecialistProviderDispatcherV1({
      bindings: [{
        providerId: 'provider.local', execute: async () => null,
        [secret]: 'value',
      }],
    }),
    error => error instanceof Error && /unknown field/u.test(error.message) && !error.message.includes(secret),
  );
});

test('Section 1 provider exception after effect is opaque UNKNOWN and must be reconciled', async () => {
  const f = fixture();
  const resolved = await f.trustedResolver.resolve(f.selection);
  let executed = 0;
  const dispatcher = new SpecialistProviderDispatcherV1({
    now: () => T0,
    bindings: [{
      providerId: 'provider.local',
      execute: async () => {
        executed += 1;
        throw new Error('PROVIDER_PRIVATE_CREDENTIAL_TOKEN_731');
      },
    }],
  });
  await assert.rejects(dispatcher.execute(f.request(resolved)), error =>
    error instanceof Error
    && error.code === 'SPECIALIST_PROVIDER_OUTCOME_UNKNOWN'
    && /reconcile the canonical effect/u.test(error.message)
    && !error.message.includes('PROVIDER_PRIVATE_CREDENTIAL_TOKEN_731')
    && !Object.hasOwn(error, 'cause'));
  assert.equal(executed, 1, 'no speculative provider replay after unknown effect');
  const saved = JSON.parse(JSON.stringify(resolved));
  const restarted = f.newDispatcher();
  f.nowMs = T0 + 301_000;
  await assert.rejects(restarted.execute(f.request(saved)), /stale/u);
  assert.equal(f.providerCalls, 0, 'stale durable readiness must not dispatch after restart');
});

test('Section 1 post-effect malformed receipt is UNKNOWN, never retry-safe or provider completion', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  let effects = 0;
  const dispatcher = new SpecialistProviderDispatcherV1({
    now: () => T0,
    bindings: [{
      providerId: 'provider.local',
      execute: async () => {
        effects += 1;
        return {
          providerReceiptId: 'receipt.local',
          observedAt: ts(T0),
          resultArtifactRefs: [],
        };
      },
    }],
  });
  await assert.rejects(dispatcher.execute(f.request(readiness)), error =>
    error instanceof Error
    && error.code === 'SPECIALIST_PROVIDER_OUTCOME_UNKNOWN'
    && /reconcile the canonical effect/u.test(error.message)
    && !Object.hasOwn(error, 'cause'));
  assert.equal(effects, 1, 'ambiguous effect must never be resent');
});

test('Section 1 post-effect clock exception redacts its text and retains UNKNOWN', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  let clockReads = 0;
  let effects = 0;
  const dispatcher = new SpecialistProviderDispatcherV1({
    now: () => {
      clockReads += 1;
      if (clockReads === 3) throw new Error('PRIVATE_CLOCK_CREDENTIAL_731');
      return T0;
    },
    bindings: [{
      providerId: 'provider.local',
      execute: async () => { effects += 1; return {}; },
    }],
  });
  await assert.rejects(dispatcher.execute(f.request(readiness)), error =>
    error instanceof Error
    && error.code === 'SPECIALIST_PROVIDER_OUTCOME_UNKNOWN'
    && !error.message.includes('PRIVATE_CLOCK_CREDENTIAL_731'));
  assert.equal(clockReads, 3);
  assert.equal(effects, 1, 'post-effect clock failure is not a no-effect signal');
});

test('Section 1 pre-effect clock failure still prevents provider dispatch', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  let calls = 0;
  const dispatcher = new SpecialistProviderDispatcherV1({
    now: () => { throw new Error('trusted clock unavailable'); },
    bindings: [{ providerId: 'provider.local', execute: async () => { calls += 1; } }],
  });
  await assert.rejects(dispatcher.execute(f.request(readiness)), /trusted clock unavailable/u);
  assert.equal(calls, 0, 'no effect exists before the dispatch boundary');
});


test('Section 1 request and binding Proxy reflection traps are redacted before any effect', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  const poison = () => { throw new Error('SECRET_PROXY_REFLECTION_743'); };
  let effects = 0;
  const requestProxy = new Proxy(f.request(readiness), { getPrototypeOf: poison });
  const dispatcher = new SpecialistProviderDispatcherV1({
    now: () => T0,
    bindings: [{ providerId: 'provider.local', execute: async () => { effects += 1; } }],
  });
  await assert.rejects(dispatcher.execute(requestProxy), error =>
    /cannot be inspected safely/u.test(error.message)
    && !error.message.includes('SECRET_PROXY_REFLECTION_743'));
  const bindingArray = new Proxy([], { ownKeys: poison });
  assert.throws(() => new SpecialistProviderDispatcherV1({ bindings: bindingArray }), error =>
    /cannot be inspected safely/u.test(error.message)
    && !error.message.includes('SECRET_PROXY_REFLECTION_743'));
  assert.equal(effects, 0);
});

test('Section 1 nested readiness Proxy trap never reaches provider and never exposes secret text', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  const poison = () => { throw new Error('SECRET_NESTED_READINESS_813'); };
  const nested = new Proxy(readiness.inspection, { ownKeys: poison });
  const forged = { ...readiness, inspection: nested };
  await assert.rejects(f.newDispatcher().execute(f.request(forged)), error =>
    /cannot be inspected safely/u.test(error.message)
    && !error.message.includes('SECRET_NESTED_READINESS_813'));
  assert.equal(f.providerCalls, 0);
});

test('Section 1 post-effect Proxy receipt reflection becomes opaque UNKNOWN without resending', async () => {
  const f = fixture();
  const readiness = await f.trustedResolver.resolve(f.selection);
  let effects = 0;
  const poison = () => { throw new Error('SECRET_PROVIDER_RECEIPT_921'); };
  const dispatcher = new SpecialistProviderDispatcherV1({
    now: () => T0,
    bindings: [{
      providerId: 'provider.local',
      execute: async () => {
        effects += 1;
        return new Proxy({}, { ownKeys: poison });
      },
    }],
  });
  await assert.rejects(dispatcher.execute(f.request(readiness)), error =>
    error.code === 'SPECIALIST_PROVIDER_OUTCOME_UNKNOWN'
    && /reconcile the canonical effect/u.test(error.message)
    && !error.message.includes('SECRET_PROVIDER_RECEIPT_921')
    && !Object.hasOwn(error, 'cause'));
  assert.equal(effects, 1);
});


test('Section 1 negative-zero readiness age cannot masquerade as a canonical zero-age observation', async () => {
  const f = fixture();
  const observation = await f.trustedResolver.resolve(f.selection);
  await assert.rejects(
    f.newDispatcher().execute(f.request({ ...observation, ageMs: -0 })),
    /observation age is inconsistent/u,
  );
  assert.equal(f.providerCalls, 0, 'noncanonical readiness cannot reach the provider');
});

test('Section 1 negative-zero injected clock is denied before the provider boundary', async () => {
  const f = fixture();
  const observation = await f.trustedResolver.resolve(f.selection);
  let effects = 0;
  const dispatcher = new SpecialistProviderDispatcherV1({
    now: () => -0,
    bindings: [{
      providerId: 'provider.local',
      execute: async () => { effects += 1; },
    }],
  });
  await assert.rejects(
    dispatcher.execute(f.request(observation)),
    /clock returned an invalid time/u,
  );
  assert.equal(effects, 0, 'noncanonical clock must not dispatch any provider effect');
});


test('Section 1 readiness provider rejects hostile reflection without leaking untrusted exception text', async () => {
  const selection = fixture().selection;
  let providerEffects = 0;
  const resolverFor = resolveReadiness => new SpecialistProviderReadinessResolverV1({
    now: () => T0,
    bindings: [{ providerId: 'provider.local', maxAgeMs: 300_000, resolveReadiness }],
  });
  const poisonedResult = new Proxy({}, {
    getPrototypeOf() { throw new Error('SECRET_RESOLVER_RESULT_PROTO_162'); },
  });
  const poisonedArray = new Proxy([], {
    ownKeys() { throw new Error('SECRET_RESOLVER_ARRAY_KEYS_163'); },
  });
  const poisonedState = new Proxy({}, {
    getPrototypeOf() { throw new Error('SECRET_RESOLVER_NESTED_STATE_164'); },
  });
  for (const [result, secret] of [
    [poisonedResult, 'SECRET_RESOLVER_RESULT_PROTO_162'],
    [{ observedAt: ts(T0), providerStates: poisonedArray }, 'SECRET_RESOLVER_ARRAY_KEYS_163'],
    [{ observedAt: ts(T0), providerStates: [poisonedState] }, 'SECRET_RESOLVER_NESTED_STATE_164'],
  ]) {
    const resolver = resolverFor(() => result);
    await assert.rejects(resolver.resolve(selection), error =>
      !error.message.includes(secret)
      && (/cannot be inspected safely|not canonical provider evidence/u).test(error.message));
  }
  assert.equal(providerEffects, 0, 'invalid provider readiness cannot dispatch effects');
});

test('Section 1 rejects secret-bearing provider resolver failures with opaque diagnostics', async () => {
  const selection = fixture().selection;
  const resolver = new SpecialistProviderReadinessResolverV1({
    now: () => T0,
    bindings: [{
      providerId: 'provider.local',
      maxAgeMs: 300_000,
      resolveReadiness: async () => {
        throw new Error('SECRET_PROVIDER_CREDENTIAL_165');
      },
    }],
  });
  await assert.rejects(resolver.resolve(selection), error =>
    error.message === 'Trusted readiness provider resolution failed'
    && !error.message.includes('SECRET_PROVIDER_CREDENTIAL_165')
    && !Object.hasOwn(error, 'cause'));
});

test('Section 1 rejects hostile resolver binding reflection before any resolution', () => {
  let calls = 0;
  const poisonedBinding = new Proxy({}, {
    ownKeys() { throw new Error('SECRET_RESOLVER_BINDING_166'); },
  });
  assert.throws(() => new SpecialistProviderReadinessResolverV1({
    bindings: [poisonedBinding],
    now: () => { calls += 1; return T0; },
  }), error => /cannot be inspected safely/u.test(error.message)
    && !error.message.includes('SECRET_RESOLVER_BINDING_166'));
  assert.equal(calls, 0);
});

test('Section 1 canonical resolver-positive path is preserved after hostile input hardening', async () => {
  const f = fixture();
  const actual = await f.trustedResolver.resolve(f.selection);
  assert.equal(actual.executable, true);
  assert.equal(actual.trustedResolverInvoked, true);
  assert.equal(actual.authority.providerExecutionAuthorized, false);
  assert.equal(f.providerCalls, 0);
});
