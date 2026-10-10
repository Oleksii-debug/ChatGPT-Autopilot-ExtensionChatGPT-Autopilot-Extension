import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CloudWorkspaceContinuityStatus,
  CloudWorkspaceHealth,
  CloudWorkspaceObservationTrust,
  assessCloudWorkspaceContinuityV1,
  createCloudWorkspaceBindingV1,
  normalizeCloudWorkspaceBindingV1,
  normalizeCloudWorkspaceObservationV1,
  verifyCloudWorkspaceIsolationV1,
  teardownAndVerifyCloudWorkspaceV1,
  commitVerifiedCloudWorkspaceBindingV1,
  reconcileCloudWorkspaceBindingCommitV1,
} from '../src/core/cloud-workspace-contract.js';
import {
  claimExecutionOwnershipV1,
  createExecutionOwnershipV1,
  recoverExpiredExecutionOwnershipV1,
} from '../src/core/execution-plane-ownership.js';

const ENV_SHA = 'a'.repeat(64);
const CHECKPOINT_SHA = 'b'.repeat(64);

function cloudOwnership() {
  const available = createExecutionOwnershipV1({
    taskId: 'task.cloud.1',
    planId: 'plan.cloud.1',
    nodeId: 'node.cloud.1',
    effectId: 'effect.cloud.1',
    policyEnvelopeId: 'policy.cloud.1',
    at: '2026-09-25T06:00:00.000Z',
  });
  return claimExecutionOwnershipV1(available, {
    plane: 'CLOUD',
    ownerId: 'worker.cloud.1',
    leaseId: 'lease.cloud.1',
    leaseUntil: '2026-09-25T07:00:00.000Z',
    at: '2026-09-25T06:00:00.000Z',
  });
}

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace.cloud.1',
    providerId: 'cloud.provider.1',
    workspaceRevision: 'rev.10',
    environmentSha256: ENV_SHA,
    checkpointArtifactId: 'artifact.checkpoint.10',
    checkpointSha256: CHECKPOINT_SHA,
    taskId: 'task.cloud.1',
    planId: 'plan.cloud.1',
    nodeId: 'node.cloud.1',
    effectId: 'effect.cloud.1',
    policyEnvelopeId: 'policy.cloud.1',
    executionOwnerId: 'worker.cloud.1',
    executionLeaseId: 'lease.cloud.1',
    executionOwnershipRevision: 2,
    health: CloudWorkspaceHealth.READY,
    observerId: 'observer.cloud.1',
    observedAt: '2026-09-25T06:05:00.000Z',
    expiresAt: '2026-09-25T06:30:00.000Z',
    ...overrides,
  };
}

function bindingAndOwnership() {
  const ownership = cloudOwnership();
  const binding = createCloudWorkspaceBindingV1(
    observation(),
    ownership,
    { at: '2026-09-25T06:06:00.000Z' },
  );
  return { binding, ownership };
}

test('fresh persistent cloud workspace is ready only as non-authorizing runtime evidence', () => {
  const { binding, ownership } = bindingAndOwnership();
  const result = assessCloudWorkspaceContinuityV1(
    binding,
    observation({ observedAt: '2026-09-25T06:10:00.000Z', expiresAt: '2026-09-25T06:40:00.000Z' }),
    ownership,
    { at: '2026-09-25T06:11:00.000Z' },
  );

  assert.equal(result.status, CloudWorkspaceContinuityStatus.READY);
  assert.equal(result.workspaceReady, true);
  assert.equal(result.reasonCode, 'READY');
  assert.equal(result.observationTrust, CloudWorkspaceObservationTrust.UNVERIFIED_INPUT);
  assert.equal(result.providerObservationVerified, false);
  assert.equal(result.requiresCanonicalProviderObservation, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.resumeAuthorized, false);
  assert.equal(result.requiresCanonicalRuntime, true);
  assert.equal(result.requiresFreshPolicy, true);
  assert.equal(result.requiresCanonicalReconciliation, false);
  assert.equal(Object.isFrozen(result), true);
});

test('workspace revision, environment or checkpoint drift requires canonical reconciliation', () => {
  const { binding, ownership } = bindingAndOwnership();
  const variants = [
    { workspaceRevision: 'rev.11' },
    { environmentSha256: 'c'.repeat(64) },
    { checkpointArtifactId: 'artifact.checkpoint.11' },
    { checkpointSha256: 'd'.repeat(64) },
  ];

  for (const drift of variants) {
    const result = assessCloudWorkspaceContinuityV1(
      binding,
      observation({
        observedAt: '2026-09-25T06:10:00.000Z',
        expiresAt: '2026-09-25T06:40:00.000Z',
        ...drift,
      }),
      ownership,
      { at: '2026-09-25T06:11:00.000Z' },
    );
    assert.equal(result.status, CloudWorkspaceContinuityStatus.RECONCILE_REQUIRED);
    assert.equal(result.reasonCode, 'WORKSPACE_STATE_DRIFT');
    assert.equal(result.workspaceReady, false);
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.resumeAuthorized, false);
  }
});

test('expired, degraded and unavailable observations remain blocked', () => {
  const { binding, ownership } = bindingAndOwnership();

  const expired = assessCloudWorkspaceContinuityV1(
    binding,
    observation({ observedAt: '2026-09-25T06:10:00.000Z', expiresAt: '2026-09-25T06:11:00.000Z' }),
    ownership,
    { at: '2026-09-25T06:11:00.000Z' },
  );
  assert.equal(expired.status, CloudWorkspaceContinuityStatus.BLOCKED);
  assert.equal(expired.reasonCode, 'OBSERVATION_EXPIRED');

  for (const health of [CloudWorkspaceHealth.DEGRADED, CloudWorkspaceHealth.UNAVAILABLE]) {
    const result = assessCloudWorkspaceContinuityV1(
      binding,
      observation({ health, observedAt: '2026-09-25T06:10:00.000Z', expiresAt: '2026-09-25T06:40:00.000Z' }),
      ownership,
      { at: '2026-09-25T06:11:00.000Z' },
    );
    assert.equal(result.status, CloudWorkspaceContinuityStatus.BLOCKED);
    assert.equal(result.workspaceReady, false);
  }
});

test('expired or ambiguous canonical execution ownership never becomes workspace-ready', () => {
  const { binding, ownership } = bindingAndOwnership();

  const expired = assessCloudWorkspaceContinuityV1(
    binding,
    observation({ observedAt: '2026-09-25T06:50:00.000Z', expiresAt: '2026-09-25T07:30:00.000Z' }),
    ownership,
    { at: '2026-09-25T07:00:00.001Z' },
  );
  assert.equal(expired.status, CloudWorkspaceContinuityStatus.RECONCILE_REQUIRED);
  assert.equal(expired.reasonCode, 'EXECUTION_LEASE_EXPIRED');

  const reconcile = recoverExpiredExecutionOwnershipV1(ownership, {
    at: '2026-09-25T07:00:00.001Z',
    reason: 'cloud owner disappeared before verified completion',
  });
  const ambiguous = assessCloudWorkspaceContinuityV1(
    binding,
    observation({ executionOwnershipRevision: 3, observedAt: '2026-09-25T06:50:00.000Z', expiresAt: '2026-09-25T07:30:00.000Z' }),
    reconcile,
    { at: '2026-09-25T07:01:00.000Z' },
  );
  assert.equal(ambiguous.status, CloudWorkspaceContinuityStatus.RECONCILE_REQUIRED);
  assert.equal(ambiguous.reasonCode, 'EXECUTION_RECONCILIATION_REQUIRED');
  assert.equal(ambiguous.resumeAuthorized, false);
});

