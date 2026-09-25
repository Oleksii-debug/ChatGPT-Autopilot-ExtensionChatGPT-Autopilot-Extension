import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EventTriggerRuntimeStatus,
  EventTriggerSchedulerReceiptStatus,
} from '../src/core/event-trigger-runtime.js';
import {
  GitHubDeliveryVerificationStatus,
  admitVerifiedGitHubDeliveryV1,
  normalizeGitHubEventBindingV1,
} from '../src/core/github-event-trigger-adapter.js';

const T0 = '2026-09-25T10:00:00.000Z';
const T1 = '2026-09-25T10:01:00.000Z';
const T2 = '2026-09-25T10:01:01.000Z';
const T3 = '2026-09-25T10:02:00.000Z';
const SHA_A = 'a'.repeat(64);
const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

function trigger(overrides = {}) {
  return {
    schemaVersion: 1,
    triggerId: 'github-trigger-1',
    triggerRevision: 3,
    agentId: 'agent-1',
    jobId: 'job-1',
    kind: 'GITHUB',
    providerId: 'github-webhook',
    sourceBindingId: 'github-hook:42',
    requiredCapabilityIds: ['github.events.read'],
    enabled: true,
    createdAt: T0,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'github-binding-1',
    bindingRevision: 4,
    triggerId: 'github-trigger-1',
    triggerRevision: 3,
    providerId: 'github-webhook',
    sourceBindingId: 'github-hook:42',
    repositoryFullName: 'Oleksii-debug/example',
    hookId: 42,
    verificationProfileId: 'github-hmac-sha256-profile-1',
    allowedEventNames: ['issues', 'pull_request', 'workflow_run'],
    maxDeliveryAgeSeconds: 300,
    createdAt: T0,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'github-payload-1',
    kind: 'event-payload',
    uri: 'artifact://github/delivery-1',
    mediaType: 'application/json',
    sha256: SHA_A,
    sizeBytes: 123,
    createdAt: T1,
    producerInvocationId: null,
    sensitive: false,
    ...overrides,
  };
}

function delivery(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'github-binding-1',
    bindingRevision: 4,
    deliveryId: DELIVERY_ID,
    repositoryFullName: 'Oleksii-debug/example',
    hookId: 42,
    eventName: 'issues',
    verificationProfileId: 'github-hmac-sha256-profile-1',
    verificationStatus: GitHubDeliveryVerificationStatus.VERIFIED,
    payloadArtifactRef: artifact(),
    receivedAt: T1,
    verifiedAt: T2,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    bindingId: 'github-binding-1',
    bindingRevision: 4,
    deliveryId: DELIVERY_ID,
    admittedAt: T3,
    ...overrides,
  };
}

function deps({
  trustedTrigger = trigger(),
  trustedBinding = binding(),
  trustedDelivery = delivery(),
  admitCanonicalOccurrence = async schedulerRequest => ({
    schemaVersion: 1,
    status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
    occurrenceId: schedulerRequest.occurrenceId,
    materialFingerprint: schedulerRequest.materialFingerprint,
    canonicalTaskId: 'task-github-1',
    schedulerRevision: 9,
    reason: '',
  }),
} = {}) {
  return {
    resolveTriggerDefinition: async () => trustedTrigger,
    resolveGitHubEventBinding: async () => trustedBinding,
    resolveVerifiedGitHubDelivery: async () => trustedDelivery,
    admitCanonicalOccurrence,
  };
}

test('verified GitHub delivery binds official delivery identity and repository evidence to canonical scheduler', async () => {
  let calls = 0;
  let seen;
  const out = await admitVerifiedGitHubDeliveryV1(request(), deps({
    admitCanonicalOccurrence: async schedulerRequest => {
      calls += 1;
      seen = schedulerRequest;
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-github-1',
        schedulerRevision: 9,
        reason: '',
      };
    },
  }));

  assert.equal(calls, 1);
  assert.equal(seen.kind, 'GITHUB');
  assert.equal(seen.triggerId, 'github-trigger-1');
  assert.equal(seen.providerId, 'github-webhook');
  assert.equal(seen.sourceBindingId, 'github-hook:42');
  assert.equal(seen.sourceEventId, DELIVERY_ID);
  assert.equal(seen.payloadArtifactId, 'github-payload-1');
  assert.equal(seen.payloadSha256, SHA_A);

  assert.equal(out.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(out.githubBindingId, 'github-binding-1');
  assert.equal(out.githubDeliveryId, DELIVERY_ID);
  assert.equal(out.githubRepositoryFullName, 'Oleksii-debug/example');
  assert.equal(out.githubHookId, 42);
  assert.equal(out.githubEventName, 'issues');
  assert.equal(out.githubSignatureVerified, true);
  assert.equal(out.githubDeliveryFresh, true);
  assert.equal(out.providerNetworkAuthority, false);
  assert.equal(out.signatureMaterialPersisted, false);
  assert.equal(out.credentialMaterialPersisted, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.policyDecisionGranted, false);
  assert.equal(Object.isFrozen(out), true);
});

