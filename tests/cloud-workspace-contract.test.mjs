import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CloudWorkspaceContinuityStatus,
  CloudWorkspaceHealth,
  assessCloudWorkspaceContinuityV1,
  createCloudWorkspaceBindingV1,
  normalizeCloudWorkspaceBindingV1,
  normalizeCloudWorkspaceObservationV1,
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

test('binding authority flags cannot be forged', () => {
  const { binding } = bindingAndOwnership();
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
}
