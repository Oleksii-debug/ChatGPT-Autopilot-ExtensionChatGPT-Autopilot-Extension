import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EventTriggerRuntimeStatus,
  EventTriggerSchedulerReceiptStatus,
} from '../src/core/event-trigger-runtime.js';
import {
  FileChangeKind,
  admitTrustedFileChangeV1,
  normalizeFileEventBindingV1,
  normalizeTrustedFileChangeV1,
} from '../src/core/file-event-trigger-adapter.js';

const T0 = '2026-09-25T10:00:00.000Z';
const T1 = '2026-09-25T10:01:00.000Z';
const T2 = '2026-09-25T10:01:01.000Z';
const T3 = '2026-09-25T10:02:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function trigger(overrides = {}) {
  return {
    schemaVersion: 1,
    triggerId: 'file-trigger-1',
    triggerRevision: 3,
    agentId: 'agent-1',
    jobId: 'job-1',
    kind: 'FILE',
    providerId: 'local-filesystem-watch',
    sourceBindingId: 'file-watch-binding-1',
    requiredCapabilityIds: ['filesystem.watch.read'],
    enabled: true,
    createdAt: T0,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'file-binding-1',
    bindingRevision: 4,
    triggerId: 'file-trigger-1',
    triggerRevision: 3,
    providerId: 'local-filesystem-watch',
    sourceBindingId: 'file-watch-binding-1',
    watchId: 'watch-1',
    scopeId: 'scope-documents',
    allowedChangeKinds: [
      FileChangeKind.CREATED,
      FileChangeKind.MODIFIED,
      FileChangeKind.DELETED,
      FileChangeKind.RENAMED,
    ],
    maxObservationAgeSeconds: 300,
    createdAt: T0,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'file-change-evidence-1',
    kind: 'file-change-event',
    uri: 'artifact://file-change/evidence-1',
    mediaType: 'application/json',
    sha256: SHA_A,
    sizeBytes: 96,
    createdAt: T1,
    producerInvocationId: 'filesystem-watch-provider',
    sensitive: false,
    ...overrides,
  };
}

function change(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'file-binding-1',
    bindingRevision: 4,
    changeId: 'change-1',
    watchId: 'watch-1',
    scopeId: 'scope-documents',
    changeKind: FileChangeKind.MODIFIED,
    subjectId: 'file-identity-42',
    evidenceArtifactRef: artifact(),
    observedAt: T1,
    recordedAt: T2,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    bindingId: 'file-binding-1',
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
    canonicalTaskId: 'task-file-change-1',
    schedulerRevision: 9,
    reason: '',
  }),
} = {}) {
  return {
    resolveTriggerDefinition: async () => structuredClone(trustedTrigger),
    resolveFileEventBinding: async () => structuredClone(trustedBinding),
    resolveTrustedFileChange: async () => structuredClone(trustedChange),
    admitCanonicalOccurrence,
  };
}

test('trusted file change is exact-bound and handed once to canonical scheduler', async () => {
  let calls = 0;
  let seen;
  const out = await admitTrustedFileChangeV1(request(), deps({
    admitCanonicalOccurrence: async schedulerRequest => {
      calls += 1;
      seen = schedulerRequest;
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-file-change-1',
        schedulerRevision: 9,
        reason: '',
      };
    },
  }));

  assert.equal(calls, 1);
  assert.equal(seen.kind, 'FILE');
  assert.equal(seen.triggerId, 'file-trigger-1');
  assert.equal(seen.providerId, 'local-filesystem-watch');
  assert.equal(seen.sourceBindingId, 'file-watch-binding-1');
  assert.equal(seen.sourceEventId, 'change-1');
  assert.equal(seen.payloadArtifactId, 'file-change-evidence-1');
  assert.equal(seen.payloadSha256, SHA_A);
  assert.match(seen.occurrenceId, /^event:[a-f0-9]{64}$/u);

  assert.equal(out.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(out.fileBindingId, 'file-binding-1');
  assert.equal(out.fileBindingRevision, 4);
  assert.equal(out.fileWatchId, 'watch-1');
  assert.equal(out.fileScopeId, 'scope-documents');
  assert.equal(out.fileChangeId, 'change-1');
  assert.equal(out.fileChangeKind, FileChangeKind.MODIFIED);
  assert.equal(out.fileSubjectId, 'file-identity-42');
  assert.equal(out.trustedProviderObservationBound, true);
  assert.equal(out.fileWatchAuthority, false);
  assert.equal(out.filesystemAuthority, false);
  assert.equal(out.rawPathPersisted, false);
  assert.equal(out.fileContentPersisted, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.policyDecisionGranted, false);
  assert.equal(Object.isFrozen(out), true);
});