test('repository, hook, event, verification profile and verification status are exact trust gates', async () => {
  const cases = [
    [delivery({ repositoryFullName: 'Oleksii-debug/other' }), /repository does not match/],
    [delivery({ hookId: 43 }), /hookId does not match/],
    [delivery({ eventName: 'push' }), /event is not allowed/],
    [delivery({ verificationProfileId: 'other-profile' }), /verification profile does not match/],
    [delivery({ verificationStatus: GitHubDeliveryVerificationStatus.FAILED }), /not cryptographically verified/],
  ];

  for (const [trustedDelivery, expected] of cases) {
    let schedulerCalls = 0;
    await assert.rejects(
      admitVerifiedGitHubDeliveryV1(
        request(),
        deps({
          trustedDelivery,
          admitCanonicalOccurrence: async () => {
            schedulerCalls += 1;
            throw new Error('must not run');
          },
        }),
      ),
      expected,
    );
    assert.equal(schedulerCalls, 0);
  }
});

test('stale, pre-binding and noncanonical GitHub deliveries fail before scheduler admission', async () => {
  let schedulerCalls = 0;
  const never = async () => {
    schedulerCalls += 1;
    throw new Error('must not run');
  };

  await assert.rejects(
    admitVerifiedGitHubDeliveryV1(
      request({ admittedAt: '2026-09-25T10:10:00.000Z' }),
      deps({ admitCanonicalOccurrence: never }),
    ),
    /stale for configured binding window/,
  );

  await assert.rejects(
    admitVerifiedGitHubDeliveryV1(
      request({ admittedAt: '2026-09-25T10:02:00Z' }),
      deps({ admitCanonicalOccurrence: never }),
    ),
    /canonical ISO-8601 UTC representation/,
  );

  await assert.rejects(
    admitVerifiedGitHubDeliveryV1(
      request(),
      deps({
        trustedDelivery: delivery({
          receivedAt: '2026-09-25T09:59:59.000Z',
          verifiedAt: T1,
          payloadArtifactRef: artifact({ createdAt: '2026-09-25T09:59:59.000Z' }),
        }),
        admitCanonicalOccurrence: never,
      }),
    ),
    /predates trusted binding/,
  );

  assert.equal(schedulerCalls, 0);
});

