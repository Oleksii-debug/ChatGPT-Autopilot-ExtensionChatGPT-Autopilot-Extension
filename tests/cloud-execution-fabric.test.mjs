import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CloudFabricAffinity,
  CloudFabricDisposition,
  assessCloudExecutionFabricV1,
  normalizeCloudExecutionSlotV1,
} from '../src/core/cloud-execution-fabric.js';
import {
  claimExecutionOwnershipV1,
  createExecutionOwnershipV1,
} from '../src/core/execution-plane-ownership.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function availableOwnership(at = '2026-09-25T10:00:00.000Z') {
  return createExecutionOwnershipV1({
    taskId: 'task-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    effectId: 'effect-1',
    policyEnvelopeId: 'policy-1',
    at,
  });
}

function ownedCloud({
  at = '2026-09-25T10:00:01.000Z',
  leaseUntil = '2026-09-25T10:30:00.000Z',
} = {}) {
  return claimExecutionOwnershipV1(availableOwnership(), {
    plane: 'CLOUD',
    ownerId: 'cloud-owner-1',
    leaseId: 'lease-1',
    leaseUntil,
    at,
  });
}

function provider(providerId = 'provider-a', overrides = {}) {
  return {
    schemaVersion: 1,
    providerId,
    toolId: '',
    health: 'READY',
    installationRequired: false,
    installed: true,
    authenticationRequired: false,
    authenticated: true,
    pathKind: 'API',
    latencyMs: 10,
    reasonCode: '',
    ...overrides,
  };
}

function slot(slotId = 'slot-a', overrides = {}) {
  return {
    schemaVersion: 1,
    slotId,
    providerId: 'provider-a',
    workspaceId: '',
    temperature: 'WARM',
    health: 'READY',
    capabilities: ['BROWSER', 'TERMINAL', 'FILESYSTEM'],
    availableUnits: 2,
    rateLimitRemaining: 100,
    estimatedStartupMs: 500,
    estimatedCostUsdMicros: 50,
    checkpointResumeSupported: true,
    artifactSyncSupported: true,
    secureScrubSupported: true,
    evidenceRetentionSupported: true,
    observedAt: '2026-09-25T10:00:01.000Z',
    expiresAt: '2026-09-25T10:20:00.000Z',
    ...overrides,
  };
}

function resourceBudget(maxCostUsdMicros = 1_000) {
  return {
    maxConcurrentAgents: 8,
    maxChildAgents: 8,
    maxModelCalls: 100,
    maxModelInputTokens: 100_000,
    maxModelOutputTokens: 100_000,
    maxRuntimeSeconds: 3_600,
    maxCostUsdMicros,
  };
}

function cloudResourceRequest(costUsdMicros = 100) {
  return {
    concurrentAgents: 1,
    runtimeSeconds: 120,
    costUsdMicros,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    agentId: 'agent-1',
    affinity: CloudFabricAffinity.CLOUD_PREFERRED,
    requiredCapabilities: ['BROWSER', 'FILESYSTEM'],
    localCapabilities: [],
    requiresCheckpointResume: true,
    checkpointArtifactId: 'checkpoint-artifact-1',
    checkpointSha256: SHA_A,
    executionOwnership: availableOwnership(),
    cloudSlots: [slot()],
    providerStates: [provider()],
    workspaceBindings: [],
    resourceBudget: resourceBudget(),
    resourceUsage: {},
    cloudResourceRequest: cloudResourceRequest(),
    assessedAt: '2026-09-25T10:05:00.000Z',
    ...overrides,
  };
}

function workspaceBinding(ownership, overrides = {}) {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-a',
    providerId: 'provider-a',
    workspaceRevision: 'workspace-revision-1',
    environmentSha256: SHA_A,
    checkpointArtifactId: 'checkpoint-artifact-1',
    checkpointSha256: SHA_B,
    taskId: ownership.taskId,
    planId: ownership.planId,
    nodeId: ownership.nodeId,
    effectId: ownership.effectId,
    policyEnvelopeId: ownership.policyEnvelopeId,
    executionOwnerId: ownership.ownerId,
    executionLeaseId: ownership.leaseId,
    executionOwnershipRevision: ownership.revision,
    baselineObservedAt: '2026-09-25T10:00:02.000Z',
    boundAt: '2026-09-25T10:00:03.000Z',
    observationTrust: 'UNVERIFIED_INPUT',
    executionAuthorized: false,
    resumeAuthorized: false,
    ...overrides,
  };
}