test('watch, scope, change kind and exact request identity are fail-closed before scheduler', async () => {
  const cases = [
    [change({ watchId: 'watch-other' }), /watchId does not match/u],
    [change({ scopeId: 'scope-other' }), /scopeId does not match/u],
    [change({ changeKind: FileChangeKind.DELETED }), /kind is not allowed/u, binding({
      allowedChangeKinds: [FileChangeKind.MODIFIED],
    })],
    [change({ bindingRevision: 5 }), /requested binding\/change identity/u],
    [change({ changeId: 'change-other' }), /requested binding\/change identity/u],
  ];

  for (const [trustedChange, expected, trustedBinding = binding()] of cases) {
    let calls = 0;
    await assert.rejects(
      admitTrustedFileChangeV1(
        request(),
        deps({
          trustedBinding,
          trustedChange,
          admitCanonicalOccurrence: async () => {
            calls += 1;
            throw new Error('must not run');
          },
        }),
      ),
      expected,
    );
    assert.equal(calls, 0);
  }
});

test('non-FILE trigger or binding drift fails before trusted change can schedule work', async () => {
  let calls = 0;
  await assert.rejects(
    admitTrustedFileChangeV1(
      request(),
      deps({
        trustedTrigger: trigger({ kind: 'WEBHOOK' }),
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /must resolve a FILE trigger/u,
  );

  await assert.rejects(
    admitTrustedFileChangeV1(
      request(),
      deps({
        trustedBinding: binding({ providerId: 'provider-other' }),
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
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
    admitTrustedFileChangeV1(
      request({ admittedAt: '2026-09-25T10:10:00.000Z' }),
      deps({ admitCanonicalOccurrence: never }),
    ),
    /stale for configured binding window/u,
  );

  await assert.rejects(
    admitTrustedFileChangeV1(
      request({ admittedAt: T1 }),
      deps({ admitCanonicalOccurrence: never }),
    ),
    /predates trusted file change record/u,
  );

  await assert.rejects(
    admitTrustedFileChangeV1(
      request(),
      deps({
        trustedChange: change({
          observedAt: '2026-09-25T09:59:59.000Z',
          recordedAt: T1,
          evidenceArtifactRef: artifact({ createdAt: T1 }),
        }),
        admitCanonicalOccurrence: never,
      }),
    ),
    /predates binding/u,
  );

  assert.equal(calls, 0);
});

test('provider change record and evidence chronology are exact canonical UTC', () => {
  assert.throws(
    () => normalizeTrustedFileChangeV1(change({ recordedAt: '2026-09-25T10:01:01Z' })),
    /canonical ISO-8601 UTC representation/u,
  );
  assert.throws(
    () => normalizeTrustedFileChangeV1(change({
      observedAt: T2,
      recordedAt: T1,
      evidenceArtifactRef: artifact({ createdAt: T2 }),
    })),
    /cannot predate provider observation/u,
  );
  assert.throws(
    () => normalizeTrustedFileChangeV1(change({
      evidenceArtifactRef: artifact({ createdAt: T0 }),
    })),
    /outside observation\/record chronology/u,
  );
  assert.throws(
    () => normalizeTrustedFileChangeV1(change({
      evidenceArtifactRef: artifact({ createdAt: T3 }),
    })),
    /outside observation\/record chronology/u,
  );
});

test('durable FILE ingress rejects raw paths, file content and credential material', () => {
  for (const extra of [
    { absolutePath: 'C:\\Users\\Owner\\secret.txt' },
    { relativePath: 'secret.txt' },
    { fileContent: 'private bytes' },
    { credentialRef: 'credential-1' },
  ]) {
    assert.throws(
      () => normalizeTrustedFileChangeV1({ ...change(), ...extra }),
      /unknown field/u,
    );
  }

  assert.throws(
    () => normalizeFileEventBindingV1({
      ...binding(),
      rootPath: 'C:\\',
    }),
    /unknown field: rootPath/u,
  );
});

test('evidence ArtifactRef is exact, opaque, non-sensitive metadata evidence', () => {
  const bad = [
    [artifact({ schemaVersion: '1' }), /schemaVersion must be numeric 1/u],
    [artifact({ artifactId: ' artifact-1 ' }), /artifactId is invalid/u],
    [artifact({ kind: 'file-content' }), /kind must be file-change-event/u],
    [artifact({ mediaType: 'text/plain' }), /mediaType must be application\/json/u],
    [artifact({ sensitive: true }), /non-sensitive metadata evidence/u],
    [artifact({ uri: 'file:///C:/private.txt' }), /opaque artifact URI/u],
    [artifact({ sha256: SHA_A.toUpperCase() }), /canonical lowercase SHA-256/u],
    [artifact({ sizeBytes: 0 }), /non-empty integer sizeBytes/u],
  ];
  for (const [evidenceArtifactRef, expected] of bad) {
    assert.throws(
      () => normalizeTrustedFileChangeV1(change({ evidenceArtifactRef })),
      expected,
    );
  }
});

test('change-kind allowlist is exact, bounded, dense and duplicate-free', () => {
  assert.throws(
    () => normalizeFileEventBindingV1(binding({
      allowedChangeKinds: [FileChangeKind.MODIFIED, FileChangeKind.MODIFIED],
    })),
    /contains duplicates/u,
  );
  assert.throws(
    () => normalizeFileEventBindingV1(binding({
      allowedChangeKinds: ['modified'],
    })),
    /allowedChangeKinds\[0\] is invalid/u,
  );
  assert.throws(
    () => normalizeFileEventBindingV1(binding({
      allowedChangeKinds: new Array(1),
    })),
    /must not be sparse/u,
  );
  assert.throws(
    () => normalizeFileEventBindingV1(binding({
      allowedChangeKinds: [],
    })),
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

  const trustedChange = change({ evidenceArtifactRef: hostileArtifact });
  const directDeps = {
    resolveTriggerDefinition: async () => trigger(),
    resolveFileEventBinding: async () => binding(),
    resolveTrustedFileChange: async () => trustedChange,
    admitCanonicalOccurrence: async () => {
      schedulerCalls += 1;
      throw new Error('must not run');
    },
  };
  await assert.rejects(
    admitTrustedFileChangeV1(request(), directDeps),
    /evidenceArtifactRef field sha256 must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);
  assert.equal(schedulerCalls, 0);

  const badDeps = deps({
    admitCanonicalOccurrence: async () => {
      schedulerCalls += 1;
      throw new Error('must not run');
    },
  });
  Object.defineProperty(badDeps, 'resolveTrustedFileChange', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return async () => change();
    },
  });
  await assert.rejects(
    admitTrustedFileChangeV1(request(), badDeps),
    /resolveTrustedFileChange must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);
  assert.equal(schedulerCalls, 0);
});

test('disabled FILE trigger performs zero canonical scheduler calls', async () => {
  let calls = 0;
  const out = await admitTrustedFileChangeV1(
    request(),
    deps({
      trustedTrigger: trigger({ enabled: false }),
      admitCanonicalOccurrence: async () => {
        calls += 1;
        throw new Error('must not run');
      },
    }),
  );
  assert.equal(out.status, EventTriggerRuntimeStatus.DISABLED);
  assert.equal(out.schedulerCalled, false);
  assert.equal(out.canonicalWorkPresent, false);
  assert.equal(calls, 0);
});

test('same provider change keeps occurrence identity while changed evidence remains visible', async () => {
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
        canonicalTaskId: 'task-file-change-existing',
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
      canonicalTaskId: 'task-file-change-1',
      schedulerRevision: 9,
      reason: '',
    };
  };

  const first = await admitTrustedFileChangeV1(
    request(),
    deps({ admitCanonicalOccurrence: canonical }),
  );
  const duplicate = await admitTrustedFileChangeV1(
    request(),
    deps({ admitCanonicalOccurrence: canonical }),
  );
  const changed = await admitTrustedFileChangeV1(
    request(),
    deps({
      trustedChange: change({
        evidenceArtifactRef: artifact({
          artifactId: 'file-change-evidence-2',
          sha256: SHA_B,
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
  assert.notEqual(first.materialFingerprint, changed.materialFingerprint);
  assert.equal(changed.canonicalWorkPresent, false);
});

test('request and trusted records reject representation aliases and unknown fields', async () => {
  let calls = 0;
  await assert.rejects(
    admitTrustedFileChangeV1(
      request({ bindingRevision: '4' }),
      deps({
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /bindingRevision must be a positive integer/u,
  );
  await assert.rejects(
    admitTrustedFileChangeV1(
      { ...request(), absolutePath: 'C:\\private.txt' },
      deps({
        admitCanonicalOccurrence: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /unknown field: absolutePath/u,
  );
  assert.equal(calls, 0);
});
