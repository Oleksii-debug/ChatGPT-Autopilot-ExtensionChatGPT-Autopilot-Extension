import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EventTriggerRuntimeStatus,
  EventTriggerSchedulerReceiptStatus,
} from '../src/core/event-trigger-runtime.js';
import {
  MailChangeKind,
  admitTrustedMailChangeV1,
  normalizeMailEventBindingV1,
  normalizeTrustedMailChangeV1,
} from '../src/core/mail-event-trigger-adapter.js';

const T0 = '2026-09-25T10:00:00.000Z';
const T1 = '2026-09-25T10:01:00.000Z';
const T2 = '2026-09-25T10:01:01.000Z';
const T3 = '2026-09-25T10:02:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function trigger(overrides = {}) {
  return {
    schemaVersion: 1,
    triggerId: 'mail-trigger-1',
    triggerRevision: 3,
    agentId: 'agent-1',
    jobId: 'job-1',
    kind: 'MAIL',
    providerId: 'google-workspace-gmail',
    sourceBindingId: 'gmail-history-binding-1',
    requiredCapabilityIds: ['gmail.metadata.read'],
    enabled: true,
    createdAt: T0,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'mail-binding-1',
    bindingRevision: 4,
    triggerId: 'mail-trigger-1',
    triggerRevision: 3,
    providerId: 'google-workspace-gmail',
    sourceBindingId: 'gmail-history-binding-1',
    mailboxId: 'mailbox-owner-primary',
    watchId: 'gmail-watch-1',
    allowedChangeKinds: [
      MailChangeKind.MESSAGE_ADDED,
      MailChangeKind.MESSAGE_DELETED,
      MailChangeKind.LABEL_ADDED,
      MailChangeKind.LABEL_REMOVED,
    ],
    maxObservationAgeSeconds: 300,
    createdAt: T0,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'mail-change-evidence-1',
    kind: 'mail-change-event',
    uri: 'artifact://mail-change/evidence-1',
    mediaType: 'application/json',
    sha256: SHA_A,
    sizeBytes: 128,
    createdAt: T1,
    producerInvocationId: 'gmail-history-provider',
    sensitive: true,
    ...overrides,
  };
}

function change(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'mail-binding-1',
    bindingRevision: 4,
    changeId: 'change-1',
    mailboxId: 'mailbox-owner-primary',
    watchId: 'gmail-watch-1',
    historyId: '9876543210',
    changeKind: MailChangeKind.MESSAGE_ADDED,
    messageId: 'message-42',
    threadId: 'thread-7',
    evidenceArtifactRef: artifact(),
    observedAt: T1,
    recordedAt: T2,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    bindingId: 'mail-binding-1',
    bindingRevision: 4,
    changeId: 'change-1',
    admittedAt: T3,
    ...overrides,
  };
}

function deps({
  trustedTrigger = trigger(),
  trustedBinding = binding(),
  trustedChange = change(),
  admitCanonicalOccurrence = async schedulerRequest => ({
    schemaVersion: 1,
    status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
    occurrenceId: schedulerRequest.occurrenceId,
    materialFingerprint: schedulerRequest.materialFingerprint,
    canonicalTaskId: 'task-mail-change-1',
    schedulerRevision: 9,
    reason: '',
  }),
} = {}) {
  return {
    resolveTriggerDefinition: async () => structuredClone(trustedTrigger),
    resolveMailEventBinding: async () => structuredClone(trustedBinding),
    resolveTrustedMailChange: async () => structuredClone(trustedChange),
    admitCanonicalOccurrence,
  };
}

