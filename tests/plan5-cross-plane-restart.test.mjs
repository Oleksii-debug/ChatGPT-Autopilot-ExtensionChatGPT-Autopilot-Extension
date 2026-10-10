import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExecutionOwnershipV1,
  claimExecutionOwnershipV1,
  requestExecutionHandoffV1,
  acceptExecutionHandoffV1,
  recoverExpiredExecutionOwnershipV1,
  ExecutionOwnershipState,
} from '../src/core/execution-plane-ownership.js';
import {
  CloudWorkspaceContinuityStatus,
  createCloudWorkspaceBindingV1,
  assessCloudWorkspaceContinuityV1,
} from '../src/core/cloud-workspace-contract.js';
import {
  RemoteSteeringAction,
  assessRemoteSteeringCommandV1,
} from '../src/core/remote-steering-contract.js';

const ROOT = Object.freeze({
  taskId: 'task.plan5',
  planId: 'plan.plan5',
  nodeId: 'node.plan5',
  effectId: 'effect.plan5',
  policyEnvelopeId: 'policy.plan5',
});
const roundtrip = (data) => JSON.parse(JSON.stringify(data));
function ownedLocal() {
  const available = createExecutionOwnershipV1({ ...ROOT, at: '2026-10-10T10:00:00.000Z' });
  return claimExecutionOwnershipV1(available, {
    plane: 'LOCAL',
    ownerId: 'device.local',
    leaseId: 'lease.local',
    leaseUntil: '2026-10-10T10:10:00.000Z',
    at: '2026-10-10T10:00:00.000Z',
  });
}
function cloudOwner() {
  const handoff = requestExecutionHandoffV1(ownedLocal(), {
    leaseId: 'lease.local',
    toPlane: 'CLOUD',
    handoffId: 'handoff.local.cloud',
    at: '2026-10-10T10:01:00.000Z',
  });
  return acceptExecutionHandoffV1(roundtrip(handoff), {
    handoffId: 'handoff.local.cloud',
    ownerId: 'device.cloud',
    leaseId: 'lease.cloud',
    leaseUntil: '2026-10-10T10:20:00.000Z',
    at: '2026-10-10T10:02:00.000Z',
  });
}
function observation(owner, overrides = {}) {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace.plan5',
    providerId: 'provider.plan5',
    workspaceRevision: 'workspace.rev1',
    environmentSha256: 'a'.repeat(64),
    checkpointArtifactId: 'artifact.plan5',
    checkpointSha256: 'b'.repeat(64),
    ...ROOT,
    executionOwnerId: owner.ownerId,
    executionLeaseId: owner.leaseId,
    executionOwnershipRevision: owner.revision,
    health: 'READY',
    observerId: 'observer.plan5',
    observedAt: '2026-10-10T10:03:00.000Z',
    expiresAt: '2026-10-10T10:09:00.000Z',
    ...overrides,
  };
}

test('local-cloud handoff survives JSON restart and retains exact effect, checkpoint, policy and lease identity', () => {
  const owner = roundtrip(cloudOwner());
  assert.deepEqual([owner.taskId, owner.planId, owner.nodeId, owner.effectId, owner.policyEnvelopeId],
    [ROOT.taskId, ROOT.planId, ROOT.nodeId, ROOT.effectId, ROOT.policyEnvelopeId]);
  assert.equal(owner.state, ExecutionOwnershipState.OWNED);
  assert.equal(owner.ownerPlane, 'CLOUD');
  const binding = roundtrip(createCloudWorkspaceBindingV1(
    observation(owner), owner, { at: '2026-10-10T10:04:00.000Z' },
  ));
  assert.equal(binding.executionOwnershipRevision, owner.revision);
  assert.equal(binding.checkpointArtifactId, 'artifact.plan5');
  assert.equal(binding.checkpointSha256, 'b'.repeat(64));
  const continuity = assessCloudWorkspaceContinuityV1(
    binding,
    observation(owner, { observedAt: '2026-10-10T10:05:00.000Z' }),
    owner,
    { at: '2026-10-10T10:05:30.000Z' },
  );
  assert.equal(continuity.status, CloudWorkspaceContinuityStatus.READY);
  assert.equal(continuity.executionAuthorized, false);
  assert.equal(continuity.resumeAuthorized, false);
  assert.equal(continuity.requiresCanonicalRuntime, true);
});