test('extended-year chronology uses time order instead of ISO string order', async () => {
  const triggerAt = '9999-12-31T23:59:59.000Z';
  const bindingAt = '+010000-01-01T00:00:00.000Z';
  const receivedAt = '+010000-01-01T00:00:01.000Z';
  const verifiedAt = '+010000-01-01T00:00:02.000Z';
  const admittedAt = '+010000-01-01T00:00:03.000Z';

  const out = await admitVerifiedGitHubDeliveryV1(
    request({ admittedAt }),
    deps({
      trustedTrigger: trigger({ createdAt: triggerAt }),
      trustedBinding: binding({ createdAt: bindingAt }),
      trustedDelivery: delivery({
        receivedAt,
        verifiedAt,
        payloadArtifactRef: artifact({ createdAt: receivedAt }),
      }),
    }),
  );
  assert.equal(out.status, EventTriggerRuntimeStatus.ACCEPTED);

  let schedulerCalls = 0;
  await assert.rejects(
    admitVerifiedGitHubDeliveryV1(
      request({ admittedAt }),
      deps({
        trustedTrigger: trigger({ createdAt: bindingAt }),
        trustedBinding: binding({ createdAt: triggerAt }),
        trustedDelivery: delivery({
          receivedAt,
          verifiedAt,
          payloadArtifactRef: artifact({ createdAt: receivedAt }),
        }),
        admitCanonicalOccurrence: async () => {
          schedulerCalls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /binding cannot predate/u,
  );
  assert.equal(schedulerCalls, 0);

  await assert.rejects(
    admitVerifiedGitHubDeliveryV1(
      request({ admittedAt }),
      deps({
        trustedTrigger: trigger({ createdAt: triggerAt }),
        trustedBinding: binding({ createdAt: bindingAt }),
        trustedDelivery: delivery({
          receivedAt,
          verifiedAt,
          payloadArtifactRef: artifact({ createdAt: '+010000-01-01T00:00:04.000Z' }),
        }),
        admitCanonicalOccurrence: async () => {
          schedulerCalls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /payload artifact cannot postdate receipt/u,
  );
  assert.equal(schedulerCalls, 0);
});

test('binding requires a GITHUB trigger and exact bounded event allowlist', async () => {
  let schedulerCalls = 0;
  await assert.rejects(
    admitVerifiedGitHubDeliveryV1(
      request(),
      deps({
        trustedTrigger: trigger({ kind: 'WEBHOOK' }),
        admitCanonicalOccurrence: async () => {
          schedulerCalls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /must resolve a GITHUB trigger/,
  );
  assert.equal(schedulerCalls, 0);

  assert.throws(
    () => normalizeGitHubEventBindingV1(binding({ allowedEventNames: ['issues', 'issues'] })),
    /contains duplicates/,
  );
  assert.throws(
    () => normalizeGitHubEventBindingV1(binding({ allowedEventNames: ['issues', 'Push'] })),
    /allowedEventNames\[1\] is invalid/,
  );
  assert.throws(
    () => normalizeGitHubEventBindingV1(binding({ hookId: '42' })),
    /hookId must be a positive integer/,
  );

  const sparse = new Array(1);
  assert.throws(
    () => normalizeGitHubEventBindingV1(binding({ allowedEventNames: sparse })),
    /must not be sparse/,
  );
});

test('signature and credential material cannot enter the durable GitHub delivery schema', async () => {
  let schedulerCalls = 0;
  await assert.rejects(
    admitVerifiedGitHubDeliveryV1(
      request(),
      deps({
        trustedDelivery: {
          ...delivery(),
          signature: 'sha256=do-not-store',
        },
        admitCanonicalOccurrence: async () => {
          schedulerCalls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /unknown field: signature/,
  );
  await assert.rejects(
    admitVerifiedGitHubDeliveryV1(
      request(),
      deps({
        trustedDelivery: {
          ...delivery(),
          webhookSecret: 'do-not-store',
        },
        admitCanonicalOccurrence: async () => {
          schedulerCalls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /unknown field: webhookSecret/,
  );
  assert.equal(schedulerCalls, 0);
});

test('payload and dependency accessors fail closed without executing getters or scheduler', async () => {
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
    admitVerifiedGitHubDeliveryV1(
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

  const badDeps = deps({
    admitCanonicalOccurrence: async () => {
      schedulerCalls += 1;
      throw new Error('must not run');
    },
  });
  Object.defineProperty(badDeps, 'resolveVerifiedGitHubDelivery', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return async () => delivery();
    },
  });
  await assert.rejects(
    admitVerifiedGitHubDeliveryV1(request(), badDeps),
    /resolveVerifiedGitHubDelivery must be an enumerable own data property/,
  );
  assert.equal(getterReads, 0);
  assert.equal(schedulerCalls, 0);
});

test('same GitHub delivery keeps occurrence identity while changed payload material remains visible', async () => {
  const seen = new Map();
  const canonical = async schedulerRequest => {
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
        canonicalTaskId: 'task-github-existing',
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
      canonicalTaskId: 'task-github-1',
      schedulerRevision: 9,
      reason: '',
    };
  };

  const first = await admitVerifiedGitHubDeliveryV1(request(), deps({
    admitCanonicalOccurrence: canonical,
  }));
  const duplicate = await admitVerifiedGitHubDeliveryV1(request(), deps({
    admitCanonicalOccurrence: canonical,
  }));
  const changed = await admitVerifiedGitHubDeliveryV1(request(), deps({
    trustedDelivery: delivery({
      payloadArtifactRef: artifact({
        artifactId: 'github-payload-2',
        sha256: 'b'.repeat(64),
      }),
    }),
    admitCanonicalOccurrence: canonical,
  }));

  assert.equal(first.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(duplicate.status, EventTriggerRuntimeStatus.DUPLICATE);
  assert.equal(changed.status, EventTriggerRuntimeStatus.BLOCKED);
  assert.equal(first.occurrenceId, duplicate.occurrenceId);
  assert.equal(first.occurrenceId, changed.occurrenceId);
  assert.equal(changed.canonicalWorkPresent, false);
});