test('trusted mail change is exact-bound and handed once to canonical scheduler', async () => {
  let calls = 0;
  let seen;
  const out = await admitTrustedMailChangeV1(request(), deps({
    admitCanonicalOccurrence: async schedulerRequest => {
      calls += 1;
      seen = schedulerRequest;
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-mail-change-1',
        schedulerRevision: 9,
        reason: '',
      };
    },
  }));

  assert.equal(calls, 1);
  assert.equal(seen.kind, 'MAIL');
  assert.equal(seen.triggerId, 'mail-trigger-1');
  assert.equal(seen.providerId, 'google-workspace-gmail');
  assert.equal(seen.sourceBindingId, 'gmail-history-binding-1');
  assert.match(seen.sourceEventId, /^mail:[a-f0-9]{64}$/u);
  assert.equal(seen.payloadArtifactId, 'mail-change-evidence-1');
  assert.equal(seen.payloadSha256, SHA_A);
  assert.match(seen.occurrenceId, /^event:[a-f0-9]{64}$/u);
  assert.equal(out.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(out.mailBindingId, 'mail-binding-1');
  assert.equal(out.mailBindingRevision, 4);
  assert.equal(out.mailMailboxId, 'mailbox-owner-primary');
  assert.equal(out.mailWatchId, 'gmail-watch-1');
  assert.equal(out.mailHistoryId, '9876543210');
  assert.equal(out.mailChangeKind, MailChangeKind.MESSAGE_ADDED);
  assert.equal(out.mailMessageId, 'message-42');
  assert.equal(out.mailThreadId, 'thread-7');
  assert.equal(out.mailboxAuthority, false);
  assert.equal(out.mailNetworkAuthority, false);
  assert.equal(out.historyCursorAuthority, false);
  assert.equal(out.credentialAuthority, false);
  assert.equal(out.rawEmailAddressPersisted, false);
  assert.equal(out.mailContentPersisted, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.policyDecisionGranted, false);
  assert.equal(Object.isFrozen(out), true);
});

test('mailbox, watch, change kind and exact request identity fail closed before scheduler', async () => {
  const cases = [
    [change({ mailboxId: 'mailbox-other' }), /mailboxId does not match/u],
    [change({ watchId: 'watch-other' }), /watchId does not match/u],
    [change({ changeKind: MailChangeKind.MESSAGE_DELETED }), /kind is not allowed/u, binding({
      allowedChangeKinds: [MailChangeKind.MESSAGE_ADDED],
    })],
    [change({ bindingRevision: 5 }), /requested binding\/change identity/u],
    [change({ changeId: 'change-other' }), /requested binding\/change identity/u],
  ];

  for (const [trustedChange, expected, trustedBinding = binding()] of cases) {
    let calls = 0;
    await assert.rejects(
      admitTrustedMailChangeV1(request(), deps({
        trustedBinding,
        trustedChange,
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      })),
      expected,
    );
    assert.equal(calls, 0);
  }
});

test('non-MAIL trigger and binding drift fail before trusted change can schedule work', async () => {
  let calls = 0;
  const never = async () => {
    calls += 1;
    throw new Error('must not run');
  };
  await assert.rejects(
    admitTrustedMailChangeV1(request(), deps({
      trustedTrigger: trigger({ kind: 'DRIVE' }),
      admitCanonicalOccurrence: never,
    })),
    /must resolve a MAIL trigger/u,
  );
  await assert.rejects(
    admitTrustedMailChangeV1(request(), deps({
      trustedBinding: binding({ providerId: 'provider-other' }),
      admitCanonicalOccurrence: never,
    })),
    /providerId does not match trusted trigger definition/u,
  );
  assert.equal(calls, 0);
});

test('chronology and freshness are enforced before scheduler admission', async () => {
  let calls = 0;
  const never = async () => {
    calls += 1;
    throw new Error('must not run');
  };
  await assert.rejects(
    admitTrustedMailChangeV1(
      request({ admittedAt: '2026-09-25T10:10:00.000Z' }),
      deps({ admitCanonicalOccurrence: never }),
    ),
    /stale for configured binding window/u,
  );
  await assert.rejects(
    admitTrustedMailChangeV1(request({ admittedAt: T1 }), deps({ admitCanonicalOccurrence: never })),
    /predates trusted mail change record/u,
  );
  await assert.rejects(
    admitTrustedMailChangeV1(request(), deps({
      trustedChange: change({
        observedAt: '2026-09-25T09:59:59.000Z',
        recordedAt: T1,
        evidenceArtifactRef: artifact({ createdAt: T1 }),
      }),
      admitCanonicalOccurrence: never,
    })),
    /predates binding/u,
  );
  assert.equal(calls, 0);
});

