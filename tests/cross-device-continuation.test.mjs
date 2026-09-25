import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CrossDeviceContinuationStatus,
  MAX_CROSS_DEVICE_CONTINUATION_TTL_MS,
  assessCrossDeviceContinuationV1,
} from '../src/core/cross-device-continuation.js';
import {
  claimExecutionOwnershipV1,
  createExecutionOwnershipV1,
  requestExecutionHandoffV1,
} from '../src/core/execution-plane-ownership.js';
import { createAgentCheckpointV1 } from '../src/core/agent-checkpoint.js';

const REQUESTED_AT = '2026-09-25T13:10:00.000Z';
const ASSESSED_AT = '2026-09-25T13:12:00.000Z';
const EXPIRES_AT = '2026-09-25T13:20:00.000Z';
const CHECKPOINT_AT = '2026-09-25T13:08:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function pendingOwnership(overrides = {}) {
  const available = createExecutionOwnershipV1({
    taskId: 'task-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    effectId: 'effect-1',
    policyEnvelopeId: 'policy-1',
    at: '2026-09-25T13:00:00.000Z',
  });
  const owned = claimExecutionOwnershipV1(available, {
    plane: 'LOCAL',
    ownerId: 'owner-local-1',
    leaseId: 'lease-1',
    leaseUntil: '2026-09-25T14:00:00.000Z',
    at: '2026-09-25T13:01:00.000Z',
  });
  const pending = requestExecutionHandoffV1(owned, {
    leaseId: 'lease-1',
    toPlane: 'CLOUD',
    handoffId: 'handoff-1',
    at: '2026-09-25T13:09:00.000Z',
  });
  return { ...pending, ...overrides };
}

async function checkpoint(overrides = {}) {
  return createAgentCheckpointV1({
    schemaVersion: 1,
    checkpointId: 'checkpoint-1',
    agentId: 'agent-1',
    jobId: 'job-1',
    planId: 'plan-1',
    planRevision: 7,
    internalStateRevision: 11,
    exactEffectLedgerRevision: 5,
    policyRevisionId: 'policy-revision-7',
    snapshotArtifact: {
      schemaVersion: 1,
      artifactId: 'artifact-checkpoint-1',
      kind: 'agent-state-checkpoint',
      uri: 'artifact://checkpoint-1',
      mediaType: 'application/json',
      sha256: SHA_A,
      sizeBytes: 128,
      createdAt: CHECKPOINT_AT,
      producerInvocationId: 'invocation-checkpoint-1',
      sensitive: true,
    },
    evidenceArtifactIds: ['evidence-checkpoint-1'],
    createdAt: CHECKPOINT_AT,
    ...overrides,
  });
}

function handoffCheckpointBinding(cp, ownership = pendingOwnership(), overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: ownership.taskId,
    planId: ownership.planId,
    nodeId: ownership.nodeId,
    effectId: ownership.effectId,
    handoffId: ownership.handoffId,
    executionOwnershipRevision: ownership.revision,
    checkpointId: cp.checkpointId,
    checkpointDigest: cp.checkpointDigest,
    boundAt: '2026-09-25T13:09:30.000Z',
    ...overrides,
  };
}

function head(overrides = {}) {
  return {
    schemaVersion: 1,
    agentId: 'agent-1',
    jobId: 'job-1',
    planId: 'plan-1',
    planRevision: 7,
    internalStateRevision: 11,
    exactEffectLedgerRevision: 5,
    policyRevisionId: 'policy-revision-7',
    unresolvedEffectIds: [],
    observedAt: '2026-09-25T13:11:00.000Z',
    ...overrides,
  };
}

