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
  await assert.rejects(f.newDispatcher().execute(f.request(readiness)), /SENTINEL_PROVIDER_REACHED/u);
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
