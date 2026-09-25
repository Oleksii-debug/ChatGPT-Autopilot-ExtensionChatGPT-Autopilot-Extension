import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EventTriggerRuntimeStatus,
  EventTriggerSchedulerReceiptStatus,
} from '../src/core/event-trigger-runtime.js';
import {
  DriveChangeKind,
  admitDriveChangeV1,
  normalizeDriveChangeV1,
  normalizeDriveWatchBindingV1,
} from '../src/core/drive-event-trigger-adapter.js';

const T0 = '2026-09-25T10:00:00.000Z';
const T1 = '2026-09-25T10:01:00.000Z';
const T2 = '2026-09-25T10:02:00.000Z';
const SHA_A = 'a'.repeat(64);

function trigger(overrides = {}) {
  return {
    schemaVersion: 1,
    triggerId: 'drive-trigger-1',
    triggerRevision: 2,
    agentId: 'agent-1',
    jobId: 'job-1',
    kind: 'DRIVE',
    providerId: 'google-workspace',
    sourceBindingId: 'drive-source-1',
    requiredCapabilityIds: ['google.drive.changes.read'],
    enabled: true,
    createdAt: T0,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'drive-binding-1',
    bindingRevision: 4,
    triggerId: 'drive-trigger-1',
    triggerRevision: 2,
    providerId: 'google-workspace',
    sourceBindingId: 'drive-source-1',
    watchId: 'watch-1',
    resourceId: 'resource-1',
    driveScopeId: 'scope-1',
    maxChangeAgeSeconds: 300,
    createdAt: T0,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'drive-change-evidence-1',
    kind: 'drive-change-evidence',
    uri: 'artifact://drive/change-1',
    mediaType: 'application/json',
    sha256: SHA_A,
    sizeBytes: 128,
    createdAt: T1,
    producerInvocationId: null,
    sensitive: true,
    ...overrides,
  };
}

function change(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'drive-binding-1',
    bindingRevision: 4,
    watchId: 'watch-1',
    resourceId: 'resource-1',
    driveScopeId: 'scope-1',
    changeToken: 'page-token-123:ordinal-7',
    changeKind: DriveChangeKind.FILE_CHANGED,
    fileId: 'file-1',
    evidenceArtifactRef: artifact(),
    observedAt: T1,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    bindingId: 'drive-binding-1',
    bindingRevision: 4,
    changeToken: 'page-token-123:ordinal-7',
    admittedAt: T2,
    ...overrides,
  };
}

function deps({
  trustedTrigger = trigger(),
  trustedBinding = binding(),
  trustedChange = change(),
  admitCanonicalOccurrence = async (schedulerRequest) => ({
    schemaVersion: 1,
    status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
    occurrenceId: schedulerRequest.occurrenceId,
    materialFingerprint: schedulerRequest.materialFingerprint,
    canonicalTaskId: 'task-drive-1',
    schedulerRevision: 5,
    reason: '',
  }),
} = {}) {
  return {
    resolveTriggerDefinition: async () => trustedTrigger,
    resolveDriveWatchBinding: async () => trustedBinding,
    resolveDriveChange: async () => trustedChange,
    admitCanonicalOccurrence,
  };
}

