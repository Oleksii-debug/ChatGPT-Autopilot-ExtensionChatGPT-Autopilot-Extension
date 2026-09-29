import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventTriggerKind,
} from '../src/core/event-trigger-contract.js';
import {
  EventTriggerRuntimeStatus,
  EventTriggerSchedulerReceiptStatus,
  admitEventTriggerObservationV1,
} from '../src/core/event-trigger-runtime.js';

const T0 = '2026-09-25T10:00:00.000Z';
const T1 = '2026-09-25T10:01:00.000Z';
const T2 = '2026-09-25T10:02:00.000Z';
const SHA_A = 'a'.repeat(64);

function trigger(overrides = {}) {
  return {
    schemaVersion: 1,
    triggerId: 'trigger-runtime-1',
    triggerRevision: 7,
    agentId: 'agent-1',
    jobId: 'job-1',
    kind: EventTriggerKind.WEBHOOK,
    providerId: 'webhook-provider',
    sourceBindingId: 'binding-1',
    requiredCapabilityIds: ['webhook.read'],
    enabled: true,
    createdAt: T0,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    observationId: 'observation-1',
    triggerId: 'trigger-runtime-1',
    triggerRevision: 7,
    providerId: 'webhook-provider',
    sourceBindingId: 'binding-1',
    sourceEventId: 'provider-event-1',
    payloadArtifactRef: {
      schemaVersion: 1,
      artifactId: 'artifact-event-1',
      kind: 'event-payload',
      uri: 'artifact://events/1',
      mediaType: 'application/json',
      sha256: SHA_A,
      sizeBytes: 42,
      createdAt: T1,
      producerInvocationId: null,
      sensitive: false,
    },
    observedAt: T1,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    trigger: trigger(),
    observation: observation(),
    admittedAt: T2,
    ...overrides,
  };
}

function deps({
  trustedTrigger = trigger(),
  admitCanonicalOccurrence = async (schedulerRequest) => ({
    schemaVersion: 1,
    status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
    occurrenceId: schedulerRequest.occurrenceId,
    materialFingerprint: schedulerRequest.materialFingerprint,
    canonicalTaskId: 'task-event-1',
    schedulerRevision: 12,
    reason: '',
  }),
} = {}) {
  return {
    resolveTriggerDefinition: async () => trustedTrigger,
    admitCanonicalOccurrence,
  };
}