test('CLOUD_PREFERRED deterministically selects ready warm capacity without granting authority', () => {
  const result = assessCloudExecutionFabricV1(request({
    cloudSlots: [
      slot('slot-cold-cheap', {
        providerId: 'provider-b',
        temperature: 'COLD',
        estimatedCostUsdMicros: 10,
        estimatedStartupMs: 50,
      }),
      slot('slot-warm', {
        providerId: 'provider-a',
        temperature: 'WARM',
        estimatedCostUsdMicros: 80,
        estimatedStartupMs: 900,
      }),
    ],
    providerStates: [provider('provider-b'), provider('provider-a')],
  }));

  assert.equal(result.disposition, CloudFabricDisposition.CLOUD);
  assert.equal(result.selectedSlotId, 'slot-warm');
  assert.equal(result.selectedProviderId, 'provider-a');
  assert.equal(result.requiredExecutionTransition, 'CLAIM_CLOUD');
  assert.equal(result.workspaceProvisioningRequired, true);
  assert.equal(result.checkpointVerificationRequired, true);
  assert.equal(result.checkpointTransferRequired, true);
  assert.equal(result.artifactSyncRequired, true);
  assert.equal(result.teardownScrubVerificationRequired, true);
  assert.equal(result.workspaceContinuityVerified, false);
  assert.equal(result.capacityAuthority, 'UNVERIFIED_INPUT');
  assert.equal(result.providerReadinessAuthority, 'UNVERIFIED_INPUT');
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.dispatchAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.provisioningAuthorized, false);
  assert.equal(result.resumeAuthorized, false);
  assert.equal(result.teardownAuthorized, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.policyDecisionGranted, false);
});

test('LOCAL_ONLY never selects cloud capacity', () => {
  const result = assessCloudExecutionFabricV1(request({
    affinity: CloudFabricAffinity.LOCAL_ONLY,
    localCapabilities: ['FILESYSTEM', 'BROWSER'],
  }));

  assert.equal(result.disposition, CloudFabricDisposition.LOCAL);
  assert.equal(result.recommendedPlane, 'LOCAL');
  assert.equal(result.selectedSlotId, '');
  assert.equal(result.requiredExecutionTransition, 'CLAIM_LOCAL');
  assert.equal(result.reasonCode, 'LOCAL_ONLY_AFFINITY');
});

test('AUTO prefers a capable local path and uses cloud only when local capability is missing', () => {
  const local = assessCloudExecutionFabricV1(request({
    affinity: CloudFabricAffinity.AUTO,
    localCapabilities: ['BROWSER', 'FILESYSTEM'],
  }));
  assert.equal(local.disposition, CloudFabricDisposition.LOCAL);
  assert.equal(local.reasonCode, 'AUTO_LOCAL_CAPABLE');

  const cloud = assessCloudExecutionFabricV1(request({
    affinity: CloudFabricAffinity.AUTO,
    localCapabilities: ['FILESYSTEM'],
  }));
  assert.equal(cloud.disposition, CloudFabricDisposition.CLOUD);
  assert.equal(cloud.reasonCode, 'AUTO_CLOUD_REQUIRED_BY_CAPABILITY');
});

test('CLOUD_REQUIRED fails closed when the canonical resource envelope denies the request', () => {
  const result = assessCloudExecutionFabricV1(request({
    affinity: CloudFabricAffinity.CLOUD_REQUIRED,
    resourceBudget: resourceBudget(50),
    cloudResourceRequest: cloudResourceRequest(100),
  }));

  assert.equal(result.disposition, CloudFabricDisposition.BLOCKED);
  assert.equal(result.reasonCode, 'CLOUD_RESOURCE_BUDGET_DENIED');
  assert.equal(result.budgetDecision, 'DENY');
  assert.equal(result.candidateAssessments[0].reasonCode, 'RESOURCE_BUDGET_DENIED');
});

test('stale, capability-incomplete, capacity-empty, rate-exhausted and unsafe teardown slots are ineligible', () => {
  const result = assessCloudExecutionFabricV1(request({
    affinity: CloudFabricAffinity.CLOUD_REQUIRED,
    cloudSlots: [
      slot('slot-stale', {
        observedAt: '2026-09-25T09:00:00.000Z',
        expiresAt: '2026-09-25T09:30:00.000Z',
      }),
      slot('slot-capability', { capabilities: ['BROWSER'] }),
      slot('slot-capacity', { availableUnits: 0 }),
      slot('slot-rate', { rateLimitRemaining: 0 }),
      slot('slot-scrub', { secureScrubSupported: false }),
    ],
  }));

  assert.equal(result.disposition, CloudFabricDisposition.BLOCKED);
  assert.equal(result.reasonCode, 'NO_ELIGIBLE_CLOUD_SLOT');
  const reasons = Object.fromEntries(result.candidateAssessments.map(item => [item.slotId, item.reasonCode]));
  assert.equal(reasons['slot-stale'], 'STALE_SLOT_OBSERVATION');
  assert.equal(reasons['slot-capability'], 'CAPABILITY_MISMATCH');
  assert.equal(reasons['slot-capacity'], 'NO_CAPACITY');
  assert.equal(reasons['slot-rate'], 'RATE_LIMIT_EXHAUSTED');
  assert.equal(reasons['slot-scrub'], 'SECURE_SCRUB_UNAVAILABLE');
});

