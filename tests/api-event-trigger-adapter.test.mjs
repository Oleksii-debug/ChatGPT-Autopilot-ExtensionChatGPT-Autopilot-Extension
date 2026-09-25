import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EventTriggerRuntimeStatus,
  EventTriggerSchedulerReceiptStatus,
} from '../src/core/event-trigger-runtime.js';
import {
  ApiResourceChangeKind,
  admitApiResourceChangeV1,
  normalizeApiMonitorBindingV1,
  normalizeApiResourceChangeV1,
} from '../src/core/api-event-trigger-adapter.js';

const T0 = '2026-09-25T10:00:00.000Z';
const T1 = '2026-09-25T10:01:00.000Z';
const T2 = '2026-09-25T10:02:00.000Z';
const SHA_A = 'a'.repeat(64);

function trigger(overrides = {}) {
  return {
    schemaVersion: 1,
    triggerId: 'api-trigger-1',
    triggerRevision: 3,
    agentId: 'agent-1',
    jobId: 'job-1',
    kind: 'API',
    providerId: 'api-monitor-provider',
    sourceBindingId: 'api-source-1',
    requiredCapabilityIds: ['api.monitor.read'],
    enabled: true,
    createdAt: T0,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'api-binding-1',
    bindingRevision: 5,
    triggerId: 'api-trigger-1',
    triggerRevision: 3,
    providerId: 'api-monitor-provider',
    sourceBindingId: 'api-source-1',
    monitorId: 'monitor-1',
    resourceId: 'resource-1',
    maxChangeAgeSeconds: 300,
    createdAt: T0,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'api-change-evidence-1',
    kind: 'api-change-evidence',
    uri: 'artifact://api/change-1',
    mediaType: 'application/json',
    sha256: SHA_A,
    sizeBytes: 96,
    createdAt: T1,
    producerInvocationId: null,
    sensitive: false,
    ...overrides,
  };
}

function change(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'api-binding-1',
    bindingRevision: 5,
    monitorId: 'monitor-1',
    resourceId: 'resource-1',
    changeId: 'change-42',
    changeKind: ApiResourceChangeKind.UPDATED,
    previousVersion: 'etag-v1',
    currentVersion: 'etag-v2',
    evidenceArtifactRef: artifact(),
    observedAt: T1,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    bindingId: 'api-binding-1',
    bindingRevision: 5,
    changeId: 'change-42',
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
    canonicalTaskId: 'task-api-1',
    schedulerRevision: 7,
    reason: '',
  }),
} = {}) {
  return {
    resolveTriggerDefinition: async () => trustedTrigger,
    resolveApiMonitorBinding: async () => trustedBinding,
    resolveApiResourceChange: async () => trustedChange,
    admitCanonicalOccurrence,
  };
}

