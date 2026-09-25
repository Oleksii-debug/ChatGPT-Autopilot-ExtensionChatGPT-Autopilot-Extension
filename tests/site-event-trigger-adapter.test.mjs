import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EventTriggerRuntimeStatus,
  EventTriggerSchedulerReceiptStatus,
} from '../src/core/event-trigger-runtime.js';
import {
  SiteChangeKind,
  admitSiteChangeV1,
  normalizeSiteChangeV1,
  normalizeSiteMonitorBindingV1,
} from '../src/core/site-event-trigger-adapter.js';

const T0 = '2026-09-25T10:00:00.000Z';
const T1 = '2026-09-25T10:01:00.000Z';
const T2 = '2026-09-25T10:02:00.000Z';
const SHA_A = 'a'.repeat(64);

function trigger(overrides = {}) {
  return {
    schemaVersion: 1,
    triggerId: 'site-trigger-1',
    triggerRevision: 3,
    agentId: 'agent-1',
    jobId: 'job-1',
    kind: 'SITE',
    providerId: 'site-monitor',
    sourceBindingId: 'site-monitor:owner-site',
    requiredCapabilityIds: ['site.events.read'],
    enabled: true,
    createdAt: T0,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'site-binding-1',
    bindingRevision: 4,
    triggerId: 'site-trigger-1',
    triggerRevision: 3,
    providerId: 'site-monitor',
    sourceBindingId: 'site-monitor:owner-site',
    monitorId: 'monitor-1',
    siteId: 'site-owner-1',
    resourceScopeId: 'scope-public-content',
    allowedChangeKinds: [
      SiteChangeKind.RESOURCE_CREATED,
      SiteChangeKind.RESOURCE_UPDATED,
      SiteChangeKind.RESOURCE_DELETED,
      SiteChangeKind.SITE_STATE_CHANGED,
    ],
    maxChangeAgeSeconds: 300,
    createdAt: T0,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'site-change-evidence-1',
    kind: 'site-change-evidence',
    uri: 'artifact://site/change-1',
    mediaType: 'application/json',
    sha256: SHA_A,
    sizeBytes: 121,
    createdAt: T1,
    producerInvocationId: null,
    sensitive: true,
    ...overrides,
  };
}

function change(overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId: 'site-binding-1',
    bindingRevision: 4,
    monitorId: 'monitor-1',
    siteId: 'site-owner-1',
    resourceScopeId: 'scope-public-content',
    changeId: 'change-0001',
    changeKind: SiteChangeKind.RESOURCE_UPDATED,
    resourceId: 'resource-page-42',
    evidenceArtifactRef: artifact(),
    observedAt: T1,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    bindingId: 'site-binding-1',
    bindingRevision: 4,
    changeId: 'change-0001',
    admittedAt: T2,
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
    canonicalTaskId: 'task-site-1',
    schedulerRevision: 9,
    reason: '',
  }),
} = {}) {
  return {
    resolveTriggerDefinition: async () => trustedTrigger,
    resolveSiteMonitorBinding: async () => trustedBinding,
    resolveSiteChange: async () => trustedChange,
    admitCanonicalOccurrence,
  };
}

test('trusted site change binds exact monitor identity to canonical scheduler without authority amplification', async () => {
  let calls = 0;
  let seen;
  const out = await admitSiteChangeV1(request(), deps({
    admitCanonicalOccurrence: async schedulerRequest => {
      calls += 1;
      seen = schedulerRequest;
      return {
        schemaVersion: 1,
        status: EventTriggerSchedulerReceiptStatus.ACCEPTED,
        occurrenceId: schedulerRequest.occurrenceId,
        materialFingerprint: schedulerRequest.materialFingerprint,
        canonicalTaskId: 'task-site-1',
        schedulerRevision: 9,
        reason: '',
      };
    },
  }));

  assert.equal(calls, 1);
  assert.equal(seen.kind, 'SITE');
  assert.equal(seen.triggerId, 'site-trigger-1');
  assert.equal(seen.providerId, 'site-monitor');
  assert.equal(seen.sourceBindingId, 'site-monitor:owner-site');
  assert.match(seen.sourceEventId, /^site:[a-f0-9]{64}$/u);
  assert.equal(seen.payloadArtifactId, 'site-change-evidence-1');
  assert.equal(seen.payloadSha256, SHA_A);

  assert.equal(out.status, EventTriggerRuntimeStatus.ACCEPTED);
  assert.equal(out.siteBindingId, 'site-binding-1');
  assert.equal(out.siteMonitorId, 'monitor-1');
  assert.equal(out.siteId, 'site-owner-1');
  assert.equal(out.siteResourceScopeId, 'scope-public-content');
  assert.equal(out.siteChangeId, 'change-0001');
  assert.equal(out.siteChangeKind, SiteChangeKind.RESOURCE_UPDATED);
  assert.equal(out.siteResourceId, 'resource-page-42');
  assert.equal(out.siteChangeFresh, true);
  assert.equal(out.providerNetworkAuthority, false);
  assert.equal(out.sitePollingAuthority, false);
  assert.equal(out.browserAuthority, false);
  assert.equal(out.cmsAuthority, false);
  assert.equal(out.credentialMaterialPersisted, false);
  assert.equal(out.cookieMaterialPersisted, false);
  assert.equal(out.rawSiteUrlPersisted, false);
  assert.equal(out.rawSiteContentPersisted, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.policyDecisionGranted, false);
  assert.equal(Object.isFrozen(out), true);
});

