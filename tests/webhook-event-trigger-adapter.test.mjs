import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EventTriggerRuntimeStatus,
  EventTriggerSchedulerReceiptStatus,
} from '../src/core/event-trigger-runtime.js';
import {
  WebhookVerificationStatus,
  admitVerifiedWebhookDeliveryV1,
  normalizeWebhookBindingV1,
  normalizeVerifiedWebhookDeliveryV1,
} from '../src/core/webhook-event-trigger-adapter.js';

const T0 = '2026-09-25T10:00:00.000Z';
const T1 = '2026-09-25T10:01:00.000Z';
const T2 = '2026-09-25T10:01:01.000Z';
const T3 = '2026-09-25T10:02:00.000Z';
const SHA_A = 'a'.repeat(64);

function trigger(overrides = {}) {
  return {
    schemaVersion: 1,
    triggerId: 'webhook-trigger-1',
    triggerRevision: 3,
    agentId: 'agent-1',
    jobId: 'job-1',
    kind: 'WEBHOOK',
    providerId: 'webhook-provider',
    sourceBindingId: 'webhook-source-1',
    requiredCapabilityIds: ['webhook.read'],
    enabled: true,
    createdAt: T0,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'webhook-binding-1',
    bindingRevision: 4,
    triggerId: 'webhook-trigger-1',
    triggerRevision: 3,
    providerId: 'webhook-provider',
    sourceBindingId: 'webhook-source-1',
    verificationProfileId: 'verification-profile-1',
    maxDeliveryAgeSeconds: 300,
    createdAt: T0,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'webhook-payload-1',
    kind: 'event-payload',
    uri: 'artifact://webhook/payload-1',
    mediaType: 'application/json',
    sha256: SHA_A,
    sizeBytes: 42,
    createdAt: T1,
    producerInvocationId: null,
    sensitive: false,
    ...overrides,
  };
}

function delivery(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'webhook-binding-1',
    bindingRevision: 4,
    deliveryId: 'delivery-1',
    providerEventId: 'provider-event-1',
    verificationProfileId: 'verification-profile-1',
    verificationStatus: WebhookVerificationStatus.VERIFIED,
    payloadArtifactRef: artifact(),
    receivedAt: T1,
    verifiedAt: T2,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    bindingId: 'webhook-binding-1',
    bindingRevision: 4,
    deliveryId: 'delivery-1',
    admittedAt: T3,
    ...overrides,
  };
}

function deps({
  trustedTrigger = trigger(),
  trustedBinding = binding(),
  trustedDelivery = delivery(),
  admitCanonicalOccurrence = async (schedulerRequest) => ({
    schemaVersion: 1,
    status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
    occurrenceId: schedulerRequest.occurrenceId,
    materialFingerprint: schedulerRequest.materialFingerprint,
    canonicalTaskId: 'task-webhook-1',
    schedulerRevision: 9,
    reason: '',
  }),
} = {}) {
  return {
    resolveTriggerDefinition: async () => trustedTrigger,
    resolveWebhookBinding: async () => trustedBinding,
    resolveVerifiedWebhookDelivery: async () => trustedDelivery,
    admitCanonicalOccurrence,
  };
}

test('verified webhook delivery is bound to trusted identities and handed once to canonical scheduler', async () => {
  let calls = 0;
  let seen;
  const out = await admitVerifiedWebhookDeliveryV1(request(), deps({
    admitCanonicalOccurrence: async (schedulerRequest) => {
      calls += 1;
      seen = schedulerRequest;
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-webhook-1',
        schedulerRevision: 9,
        reason: '',
      };
    },
  }));

  assert.equal(calls, 1);
  assert.equal(seen.kind, 'WEBHOOK');
  assert.equal(seen.triggerId, 'webhook-trigger-1');
  assert.equal(seen.triggerRevision, 3);
  assert.equal(seen.providerId, 'webhook-provider');
  assert.equal(seen.sourceBindingId, 'webhook-source-1');
  assert.equal(seen.sourceEventId, 'provider-event-1');
  assert.equal(seen.payloadArtifactId, 'webhook-payload-1');
  assert.equal(seen.payloadSha256, SHA_A);
  assert.match(seen.occurrenceId, /^event:[a-f0-9]{64}$/u);

  assert.equal(out.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(out.webhookBindingId, 'webhook-binding-1');
  assert.equal(out.webhookBindingRevision, 4);
  assert.equal(out.webhookDeliveryId, 'delivery-1');
  assert.equal(out.webhookVerificationProfileId, 'verification-profile-1');
  assert.equal(out.webhookVerified, true);
  assert.equal(out.webhookDeliveryFresh, true);
  assert.equal(out.providerNetworkAuthority, false);
  assert.equal(out.signatureMaterialPersisted, false);
  assert.equal(out.credentialMaterialPersisted, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.policyDecisionGranted, false);
  assert.equal(Object.isFrozen(out), true);
});