test('historyId and timestamps require exact canonical representations', () => {
  for (const historyId of [9876543210, '09876543210', ' 9876543210 ', '+9876543210', '9e9', '-1']) {
    assert.throws(
      () => normalizeTrustedMailChangeV1(change({ historyId })),
      /canonical decimal historyId/u,
    );
  }
  assert.equal(normalizeTrustedMailChangeV1(change({ historyId: '0' })).historyId, '0');
  assert.throws(
    () => normalizeTrustedMailChangeV1(change({ recordedAt: '2026-09-25T10:01:01Z' })),
    /canonical ISO-8601 UTC representation/u,
  );
  assert.throws(
    () => normalizeTrustedMailChangeV1(change({
      observedAt: T2,
      recordedAt: T1,
      evidenceArtifactRef: artifact({ createdAt: T2 }),
    })),
    /cannot predate provider observation/u,
  );
});

test('durable MAIL ingress rejects raw email and content or credential material', () => {
  for (const extra of [
    { emailAddress: 'owner@example.com' },
    { subject: 'Private subject' },
    { snippet: 'Private preview' },
    { body: 'Private body' },
    { headers: { from: 'person@example.com' } },
    { accessToken: 'secret' },
    { credentialRef: 'credential-1' },
  ]) {
    assert.throws(
      () => normalizeTrustedMailChangeV1({ ...change(), ...extra }),
      /unknown field/u,
    );
  }
  assert.throws(
    () => normalizeMailEventBindingV1({ ...binding(), emailAddress: 'owner@example.com' }),
    /unknown field: emailAddress/u,
  );
  assert.throws(
    () => normalizeMailEventBindingV1(binding({ mailboxId: 'owner@example.com' })),
    /opaque non-email identifier/u,
  );
  assert.throws(
    () => normalizeTrustedMailChangeV1(change({ mailboxId: 'owner@example.com' })),
    /opaque non-email identifier/u,
  );
});

test('mail change ArtifactRef is exact, opaque and explicitly sensitive', () => {
  const bad = [
    [artifact({ schemaVersion: '1' }), /schemaVersion must be numeric 1/u],
    [artifact({ artifactId: ' artifact-1 ' }), /artifactId is invalid/u],
    [artifact({ kind: 'mail-content' }), /kind must be mail-change-event/u],
    [artifact({ mediaType: 'message/rfc822' }), /mediaType must be application\/json/u],
    [artifact({ sensitive: false }), /must be marked sensitive/u],
    [artifact({ uri: 'https://mail.google.com/private' }), /opaque artifact URI/u],
    [artifact({ sha256: SHA_A.toUpperCase() }), /canonical lowercase SHA-256/u],
    [artifact({ sizeBytes: 0 }), /non-empty integer sizeBytes/u],
  ];
  for (const [evidenceArtifactRef, expected] of bad) {
    assert.throws(
      () => normalizeTrustedMailChangeV1(change({ evidenceArtifactRef })),
      expected,
    );
  }
});

test('change-kind allowlist is exact, bounded, dense and duplicate-free', () => {
  assert.throws(
    () => normalizeMailEventBindingV1(binding({
      allowedChangeKinds: [MailChangeKind.MESSAGE_ADDED, MailChangeKind.MESSAGE_ADDED],
    })),
    /contains duplicates/u,
  );
  assert.throws(
    () => normalizeMailEventBindingV1(binding({ allowedChangeKinds: ['message_added'] })),
    /allowedChangeKinds\[0\] is invalid/u,
  );
  assert.throws(
    () => normalizeMailEventBindingV1(binding({ allowedChangeKinds: new Array(1) })),
    /must not be sparse/u,
  );
  assert.throws(
    () => normalizeMailEventBindingV1(binding({ allowedChangeKinds: [] })),
    /non-empty bounded plain array/u,
  );
});

test('hostile ArtifactRef and dependency accessors are rejected without getter execution', async () => {
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
    admitTrustedMailChangeV1(request(), {
      resolveTriggerDefinition: async () => trigger(),
      resolveMailEventBinding: async () => binding(),
      resolveTrustedMailChange: async () => change({ evidenceArtifactRef: hostileArtifact }),
      admitCanonicalOccurrence: async () => {
        schedulerCalls += 1;
        throw new Error('must not run');
      },
    }),
    /evidenceArtifactRef field sha256 must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);
  assert.equal(schedulerCalls, 0);

  const hostileDeps = deps();
  Object.defineProperty(hostileDeps, 'resolveTrustedMailChange', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return async () => change();
    },
  });
  await assert.rejects(
    admitTrustedMailChangeV1(request(), hostileDeps),
    /resolveTrustedMailChange must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);
  assert.equal(schedulerCalls, 0);
});