test('cloud-local migration invalidates old cloud workspace and cannot silently re-accept a handoff', () => {
  const cloud = cloudOwner();
  const oldBinding = createCloudWorkspaceBindingV1(
    observation(cloud), cloud, { at: '2026-10-10T10:04:00.000Z' },
  );
  const handoff = requestExecutionHandoffV1(roundtrip(cloud), {
    leaseId: cloud.leaseId,
    toPlane: 'LOCAL',
    handoffId: 'handoff.cloud.local',
    at: '2026-10-10T10:06:00.000Z',
  });
  const local = acceptExecutionHandoffV1(roundtrip(handoff), {
    handoffId: handoff.handoffId,
    ownerId: 'device.local2',
    leaseId: 'lease.local2',
    leaseUntil: '2026-10-10T10:25:00.000Z',
    at: '2026-10-10T10:07:00.000Z',
  });
  assert.equal(local.ownerPlane, 'LOCAL');
  assert.equal(local.effectId, cloud.effectId);
  assert.equal(local.policyEnvelopeId, cloud.policyEnvelopeId);
  assert.throws(() => acceptExecutionHandoffV1(local, {
    handoffId: 'handoff.cloud.local',
    ownerId: 'attacker',
    leaseId: 'lease.duplicate',
    leaseUntil: '2026-10-10T10:30:00.000Z',
    at: '2026-10-10T10:08:00.000Z',
  }), /handoff identity mismatch/u);
  const stale = assessCloudWorkspaceContinuityV1(
    roundtrip(oldBinding),
    observation(cloud, { observedAt: '2026-10-10T10:07:30.000Z' }),
    roundtrip(local),
    { at: '2026-10-10T10:08:00.000Z' },
  );
  assert.equal(stale.status, CloudWorkspaceContinuityStatus.BLOCKED);
  assert.equal(stale.reasonCode, 'EXECUTION_NOT_CLOUD');
  assert.equal(stale.resumeAuthorized, false);
});

test('lost cloud owner after lease expiry always enters reconciliation rather than blind replay', () => {
  const cloud = cloudOwner();
  const lost = recoverExpiredExecutionOwnershipV1(roundtrip(cloud), {
    at: '2026-10-10T10:20:00.001Z',
  });
  assert.equal(lost.state, ExecutionOwnershipState.RECONCILE);
  assert.equal(lost.effectId, cloud.effectId);
  assert.equal(lost.leaseId, cloud.leaseId);
  assert.throws(() => claimExecutionOwnershipV1(lost, {
    plane: 'LOCAL',
    ownerId: 'device.new',
    leaseId: 'lease.retry',
    leaseUntil: '2026-10-10T10:30:00.000Z',
    at: '2026-10-10T10:21:00.000Z',
  }), /not available/u);
  const binding = createCloudWorkspaceBindingV1(
    observation(cloud), cloud, { at: '2026-10-10T10:04:00.000Z' },
  );
  const continuity = assessCloudWorkspaceContinuityV1(
    binding,
    observation(lost, { observedAt: '2026-10-10T10:21:00.000Z', expiresAt: '2026-10-10T10:23:00.000Z' }),
    lost,
    { at: '2026-10-10T10:21:30.000Z' },
  );
  assert.equal(continuity.status, CloudWorkspaceContinuityStatus.RECONCILE_REQUIRED);
  assert.equal(continuity.resumeAuthorized, false);
});

function steering(epoch) {
  return {
    command: {
      schemaVersion: 1,
      commandId: 'cmd.plan5',
      action: RemoteSteeringAction.STOP,
      jobId: 'job.plan5',
      planId: 'plan.plan5',
      expectedJobRevision: 5,
      expectedPlanRevision: 3,
      expectedControlEpoch: epoch,
      policyEnvelopeId: 'policy.plan5',
      sourcePrincipalId: 'owner.plan5',
      sourceDeviceId: 'mobile.device',
      sourceSessionId: 'session.mobile',
      issuedAt: '2026-10-10T10:08:20.000Z',
      expiresAt: '2026-10-10T10:09:00.000Z',
    },
  };
}
function trustedRemote(epoch) {
  return {
    schemaVersion: 1,
    jobId: 'job.plan5',
    planId: 'plan.plan5',
    jobRevision: 5,
    planRevision: 3,
    controlEpoch: epoch,
    policyEnvelopeId: 'policy.plan5',
    observedAt: '2026-10-10T10:08:25.000Z',
  };
}
test('remote STOP after restart remains non-authorizing and rejects stale cross-device control epochs', async () => {
  const options = {
    assessmentAt: '2026-10-10T10:08:30.000Z',
    resolveCurrentSnapshot: async () => roundtrip(trustedRemote(12)),
  };
  const good = await assessRemoteSteeringCommandV1(roundtrip(steering(12)), options);
  assert.equal(good.action, RemoteSteeringAction.STOP);
  assert.equal(good.controlEpochBound, true);
  assert.equal(good.mutationAuthorized, false);
  assert.equal(good.requiresCanonicalPrincipalAuthentication, true);
  assert.equal(good.requiresCanonicalControlEpochRecheck, true);
  await assert.rejects(() => assessRemoteSteeringCommandV1(
    roundtrip(steering(11)), options,
  ), /control epoch/u);
  await assert.rejects(() => assessRemoteSteeringCommandV1(
    roundtrip(steering(12)), {
      ...options,
      resolveCurrentSnapshot: async () => roundtrip(trustedRemote(13)),
    },
  ), /control epoch/u);
});