test('a live CLOUD owner requires exact existing workspace continuity binding and cannot silently migrate', () => {
  const ownership = ownedCloud();
  const missing = assessCloudExecutionFabricV1(request({
    affinity: CloudFabricAffinity.CLOUD_REQUIRED,
    executionOwnership: ownership,
    cloudSlots: [slot('slot-existing', { workspaceId: 'workspace-a' })],
    workspaceBindings: [],
  }));
  assert.equal(missing.disposition, CloudFabricDisposition.RECONCILE_REQUIRED);
  assert.equal(missing.reasonCode, 'CLOUD_WORKSPACE_BINDING_REQUIRED');

  const exact = assessCloudExecutionFabricV1(request({
    affinity: CloudFabricAffinity.CLOUD_REQUIRED,
    executionOwnership: ownership,
    cloudSlots: [slot('slot-existing', { workspaceId: 'workspace-a' })],
    workspaceBindings: [workspaceBinding(ownership)],
  }));
  assert.equal(exact.disposition, CloudFabricDisposition.CLOUD);
  assert.equal(exact.requiredExecutionTransition, 'NONE');
  assert.equal(exact.selectedWorkspaceId, 'workspace-a');
  assert.equal(exact.workspaceProvisioningRequired, false);
  assert.equal(exact.workspaceContinuityVerified, false);

  const mismatch = assessCloudExecutionFabricV1(request({
    affinity: CloudFabricAffinity.CLOUD_REQUIRED,
    executionOwnership: ownership,
    cloudSlots: [slot('slot-other', { workspaceId: 'workspace-b' })],
    workspaceBindings: [workspaceBinding(ownership)],
  }));
  assert.equal(mismatch.disposition, CloudFabricDisposition.BLOCKED);
  assert.equal(mismatch.reasonCode, 'NO_ELIGIBLE_CLOUD_SLOT');
  assert.equal(mismatch.candidateAssessments[0].reasonCode, 'CURRENT_CLOUD_WORKSPACE_MISMATCH');
});

test('expired execution ownership always requires reconciliation before fabric routing', () => {
  const ownership = ownedCloud({ leaseUntil: '2026-09-25T10:01:00.000Z' });
  const result = assessCloudExecutionFabricV1(request({
    executionOwnership: ownership,
    workspaceBindings: [workspaceBinding(ownership)],
  }));
  assert.equal(result.disposition, CloudFabricDisposition.RECONCILE_REQUIRED);
  assert.equal(result.reasonCode, 'EXECUTION_LEASE_EXPIRED');
  assert.equal(result.recommendedPlane, '');
});

test('checkpoint resume requires a complete exact artifact identity', () => {
  assert.throws(
    () => assessCloudExecutionFabricV1(request({ checkpointSha256: '' })),
    /checkpoint resume requires exact artifact identity/u,
  );
  assert.throws(
    () => assessCloudExecutionFabricV1(request({
      requiresCheckpointResume: false,
      checkpointArtifactId: 'checkpoint-artifact-1',
      checkpointSha256: '',
    })),
    /checkpoint identity must be complete/u,
  );
});

test('slot normalization rejects secret-shaped or noncanonical side fields', () => {
  assert.throws(
    () => normalizeCloudExecutionSlotV1({ ...slot(), token: 'secret' }),
    /unknown field/u,
  );
  assert.throws(
    () => normalizeCloudExecutionSlotV1({
      ...slot(),
      observedAt: '2026-09-25T12:00:01+02:00',
    }),
    /canonical ISO-8601/u,
  );
});

test('authority boundaries consume descriptor snapshots with zero ordinary getter reads', () => {
  let reads = 0;
  const rawSlot = new Proxy(slot(), {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const rawSlots = new Proxy([rawSlot], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const rawRequest = request({ cloudSlots: rawSlots });
  const requestProxy = new Proxy(rawRequest, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const result = assessCloudExecutionFabricV1(requestProxy);
  assert.equal(result.disposition, CloudFabricDisposition.CLOUD);
  assert.equal(reads, 0);
});

test('accessor-backed outer authority is rejected without executing the getter', () => {
  let reads = 0;
  const raw = request();
  Object.defineProperty(raw, 'affinity', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return CloudFabricAffinity.CLOUD_REQUIRED;
    },
  });

  assert.throws(
    () => assessCloudExecutionFabricV1(raw),
    /enumerable own data properties/u,
  );
  assert.equal(reads, 0);
});