test('disabled MAIL trigger performs zero canonical scheduler calls', async () => {
  let calls = 0;
  const out = await admitTrustedMailChangeV1(request(), deps({
    trustedTrigger: trigger({ enabled: false }),
    admitCanonicalOccurrence: async () => {
      calls += 1;
      throw new Error('must not run');
    },
  }));
  assert.equal(out.status, EventTriggerRuntimeStatus.DISABLED);
  assert.equal(out.schedulerCalled, false);
  assert.equal(out.canonicalWorkPresent, false);
  assert.equal(calls, 0);
});

test('same provider mail event keeps occurrence identity while changed evidence remains visible', async () => {
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
        canonicalTaskId: 'task-mail-change-existing',
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
      canonicalTaskId: 'task-mail-change-1',
      schedulerRevision: 9,
      reason: '',
    };
  };

  const first = await admitTrustedMailChangeV1(request(), deps({ admitCanonicalOccurrence: canonical }));
  const duplicate = await admitTrustedMailChangeV1(request(), deps({ admitCanonicalOccurrence: canonical }));
  const changed = await admitTrustedMailChangeV1(request(), deps({
    trustedChange: change({
      threadId: 'thread-8',
      evidenceArtifactRef: artifact({
        artifactId: 'mail-change-evidence-2',
        sha256: SHA_B,
      }),
    }),
    admitCanonicalOccurrence: canonical,
  }));
  assert.equal(first.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(duplicate.status, EventTriggerRuntimeStatus.DUPLICATE);
  assert.equal(changed.status, EventTriggerRuntimeStatus.BLOCKED);
  assert.equal(first.occurrenceId, duplicate.occurrenceId);
  assert.equal(first.occurrenceId, changed.occurrenceId);
  assert.notEqual(first.materialFingerprint, changed.materialFingerprint);
  assert.equal(changed.canonicalWorkPresent, false);
});

test('source identity separates mailbox, watch, history, change kind and message identity', async () => {
  const identities = [];
  const capture = async schedulerRequest => {
    identities.push(schedulerRequest.sourceEventId);
    return {
      schemaVersion: 1,
      status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
      occurrenceId: schedulerRequest.occurrenceId,
      materialFingerprint: schedulerRequest.materialFingerprint,
      canonicalTaskId: 'task-' + identities.length,
      schedulerRevision: identities.length,
      reason: '',
    };
  };
  await admitTrustedMailChangeV1(request(), deps({ admitCanonicalOccurrence: capture }));
  await admitTrustedMailChangeV1(request(), deps({
    trustedBinding: binding({ mailboxId: 'mailbox-other' }),
    trustedChange: change({ mailboxId: 'mailbox-other' }),
    admitCanonicalOccurrence: capture,
  }));
  await admitTrustedMailChangeV1(request(), deps({
    trustedBinding: binding({ watchId: 'gmail-watch-2' }),
    trustedChange: change({ watchId: 'gmail-watch-2' }),
    admitCanonicalOccurrence: capture,
  }));
  await admitTrustedMailChangeV1(request(), deps({
    trustedChange: change({ historyId: '9876543211' }),
    admitCanonicalOccurrence: capture,
  }));
  await admitTrustedMailChangeV1(request(), deps({
    trustedChange: change({ changeKind: MailChangeKind.LABEL_ADDED }),
    admitCanonicalOccurrence: capture,
  }));
  await admitTrustedMailChangeV1(request(), deps({
    trustedChange: change({ messageId: 'message-43' }),
    admitCanonicalOccurrence: capture,
  }));
  assert.equal(new Set(identities).size, identities.length);
});

test('request and trusted records reject representation aliases and unknown fields', async () => {
  let calls = 0;
  await assert.rejects(
    admitTrustedMailChangeV1(request({ bindingRevision: '4' }), deps({
      admitCanonicalOccurrence: async () => {
        calls += 1;
        throw new Error('must not run');
      },
    })),
    /bindingRevision must be a positive integer/u,
  );
  await assert.rejects(
    admitTrustedMailChangeV1({ ...request(), emailAddress: 'owner@example.com' }, deps({
      admitCanonicalOccurrence: async () => {
        calls += 1;
        throw new Error('must not run');
      },
    })),
    /unknown field: emailAddress/u,
  );
  assert.equal(calls, 0);
});