test('trusted Drive change is bound to exact watch identity and canonical scheduler', async () => {
  let calls = 0;
  let seen;
  const out = await admitDriveChangeV1(request(), deps({
    admitCanonicalOccurrence: async (schedulerRequest) => {
      calls += 1;
      seen = schedulerRequest;
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-drive-1',
        schedulerRevision: 5,
        reason: '',
      };
    },
  }));

  assert.equal(calls, 1);
  assert.equal(seen.kind, 'DRIVE');
  assert.equal(seen.triggerId, 'drive-trigger-1');
  assert.equal(seen.providerId, 'google-workspace');
  assert.equal(seen.sourceBindingId, 'drive-source-1');
  assert.match(seen.sourceEventId, /^drive:[a-f0-9]{64}$/u);
  assert.equal(seen.payloadArtifactId, 'drive-change-evidence-1');

  assert.equal(out.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(out.driveBindingId, 'drive-binding-1');
  assert.equal(out.driveWatchId, 'watch-1');
  assert.equal(out.driveResourceId, 'resource-1');
  assert.equal(out.driveScopeId, 'scope-1');
  assert.equal(out.driveChangeKind, DriveChangeKind.FILE_CHANGED);
  assert.equal(out.driveFileId, 'file-1');
  assert.equal(out.driveChangeFresh, true);
  assert.equal(out.watchAuthority, false);
  assert.equal(out.changeFeedCursorAuthority, false);
  assert.equal(out.providerNetworkAuthority, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(Object.isFrozen(out), true);
});

test('Drive trigger/binding/change identities must match exact trusted revisions', async () => {
  let calls = 0;
  const stop = async () => {
    calls += 1;
    throw new Error('must not run');
  };

  await assert.rejects(
    admitDriveChangeV1(request(), deps({
      trustedTrigger: trigger({ kind: 'MAIL' }),
      admitCanonicalOccurrence: stop,
    })),
    /must resolve a DRIVE trigger/u,
  );
  await assert.rejects(
    admitDriveChangeV1(request(), deps({
      trustedBinding: binding({ resourceId: 'resource-2' }),
      trustedChange: change(),
      admitCanonicalOccurrence: stop,
    })),
    /resourceId does not match trusted binding/u,
  );
  await assert.rejects(
    admitDriveChangeV1(request(), deps({
      trustedChange: change({ changeToken: 'other-token' }),
      admitCanonicalOccurrence: stop,
    })),
    /does not match requested changeToken/u,
  );
  assert.equal(calls, 0);
});

test('stale or future Drive change fails closed before scheduler admission', async () => {
  let calls = 0;
  const stop = async () => {
    calls += 1;
    throw new Error('must not run');
  };

  await assert.rejects(
    admitDriveChangeV1(
      request({ admittedAt: '2026-09-25T10:10:00.000Z' }),
      deps({ admitCanonicalOccurrence: stop }),
    ),
    /stale for configured binding window/u,
  );

  await assert.rejects(
    admitDriveChangeV1(
      request({ admittedAt: '2026-09-25T10:00:30.000Z' }),
      deps({ admitCanonicalOccurrence: stop }),
    ),
    /predates trusted change observation/u,
  );
  assert.equal(calls, 0);
});

test('file-level and drive-level change kinds enforce file identity shape', () => {
  assert.throws(
    () => normalizeDriveChangeV1(change({ fileId: '' })),
    /file change requires fileId/u,
  );
  assert.throws(
    () => normalizeDriveChangeV1(change({
      changeKind: DriveChangeKind.DRIVE_CHANGED,
      fileId: 'file-1',
    })),
    /drive-level change must not carry fileId/u,
  );

  const driveLevel = normalizeDriveChangeV1(change({
    changeKind: DriveChangeKind.DRIVE_CHANGED,
    fileId: '',
  }));
  assert.equal(driveLevel.fileId, '');
});

test('change evidence must be opaque, immutable, sensitive JSON artifact material', () => {
  assert.throws(
    () => normalizeDriveChangeV1(change({
      evidenceArtifactRef: artifact({ kind: 'raw-file' }),
    })),
    /kind must be drive-change-evidence/u,
  );
  assert.throws(
    () => normalizeDriveChangeV1(change({
      evidenceArtifactRef: artifact({ sensitive: false }),
    })),
    /sensitive must be true/u,
  );
  assert.throws(
    () => normalizeDriveChangeV1(change({
      evidenceArtifactRef: artifact({ uri: 'https://drive.google.com/file/secret' }),
    })),
    /opaque artifact:\/\/ URI/u,
  );
  assert.throws(
    () => normalizeDriveChangeV1(change({
      evidenceArtifactRef: artifact({ sha256: SHA_A.toUpperCase() }),
    })),
    /canonical lowercase SHA-256/u,
  );
});

test('raw OAuth, webhook token, path and notification header fields are rejected', () => {
  for (const extra of [
    ['accessToken', 'secret'],
    ['channelToken', 'secret'],
    ['xGoogMessageNumber', '7'],
    ['rawPath', 'C:\\secret\\file.txt'],
  ]) {
    assert.throws(
      () => normalizeDriveChangeV1({
        ...change(),
        [extra[0]]: extra[1],
      }),
      /unknown field/u,
    );
  }

  assert.throws(
    () => normalizeDriveWatchBindingV1({
      ...binding(),
      credentialRef: 'credential-1',
    }),
    /unknown field/u,
  );
});

test('descriptor-backed change evidence fails without invoking getter or scheduler', async () => {
  let getterReads = 0;
  let schedulerCalls = 0;
  const hostile = artifact();
  Object.defineProperty(hostile, 'sha256', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return SHA_A;
    },
  });

  await assert.rejects(
    admitDriveChangeV1(
      request(),
      deps({
        trustedChange: change({ evidenceArtifactRef: hostile }),
        admitCanonicalOccurrence: async () => {
          schedulerCalls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /field sha256 must be an enumerable own data property/u,
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
  Object.defineProperty(bad, 'resolveDriveChange', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return async () => change();
    },
  });

  await assert.rejects(
    admitDriveChangeV1(request(), bad),
    /resolveDriveChange must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);
  assert.equal(schedulerCalls, 0);
});

test('same trusted change token keeps occurrence identity while changed evidence conflicts canonically', async () => {
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
        canonicalTaskId: 'task-drive-existing',
        schedulerRevision: 6,
        reason: 'Already admitted',
      };
    }
    seen.set(schedulerRequest.occurrenceId, schedulerRequest.materialFingerprint);
    return {
      schemaVersion: 1,
      status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
      occurrenceId: schedulerRequest.occurrenceId,
      materialFingerprint: schedulerRequest.materialFingerprint,
      canonicalTaskId: 'task-drive-1',
      schedulerRevision: 5,
      reason: '',
    };
  };

  const first = await admitDriveChangeV1(request(), deps({
    admitCanonicalOccurrence: canonical,
  }));
  const duplicate = await admitDriveChangeV1(request(), deps({
    admitCanonicalOccurrence: canonical,
  }));
  const changed = await admitDriveChangeV1(request(), deps({
    trustedChange: change({
      evidenceArtifactRef: artifact({
        artifactId: 'drive-change-evidence-2',
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
});

test('noncanonical timestamp and opaque-token aliases fail closed', async () => {
  await assert.rejects(
    admitDriveChangeV1(
      request({ admittedAt: '2026-09-25T10:02:00Z' }),
      deps(),
    ),
    /canonical ISO-8601 UTC representation/u,
  );
  await assert.rejects(
    admitDriveChangeV1(
      request({ changeToken: ' page-token-123:ordinal-7 ' }),
      deps(),
    ),
    /bounded opaque ASCII/u,
  );
});