test('binding requires exact canonical CLOUD owner, lease and effect identity', () => {
  const ownership = cloudOwnership();

  assert.throws(() => createCloudWorkspaceBindingV1(
    observation({ effectId: 'effect.other' }),
    ownership,
    { at: '2026-09-25T06:06:00.000Z' },
  ), /does not match canonical execution ownership/);

  const localAvailable = createExecutionOwnershipV1({
    taskId: 'task.cloud.1',
    planId: 'plan.cloud.1',
    nodeId: 'node.cloud.1',
    effectId: 'effect.cloud.1',
    policyEnvelopeId: 'policy.cloud.1',
    at: '2026-09-25T06:00:00.000Z',
  });
  const local = claimExecutionOwnershipV1(localAvailable, {
    plane: 'LOCAL',
    ownerId: 'worker.cloud.1',
    leaseId: 'lease.cloud.1',
    leaseUntil: '2026-09-25T07:00:00.000Z',
    at: '2026-09-25T06:00:00.000Z',
  });
  assert.throws(() => createCloudWorkspaceBindingV1(
    observation(),
    local,
    { at: '2026-09-25T06:06:00.000Z' },
  ), /OWNED CLOUD/);
});

test('caller identity, enum, hash and timestamp aliases fail closed before canonical normalization', () => {
  const ownership = cloudOwnership();
  const badOwnershipPlane = { ...ownership, ownerPlane: 'cloud' };
  assert.throws(() => createCloudWorkspaceBindingV1(
    observation(),
    badOwnershipPlane,
    { at: '2026-09-25T06:06:00.000Z' },
  ), /exact canonical enum/);

  const badOwnershipTime = { ...ownership, updatedAt: '2026-09-25T06:00:00Z' };
  assert.throws(() => createCloudWorkspaceBindingV1(
    observation(),
    badOwnershipTime,
    { at: '2026-09-25T06:06:00.000Z' },
  ), /canonical ISO-8601 UTC/);

  assert.throws(() => normalizeCloudWorkspaceObservationV1(
    observation({ workspaceId: ' workspace.cloud.1' }),
  ), /exact canonical identity/);
  assert.throws(() => normalizeCloudWorkspaceObservationV1(
    observation({ health: 'ready' }),
  ), /exact canonical enum/);
  assert.throws(() => normalizeCloudWorkspaceObservationV1(
    observation({ environmentSha256: ENV_SHA.toUpperCase() }),
  ), /lowercase SHA-256/);
  assert.throws(() => normalizeCloudWorkspaceObservationV1(
    observation({ observedAt: '2026-09-25T06:05:00Z' }),
  ), /canonical ISO-8601 UTC/);
});

