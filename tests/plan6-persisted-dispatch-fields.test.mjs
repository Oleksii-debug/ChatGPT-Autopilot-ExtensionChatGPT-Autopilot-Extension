import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRunTimelineV1 } from '../src/core/agent-run-timeline.js';

// Plan 6 Section 1: metadata only; no providers, external effects or replay.
function fixture() {
  return {
    id: 'plan6-agent',
    runtime: {
      history: [],
      specialistDispatchByAgentId: {
        'agent-1': {
          state: 'PROVIDER_SUCCEEDED',
          providerReceiptId: 'opaque-receipt-1',
          resultArtifactRefs: [{ artifactId: 'artifact-1' }],
        },
      },
      specialistExecutionOwnerships: [
        { state: 'VERIFIED', nodeId: 'node-1', effectId: 'effect-1' },
      ],
    },
  };
}

function projection(input) {
  return buildAgentRunTimelineV1(input);
}

test('Plan6 S1 ordinary dispatch and ownership metadata survives JSON cold restart without authority', () => {
  const initial = projection(fixture());
  const restored = projection(JSON.parse(JSON.stringify(fixture())));
  assert.deepEqual(restored, initial);
  assert.equal(initial.evidenceMap.specialistProviderDispatch.inspectedAttempts, 1);
  assert.equal(initial.evidenceMap.specialistProviderDispatch.receiptIdsRecorded, 1);
  assert.equal(initial.evidenceMap.specialistProviderDispatch.artifactReferencesRecorded, 1);
  assert.equal(initial.evidenceMap.specialistExecutionOwnership.structurallyBoundNodeRecords, 1);
  assert.equal(initial.evidenceMap.specialistProviderDispatch.externalEffectVerified, false);
  assert.equal(initial.evidenceMap.specialistExecutionOwnership.agentTreeEdgesVerified, false);
  assert.equal(initial.mayReplayExternalEffect, false);
});

test('Plan6 S1 non-enumerable durable evidence scalars fail closed before evidence export', () => {
  const cases = [
    ['dispatch state', input => input.runtime.specialistDispatchByAgentId['agent-1'], 'state'],
    ['dispatch receipt identity', input => input.runtime.specialistDispatchByAgentId['agent-1'], 'providerReceiptId'],
    ['dispatch artifact references', input => input.runtime.specialistDispatchByAgentId['agent-1'], 'resultArtifactRefs'],
    ['ownership state', input => input.runtime.specialistExecutionOwnerships[0], 'state'],
    ['ownership node identity', input => input.runtime.specialistExecutionOwnerships[0], 'nodeId'],
    ['ownership effect identity', input => input.runtime.specialistExecutionOwnerships[0], 'effectId'],
  ];
  for (const [label, target, key] of cases) {
    const input = fixture();
    const object = target(input);
    const original = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { ...original, enumerable: false });
    assert.throws(() => projection(input),
      error => error instanceof Error && /persisted field must be an enumerable data field/u.test(error.message),
      label);
  }
});

test('Plan6 S1 descriptor accessor/Proxy traps never run user getters or leak secret diagnostics', () => {
  const secret = 'NEVER_EXPORT_DISPATCH_OWNER_SECRET_20261010';
  let getterCalls = 0;
  const cases = [
    [input => input.runtime.specialistDispatchByAgentId['agent-1'], 'providerReceiptId'],
    [input => input.runtime.specialistDispatchByAgentId['agent-1'], 'resultArtifactRefs'],
    [input => input.runtime.specialistExecutionOwnerships[0], 'nodeId'],
  ];
  for (const [target, key] of cases) {
    const input = fixture();
    Object.defineProperty(target(input), key, {
      configurable: true,
      enumerable: true,
      get() { getterCalls += 1; throw Error(secret); },
    });
    assert.throws(() => projection(input),
      error => error instanceof Error && /accessor-backed/u.test(error.message) &&
        !error.message.includes(secret));
  }
  assert.equal(getterCalls, 0);
  const trapped = fixture();
  trapped.runtime.specialistDispatchByAgentId['agent-1'] =
    new Proxy(trapped.runtime.specialistDispatchByAgentId['agent-1'], {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'providerReceiptId') throw Error(secret);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
  assert.throws(() => projection(trapped),
    error => error instanceof Error && /cannot be safely inspected/u.test(error.message) &&
      !error.message.includes(secret));
  assert.equal(projection(JSON.parse(JSON.stringify(fixture()))).evidenceOnly, true);
});
