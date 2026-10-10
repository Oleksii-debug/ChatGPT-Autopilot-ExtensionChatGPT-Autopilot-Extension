import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeAgentPlanV1 } from '../src/core/agent-plan.js';
import {
  ExactEffectEventType,
  ExactEffectPhase,
  createExactEffectStateV1,
  exactEffectCanExecuteV1,
  normalizeExactEffectStateV1,
  reduceExactEffectV1,
} from '../src/core/universal-agent-exact-effect.js';
import {
  AgentCheckpointRewindStatus,
  assessAgentCheckpointRewindV1,
  createAgentCheckpointV1,
  verifyAgentCheckpointV1,
} from '../src/core/agent-checkpoint.js';

// Cross-contract fixture: one canonical job/plan, one consequential invocation,
// and one integrity-bound checkpoint. No provider credentials or live effects.
const AT = '2026-09-25T02:40:00.000Z';
const AMBIGUOUS_AT = '2026-09-25T02:40:02.000Z';
const CHECKPOINT_AT = '2026-09-25T02:42:00.000Z';

function plan() {
  return normalizeAgentPlanV1({
    schemaVersion: 1,
    planId: 'plan-1',
    jobId: 'job-1',
    objective: 'Verify the exact external effect',
    successCriteria: ['Effect independently verified'],
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
    nodes: [{
      nodeId: 'node-1',
      title: 'Verify effect',
      objective: 'Reconcile before retry',
      dependsOn: [],
      conflictKeys: ['filesystem.write'],
      ownerId: 'agent-1',
      executionPlane: 'BROWSER',
      acceptanceCriteria: ['Independent observation'],
      budget: {},
      state: 'PENDING',
      evidence: '',
      updatedAt: AT,
    }],
  });
}

function ambiguousEffect() {
  let state = createExactEffectStateV1({
    schemaVersion: 1,
    invocationId: 'invoke-1',
    toolId: 'filesystem.write',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.write'],
    policyDecisionId: 'policy-1',
    arguments: { pathRef: 'workspace:out.txt' },
    createdAt: AT,
  }, { createdAt: AT });

  const started = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: 'start-1',
    type: ExactEffectEventType.BEGIN_EXECUTION,
    effectId: 'invoke-1',
    at: '2026-09-25T02:40:01.000Z',
  });
  assert.equal(started.action, 'EXECUTE');
  state = started.state;

  const ambiguous = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: 'ambiguous-1',
    type: ExactEffectEventType.DECLARE_AMBIGUITY,
    effectId: 'invoke-1',
    executionId: 'invoke-1:attempt:1',
    at: AMBIGUOUS_AT,
    reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
    summary: 'Provider timed out after dispatch.',
  });
  assert.equal(ambiguous.action, 'RECONCILE');
  return ambiguous.state;
}