test('trusted API change reaches canonical scheduler with exact resource identity', async () => {
  let calls = 0;
  let seen;
  const out = await admitApiResourceChangeV1(request(), deps({
    admitCanonicalOccurrence: async (schedulerRequest) => {
      calls += 1;
      seen = schedulerRequest;
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-api-1',
        schedulerRevision: 7,
        reason: '',
      };
    },
  }));

  assert.equal(calls, 1);
  assert.equal(seen.kind, 'API');
  assert.equal(seen.triggerId, 'api-trigger-1');
  assert.equal(seen.providerId, 'api-monitor-provider');
  assert.equal(seen.sourceBindingId, 'api-source-1');
  assert.match(seen.sourceEventId, /^api:[a-f0-9]{64}$/u);
  assert.equal(seen.payloadArtifactId, 'api-change-evidence-1');

  assert.equal(out.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(out.apiMonitorId, 'monitor-1');
  assert.equal(out.apiResourceId, 'resource-1');
  assert.equal(out.apiChangeId, 'change-42');
  assert.equal(out.apiChangeKind, ApiResourceChangeKind.UPDATED);
  assert.equal(out.apiPreviousVersion, 'etag-v1');
  assert.equal(out.apiCurrentVersion, 'etag-v2');
  assert.equal(out.providerNetworkAuthority, false);
  assert.equal(out.pollingAuthority, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(Object.isFrozen(out), true);
});

test('CREATED UPDATED and DELETED enforce exact version transition shapes', () => {
  const created = normalizeApiResourceChangeV1(change({
    changeKind: ApiResourceChangeKind.CREATED,
    previousVersion: '',
    currentVersion: 'v1',
  }));
  assert.equal(created.currentVersion, 'v1');

  const quotedEtag = normalizeApiResourceChangeV1(change({
    previousVersion: 'W/"etag-v1"',
    currentVersion: '"etag-v2"',
  }));
  assert.equal(quotedEtag.previousVersion, 'W/"etag-v1"');
  assert.equal(quotedEtag.currentVersion, '"etag-v2"');

  assert.throws(
    () => normalizeApiResourceChangeV1(change({
      changeKind: ApiResourceChangeKind.CREATED,
      previousVersion: 'old',
      currentVersion: 'v1',
    })),
    /CREATED requires empty previousVersion/u,
  );
  assert.throws(
    () => normalizeApiResourceChangeV1(change({
      previousVersion: 'same',
      currentVersion: 'same',
    })),
    /UPDATED requires distinct non-empty versions/u,
  );

  const deleted = normalizeApiResourceChangeV1(change({
    changeKind: ApiResourceChangeKind.DELETED,
    previousVersion: 'v2',
    currentVersion: '',
  }));
  assert.equal(deleted.currentVersion, '');
  assert.throws(
    () => normalizeApiResourceChangeV1(change({
      changeKind: ApiResourceChangeKind.DELETED,
      previousVersion: '',
      currentVersion: '',
    })),
    /DELETED requires non-empty previousVersion/u,
  );
});

test('trigger binding and resolved change substitutions fail before scheduler', async () => {
  let calls = 0;
  const stop = async () => {
    calls += 1;
    throw new Error('must not run');
  };

  await assert.rejects(
    admitApiResourceChangeV1(request(), deps({
      trustedTrigger: trigger({ kind: 'SITE' }),
      admitCanonicalOccurrence: stop,
    })),
    /must resolve an API trigger/u,
  );
  await assert.rejects(
    admitApiResourceChangeV1(request(), deps({
      trustedChange: change({ resourceId: 'resource-2' }),
      admitCanonicalOccurrence: stop,
    })),
    /resourceId does not match trusted binding/u,
  );
  await assert.rejects(
    admitApiResourceChangeV1(request(), deps({
      trustedChange: change({ changeId: 'change-43' }),
      admitCanonicalOccurrence: stop,
    })),
    /does not match requested changeId/u,
  );
  assert.equal(calls, 0);
});

test('stale or future API changes fail closed before scheduler admission', async () => {
  let calls = 0;
  const stop = async () => {
    calls += 1;
    throw new Error('must not run');
  };

  await assert.rejects(
    admitApiResourceChangeV1(
      request({ admittedAt: '2026-09-25T10:10:00.000Z' }),
      deps({ admitCanonicalOccurrence: stop }),
    ),
    /stale for configured binding window/u,
  );
  await assert.rejects(
    admitApiResourceChangeV1(
      request({ admittedAt: '2026-09-25T10:00:30.000Z' }),
      deps({ admitCanonicalOccurrence: stop }),
    ),
    /predates trusted change observation/u,
  );
  assert.equal(calls, 0);
});

test('API evidence is immutable ArtifactRef metadata and direct endpoint/auth material is rejected', () => {
  assert.throws(
    () => normalizeApiResourceChangeV1(change({
      evidenceArtifactRef: artifact({ kind: 'raw-api-response' }),
    })),
    /kind must be api-change-evidence/u,
  );
  assert.throws(
    () => normalizeApiResourceChangeV1(change({
      evidenceArtifactRef: artifact({ uri: 'https://api.example.test/private' }),
    })),
    /opaque artifact:\/\/ URI/u,
  );
  assert.throws(
    () => normalizeApiResourceChangeV1(change({
      evidenceArtifactRef: artifact({ sha256: SHA_A.toUpperCase() }),
    })),
    /canonical lowercase SHA-256/u,
  );

  for (const [key, value] of [
    ['url', 'https://api.example.test/private'],
    ['authorization', 'Bearer secret'],
    ['headers', {}],
    ['responseBody', 'secret'],
  ]) {
    assert.throws(
      () => normalizeApiResourceChangeV1({ ...change(), [key]: value }),
      /unknown field/u,
    );
  }
  assert.throws(
    () => normalizeApiMonitorBindingV1({ ...binding(), credentialRef: 'credential-1' }),
    /unknown field/u,
  );
});

test('descriptor-backed evidence and dependency accessors fail without execution', async () => {
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
    admitApiResourceChangeV1(request(), deps({
      trustedChange: change({ evidenceArtifactRef: hostile }),
      admitCanonicalOccurrence: async () => {
        schedulerCalls += 1;
        throw new Error('must not run');
      },
    })),
    /field sha256 must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);
  assert.equal(schedulerCalls, 0);

  const bad = deps();
  Object.defineProperty(bad, 'resolveApiResourceChange', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return async () => change();
    },
  });

  await assert.rejects(
    admitApiResourceChangeV1(request(), bad),
    /resolveApiResourceChange must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);
});

test('same trusted changeId keeps occurrence identity while changed material conflicts canonically', async () => {
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
        canonicalTaskId: 'task-api-existing',
        schedulerRevision: 8,
        reason: 'Already admitted',
      };
    }
    seen.set(schedulerRequest.occurrenceId, schedulerRequest.materialFingerprint);
    return {
      schemaVersion: 1,
      status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
      occurrenceId: schedulerRequest.occurrenceId,
      materialFingerprint: schedulerRequest.materialFingerprint,
      canonicalTaskId: 'task-api-1',
      schedulerRevision: 7,
      reason: '',
    };
  };

  const first = await admitApiResourceChangeV1(request(), deps({ admitCanonicalOccurrence: canonical }));
  const duplicate = await admitApiResourceChangeV1(request(), deps({ admitCanonicalOccurrence: canonical }));
  const changed = await admitApiResourceChangeV1(request(), deps({
    trustedChange: change({
      currentVersion: 'etag-v3',
      evidenceArtifactRef: artifact({
        artifactId: 'api-change-evidence-2',
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

test('noncanonical timestamps and representation aliases fail closed', async () => {
  await assert.rejects(
    admitApiResourceChangeV1(request({ admittedAt: '2026-09-25T10:02:00Z' }), deps()),
    /canonical ISO-8601 UTC representation/u,
  );
  await assert.rejects(
    admitApiResourceChangeV1(request({ changeId: ' change-42 ' }), deps()),
    /bounded canonical opaque text/u,
  );
  assert.throws(
    () => normalizeApiResourceChangeV1(change({ previousVersion: ' etag-v1 ' })),
    /bounded canonical opaque text/u,
  );
});