test('unverified delivery fails closed before any scheduler call', async () => {
  let calls = 0;
  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request(),
      deps({
        trustedDelivery: delivery({ verificationStatus: WebhookVerificationStatus.FAILED }),
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /not cryptographically verified/,
  );
  assert.equal(calls, 0);
});

test('stale delivery fails closed before canonical scheduler admission', async () => {
  let calls = 0;
  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request({ admittedAt: '2026-09-25T10:10:00.000Z' }),
      deps({
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /stale for configured binding window/,
  );
  assert.equal(calls, 0);
});

test('trusted binding and delivery must match exact trigger/provider/source revision', async () => {
  let calls = 0;
  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request(),
      deps({
        trustedBinding: binding({ providerId: 'different-provider' }),
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /providerId does not match trusted trigger definition/,
  );

  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request(),
      deps({
        trustedDelivery: delivery({ bindingRevision: 5 }),
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /does not match requested binding\/delivery identity/,
  );
  assert.equal(calls, 0);
});

test('non-WEBHOOK trigger and pre-binding delivery fail closed', async () => {
  let calls = 0;
  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request(),
      deps({
        trustedTrigger: trigger({ kind: 'MAIL' }),
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /must resolve a WEBHOOK trigger/,
  );

  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request(),
      deps({
        trustedDelivery: delivery({
          receivedAt: '2026-09-25T09:59:59.000Z',
          verifiedAt: T1,
          payloadArtifactRef: artifact({ createdAt: '2026-09-25T09:59:59.000Z' }),
        }),
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /predates trusted binding/,
  );
  assert.equal(calls, 0);
});

test('secret/signature material is not part of accepted binding or delivery schemas', () => {
  assert.throws(
    () => normalizeWebhookBindingV1({
      ...binding(),
      credentialRef: 'secret-ref',
    }),
    /unknown field: credentialRef/,
  );
  assert.throws(
    () => normalizeVerifiedWebhookDeliveryV1({
      ...delivery(),
      signature: 'do-not-store',
    }),
    /unknown field: signature/,
  );
  assert.throws(
    () => normalizeVerifiedWebhookDeliveryV1({
      ...delivery(),
      authorizationHeader: 'do-not-store',
    }),
    /unknown field: authorizationHeader/,
  );
});

test('standalone verified-delivery normalizer rejects noncanonical or empty payload material', () => {
  assert.throws(
    () => normalizeVerifiedWebhookDeliveryV1({
      ...delivery(),
      payloadArtifactRef: artifact({ sha256: SHA_A.toUpperCase() }),
    }),
    /canonical lowercase SHA-256/,
  );
  assert.throws(
    () => normalizeVerifiedWebhookDeliveryV1({
      ...delivery(),
      payloadArtifactRef: artifact({ sizeBytes: 0 }),
    }),
    /non-empty integer sizeBytes/,
  );
});

test('payload artifact accessors fail closed without executing getters or scheduler', async () => {
  let getterReads = 0;
  let schedulerCalls = 0;
  const hostileArtifact = artifact();
  Object.defineProperty(hostileArtifact, 'sha256', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return SHA_A;
    },
  });

  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request(),
      deps({
        trustedDelivery: delivery({ payloadArtifactRef: hostileArtifact }),
        admitCanonicalOccurrence: async () => {
          schedulerCalls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /payloadArtifactRef field sha256 must be an enumerable own data property/,
  );
  assert.equal(getterReads, 0);
  assert.equal(schedulerCalls, 0);
});

test('accessor-backed dependency fails without invoking getter or scheduler', async () => {
  let getterReads = 0;
  let schedulerCalls = 0;
  const bad = deps({
    admitCanonicalOccurrence: async () => {
      schedulerCalls += 1;
      throw new Error('must not run');
    },
  });
  Object.defineProperty(bad, 'resolveVerifiedWebhookDelivery', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return async () => delivery();
    },
  });

  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(request(), bad),
    /resolveVerifiedWebhookDelivery must be an enumerable own data property/,
  );
  assert.equal(getterReads, 0);
  assert.equal(schedulerCalls, 0);
});

test('duplicate upstream event keeps occurrence identity while changed material remains visible to canonical runtime', async () => {
  const seen = new Map();
  const canonical = async (schedulerRequest) => {
    const prior = seen.get(schedulerRequest.occurrenceId);
    if (prior && prior !== schedulerRequest.materialFingerprint) {
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.BLOCKED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: null,
        schedulerRevision: null,
        reason: 'Occurrence material conflicts with prior evidence',
      };
    }
    if (prior) {
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.DUPLICATE,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-webhook-existing',
        schedulerRevision: 10,
        reason: 'Already admitted',
      };
    }
    seen.set(schedulerRequest.occurrenceId, schedulerRequest.materialFingerprint);
    return {
      schemaVersion: 1,
      status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
      occurrenceId: schedulerRequest.occurrenceId,
      materialFingerprint: schedulerRequest.materialFingerprint,
      canonicalTaskId: 'task-webhook-1',
      schedulerRevision: 9,
      reason: '',
    };
  };

  const first = await admitVerifiedWebhookDeliveryV1(request(), deps({
    admitCanonicalOccurrence: canonical,
  }));

  const duplicate = await admitVerifiedWebhookDeliveryV1(
    request({ deliveryId: 'delivery-2' }),
    deps({
      trustedDelivery: delivery({ deliveryId: 'delivery-2' }),
      admitCanonicalOccurrence: canonical,
    }),
  );

  const changed = await admitVerifiedWebhookDeliveryV1(
    request({ deliveryId: 'delivery-3' }),
    deps({
      trustedDelivery: delivery({
        deliveryId: 'delivery-3',
        payloadArtifactRef: artifact({
          artifactId: 'webhook-payload-2',
          sha256: 'b'.repeat(64),
        }),
      }),
      admitCanonicalOccurrence: canonical,
    }),
  );

  assert.equal(first.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(duplicate.status, EventTriggerRuntimeStatus.DUPLICATE);
  assert.equal(changed.status, EventTriggerRuntimeStatus.BLOCKED);
  assert.equal(first.occurrenceId, duplicate.occurrenceId);
  assert.equal(first.occurrenceId, changed.occurrenceId);
  assert.equal(changed.canonicalWorkPresent, false);
});

test('extended-year webhook chronology is ordered by epoch at every trust boundary', async () => {
  const beforeBoundary = '9999-12-31T23:59:59.999Z';
  const afterBoundary = '+010000-01-01T00:00:00.000Z';
  const afterBoundaryLater = '+010000-01-01T00:00:00.001Z';
  const afterBoundaryLatest = '+010000-01-01T00:00:00.002Z';

  const validDelivery = normalizeVerifiedWebhookDeliveryV1(delivery({
    receivedAt: beforeBoundary,
    verifiedAt: afterBoundary,
    payloadArtifactRef: artifact({ createdAt: beforeBoundary }),
  }));
  assert.equal(validDelivery.verifiedAt, afterBoundary);

  assert.throws(
    () => normalizeVerifiedWebhookDeliveryV1(delivery({
      receivedAt: afterBoundary,
      verifiedAt: beforeBoundary,
      payloadArtifactRef: artifact({ createdAt: beforeBoundary }),
    })),
    /verification cannot predate receipt/u,
  );

  let schedulerCalls = 0;
  const stop = async () => {
    schedulerCalls += 1;
    throw new Error('must not run');
  };

  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request({ admittedAt: afterBoundaryLatest }),
      deps({
        trustedTrigger: trigger({ createdAt: afterBoundary }),
        trustedBinding: binding({ createdAt: beforeBoundary }),
        trustedDelivery: delivery({
          receivedAt: afterBoundaryLater,
          verifiedAt: afterBoundaryLater,
          payloadArtifactRef: artifact({ createdAt: afterBoundaryLater }),
        }),
        admitCanonicalOccurrence: stop,
      }),
    ),
    /binding cannot predate its trusted trigger definition/u,
  );

  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request({ admittedAt: afterBoundaryLatest }),
      deps({
        trustedTrigger: trigger({ createdAt: '9999-12-31T23:59:59.998Z' }),
        trustedBinding: binding({ createdAt: afterBoundary }),
        trustedDelivery: delivery({
          receivedAt: beforeBoundary,
          verifiedAt: afterBoundaryLater,
          payloadArtifactRef: artifact({ createdAt: beforeBoundary }),
        }),
        admitCanonicalOccurrence: stop,
      }),
    ),
    /delivery predates trusted binding/u,
  );

  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request({ admittedAt: beforeBoundary }),
      deps({
        trustedTrigger: trigger({ createdAt: '9999-12-31T23:59:59.998Z' }),
        trustedBinding: binding({ createdAt: beforeBoundary }),
        trustedDelivery: delivery({
          receivedAt: afterBoundary,
          verifiedAt: afterBoundaryLater,
          payloadArtifactRef: artifact({ createdAt: afterBoundary }),
        }),
        admitCanonicalOccurrence: stop,
      }),
    ),
    /admission predates trusted verification/u,
  );
  assert.equal(schedulerCalls, 0);

  const accepted = await admitVerifiedWebhookDeliveryV1(
    request({ admittedAt: afterBoundaryLatest }),
    deps({
      trustedTrigger: trigger({ createdAt: '9999-12-31T23:59:59.998Z' }),
      trustedBinding: binding({ createdAt: beforeBoundary }),
      trustedDelivery: delivery({
        receivedAt: afterBoundary,
        verifiedAt: afterBoundaryLater,
        payloadArtifactRef: artifact({ createdAt: afterBoundary }),
      }),
    }),
  );
  assert.equal(accepted.status, EventTriggerRuntimeStatus.ACCEPTED);
});

test('noncanonical timestamps and verification-profile substitution fail closed', async () => {
  let calls = 0;
  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request({ admittedAt: '2026-09-25T10:02:00Z' }),
      deps({
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /canonical ISO-8601 UTC representation/,
  );

  await assert.rejects(
    admitVerifiedWebhookDeliveryV1(
      request(),
      deps({
        trustedDelivery: delivery({ verificationProfileId: 'verification-profile-2' }),
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /verification profile does not match trusted binding/,
  );
  assert.equal(calls, 0);
});