function worldState(overrides = {}) {
  const baseObservation = {
    schemaVersion: 1,
    observationId: 'obs-target-1',
    scopeId: 'project-1',
    providerId: 'device-presence-provider',
    resourceId: 'device-target-1',
    revisionId: 'device-revision-7',
    contentSha256: SHA_B,
    observedAt: '2026-09-25T13:10:30.000Z',
    validUntil: '2026-09-25T13:30:00.000Z',
    evidenceArtifactIds: ['evidence-device-1'],
  };
  const snapshot = {
    schemaVersion: 1,
    snapshotId: 'snapshot-device-1',
    scopeId: 'project-1',
    revision: 7,
    observations: [baseObservation],
    capturedAt: '2026-09-25T13:10:40.000Z',
  };
  return {
    snapshot,
    currentObservations: [{
      ...baseObservation,
      observationId: 'obs-target-current-1',
      observedAt: '2026-09-25T13:11:30.000Z',
    }],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    continuationId: 'continuation-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    jobId: 'job-1',
    taskId: 'task-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    effectId: 'effect-1',
    policyEnvelopeId: 'policy-1',
    sourceOwnerId: 'owner-local-1',
    sourceDeviceId: 'device-source-1',
    targetDeviceId: 'device-target-1',
    targetPlane: 'CLOUD',
    handoffId: 'handoff-1',
    checkpointId: 'checkpoint-1',
    requestedAt: REQUESTED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

async function options(overrides = {}) {
  const cp = await checkpoint();
  const ownership = pendingOwnership();
  return {
    resolveExecutionOwnership: async () => ownership,
    resolveHandoffCheckpointBinding: async () => handoffCheckpointBinding(cp, ownership),
    resolveAgentCheckpoint: async () => cp,
    resolveAgentHead: async () => head(),
    resolveTargetWorldState: async () => worldState(),
    assessmentAt: ASSESSED_AT,
    ...overrides,
  };
}

test('fresh target device + exact pending handoff + current checkpoint yields advisory canonical-accept readiness only', async () => {
  const result = await assessCrossDeviceContinuationV1(request(), await options());
  assert.equal(result.status, CrossDeviceContinuationStatus.READY_FOR_CANONICAL_ACCEPT);
  assert.equal(result.reasonCode, 'READY');
  assert.equal(result.sourcePlane, 'LOCAL');
  assert.equal(result.targetPlane, 'CLOUD');
  assert.equal(result.handoffId, 'handoff-1');
  assert.equal(result.checkpointDigestVerified, true);
  assert.equal(result.checkpointSnapshotMaterialVerified, false);
  assert.equal(result.targetWorldStateFresh, true);
  assert.equal(result.targetObservationId, 'obs-target-current-1');
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.handoffAuthorized, false);
  assert.equal(result.acceptAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.resumeAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.policyDecisionGranted, false);
  assert.equal(result.sourceDeviceAuthenticated, false);
  assert.equal(result.targetDeviceAuthenticated, false);
  assert.equal(result.requiresCanonicalDeviceAuthentication, true);
  assert.equal(result.requiresCanonicalAcceptExecutionHandoff, true);
  assert.equal(result.requiresFreshPolicy, true);
  assert.equal(result.requiresFreshStateRecheck, true);
  assert.equal(result.requiresCheckpointSnapshotVerification, true);
  assert.equal(result.requiresExactEffectReconciliation, false);
  assert.equal(Object.isFrozen(result), true);
});

test('caller cannot substitute a different valid checkpoint with identical revision counters', async () => {
  const ownership = pendingOwnership();
  const bound = await checkpoint();
  const substituted = await checkpoint({
    checkpointId: 'checkpoint-2',
    snapshotArtifact: {
      schemaVersion: 1,
      artifactId: 'artifact-checkpoint-2',
      kind: 'agent-state-checkpoint',
      uri: 'artifact://checkpoint-2',
      mediaType: 'application/json',
      sha256: SHA_B,
      sizeBytes: 128,
      createdAt: CHECKPOINT_AT,
      producerInvocationId: 'invocation-checkpoint-2',
      sensitive: true,
    },
    evidenceArtifactIds: ['evidence-checkpoint-2'],
  });
  let downstreamReads = 0;
  const result = await assessCrossDeviceContinuationV1(
    request({ checkpointId: 'checkpoint-2' }),
    await options({
      resolveExecutionOwnership: async () => ownership,
      resolveAgentCheckpoint: async () => substituted,
      resolveHandoffCheckpointBinding: async () => handoffCheckpointBinding(bound, ownership),
      resolveAgentHead: async () => {
        downstreamReads += 1;
        return head();
      },
      resolveTargetWorldState: async () => {
        downstreamReads += 1;
        return worldState();
      },
    }),
  );
  assert.equal(result.status, CrossDeviceContinuationStatus.BLOCKED);
  assert.equal(result.reasonCode, 'HANDOFF_CHECKPOINT_BINDING_MISMATCH');
  assert.equal(result.acceptAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(downstreamReads, 0);
});

test('unresolved external effects require reconciliation and never authorize resume', async () => {
  const result = await assessCrossDeviceContinuationV1(
    request(),
    await options({ resolveAgentHead: async () => head({ unresolvedEffectIds: ['effect-unresolved-1'] }) }),
  );
  assert.equal(result.status, CrossDeviceContinuationStatus.RECONCILE_REQUIRED);
  assert.equal(result.reasonCode, 'UNRESOLVED_EXTERNAL_EFFECTS');
  assert.equal(result.unresolvedEffectCount, 1);
  assert.equal(result.resumeAuthorized, false);
  assert.equal(result.requiresExactEffectReconciliation, true);
});

test('checkpoint behind any current plan/internal/effect/policy revision requires reconciliation', async () => {
  const variants = [
    { planRevision: 8 },
    { internalStateRevision: 12 },
    { exactEffectLedgerRevision: 6 },
    { policyRevisionId: 'policy-revision-8' },
  ];
  for (const delta of variants) {
    const result = await assessCrossDeviceContinuationV1(
      request(),
      await options({ resolveAgentHead: async () => head(delta) }),
    );
    assert.equal(result.status, CrossDeviceContinuationStatus.RECONCILE_REQUIRED);
    assert.equal(result.reasonCode, 'CHECKPOINT_NOT_CURRENT');
    assert.equal(result.acceptAuthorized, false);
  }
});

test('stale target world-state projection blocks continuation', async () => {
  const stale = worldState();
  stale.currentObservations = [{
    ...stale.currentObservations[0],
    revisionId: 'device-revision-8',
    observedAt: '2026-09-25T13:11:40.000Z',
  }];
  const result = await assessCrossDeviceContinuationV1(
    request(),
    await options({ resolveTargetWorldState: async () => stale }),
  );
  assert.equal(result.status, CrossDeviceContinuationStatus.BLOCKED);
  assert.equal(result.reasonCode, 'TARGET_WORLD_STATE_STALE');
  assert.equal(result.targetWorldStateDrift[0].reason, 'REVISION_CHANGED');
  assert.equal(result.executionAuthorized, false);
});

test('target must be observed after continuation request', async () => {
  const stale = worldState();
  stale.snapshot = {
    ...stale.snapshot,
    capturedAt: '2026-09-25T13:10:10.000Z',
    observations: [{
      ...stale.snapshot.observations[0],
      observedAt: '2026-09-25T13:09:30.000Z',
      validUntil: '2026-09-25T13:30:00.000Z',
    }],
  };
  stale.currentObservations = [{
    ...stale.snapshot.observations[0],
    observationId: 'obs-target-current-old',
    observedAt: '2026-09-25T13:09:40.000Z',
  }];
  const result = await assessCrossDeviceContinuationV1(
    request(),
    await options({ resolveTargetWorldState: async () => stale }),
  );
  assert.equal(result.status, CrossDeviceContinuationStatus.BLOCKED);
  assert.equal(result.reasonCode, 'TARGET_DEVICE_NOT_OBSERVED_AFTER_REQUEST');
});

test('non-pending ownership and source lease expiry never become handoff-ready', async () => {
  const available = createExecutionOwnershipV1({
    taskId: 'task-1', planId: 'plan-1', nodeId: 'node-1', effectId: 'effect-1',
    policyEnvelopeId: 'policy-1', at: '2026-09-25T13:00:00.000Z',
  });
  const owned = claimExecutionOwnershipV1(available, {
    plane: 'LOCAL', ownerId: 'owner-local-1', leaseId: 'lease-1',
    leaseUntil: '2026-09-25T14:00:00.000Z', at: '2026-09-25T13:01:00.000Z',
  });
  const blocked = await assessCrossDeviceContinuationV1(
    request(),
    await options({ resolveExecutionOwnership: async () => owned }),
  );
  assert.equal(blocked.status, CrossDeviceContinuationStatus.BLOCKED);
  assert.equal(blocked.reasonCode, 'EXECUTION_HANDOFF_NOT_PENDING');

  const expired = pendingOwnership({ leaseUntil: '2026-09-25T13:11:00.000Z' });
  const reconcile = await assessCrossDeviceContinuationV1(
    request({ expiresAt: '2026-09-25T13:10:30.000Z' }),
    await options({ resolveExecutionOwnership: async () => expired }),
  );
  assert.equal(reconcile.status, CrossDeviceContinuationStatus.RECONCILE_REQUIRED);
  assert.equal(reconcile.reasonCode, 'SOURCE_EXECUTION_LEASE_EXPIRED');
});

test('request may not outlive source lease', async () => {
  const ownership = pendingOwnership({ leaseUntil: '2026-09-25T13:15:00.000Z' });
  const result = await assessCrossDeviceContinuationV1(
    request({ expiresAt: '2026-09-25T13:20:00.000Z' }),
    await options({ resolveExecutionOwnership: async () => ownership }),
  );
  assert.equal(result.status, CrossDeviceContinuationStatus.BLOCKED);
  assert.equal(result.reasonCode, 'REQUEST_OUTLIVES_SOURCE_LEASE');
});

test('exact authority representations fail closed before resolver execution', async () => {
  let resolverCalls = 0;
  const baseOptions = await options({
    resolveExecutionOwnership: async () => {
      resolverCalls += 1;
      return pendingOwnership();
    },
  });
  for (const bad of [
    request({ schemaVersion: '1' }),
    request({ targetPlane: 'cloud' }),
    request({ requestedAt: '2026-09-25T13:10:00Z' }),
    request({ sourceDeviceId: ' device-source-1' }),
    request({ targetDeviceId: 'device-source-1' }),
  ]) {
    await assert.rejects(() => assessCrossDeviceContinuationV1(bad, baseOptions));
  }
  assert.equal(resolverCalls, 0);
});

test('handoff checkpoint binding requires canonical checkpoint digest and exact ownership revision', async () => {
  const cp = await checkpoint();
  const ownership = pendingOwnership();

  for (const checkpointDigest of [
    cp.checkpointDigest.slice('sha256:'.length),
    cp.checkpointDigest.toUpperCase(),
  ]) {
    await assert.rejects(
      async () => assessCrossDeviceContinuationV1(
        request(),
        await options({
          resolveExecutionOwnership: async () => ownership,
          resolveAgentCheckpoint: async () => cp,
          resolveHandoffCheckpointBinding: async () => handoffCheckpointBinding(cp, ownership, { checkpointDigest }),
        }),
      ),
      /exact lowercase sha256 fingerprint representation/i,
    );
  }

  await assert.rejects(
    () => assessCrossDeviceContinuationV1(
      request(),
      await options({
        resolveExecutionOwnership: async () => ownership,
        resolveAgentCheckpoint: async () => cp,
        resolveHandoffCheckpointBinding: async () => handoffCheckpointBinding(cp, ownership, {
          executionOwnershipRevision: ownership.revision - 1,
        }),
      }),
    ),
    /does not match canonical execution ownership/i,
  );
});

test('handoff checkpoint binding time is causally bounded by ownership, checkpoint and request', async () => {
  const cp = await checkpoint();
  const ownership = pendingOwnership();
  for (const boundAt of [
    '2026-09-25T13:07:59.999Z',
    '2026-09-25T13:08:59.999Z',
    '2026-09-25T13:10:00.001Z',
  ]) {
    await assert.rejects(
      async () => assessCrossDeviceContinuationV1(
        request(),
        await options({
          resolveExecutionOwnership: async () => ownership,
          resolveAgentCheckpoint: async () => cp,
          resolveHandoffCheckpointBinding: async () => handoffCheckpointBinding(cp, ownership, { boundAt }),
        }),
      ),
      /binding chronology is invalid/i,
    );
  }

  const laterCheckpoint = await checkpoint({ createdAt: '2026-09-25T13:09:30.000Z' });
  await assert.rejects(
    () => assessCrossDeviceContinuationV1(
      request(),
      await options({
        resolveExecutionOwnership: async () => ownership,
        resolveAgentCheckpoint: async () => laterCheckpoint,
        resolveHandoffCheckpointBinding: async () => handoffCheckpointBinding(laterCheckpoint, ownership, {
          boundAt: '2026-09-25T13:09:15.000Z',
        }),
      }),
    ),
    /binding chronology is invalid/i,
  );
});

test('handoff checkpoint binding accepts exact causal boundary times', async () => {
  const cp = await checkpoint();
  const ownership = pendingOwnership();
  for (const boundAt of [ownership.updatedAt, REQUESTED_AT]) {
    const result = await assessCrossDeviceContinuationV1(
      request(),
      await options({
        resolveExecutionOwnership: async () => ownership,
        resolveAgentCheckpoint: async () => cp,
        resolveHandoffCheckpointBinding: async () => handoffCheckpointBinding(cp, ownership, { boundAt }),
      }),
    );
    assert.equal(result.status, CrossDeviceContinuationStatus.READY_FOR_CANONICAL_ACCEPT);
  }
});

test('continuation TTL is bounded', async () => {
  const tooLong = new Date(Date.parse(REQUESTED_AT) + MAX_CROSS_DEVICE_CONTINUATION_TTL_MS + 1).toISOString();
  await assert.rejects(
    async () => assessCrossDeviceContinuationV1(request({ expiresAt: tooLong }), await options()),
    /expiry is invalid/i,
  );
});

test('resolved ownership aliases fail closed instead of being normalized', async () => {
  await assert.rejects(
    async () => assessCrossDeviceContinuationV1(
      request(),
      await options({ resolveExecutionOwnership: async () => pendingOwnership({ ownerPlane: 'local' }) }),
    ),
    /exact canonical enum representation/i,
  );
  await assert.rejects(
    async () => assessCrossDeviceContinuationV1(
      request(),
      await options({ resolveExecutionOwnership: async () => pendingOwnership({ revision: '3' }) }),
    ),
    /positive safe integer/i,
  );
});

test('request accessors are rejected without executing getters or resolvers', async () => {
  let getterReads = 0;
  let resolverCalls = 0;
  const raw = request();
  Object.defineProperty(raw, 'targetDeviceId', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return 'device-target-1';
    },
  });
  const baseOptions = await options({
    resolveExecutionOwnership: async () => {
      resolverCalls += 1;
      return pendingOwnership();
    },
  });
  await assert.rejects(
    () => assessCrossDeviceContinuationV1(raw, baseOptions),
    /enumerable own data property/i,
  );
  assert.equal(getterReads, 0);
  assert.equal(resolverCalls, 0);
});

test('resolver accessors are rejected without getter execution', async () => {
  let getterReads = 0;
  const base = await options();
  Object.defineProperty(base, 'resolveTargetWorldState', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return async () => worldState();
    },
  });
  await assert.rejects(
    () => assessCrossDeviceContinuationV1(request(), base),
    /enumerable own data property|data method/i,
  );
  assert.equal(getterReads, 0);
});