test('monitor, site, scope, change identity and allowlist drift fail before scheduler admission', async () => {
  const cases = [
    [change({ monitorId: 'monitor-2' }), /monitorId does not match trusted binding/u],
    [change({ siteId: 'site-owner-2' }), /siteId does not match trusted binding/u],
    [change({ resourceScopeId: 'scope-other' }), /resourceScopeId does not match trusted binding/u],
    [change({ changeId: 'change-0002' }), /does not match requested changeId/u],
    [
      change({ changeKind: SiteChangeKind.RESOURCE_DELETED }),
      /change kind is not allowed/u,
      binding({ allowedChangeKinds: [SiteChangeKind.RESOURCE_UPDATED] }),
    ],
  ];

  for (const [trustedChange, expected, trustedBinding = binding()] of cases) {
    let schedulerCalls = 0;
    await assert.rejects(
      admitSiteChangeV1(
        request(),
        deps({
          trustedBinding,
          trustedChange,
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

test('site change chronology and freshness use epoch order including extended years', async () => {
  let schedulerCalls = 0;
  const never = async () => {
    schedulerCalls += 1;
    throw new Error('must not run');
  };

  await assert.rejects(
    admitSiteChangeV1(
      request({ admittedAt: '2026-09-25T10:07:00.000Z' }),
      deps({ admitCanonicalOccurrence: never }),
    ),
    /stale for configured binding window/u,
  );

  await assert.rejects(
    admitSiteChangeV1(
      request({ admittedAt: T0 }),
      deps({ admitCanonicalOccurrence: never }),
    ),
    /admission predates trusted change observation/u,
  );

  await assert.rejects(
    admitSiteChangeV1(
      request(),
      deps({
        trustedChange: change({
          observedAt: '2026-09-25T09:59:59.000Z',
          evidenceArtifactRef: artifact({ createdAt: '2026-09-25T09:59:59.000Z' }),
        }),
        admitCanonicalOccurrence: never,
      }),
    ),
    /change predates trusted binding/u,
  );

  await assert.rejects(
    admitSiteChangeV1(
      request(),
      deps({
        trustedChange: change({
          evidenceArtifactRef: artifact({ createdAt: T2 }),
        }),
        admitCanonicalOccurrence: never,
      }),
    ),
    /evidence artifact cannot postdate observation/u,
  );
  assert.equal(schedulerCalls, 0);

  const triggerAt = '9999-12-31T23:59:59.000Z';
  const bindingAt = '+010000-01-01T00:00:00.000Z';
  const observedAt = '+010000-01-01T00:00:01.000Z';
  const admittedAt = '+010000-01-01T00:00:02.000Z';
  const out = await admitSiteChangeV1(
    request({ admittedAt }),
    deps({
      trustedTrigger: trigger({ createdAt: triggerAt }),
      trustedBinding: binding({ createdAt: bindingAt }),
      trustedChange: change({
        observedAt,
        evidenceArtifactRef: artifact({ createdAt: observedAt }),
      }),
    }),
  );
  assert.equal(out.status, EventTriggerRuntimeStatus.ACCEPTED);

  await assert.rejects(
    admitSiteChangeV1(
      request({ admittedAt }),
      deps({
        trustedTrigger: trigger({ createdAt: bindingAt }),
        trustedBinding: binding({ createdAt: triggerAt }),
        trustedChange: change({
          observedAt,
          evidenceArtifactRef: artifact({ createdAt: observedAt }),
        }),
        admitCanonicalOccurrence: never,
      }),
    ),
    /binding cannot predate/u,
  );
  assert.equal(schedulerCalls, 0);
});

test('binding requires SITE trigger and exact bounded unique change-kind allowlist', async () => {
  let schedulerCalls = 0;
  await assert.rejects(
    admitSiteChangeV1(
      request(),
      deps({
        trustedTrigger: trigger({ kind: 'WEBHOOK' }),
        admitCanonicalOccurrence: async () => {
          schedulerCalls += 1;
          throw new Error('must not run');
        },
      }),
    ),
    /must resolve a SITE trigger/u,
  );
  assert.equal(schedulerCalls, 0);

  assert.throws(
    () => normalizeSiteMonitorBindingV1(binding({
      allowedChangeKinds: [
        SiteChangeKind.RESOURCE_UPDATED,
        SiteChangeKind.RESOURCE_UPDATED,
      ],
    })),
    /contains duplicates/u,
  );

  assert.throws(
    () => normalizeSiteMonitorBindingV1(binding({
      allowedChangeKinds: ['resource_updated'],
    })),
    /allowedChangeKinds\[0\] is invalid/u,
  );

  const sparse = new Array(1);
  assert.throws(
    () => normalizeSiteMonitorBindingV1(binding({ allowedChangeKinds: sparse })),
    /must not be sparse/u,
  );

  assert.throws(
    () => normalizeSiteMonitorBindingV1(binding({ maxChangeAgeSeconds: 604801 })),
    /exceeds supported maximum/u,
  );
});

test('resource-level and site-level changes enforce exact resource identity shape', () => {
  assert.throws(
    () => normalizeSiteChangeV1(change({ resourceId: '' })),
    /resource change requires resourceId/u,
  );

  assert.throws(
    () => normalizeSiteChangeV1(change({
      changeKind: SiteChangeKind.SITE_STATE_CHANGED,
      resourceId: 'resource-page-42',
    })),
    /site-level change must not carry resourceId/u,
  );

  const siteState = normalizeSiteChangeV1(change({
    changeKind: SiteChangeKind.SITE_STATE_CHANGED,
    resourceId: '',
  }));
  assert.equal(siteState.resourceId, '');
});

test('raw URL, content, cookie and credential material cannot enter durable site schemas', () => {
  assert.throws(
    () => normalizeSiteChangeV1({
      ...change(),
      url: 'https://example.invalid/private',
    }),
    /unknown field: url/u,
  );
  assert.throws(
    () => normalizeSiteChangeV1({
      ...change(),
      html: '<html>secret</html>',
    }),
    /unknown field: html/u,
  );
  assert.throws(
    () => normalizeSiteChangeV1({
      ...change(),
      cookie: 'session=secret',
    }),
    /unknown field: cookie/u,
  );
  assert.throws(
    () => normalizeSiteMonitorBindingV1({
      ...binding(),
      credentialRef: 'credential-1',
    }),
    /unknown field: credentialRef/u,
  );
});

test('descriptor-backed evidence and dependency accessors fail without executing getters or scheduler', async () => {
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
    admitSiteChangeV1(
      request(),
      deps({
        trustedChange: change({ evidenceArtifactRef: hostileArtifact }),
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

  const badDeps = deps({
    admitCanonicalOccurrence: async () => {
      schedulerCalls += 1;
      throw new Error('must not run');
    },
  });
  Object.defineProperty(badDeps, 'resolveSiteChange', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return async () => change();
    },
  });

  await assert.rejects(
    admitSiteChangeV1(request(), badDeps),
    /resolveSiteChange must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);
  assert.equal(schedulerCalls, 0);
});

test('same trusted site change keeps occurrence identity while changed evidence conflicts canonically', async () => {
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
        canonicalTaskId: 'task-site-existing',
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
      canonicalTaskId: 'task-site-1',
      schedulerRevision: 9,
      reason: '',
    };
  };

  const first = await admitSiteChangeV1(request(), deps({
    admitCanonicalOccurrence: canonical,
  }));
  const duplicate = await admitSiteChangeV1(request(), deps({
    admitCanonicalOccurrence: canonical,
  }));
  const changed = await admitSiteChangeV1(request(), deps({
    trustedChange: change({
      evidenceArtifactRef: artifact({
        artifactId: 'site-change-evidence-2',
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

test('disabled SITE trigger performs zero scheduler admission', async () => {
  let schedulerCalls = 0;
  const out = await admitSiteChangeV1(
    request(),
    deps({
      trustedTrigger: trigger({ enabled: false }),
      admitCanonicalOccurrence: async () => {
        schedulerCalls += 1;
        throw new Error('must not run');
      },
    }),
  );

  assert.equal(out.status, EventTriggerRuntimeStatus.DISABLED);
  assert.equal(out.schedulerCalled, false);
  assert.equal(schedulerCalls, 0);
  assert.equal(out.executionAuthorized, false);
});

test('noncanonical timestamp, opaque change-id aliases and unsafe revisions fail closed', async () => {
  await assert.rejects(
    admitSiteChangeV1(
      request({ admittedAt: '2026-09-25T10:02:00Z' }),
      deps(),
    ),
    /canonical ISO-8601 UTC representation/u,
  );

  await assert.rejects(
    admitSiteChangeV1(
      request({ changeId: ' change-0001 ' }),
      deps(),
    ),
    /bounded opaque ASCII/u,
  );

  await assert.rejects(
    admitSiteChangeV1(
      request({ bindingRevision: '4' }),
      deps(),
    ),
    /positive safe integer/u,
  );
});