test('workspace observation and canonical ownership consume zero ordinary caller property reads', () => {
  let observationReads = 0;
  let ownershipReads = 0;
  const observationProxy = new Proxy(observation(), {
    get(target, property, receiver) {
      observationReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const ownershipProxy = new Proxy(cloudOwnership(), {
    get(target, property, receiver) {
      ownershipReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const binding = createCloudWorkspaceBindingV1(
    observationProxy,
    ownershipProxy,
    { at: '2026-09-25T06:06:00.000Z' },
  );
  assert.equal(observationReads, 0);
  assert.equal(ownershipReads, 0);
  assert.equal(binding.workspaceId, 'workspace.cloud.1');
});

test('hidden, accessor, symbol and secret-shaped fields are rejected without getter execution', () => {
  let getterReads = 0;
  const accessor = observation();
  Object.defineProperty(accessor, 'workspaceRevision', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'rev.10';
    },
  });
  assert.throws(() => normalizeCloudWorkspaceObservationV1(accessor), /own data properties/);
  assert.equal(getterReads, 0);

  const hidden = observation();
  Object.defineProperty(hidden, 'hiddenAuthority', { value: true, enumerable: false });
  assert.throws(() => normalizeCloudWorkspaceObservationV1(hidden), /non-enumerable/);

  const symbol = observation();
  symbol[Symbol('secret')] = 'credential';
  assert.throws(() => normalizeCloudWorkspaceObservationV1(symbol), /symbol field/);

  assert.throws(() => normalizeCloudWorkspaceObservationV1({
    ...observation(),
    accessToken: 'SECRET_DO_NOT_ACCEPT',
  }), /unknown field/);
});

test('binding trust and authority flags cannot be forged', () => {
  const { binding } = bindingAndOwnership();
  assert.equal(binding.observationTrust, CloudWorkspaceObservationTrust.UNVERIFIED_INPUT);
  assert.throws(() => normalizeCloudWorkspaceBindingV1({
    ...binding,
    observationTrust: 'VERIFIED_PROVIDER',
  }), /cannot self-assert trusted provider observation/);
  assert.throws(() => normalizeCloudWorkspaceBindingV1({
    ...binding,
    executionAuthorized: true,
  }), /cannot grant execution or resume authority/);
  assert.throws(() => normalizeCloudWorkspaceBindingV1({
    ...binding,
    resumeAuthorized: true,
  }), /cannot grant execution or resume authority/);
});

test('time-travel observations and stale execution identity are blocked', () => {
  const { binding, ownership } = bindingAndOwnership();

  const timeTravel = assessCloudWorkspaceContinuityV1(
    binding,
    observation({ observedAt: '2026-09-25T06:04:00.000Z', expiresAt: '2026-09-25T06:40:00.000Z' }),
    ownership,
    { at: '2026-09-25T06:11:00.000Z' },
  );
  assert.equal(timeTravel.status, CloudWorkspaceContinuityStatus.BLOCKED);
  assert.equal(timeTravel.reasonCode, 'OBSERVATION_TIME_INVALID');

  const staleRevision = assessCloudWorkspaceContinuityV1(
    binding,
    observation({ executionOwnershipRevision: 1, observedAt: '2026-09-25T06:10:00.000Z', expiresAt: '2026-09-25T06:40:00.000Z' }),
    ownership,
    { at: '2026-09-25T06:11:00.000Z' },
  );
  assert.equal(staleRevision.status, CloudWorkspaceContinuityStatus.BLOCKED);
  assert.equal(staleRevision.reasonCode, 'EXECUTION_BINDING_MISMATCH');
});

test('binding itself requires a fresh ready observation within the live lease', () => {
  const ownership = cloudOwnership();
  assert.throws(() => createCloudWorkspaceBindingV1(
    observation({ health: CloudWorkspaceHealth.DEGRADED }),
    ownership,
    { at: '2026-09-25T06:06:00.000Z' },
  ), /READY workspace health/);
  assert.throws(() => createCloudWorkspaceBindingV1(
    observation({ expiresAt: '2026-09-25T06:06:00.000Z' }),
    ownership,
    { at: '2026-09-25T06:06:00.000Z' },
  ), /fresh observation/);
  assert.throws(() => createCloudWorkspaceBindingV1(
    observation({ observedAt: '2026-09-25T06:07:00.000Z' }),
    ownership,
    { at: '2026-09-25T06:06:00.000Z' },
  ), /fresh observation/);
});

test('assessment option timestamp is data-only and cannot execute an accessor', () => {
  const { binding, ownership } = bindingAndOwnership();
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'at', {
    enumerable: true,
    get() {
      reads += 1;
      return '2026-09-25T06:11:00.000Z';
    },
  });
  assert.throws(() => assessCloudWorkspaceContinuityV1(
    binding,
    observation({ observedAt: '2026-09-25T06:10:00.000Z', expiresAt: '2026-09-25T06:40:00.000Z' }),
    ownership,
    options,
  ), /own data properties/);
  assert.equal(reads, 0);
});

test('lease deadline is exclusive for creation and persisted cloud continuity', () => {
  const ownership = cloudOwnership();
  assert.throws(() => createCloudWorkspaceBindingV1(
    observation({ observedAt: '2026-09-25T06:50:00.000Z', expiresAt: '2026-09-25T07:30:00.000Z' }),
    ownership,
    { at: ownership.leaseUntil },
  ), /live execution lease/u);
  const { binding } = bindingAndOwnership();
  const result = assessCloudWorkspaceContinuityV1(
    binding,
    observation({ observedAt: '2026-09-25T06:50:00.000Z', expiresAt: '2026-09-25T07:30:00.000Z' }),
    ownership,
    { at: ownership.leaseUntil },
  );
  assert.equal(result.status, CloudWorkspaceContinuityStatus.RECONCILE_REQUIRED);
  assert.equal(result.reasonCode, 'EXECUTION_LEASE_EXPIRED');
  assert.equal(result.resumeAuthorized, false);
});

test('rollback of assessment clock cannot make a future cloud binding ready', () => {
  const { binding, ownership } = bindingAndOwnership();
  const result = assessCloudWorkspaceContinuityV1(
    binding, observation(), ownership,
    { at: '2026-09-25T06:05:30.000Z' },
  );
  assert.equal(result.status, CloudWorkspaceContinuityStatus.BLOCKED);
  assert.equal(result.reasonCode, 'BINDING_FROM_FUTURE');
  assert.equal(result.executionAuthorized, false);
});

test('observation from before a later canonical ownership revision cannot bind a cloud lease', () => {
  const ownership = cloudOwnership();
  const revised = Object.freeze({ ...ownership, updatedAt: '2026-09-25T06:05:30.000Z' });
  assert.throws(
    () => createCloudWorkspaceBindingV1(observation(), revised, { at: '2026-09-25T06:06:00.000Z' }),
    /predates canonical ownership revision/u,
  );
});

const ISOLATION_AT = '2026-09-25T06:08:00.000Z';
const SCRUB_AT = '2026-09-25T06:10:00.000Z';
function isolationProof(overrides = {}) {
  return {
    workspaceId: 'workspace.cloud.1',
    providerId: 'cloud.provider.1',
    workspaceRevision: 'rev.10',
    environmentSha256: ENV_SHA,
    checkpointArtifactId: 'artifact.checkpoint.10',
    checkpointSha256: CHECKPOINT_SHA,
    executionLeaseId: 'lease.cloud.1',
    executionOwnershipRevision: 2,
    verifiedAt: '2026-09-25T06:07:00.000Z',
    filesystemIsolated: true,
    browserIsolated: true,
    processIsolated: true,
    ...overrides,
  };
}
function scrubProof(overrides = {}) {
  return {
    workspaceId: 'workspace.cloud.1',
    providerId: 'cloud.provider.1',
    workspaceRevision: 'rev.10',
    environmentSha256: ENV_SHA,
    checkpointArtifactId: 'artifact.checkpoint.10',
    checkpointSha256: CHECKPOINT_SHA,
    executionLeaseId: 'lease.cloud.1',
    executionOwnershipRevision: 2,
    verifiedAt: '2026-09-25T06:09:00.000Z',
    filesystemScrubbed: true,
    browserScrubbed: true,
    processesTerminated: true,
    secretsPurged: true,
    ...overrides,
  };
}
function teardownCompletion(overrides = {}) {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace.cloud.1',
    providerId: 'cloud.provider.1',
    workspaceRevision: 'rev.10',
    environmentSha256: ENV_SHA,
    checkpointArtifactId: 'artifact.checkpoint.10',
    checkpointSha256: CHECKPOINT_SHA,
    executionLeaseId: 'lease.cloud.1',
    executionOwnershipRevision: 2,
    completedAt: '2026-09-25T06:08:30.000Z',
    ...overrides,
  };
}
test('trusted cloud isolation adapter binds canonical owner and cannot authorize execution', async () => {
  let called = 0;
  const result = await verifyCloudWorkspaceIsolationV1(observation(), cloudOwnership(), {
    at: ISOLATION_AT,
    loadCanonicalOwnership: async () => cloudOwnership(),
    verifyIsolation: async target => {
      called++;
      assert.deepEqual(target, {
        workspaceId: 'workspace.cloud.1',
        providerId: 'cloud.provider.1',
        workspaceRevision: 'rev.10',
        environmentSha256: ENV_SHA,
        checkpointArtifactId: 'artifact.checkpoint.10',
        checkpointSha256: CHECKPOINT_SHA,
        executionLeaseId: 'lease.cloud.1',
        executionOwnershipRevision: 2,
      });
      assert.equal(Object.isFrozen(target), true);
      return isolationProof();
    },
  });
  assert.equal(called, 1);
  assert.equal(result.isolationVerified, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.resumeAuthorized, false);
  assert.equal(Object.isFrozen(result.binding), true);
});
test('cloud isolation proof rejects mismatched, incomplete, stale, future and forged adapter receipts', async () => {
  for (const mutation of [
    { workspaceId: 'workspace.other' },
    { workspaceRevision: 'rev.stale' },
    { workspaceRevision: undefined },
    { environmentSha256: 'c'.repeat(64) },
    { checkpointArtifactId: 'artifact.stale' },
    { checkpointSha256: 'd'.repeat(64) },
    { providerId: 'provider.other' },
    { executionLeaseId: 'lease.old' },
    { filesystemIsolated: false },
    { browserIsolated: false },
    { processIsolated: false },
    { verifiedAt: '2026-09-25T06:04:00.000Z' },
    { verifiedAt: '2026-09-25T06:09:00.000Z' },
    { processIsolated: 'true' },
    { unknown: true },
  ]) {
    await assert.rejects(
      () => verifyCloudWorkspaceIsolationV1(observation(), cloudOwnership(), {
        at: ISOLATION_AT,
        loadCanonicalOwnership: async () => cloudOwnership(),
    verifyIsolation: async () => isolationProof(mutation),
      }), /proof|unknown field/u,
    );
  }
  let getterReads = 0;
  const hostile = isolationProof();
  Object.defineProperty(hostile, 'processIsolated', {
    enumerable: true,
    get() { getterReads++; return true; },
  });
  await assert.rejects(() => verifyCloudWorkspaceIsolationV1(
    observation(), cloudOwnership(),
    { at: ISOLATION_AT, loadCanonicalOwnership: async () => cloudOwnership(),
    verifyIsolation: async () => hostile },
  ), /data properties/u);
  assert.equal(getterReads, 0);
});
test('cloud isolation rejects expired canonical ownership before trusted adapter invocation', async () => {
  let calls = 0;
  await assert.rejects(
    () => verifyCloudWorkspaceIsolationV1(observation(), cloudOwnership(), {
      at: '2026-09-25T07:00:00.000Z',
      loadCanonicalOwnership: async () => cloudOwnership(),
    verifyIsolation: async () => { calls++; return isolationProof(); },
    }), /live execution lease/u,
  );
  assert.equal(calls, 0);
});
test('trusted cloud teardown must verify filesystem/browser/process/secret scrub and remains non-authorizing', async () => {
  const { binding } = bindingAndOwnership();
  const calls = [];
  const receipt = await teardownAndVerifyCloudWorkspaceV1(
    JSON.parse(JSON.stringify(binding)), {
      at: SCRUB_AT, loadCanonicalOwnership: async () => cloudOwnership(),
      loadCanonicalBinding: async () => binding,
      teardown: async target => { calls.push('teardown'); assert.equal(target.workspaceId, binding.workspaceId); return teardownCompletion(); },
      verifyScrub: async () => { calls.push('verify'); return scrubProof(); },
    },
  );
  assert.deepEqual(calls, ['teardown', 'verify']);
  assert.equal(receipt.scrubVerified, true);
  assert.equal(receipt.leaseReleaseAuthorized, false);
  assert.equal(receipt.reuseAuthorized, false);
});
test('cloud teardown never reports clean on incomplete/hostile proof or failed teardown', async () => {
  const { binding } = bindingAndOwnership();
  for (const mutation of [
    { workspaceRevision: 'rev.stale' },
    { workspaceRevision: undefined },
    { environmentSha256: 'c'.repeat(64) },
    { checkpointArtifactId: 'artifact.stale' },
    { checkpointSha256: 'd'.repeat(64) },
    { filesystemScrubbed: false },
    { browserScrubbed: false },
    { processesTerminated: false },
    { secretsPurged: false },
    { executionLeaseId: 'lease.wrong' },
    { verifiedAt: '2026-09-25T06:05:00.000Z' },
    { verifiedAt: '2026-09-25T06:11:00.000Z' },
    { filesystemScrubbed: 1 },
  ]) {
    await assert.rejects(
      () => teardownAndVerifyCloudWorkspaceV1(binding, {
        at: SCRUB_AT, loadCanonicalOwnership: async () => cloudOwnership(), loadCanonicalBinding: async () => binding,
      teardown: async () => teardownCompletion(),
        verifyScrub: async () => scrubProof(mutation),
      }), /proof/u,
    );
  }
  let verified = false;
  await assert.rejects(
    () => teardownAndVerifyCloudWorkspaceV1(binding, {
      at: SCRUB_AT, loadCanonicalOwnership: async () => cloudOwnership(),
      loadCanonicalBinding: async () => binding,
      teardown: async () => { throw new Error('teardown failed'); },
      verifyScrub: async () => { verified = true; return scrubProof(); },
    }), /teardown failed/u,
  );
  assert.equal(verified, false);
});

test('S1 refuses stale pre-teardown scrub proof and never reports a clean lease', async () => {
  const { binding } = bindingAndOwnership();
  let readbacks = 0;
  await assert.rejects(
    () => teardownAndVerifyCloudWorkspaceV1(binding, {
      at: SCRUB_AT, loadCanonicalOwnership: async () => cloudOwnership(),
      loadCanonicalBinding: async () => { readbacks++; return binding; },
      teardown: async () => teardownCompletion(),
      verifyScrub: async () => scrubProof({ verifiedAt: '2026-09-25T06:08:29.000Z' }),
    }),
    /proof has stale or future verification chronology/u,
  );
  assert.equal(readbacks, 2, 'pre-teardown binding fence is checked but invalid proof never produces a clean receipt');
});

test('S1 requires versioned exact teardown completion before scrub verification', async () => {
  const { binding } = bindingAndOwnership();
  const invalid = [
    undefined,
    null,
    false,
    teardownCompletion({ schemaVersion: 2 }),
    teardownCompletion({ workspaceId: 'workspace.other' }),
    teardownCompletion({ providerId: 'provider.other' }),
    teardownCompletion({ executionLeaseId: 'lease.other' }),
    teardownCompletion({ completedAt: '2026-09-25T06:05:59.000Z' }),
    teardownCompletion({ completedAt: '2026-09-25T06:11:00.000Z' }),
    teardownCompletion({ extra: 'injected' }),
  ];
  for (const bad of invalid) {
    let scrubCalls = 0;
    await assert.rejects(
      () => teardownAndVerifyCloudWorkspaceV1(binding, {
        at: SCRUB_AT, loadCanonicalOwnership: async () => cloudOwnership(),
        loadCanonicalBinding: async () => binding,
        teardown: async () => bad,
        verifyScrub: async () => { scrubCalls++; return scrubProof(); },
      }),
      /teardown completion/u,
    );
    assert.equal(scrubCalls, 0, 'teardown failure must never trigger scrub attestation');
  }
  let getterReads = 0;
  const hostile = teardownCompletion();
  Object.defineProperty(hostile, 'completedAt', {
    enumerable: true,
    get() { getterReads++; return SCRUB_AT; },
  });
  await assert.rejects(
    () => teardownAndVerifyCloudWorkspaceV1(binding, {
      at: SCRUB_AT, loadCanonicalOwnership: async () => cloudOwnership(),
      loadCanonicalBinding: async () => binding,
      teardown: async () => hostile,
      verifyScrub: async () => { throw Error('should never verify'); },
    }),
    /own data properties/u,
  );
  assert.equal(getterReads, 0);
});

test('isolation refuses canonical ownership drift during asynchronous proof', async () => {
  let loads = 0;
  const validOwner = cloudOwnership();
  const newerOwner = { ...validOwner, revision: validOwner.revision + 1 };
  await assert.rejects(
    () => verifyCloudWorkspaceIsolationV1(observation(), validOwner, {
      at: ISOLATION_AT,
      loadCanonicalOwnership: async () => (++loads === 1 ? validOwner : newerOwner),
      verifyIsolation: async () => isolationProof(),
    }), /changed during isolation attestation/u,
  );
  assert.equal(loads, 2);
});
test('scrub rejects forged caller binding before any provider teardown', async () => {
  const { binding } = bindingAndOwnership();
  const forged = { ...binding, workspaceRevision: 'workspace.forged' };
  let teardowns = 0;
  await assert.rejects(
    () => teardownAndVerifyCloudWorkspaceV1(forged, {
      at: SCRUB_AT, loadCanonicalOwnership: async () => cloudOwnership(),
      loadCanonicalBinding: async () => binding,
      teardown: async () => { teardowns++; return teardownCompletion(); },
      verifyScrub: async () => scrubProof(),
    }), /does not match canonical binding/u,
  );
  assert.equal(teardowns, 0);
});

test('scrub does not accept a provider proof when canonical binding drifts after teardown', async () => {
  const { binding } = bindingAndOwnership();
  for (const driftOn of ['teardown', 'verification']) {
    let current = binding;
    let loads = 0;
    let teardowns = 0;
    let verifies = 0;
    await assert.rejects(
      () => teardownAndVerifyCloudWorkspaceV1(binding, {
        at: SCRUB_AT, loadCanonicalOwnership: async () => cloudOwnership(),
        loadCanonicalBinding: async () => { loads++; return current; },
        teardown: async () => {
          teardowns++;
          if (driftOn === 'teardown') {
            current = { ...binding, checkpointSha256: 'f'.repeat(64) };
          }
          return teardownCompletion();
        },
        verifyScrub: async () => {
          verifies++;
          if (driftOn === 'verification') {
            current = { ...binding, executionOwnershipRevision: binding.executionOwnershipRevision + 1 };
          }
          return scrubProof();
        },
      }),
      /canonical binding changed during teardown\/scrub/u,
    );
    assert.equal(loads, 3, 'pre-teardown and post-scrub canonical binding readbacks are mandatory');
    assert.equal(teardowns, 1);
    assert.equal(verifies, 1);
  }
});

test('scrub fails closed when final canonical binding readback fails', async () => {
  const { binding } = bindingAndOwnership();
  let loads = 0;
  await assert.rejects(
    () => teardownAndVerifyCloudWorkspaceV1(binding, {
      at: SCRUB_AT, loadCanonicalOwnership: async () => cloudOwnership(),
      loadCanonicalBinding: async () => {
        if (++loads === 3) throw new Error('canonical store readback unavailable');
        return binding;
      },
      teardown: async () => teardownCompletion(),
      verifyScrub: async () => scrubProof(),
    }),
    /canonical store readback unavailable/u,
  );
  assert.equal(loads, 3);
});

test('S1 scrub refuses stale canonical owner before any external teardown, even if binding matches', async () => {
  const { binding, ownership } = bindingAndOwnership();
  let teardownCalls = 0;
  for (const drift of [
    { revision: ownership.revision + 1 },
    { ownerId: 'worker.cloud.reassigned' },
    { leaseId: 'lease.cloud.reassigned' },
    { policyEnvelopeId: 'policy.cloud.replaced' },
    { ownerPlane: 'LOCAL' },
  ]) {
    await assert.rejects(() => teardownAndVerifyCloudWorkspaceV1(binding, {
      at: SCRUB_AT,
      loadCanonicalBinding: async () => binding,
      loadCanonicalOwnership: async () => ({ ...ownership, ...drift }),
      teardown: async () => { teardownCalls += 1; return teardownCompletion(); },
      verifyScrub: async () => scrubProof(),
    }), /canonical ownership mismatch/u);
  }
  assert.equal(teardownCalls, 0, 'no stale owner may trigger provider teardown');
});

test('S1 teardown refuses expired owner lease and rolled-back clocks before provider I/O', async () => {
  const { binding, ownership } = bindingAndOwnership();
  let teardownCalls = 0;
  let scrubCalls = 0;
  const scenarios = [
    { at: '2026-09-25T07:00:00.000Z', owner: ownership },
    { at: '2026-09-25T07:00:01.000Z', owner: ownership },
    { at: '2026-09-25T06:05:59.000Z', owner: ownership },
    { at: SCRUB_AT, owner: { ...ownership, updatedAt: '2026-09-25T06:11:00.000Z' } },
  ];
  for (const { at, owner } of scenarios) {
    await assert.rejects(() => teardownAndVerifyCloudWorkspaceV1(binding, {
      at,
      loadCanonicalBinding: async () => binding,
      loadCanonicalOwnership: async () => owner,
      teardown: async () => { teardownCalls++; return teardownCompletion(); },
      verifyScrub: async () => { scrubCalls++; return scrubProof(); },
    }), /live canonical owner lease/u);
  }
  assert.equal(teardownCalls, 0, 'stale ownership cannot delete cloud resources');
  assert.equal(scrubCalls, 0, 'invalid teardown cannot be attested as clean');
});

test('S1 scrub refuses owner changes across teardown or attestation with unchanged binding', async () => {
  const { binding, ownership } = bindingAndOwnership();
  for (const driftOn of ['teardown', 'attestation']) {
    let owner = ownership;
    let ownerLoads = 0;
    let providerTeardowns = 0;
    await assert.rejects(() => teardownAndVerifyCloudWorkspaceV1(binding, {
      at: SCRUB_AT,
      loadCanonicalBinding: async () => binding,
      loadCanonicalOwnership: async () => { ownerLoads += 1; return owner; },
      teardown: async () => {
        providerTeardowns += 1;
        if (driftOn === 'teardown') owner = { ...owner, revision: owner.revision + 1 };
        return teardownCompletion();
      },
      verifyScrub: async () => {
        if (driftOn === 'attestation') owner = { ...owner, leaseId: 'lease.cloud.reassigned' };
        return scrubProof();
      },
    }), /canonical ownership changed during teardown\/scrub/u);
    assert.equal(ownerLoads, 2, 'owner must be reloaded after scrub');
    assert.equal(providerTeardowns, 1);
  }
});

test('S1 scrub requires trusted canonical owner resolver and fails closed on final owner readback failure', async () => {
  const { binding } = bindingAndOwnership();
  let providerCalls = 0;
  await assert.rejects(() => teardownAndVerifyCloudWorkspaceV1(binding, {
    at: SCRUB_AT,
    loadCanonicalBinding: async () => binding,
    teardown: async () => { providerCalls += 1; return teardownCompletion(); },
    verifyScrub: async () => scrubProof(),
  }), /loadCanonicalOwnership/u);
  assert.equal(providerCalls, 0);
  let loads = 0;
  await assert.rejects(() => teardownAndVerifyCloudWorkspaceV1(binding, {
    at: SCRUB_AT,
    loadCanonicalBinding: async () => binding,
    loadCanonicalOwnership: async () => {
      if (++loads === 2) throw new Error('canonical owner store unavailable');
      return cloudOwnership();
    },
    teardown: async () => teardownCompletion(),
    verifyScrub: async () => scrubProof(),
  }), /canonical owner store unavailable/u);
  assert.equal(loads, 2);
});

test('S1 canonical runtime atomically persists the isolation-verified binding and reads it back', async () => {
  const owner = cloudOwnership();
  const store = { owner, binding: null, commits: 0 };
  const result = await commitVerifiedCloudWorkspaceBindingV1(observation(), owner, {
    at: ISOLATION_AT,
    loadCanonicalOwnership: async () => store.owner,
    verifyIsolation: async () => isolationProof(),
    atomicCommitCanonicalBinding: async tx => {
      assert.equal(tx.requireAtomicOwnerLeaseCompareAndSet, true);
      assert.equal(tx.requireExactCheckpoint, true);
      assert.equal(tx.expectedOwnershipRevision, owner.revision);
      assert.equal(tx.executionLeaseId, owner.leaseId);
      assert.equal(tx.binding.checkpointSha256, CHECKPOINT_SHA);
      assert.equal(Object.isFrozen(tx), true);
      store.binding = JSON.parse(JSON.stringify(tx.binding));
      store.commits++;
    },
    loadCanonicalBinding: async ({ workspaceId, executionLeaseId }) => {
      assert.equal(workspaceId, 'workspace.cloud.1');
      assert.equal(executionLeaseId, owner.leaseId);
      return store.binding;
    },
  });
  assert.equal(store.commits, 1);
  assert.equal(result.status, 'CANONICAL_BINDING_DURABLE_READBACK');
  assert.equal(result.isolationVerified, true);
  assert.equal(result.durableBindingVerified, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.resumeAuthorized, false);
  assert.equal(Object.isFrozen(result.binding), true);
});

test('S1 binding bridge fails closed on missing or forged canonical persistence', async () => {
  const owner = cloudOwnership();
  for (const mode of ['missing', 'checkpoint-drift', 'ownership-drift']) {
    let commits = 0;
    let storeOwner = owner;
    let binding = null;
    await assert.rejects(
      () => commitVerifiedCloudWorkspaceBindingV1(observation(), owner, {
        at: ISOLATION_AT,
        loadCanonicalOwnership: async () => storeOwner,
        verifyIsolation: async () => isolationProof(),
        atomicCommitCanonicalBinding: async tx => {
          commits++;
          binding = tx.binding;
          if (mode === 'ownership-drift') {
            storeOwner = { ...owner, revision: owner.revision + 1 };
          }
        },
        loadCanonicalBinding: async () => {
          if (mode === 'missing') return null;
          if (mode === 'checkpoint-drift') return { ...binding, checkpointSha256: 'f'.repeat(64) };
          return binding;
        },
      }),
      /not durably persisted|binding readback mismatch|ownership changed during binding commit/u,
    );
    assert.equal(commits, 1);
  }
});

test('S1 ambiguous canonical binding write recovers by read-only lookup without a second commit', async () => {
  const owner = cloudOwnership();
  let commits = 0;
  let persisted = null;
  await assert.rejects(
    () => commitVerifiedCloudWorkspaceBindingV1(observation(), owner, {
      at: ISOLATION_AT,
      loadCanonicalOwnership: async () => owner,
      verifyIsolation: async () => isolationProof(),
      atomicCommitCanonicalBinding: async tx => {
        commits++;
        persisted = JSON.parse(JSON.stringify(tx.binding));
        throw new Error('connection dropped after atomic commit');
      },
      loadCanonicalBinding: async () => persisted,
    }),
    /connection dropped after atomic commit/u,
  );
  assert.equal(commits, 1);
  const recovered = await reconcileCloudWorkspaceBindingCommitV1(persisted, {
    at: '2026-09-25T06:09:00.000Z',
    loadCanonicalBinding: async () => persisted,
    loadCanonicalOwnership: async () => owner,
  });
  assert.equal(recovered.status, 'CANONICAL_BINDING_DURABLE_READBACK');
  assert.equal(recovered.durableBindingVerified, true);
  assert.equal(recovered.safeRetryAuthorized, false);
  assert.equal(recovered.executionAuthorized, false);
  assert.equal(commits, 1);
  const absent = await reconcileCloudWorkspaceBindingCommitV1(persisted, {
    at: '2026-09-25T06:09:00.000Z',
    loadCanonicalBinding: async () => null,
    loadCanonicalOwnership: async () => owner,
  });
  assert.equal(absent.status, 'UNKNOWN_REQUIRES_CANONICAL_RECONCILIATION');
  assert.equal(absent.safeRetryAuthorized, false);
});

test('S1 recovery refuses a mismatched checkpoint without mutating canonical state', async () => {
  const { binding } = bindingAndOwnership();
  let lookups = 0;
  await assert.rejects(
    () => reconcileCloudWorkspaceBindingCommitV1(binding, {
      at: '2026-09-25T06:07:00.000Z',
      loadCanonicalOwnership: async () => cloudOwnership(),
      loadCanonicalBinding: async () => {
        lookups++;
        return { ...binding, environmentSha256: 'f'.repeat(64) };
      },
    }),
    /binding readback mismatch/u,
  );
  assert.equal(lookups, 1);
});


test('S1 read-only cold recovery never verifies a stolen, expired or clock-rewound cloud lease', async () => {
  const { binding, ownership } = bindingAndOwnership();
  const rawBinding = JSON.parse(JSON.stringify(binding));
  for (const [owner, at] of [
    [{ ...ownership, revision: ownership.revision + 1 }, '2026-09-25T06:07:00.000Z'],
    [{ ...ownership, ownerId: 'other.cloud.worker' }, '2026-09-25T06:07:00.000Z'],
    [ownership, '2026-09-25T07:00:00.000Z'],
    [ownership, '2026-09-25T06:05:00.000Z'],
  ]) {
    let bindingReads = 0;
    const result = await reconcileCloudWorkspaceBindingCommitV1(rawBinding, {
      at,
      loadCanonicalBinding: async () => { bindingReads++; return JSON.parse(JSON.stringify(rawBinding)); },
      loadCanonicalOwnership: async () => JSON.parse(JSON.stringify(owner)),
    });
    assert.equal(result.status, 'UNKNOWN_REQUIRES_CANONICAL_RECONCILIATION');
    assert.equal(result.durableBindingVerified, false);
    assert.equal(result.safeRetryAuthorized, false);
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.binding, null);
    assert.equal(bindingReads, 1);
  }
});

test('S1 post-crash recovery rechecks owner after asynchronous binding readback', async () => {
  const { binding, ownership } = bindingAndOwnership();
  let ownerReads = 0;
  let bindingReads = 0;
  const result = await reconcileCloudWorkspaceBindingCommitV1(
    JSON.parse(JSON.stringify(binding)), {
      at: '2026-09-25T06:07:00.000Z',
      loadCanonicalBinding: async () => {
        bindingReads++;
        return JSON.parse(JSON.stringify(binding));
      },
      loadCanonicalOwnership: async () => {
        ownerReads++;
        return ownerReads === 1 ? ownership : { ...ownership, revision: ownership.revision + 1 };
      },
    },
  );
  assert.equal(ownerReads, 2);
  assert.equal(bindingReads, 2);
  assert.equal(result.status, 'UNKNOWN_REQUIRES_CANONICAL_RECONCILIATION');
  assert.equal(result.binding, null);
  assert.equal(result.safeRetryAuthorized, false);
  assert.equal(result.durableBindingVerified, false);
});

test('S1 binding cold-recovery requires trusted canonical ownership callback and exact timestamp', async () => {
  const { binding, ownership } = bindingAndOwnership();
  let providerCalls = 0;
  for (const options of [
    { at: '2026-09-25T06:07:00.000Z', loadCanonicalBinding: async () => { providerCalls++; return binding; } },
    {
      at: '2026-09-25T06:07:00Z',
      loadCanonicalBinding: async () => { providerCalls++; return binding; },
      loadCanonicalOwnership: async () => ownership,
    },
  ]) {
    await assert.rejects(
      () => reconcileCloudWorkspaceBindingCommitV1(binding, options),
      /trusted loadCanonicalOwnership|canonical ISO-8601 UTC/u,
    );
  }
  assert.equal(providerCalls, 0);
});

test('S1 provider isolation proof refuses replay across owner revisions on same workspace and lease', async () => {
  const owner = cloudOwnership();
  const calls = { owners: 0, verifications: 0 };
  for (const forged of [
    isolationProof({ executionOwnershipRevision: 3 }),
    isolationProof({ executionOwnershipRevision: undefined }),
    JSON.parse(JSON.stringify(isolationProof({ executionOwnershipRevision: 1 }))),
  ]) {
    await assert.rejects(
      () => verifyCloudWorkspaceIsolationV1(observation(), owner, {
        at: ISOLATION_AT,
        loadCanonicalOwnership: async () => { calls.owners++; return owner; },
        verifyIsolation: async () => { calls.verifications++; return forged; },
      }),
      /exact cloud workspace\/lease identity/u,
    );
  }
  assert.equal(calls.verifications, 3);
  assert.equal(calls.owners, 6);
});

test('S1 teardown refuses revision-replayed completion or scrub, including cold JSON restart', async () => {
  const { binding } = bindingAndOwnership();
  for (const replayKind of ['completion', 'scrub']) {
    for (const revision of [1, 3, undefined]) {
      let verifications = 0;
      const trusted = {
        at: SCRUB_AT,
        loadCanonicalBinding: async () => JSON.parse(JSON.stringify(binding)),
        loadCanonicalOwnership: async () => JSON.parse(JSON.stringify(cloudOwnership())),
        teardown: async () => teardownCompletion(replayKind === 'completion'
          ? { executionOwnershipRevision: revision } : {}),
        verifyScrub: async () => {
          verifications++;
          return scrubProof(replayKind === 'scrub'
            ? { executionOwnershipRevision: revision } : {});
        },
      };
      await assert.rejects(
        () => teardownAndVerifyCloudWorkspaceV1(JSON.parse(JSON.stringify(binding)), trusted),
        /identity mismatch|exact cloud workspace\/lease identity/u,
      );
      assert.equal(verifications, replayKind === 'completion' ? 0 : 1);
    }
  }
});


test('S1 commit refuses a binding replaced during final async owner readback', async () => {
  const owner = cloudOwnership();
  let persisted = null;
  let ownerReads = 0;
  let commits = 0;
  let bindingReads = 0;
  await assert.rejects(
    () => commitVerifiedCloudWorkspaceBindingV1(observation(), owner, {
      at: ISOLATION_AT,
      verifyIsolation: async () => isolationProof(),
      loadCanonicalOwnership: async () => {
        ownerReads++;
        // Third owner lookup is the post-commit one; its await boundary
        // races a canonical binding deletion with an unchanged owner.
        if (ownerReads === 3) persisted = null;
        return owner;
      },
      atomicCommitCanonicalBinding: async tx => {
        commits++;
        persisted = JSON.parse(JSON.stringify(tx.binding));
      },
      loadCanonicalBinding: async () => {
        bindingReads++;
        return persisted;
      },
    }),
    /binding disappeared after owner readback/u,
  );
  assert.equal(commits, 1);
  assert.equal(ownerReads, 3);
  assert.equal(bindingReads, 2);
});

test('S1 cold recovery checks binding again after final owner await; never resends', async () => {
  const { binding, ownership } = bindingAndOwnership();
  let persisted = JSON.parse(JSON.stringify(binding));
  let ownerReads = 0;
  let bindingReads = 0;
  let commits = 0;
  const result = await reconcileCloudWorkspaceBindingCommitV1(persisted, {
    at: '2026-09-25T06:07:00.000Z',
    loadCanonicalBinding: async () => {
      bindingReads++;
      return persisted;
    },
    loadCanonicalOwnership: async () => {
      ownerReads++;
      if (ownerReads === 2) persisted = null;
      return ownership;
    },
  });
  assert.equal(result.status, 'UNKNOWN_REQUIRES_CANONICAL_RECONCILIATION');
  assert.equal(result.durableBindingVerified, false);
  assert.equal(result.binding, null);
  assert.equal(result.safeRetryAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(ownerReads, 2);
  assert.equal(bindingReads, 3);
  assert.equal(commits, 0);
});


test('S1 never tears down a workspace rebound while canonical owner lookup is in flight', async () => {
  const { binding, ownership } = bindingAndOwnership();
  for (const change of ['deleted', 'checkpoint-replaced']) {
    let persisted = JSON.parse(JSON.stringify(binding));
    let bindingReads = 0;
    let ownerReads = 0;
    let teardowns = 0;
    let scrubChecks = 0;
    await assert.rejects(
      () => teardownAndVerifyCloudWorkspaceV1(JSON.parse(JSON.stringify(binding)), {
        at: SCRUB_AT,
        loadCanonicalBinding: async () => {
          bindingReads++;
          return persisted;
        },
        loadCanonicalOwnership: async () => {
          ownerReads++;
          persisted = change === 'deleted' ? null
            : { ...persisted, checkpointSha256: 'f'.repeat(64) };
          return JSON.parse(JSON.stringify(ownership));
        },
        teardown: async () => { teardowns++; return teardownCompletion(); },
        verifyScrub: async () => { scrubChecks++; return scrubProof(); },
      }),
      /plain data object|canonical binding changed before provider teardown/u,
    );
    assert.equal(bindingReads, 2, 'a second durable binding read is required before provider teardown');
    assert.equal(ownerReads, 1);
    assert.equal(teardowns, 0, 'revoked/rebound binding must not trigger destructive teardown');
    assert.equal(scrubChecks, 0, 'no scrub receipt for an unauthorized teardown');
  }

  // A clean persisted binding still permits provider teardown attestation,
  // without granting lease release, reuse or execution authority.
  const { binding: goodBinding, ownership: goodOwner } = bindingAndOwnership();
  let cleanTeardowns = 0;
  const result = await teardownAndVerifyCloudWorkspaceV1(JSON.parse(JSON.stringify(goodBinding)), {
    at: SCRUB_AT,
    loadCanonicalBinding: async () => JSON.parse(JSON.stringify(goodBinding)),
    loadCanonicalOwnership: async () => JSON.parse(JSON.stringify(goodOwner)),
    teardown: async () => { cleanTeardowns++; return teardownCompletion(); },
    verifyScrub: async () => scrubProof(),
  });
  assert.equal(result.scrubVerified, true);
  assert.equal(result.leaseReleaseAuthorized, false);
  assert.equal(result.reuseAuthorized, false);
  assert.equal(cleanTeardowns, 1);
});

// Plan 5 S1: final callback ordering must not turn revoked canonical state
// into a positive scrub receipt after the provider has already been called.
test('S1 scrub rejects canonical binding deleted or replaced during the final owner await', async () => {
  const { binding, ownership } = bindingAndOwnership();
  for (const drift of ['deleted', 'checkpoint-replaced']) {
    let persisted = JSON.parse(JSON.stringify(binding));
    let ownerReads = 0;
    let bindingReads = 0;
    let teardownCalls = 0;
    let scrubCalls = 0;
    await assert.rejects(
      () => teardownAndVerifyCloudWorkspaceV1(JSON.parse(JSON.stringify(binding)), {
        at: SCRUB_AT,
        loadCanonicalBinding: async () => {
          bindingReads++;
          return persisted;
        },
        loadCanonicalOwnership: async () => {
          if (++ownerReads === 2) {
            persisted = drift === 'deleted' ? null
              : { ...persisted, checkpointSha256: 'f'.repeat(64) };
          }
          return JSON.parse(JSON.stringify(ownership));
        },
        teardown: async () => { teardownCalls++; return teardownCompletion(); },
        verifyScrub: async () => { scrubCalls++; return scrubProof(); },
      }),
      /plain data object|canonical binding changed after final owner readback/u,
    );
    assert.equal(ownerReads, 2);
    assert.equal(bindingReads, 4, 'pre-teardown and final post-owner readbacks are mandatory');
    assert.equal(teardownCalls, 1, 'uncertain teardown must not be blindly repeated');
    assert.equal(scrubCalls, 1, 'a stale prior scrub proof cannot authorize lease reuse');
  }
});

test('S1 scrub performs final canonical binding readback on clean JSON cold-restart receipt', async () => {
  const { binding, ownership } = bindingAndOwnership();
  let bindingReads = 0;
  let ownerReads = 0;
  let providerTeardowns = 0;
  const receipt = await teardownAndVerifyCloudWorkspaceV1(JSON.parse(JSON.stringify(binding)), {
    at: SCRUB_AT,
    loadCanonicalBinding: async () => {
      bindingReads++;
      return JSON.parse(JSON.stringify(binding));
    },
    loadCanonicalOwnership: async () => {
      ownerReads++;
      return JSON.parse(JSON.stringify(ownership));
    },
    teardown: async () => { providerTeardowns++; return teardownCompletion(); },
    verifyScrub: async () => scrubProof(),
  });
  assert.equal(receipt.scrubVerified, true);
  assert.equal(receipt.leaseReleaseAuthorized, false);
  assert.equal(receipt.reuseAuthorized, false);
  assert.equal(receipt.requiresCanonicalRuntime, true);
  assert.equal(bindingReads, 4);
  assert.equal(ownerReads, 2);
  assert.equal(providerTeardowns, 1);
});

test('S1 cloud observations redact hostile fields and Proxy reflection trap text', () => {
  const secret = 'PRIVATE_CLOUD_AUTH_SECRET_MUST_NOT_APPEAR';
  const variants = [
    { ...observation(), [secret]: 'injected' },
    new Proxy(observation(), { getPrototypeOf() { throw new Error(secret); } }),
    new Proxy(observation(), { ownKeys() { throw new Error(secret); } }),
    new Proxy(observation(), { getOwnPropertyDescriptor() { throw new Error(secret); } }),
  ];
  for (const hostile of variants) {
    assert.throws(
      () => normalizeCloudWorkspaceObservationV1(hostile),
      error => {
        assert.equal(error.message.includes(secret), false, 'untrusted secret must not enter diagnostics');
        assert.match(error.message, /unknown field|invalid own-data descriptors/u);
        return true;
      },
    );
  }
});

test('S1 hostile teardown receipt trap fails closed without secret leakage or scrub', async () => {
  const { binding, ownership } = bindingAndOwnership();
  const secret = 'PROVIDER_SECRET_SHOULD_STAY_PRIVATE';
  let scrubCalls = 0;
  await assert.rejects(
    () => teardownAndVerifyCloudWorkspaceV1(binding, {
      at: SCRUB_AT,
      loadCanonicalBinding: async () => JSON.parse(JSON.stringify(binding)),
      loadCanonicalOwnership: async () => JSON.parse(JSON.stringify(ownership)),
      teardown: async () => new Proxy(teardownCompletion(), {
        getOwnPropertyDescriptor() { throw new Error(secret); },
      }),
      verifyScrub: async () => { scrubCalls++; return scrubProof(); },
    }),
    error => {
      assert.equal(error.message.includes(secret), false, 'hostile provider text must not leak');
      assert.match(error.message, /invalid own-data descriptors/u);
      return true;
    },
  );
  assert.equal(scrubCalls, 0, 'a rejected provider receipt cannot trigger scrub verification');
});

test('S1 teardown completion is bound to exact workspace state across JSON restart', async () => {
  const { binding } = bindingAndOwnership();
  const alterations = [
    { workspaceRevision: 'rev.9' },
    { workspaceRevision: undefined },
    { environmentSha256: 'c'.repeat(64) },
    { environmentSha256: undefined },
    { checkpointArtifactId: 'artifact.checkpoint.9' },
    { checkpointArtifactId: undefined },
    { checkpointSha256: 'd'.repeat(64) },
    { checkpointSha256: undefined },
  ];
  for (const altered of alterations) {
    let scrubVerifications = 0;
    const durable = JSON.parse(JSON.stringify(binding));
    await assert.rejects(
      () => teardownAndVerifyCloudWorkspaceV1(durable, {
        at: SCRUB_AT,
        loadCanonicalBinding: async () => JSON.parse(JSON.stringify(binding)),
        loadCanonicalOwnership: async () => JSON.parse(JSON.stringify(cloudOwnership())),
        teardown: async target => {
          assert.equal(target.workspaceRevision, binding.workspaceRevision);
          assert.equal(target.checkpointSha256, binding.checkpointSha256);
          return JSON.parse(JSON.stringify(teardownCompletion(altered)));
        },
        verifyScrub: async () => { scrubVerifications++; return scrubProof(); },
      }),
      /teardown completion workspace state mismatch/u,
    );
    assert.equal(scrubVerifications, 0, 'old environment teardown cannot produce clean scrub evidence');
  }

  let scrubVerifications = 0;
  const verified = await teardownAndVerifyCloudWorkspaceV1(JSON.parse(JSON.stringify(binding)), {
    at: SCRUB_AT,
    loadCanonicalBinding: async () => JSON.parse(JSON.stringify(binding)),
    loadCanonicalOwnership: async () => JSON.parse(JSON.stringify(cloudOwnership())),
    teardown: async () => JSON.parse(JSON.stringify(teardownCompletion())),
    verifyScrub: async () => { scrubVerifications++; return scrubProof(); },
  });
  assert.equal(scrubVerifications, 1);
  assert.equal(verified.scrubVerified, true);
  assert.equal(verified.leaseReleaseAuthorized, false);
  assert.equal(verified.reuseAuthorized, false);
});