test('ready event is handed once to canonical scheduler with exact immutable identities', async () => {
  let calls = 0;
  let seen;
  const out = await admitEventTriggerObservationV1(request(), deps({
    admitCanonicalOccurrence: async (schedulerRequest) => {
      calls += 1;
      seen = schedulerRequest;
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-event-1',
        schedulerRevision: 12,
        reason: '',
      };
    },
  }));

  assert.equal(calls, 1);
  assert.equal(Object.isFrozen(seen), true);
  assert.equal(seen.agentId, 'agent-1');
  assert.equal(seen.jobId, 'job-1');
  assert.equal(seen.triggerId, 'trigger-runtime-1');
  assert.equal(seen.triggerRevision, 7);
  assert.equal(seen.payloadArtifactId, 'artifact-event-1');
  assert.equal(seen.payloadSha256, SHA_A);
  assert.match(seen.occurrenceId, /^event:[a-f0-9]{64}$/u);
  assert.match(seen.sourceIdentityFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.match(seen.materialFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.match(seen.triggerDefinitionFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(seen.policyDecisionGranted, false);
  assert.equal(seen.executionAuthorized, false);

  assert.equal(out.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(out.canonicalTaskId, 'task-event-1');
  assert.equal(out.schedulerRevision, 12);
  assert.equal(out.schedulerCalled, true);
  assert.equal(out.canonicalWorkPresent, true);
  assert.equal(out.policyDecisionGranted, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(Object.isFrozen(out), true);
});

test('disabled trigger performs zero canonical scheduler calls', async () => {
  let schedulerCalls = 0;
  const disabled = trigger({ enabled: false });
  const out = await admitEventTriggerObservationV1(
    request({ trigger: disabled }),
    deps({
      trustedTrigger: disabled,
      admitCanonicalOccurrence: async () => {
        schedulerCalls += 1;
        throw new Error('must not run');
      },
    }),
  );

  assert.equal(schedulerCalls, 0);
  assert.equal(out.status, EventTriggerRuntimeStatus.DISABLED);
  assert.equal(out.schedulerCalled, false);
  assert.equal(out.canonicalWorkPresent, false);
  assert.equal(out.executionAuthorized, false);
});

test('canonical duplicate receipt is surfaced without creating a second authority', async () => {
  const out = await admitEventTriggerObservationV1(request(), deps({
    admitCanonicalOccurrence: async (schedulerRequest) => ({
      schemaVersion: 1,
      status: EventTriggerSchedulerReceiptStatus.DUPLICATE,
      occurrenceId: schedulerRequest.occurrenceId,
      materialFingerprint: schedulerRequest.materialFingerprint,
      canonicalTaskId: 'task-existing-1',
      schedulerRevision: 19,
      reason: 'Occurrence already admitted by canonical scheduler',
    }),
  }));

  assert.equal(out.status, EventTriggerRuntimeStatus.DUPLICATE);
  assert.equal(out.canonicalTaskId, 'task-existing-1');
  assert.equal(out.schedulerRevision, 19);
  assert.equal(out.canonicalWorkPresent, true);
  assert.equal(out.executionAuthorized, false);
});

test('canonical blocked receipt carries exact reason and no task identity', async () => {
  const out = await admitEventTriggerObservationV1(request(), deps({
    admitCanonicalOccurrence: async (schedulerRequest) => ({
      schemaVersion: 1,
      status: EventTriggerSchedulerReceiptStatus.BLOCKED,
      occurrenceId: schedulerRequest.occurrenceId,
      materialFingerprint: schedulerRequest.materialFingerprint,
      canonicalTaskId: null,
      schedulerRevision: null,
      reason: 'Required capability is unavailable',
    }),
  }));

  assert.equal(out.status, EventTriggerRuntimeStatus.BLOCKED);
  assert.equal(out.canonicalTaskId, null);
  assert.equal(out.schedulerRevision, null);
  assert.equal(out.canonicalWorkPresent, false);
  assert.equal(out.reason, 'Required capability is unavailable');
});

test('scheduler receipt must echo exact occurrence and material identity', async () => {
  await assert.rejects(
    admitEventTriggerObservationV1(request(), deps({
      admitCanonicalOccurrence: async (schedulerRequest) => ({
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
        occurrenceId: 'event:' + '0'.repeat(64),
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-event-1',
        schedulerRevision: 1,
        reason: '',
      }),
    })),
    /occurrenceId mismatch/,
  );

  await assert.rejects(
    admitEventTriggerObservationV1(request(), deps({
      admitCanonicalOccurrence: async (schedulerRequest) => ({
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: 'sha256:' + '0'.repeat(64),
        canonicalTaskId: 'task-event-1',
        schedulerRevision: 1,
        reason: '',
      }),
    })),
    /materialFingerprint mismatch/,
  );
});

test('unknown or accessor-backed scheduler receipts fail closed', async () => {
  await assert.rejects(
    admitEventTriggerObservationV1(request(), deps({
      admitCanonicalOccurrence: async (schedulerRequest) => ({
        schemaVersion: 1,
        status: 'QUEUED',
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-event-1',
        schedulerRevision: 1,
        reason: '',
      }),
    })),
    /status is invalid/,
  );

  await assert.rejects(
    admitEventTriggerObservationV1(request(), deps({
      admitCanonicalOccurrence: async (schedulerRequest) => {
        const receipt = {
          schemaVersion: 1,
          status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
          occurrenceId: schedulerRequest.occurrenceId,
          materialFingerprint: schedulerRequest.materialFingerprint,
          schedulerRevision: 1,
          reason: '',
        };
        Object.defineProperty(receipt, 'canonicalTaskId', {
          enumerable: true,
          get() { throw new Error('getter must not execute'); },
        });
        return receipt;
      },
    })),
    /canonicalTaskId must be an enumerable own data property/,
  );
});

test('dependency accessors and unknown dependency fields fail before any scheduler effect', async () => {
  let getterCalls = 0;
  const bad = {
    resolveTriggerDefinition: async () => trigger(),
  };
  Object.defineProperty(bad, 'admitCanonicalOccurrence', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => ({});
    },
  });

  await assert.rejects(
    admitEventTriggerObservationV1(request(), bad),
    /admitCanonicalOccurrence must be an enumerable own data property/,
  );
  assert.equal(getterCalls, 0);

  await assert.rejects(
    admitEventTriggerObservationV1(request(), {
      ...deps(),
      hiddenScheduler: async () => {},
    }),
    /unknown field: hiddenScheduler/,
  );
});

test('same upstream occurrence with changed material stays visible to canonical scheduler', async () => {
  const seen = new Map();
  const canonical = async (schedulerRequest) => {
    const prior = seen.get(schedulerRequest.occurrenceId);
    if (prior && prior.materialFingerprint !== schedulerRequest.materialFingerprint) {
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.BLOCKED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: null,
        schedulerRevision: null,
        reason: 'Occurrence material conflicts with previously admitted evidence',
      };
    }
    seen.set(schedulerRequest.occurrenceId, {
      materialFingerprint: schedulerRequest.materialFingerprint,
    });
    return {
      schemaVersion: 1,
      status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
      occurrenceId: schedulerRequest.occurrenceId,
      materialFingerprint: schedulerRequest.materialFingerprint,
      canonicalTaskId: 'task-event-1',
      schedulerRevision: 1,
      reason: '',
    };
  };

  const first = await admitEventTriggerObservationV1(request(), deps({
    admitCanonicalOccurrence: canonical,
  }));
  const changedObservation = observation({
    observationId: 'observation-2',
    payloadArtifactRef: {
      ...observation().payloadArtifactRef,
      artifactId: 'artifact-event-2',
      sha256: 'b'.repeat(64),
    },
  });
  const second = await admitEventTriggerObservationV1(
    request({ observation: changedObservation }),
    deps({ admitCanonicalOccurrence: canonical }),
  );

  assert.equal(first.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(second.status, EventTriggerRuntimeStatus.BLOCKED);
  assert.equal(first.occurrenceId, second.occurrenceId);
  assert.notEqual(first.materialFingerprint, second.materialFingerprint);
});

test('scheduler failure is propagated without local fabricated success or retry state', async () => {
  await assert.rejects(
    admitEventTriggerObservationV1(request(), deps({
      admitCanonicalOccurrence: async () => {
        throw new Error('canonical scheduler unavailable');
      },
    })),
    /canonical scheduler unavailable/,
  );
});
