import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import {
  TrustedExecutionVerificationLedgerRepository,
} from '../src/core/trusted-execution-verification-ledger.js';

const T0 = '2026-09-29T00:00:00.000Z';
const T1 = '2026-09-29T00:01:00.000Z';
const T2 = '2026-09-29T00:02:00.000Z';
const T3 = '2026-09-29T00:03:00.000Z';
const T4 = '2026-09-29T00:04:00.000Z';
const T5 = '2026-09-29T00:05:00.000Z';
const T6 = '2026-09-29T01:00:00.000Z';

function makeChrome() {
  const data = Object.create(null);
  return {
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) {
            const result = {};
            for (const item of key) {
              if (Object.hasOwn(data, item)) result[item] = structuredClone(data[item]);
            }
            return result;
          }
          return Object.hasOwn(data, key)
            ? { [key]: structuredClone(data[key]) }
            : {};
        },
        async set(values) {
          Object.assign(data, structuredClone(values));
        },
      },
    },
    alarms: {
      async create() {},
      async clear() { return true; },
      async get() { return null; },
    },
  };
}

function plan({ jobId, planId, policyEnvelopeId }) {
  return {
    schemaVersion: 1,
    planId,
    jobId,
    objective: 'Complete specialist work safely.',
    successCriteria: ['Specialist effect independently verified.'],
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
    nodes: [
      {
        nodeId: 'inspect',
        title: 'Inspect',
        objective: 'Inspect prerequisite.',
        dependsOn: [],
        conflictKeys: ['browser:inspect'],
        ownerId: 'parent',
        executionPlane: 'BROWSER',
        acceptanceCriteria: [],
        budget: {},
        state: 'VERIFIED',
        evidence: 'Prerequisite verified.',
        updatedAt: T0,
      },
      {
        nodeId: 'archive',
        title: 'Archive',
        objective: 'Create archive.',
        dependsOn: ['inspect'],
        conflictKeys: ['files:archive'],
        ownerId: 'parent',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Archive exists.'],
        budget: {},
        state: 'PENDING',
        evidence: '',
        updatedAt: T0,
      },
    ],
    policyEnvelopeId,
  };
}

async function seedSpecialist(manager, {
  jobId,
  planId,
  policyEnvelopeId,
  deadlineAt = T6,
} = {}) {
  await manager.create({ id: jobId, goal: 'Complete one bounded specialist task.' });
  await manager.update(store => {
    store.byId[jobId].runtime.plan = plan({ jobId, planId, policyEnvelopeId });
    return store;
  });
  await manager.prepareSpecialistHandoff(jobId, {
    nodeId: 'archive',
    specialistId: 'native-companion',
    requestedCapabilityIds: ['filesystem.archive'],
    parentCapabilityIds: ['filesystem.archive'],
    policyEnvelopeId,
    deadlineAt,
    priority: 4,
  });
}

function proofArtifact({
  artifactId,
  createdAt = T2,
  sha = 'b'.repeat(64),
} = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'specialist-result',
    uri: `file://workspace/${artifactId.replace(/[:/]/gu, '-')}.bin`,
    mediaType: 'application/octet-stream',
    sha256: sha,
    sizeBytes: 64,
    createdAt,
    producerInvocationId: 'invoke:specialist-verifier',
    sensitive: false,
  };
}

function trustedRecordFromOwnership(ownership, {
  recordId,
  verificationId,
  outcome,
  artifactId,
  verifiedAt = T3,
  recordedAt = T4,
  validThrough = T6,
} = {}) {
  const artifact = proofArtifact({ artifactId });
  return {
    schemaVersion: 1,
    recordId,
    taskId: ownership.taskId,
    planId: ownership.planId,
    nodeId: ownership.nodeId,
    effectId: ownership.effectId,
    policyEnvelopeId: ownership.policyEnvelopeId,
    executionId: ownership.leaseId,
    outcome,
    verification: {
      schemaVersion: 1,
      verificationId,
      invocationId: 'invoke:specialist-verifier',
      observationId: 'observation:specialist-verifier',
      status: 'VERIFIED',
      reasonCode: outcome === 'NO_EFFECT_VERIFIED'
        ? 'NO_EFFECT_OBSERVED'
        : 'RESULT_POSTCONDITION_MATCH',
      summary: 'Independent verifier resolved exact specialist execution.',
      evidenceArtifactIds: [artifact.artifactId],
      verifiedAt,
      verifierId: 'independent-specialist-verifier',
      verificationAuthorityId: ownership.policyEnvelopeId,
      effectId: ownership.effectId,
      executionId: ownership.leaseId,
      attempt: 1,
    },
    evidenceArtifacts: [artifact],
    recordedAt,
    validThrough,
  };
}