async function checkpointFor(planState, effectState) {
  const snapshotUtf8 = JSON.stringify({ plan: planState, effect: effectState });
  const bytes = Buffer.from(snapshotUtf8, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const checkpoint = await createAgentCheckpointV1({
    schemaVersion: 1,
    checkpointId: 'checkpoint-1',
    agentId: 'agent-1',
    jobId: planState.jobId,
    planId: planState.planId,
    planRevision: planState.revision,
    internalStateRevision: 2,
    exactEffectLedgerRevision: 2,
    policyRevisionId: 'policy-1',
    snapshotArtifact: {
      schemaVersion: 1,
      artifactId: 'artifact-snapshot-1',
      kind: 'agent-state-checkpoint',
      uri: 'artifact://agent-1/checkpoints/1',
      mediaType: 'application/json',
      sha256,
      sizeBytes: bytes.length,
      createdAt: CHECKPOINT_AT,
      producerInvocationId: null,
      sensitive: true,
    },
    evidenceArtifactIds: [],
    createdAt: CHECKPOINT_AT,
  });
  return { checkpoint, snapshotUtf8 };
}

test('Plan1 S1: cold restart keeps an ambiguous effect blocked across plan, ledger and checkpoint', async () => {
  const sourcePlan = plan();
  const sourceEffect = ambiguousEffect();
  assert.equal(sourceEffect.phase, ExactEffectPhase.RECONCILE);
  assert.equal(exactEffectCanExecuteV1(sourceEffect), false);

  const { checkpoint, snapshotUtf8 } = await checkpointFor(sourcePlan, sourceEffect);
  assert.deepEqual(await verifyAgentCheckpointV1(checkpoint), checkpoint);

  // Simulate a complete JSON disk roundtrip and reconstruct every V1 contract.
  const cold = JSON.parse(snapshotUtf8);
  const recoveredPlan = normalizeAgentPlanV1(cold.plan);
  const recoveredEffect = normalizeExactEffectStateV1(cold.effect);
  const recoveredCheckpoint = await verifyAgentCheckpointV1(JSON.parse(JSON.stringify(checkpoint)));
  assert.equal(recoveredPlan.jobId, recoveredCheckpoint.jobId);
  assert.equal(recoveredPlan.planId, recoveredCheckpoint.planId);
  assert.equal(recoveredEffect.effectId, 'invoke-1');
  assert.equal(recoveredEffect.phase, ExactEffectPhase.RECONCILE);
  assert.equal(exactEffectCanExecuteV1(recoveredEffect), false);

  const blindReplay = reduceExactEffectV1(recoveredEffect, {
    schemaVersion: 1,
    eventId: 'blind-replay-after-restart',
    type: ExactEffectEventType.BEGIN_EXECUTION,
    effectId: recoveredEffect.effectId,
    at: '2026-09-25T02:43:00.000Z',
  });
  assert.equal(blindReplay.accepted, false);
  assert.equal(blindReplay.reason, 'BLIND_REPLAY_BLOCKED');
  assert.equal(blindReplay.state.attempt, 1);

  const assessment = await assessAgentCheckpointRewindV1({
    checkpoint: recoveredCheckpoint,
    snapshotUtf8,
    current: {
      schemaVersion: 1,
      agentId: 'agent-1',
      jobId: 'job-1',
      planId: 'plan-1',
      planRevision: 2,
      internalStateRevision: 3,
      exactEffectLedgerRevision: 2,
      policyRevisionId: 'policy-2',
      unresolvedEffectIds: [recoveredEffect.effectId],
      observedAt: '2026-09-25T02:43:00.000Z',
    },
  });
  assert.equal(assessment.status, AgentCheckpointRewindStatus.BLOCKED);
  assert.equal(assessment.reasonCode, 'UNRESOLVED_EXTERNAL_EFFECTS');
  assert.equal(assessment.restoreAuthorized, false);
});

test('Plan1 S1: unknown versions and forged checkpoint material never migrate silently', async () => {
  const sourcePlan = plan();
  const sourceEffect = ambiguousEffect();
  const { checkpoint, snapshotUtf8 } = await checkpointFor(sourcePlan, sourceEffect);

  assert.throws(() => normalizeAgentPlanV1({
    ...sourcePlan,
    schemaVersion: 99,
  }), /schemaVersion/);
  assert.throws(() => normalizeExactEffectStateV1({
    ...sourceEffect,
    schemaVersion: 99,
  }), /schemaVersion/);

  const forged = JSON.parse(JSON.stringify(checkpoint));
  forged.exactEffectLedgerRevision += 1;
  await assert.rejects(() => verifyAgentCheckpointV1(forged), /checkpointDigest/);

  const alternate = JSON.stringify({
    ...JSON.parse(snapshotUtf8),
    effect: { ...JSON.parse(snapshotUtf8).effect, phase: 'COMMITTED' },
  });
  await assert.rejects(
    () => assessAgentCheckpointRewindV1({
      checkpoint,
      snapshotUtf8: alternate,
      current: {
        schemaVersion: 1,
        agentId: 'agent-1',
        jobId: 'job-1',
        planId: 'plan-1',
        planRevision: 2,
        internalStateRevision: 3,
        exactEffectLedgerRevision: 2,
        policyRevisionId: 'policy-2',
        unresolvedEffectIds: ['invoke-1'],
        observedAt: '2026-09-25T02:43:00.000Z',
      },
    }),
    /snapshot|hash|sha256|digest/i,
  );
});