test('BrowserAgent advances completed Specialist to VERIFIED only through durable trusted ledger resolver', async () => {
  const chrome = makeChrome();
  let now = Date.parse(T1);
  const ledger = new TrustedExecutionVerificationLedgerRepository(chrome);
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => now,
    resolveTrustedExecutionVerificationRecord: ledger.resolver(),
  });

  await seedSpecialist(manager, {
    jobId: 'job.trusted.complete',
    planId: 'plan.trusted.complete',
    policyEnvelopeId: 'policy:trusted-complete',
  });
  const claimed = await manager.claimSpecialistHandoffs(
    'job.trusted.complete',
    { availableSlots: 1, leaseSeconds: 600, at: T1 },
  );
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;
  const ownership = claimed.executionOwnerships[0];

  now = Date.parse(T2);
  await manager.completeSpecialistHandoff('job.trusted.complete', {
    agentId,
    leaseId,
    resultArtifactIds: ['artifact:archive'],
    at: T2,
  });

  await ledger.append(trustedRecordFromOwnership(ownership, {
    recordId: 'trusted-record:complete:1',
    verificationId: 'verification:complete:1',
    outcome: 'EFFECT_VERIFIED',
    artifactId: 'artifact:archive',
  }));

  now = Date.parse(T5);
  const verified = await manager.verifySpecialistHandoff(
    'job.trusted.complete',
    {
      agentId,
      leaseId,
      verificationId: 'verification:complete:1',
      at: T5,
    },
  );

  assert.equal(
    verified.plan.nodes.find(node => node.nodeId === 'archive').state,
    'VERIFIED',
  );
  assert.equal(verified.executionOwnerships[0].state, 'VERIFIED');
  assert.equal(verified.trustedVerification.recordId, 'trusted-record:complete:1');

  const durable = await manager.get('job.trusted.complete');
  const history = durable.job.runtime.history.at(-1);
  assert.equal(history.type, 'specialist-handoff-verified');
  assert.equal(history.trustedRecordId, 'trusted-record:complete:1');
  assert.equal(history.verificationId, 'verification:complete:1');
  assert.equal(history.verifierId, 'independent-specialist-verifier');

  const restarted = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => now,
    resolveTrustedExecutionVerificationRecord: ledger.resolver(),
  });
  const afterRestart = await restarted.listSpecialistHandoffs('job.trusted.complete');
  assert.equal(afterRestart.executionOwnerships[0].state, 'VERIFIED');
});

test('BrowserAgent releases RECONCILE to READY only through durable NO_EFFECT trusted record', async () => {
  const chrome = makeChrome();
  let now = Date.parse(T1);
  const ledger = new TrustedExecutionVerificationLedgerRepository(chrome);
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => now,
    resolveTrustedExecutionVerificationRecord: ledger.resolver(),
  });

  await seedSpecialist(manager, {
    jobId: 'job.trusted.retry',
    planId: 'plan.trusted.retry',
    policyEnvelopeId: 'policy:trusted-retry',
  });
  const claimed = await manager.claimSpecialistHandoffs(
    'job.trusted.retry',
    { availableSlots: 1, leaseSeconds: 30, at: T1 },
  );
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;

  now = Date.parse(T2);
  const expired = await manager.claimSpecialistHandoffs(
    'job.trusted.retry',
    { availableSlots: 1, at: T2 },
  );
  assert.equal(expired.executionOwnerships[0].state, 'RECONCILE');
  const reconcileOwnership = expired.executionOwnerships[0];

  await ledger.append(trustedRecordFromOwnership(reconcileOwnership, {
    recordId: 'trusted-record:no-effect:1',
    verificationId: 'verification:no-effect:1',
    outcome: 'NO_EFFECT_VERIFIED',
    artifactId: 'artifact:no-effect',
  }));

  now = Date.parse(T5);
  const retriable = await manager.authorizeSpecialistSafeRetry(
    'job.trusted.retry',
    {
      agentId,
      leaseId,
      verificationId: 'verification:no-effect:1',
      at: T5,
    },
  );

  assert.equal(retriable.assignments[0].state, 'READY');
  assert.equal(retriable.assignments[0].leaseId, '');
  assert.equal(retriable.executionOwnerships[0].state, 'AVAILABLE');
  assert.equal(retriable.trustedVerification.recordId, 'trusted-record:no-effect:1');
  assert.equal(retriable.executionDispatched, false);

  const durable = await manager.get('job.trusted.retry');
  const history = durable.job.runtime.history.at(-1);
  assert.equal(history.type, 'specialist-handoff-safe-retry-authorized');
  assert.equal(history.trustedRecordId, 'trusted-record:no-effect:1');
  assert.equal(history.verificationId, 'verification:no-effect:1');
});

test('BrowserAgent without trusted resolver preserves legacy forged-proof fail-closed boundary', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T1),
  });

  await seedSpecialist(manager, {
    jobId: 'job.no-resolver',
    planId: 'plan.no-resolver',
    policyEnvelopeId: 'policy:no-resolver',
  });
  const claimed = await manager.claimSpecialistHandoffs(
    'job.no-resolver',
    { availableSlots: 1, leaseSeconds: 600, at: T1 },
  );
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;
  await manager.completeSpecialistHandoff('job.no-resolver', {
    agentId,
    leaseId,
    resultArtifactIds: ['artifact:archive'],
    at: T2,
  });

  await assert.rejects(
    () => manager.verifySpecialistHandoff('job.no-resolver', {
      agentId,
      leaseId,
      verificationId: 'verification:caller-forged',
      verifierId: 'caller-forged-verifier',
      verificationAuthorityId: 'policy:no-resolver',
      evidence: 'Caller assertion is not trusted evidence.',
      at: T5,
    }),
    /trusted verifier provenance/u,
  );

  const durable = await manager.get('job.no-resolver');
  assert.equal(
    durable.job.runtime.plan.nodes.find(node => node.nodeId === 'archive').state,
    'RUNNING',
  );
  assert.equal(durable.job.runtime.specialistExecutionOwnerships[0].state, 'OWNED');
});
