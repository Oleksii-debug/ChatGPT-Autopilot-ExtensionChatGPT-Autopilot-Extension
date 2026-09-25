import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentCheckpointRewindStatus,
  assessAgentCheckpointRewindV1,
  createAgentCheckpointV1,
  normalizeAgentCheckpointHeadV1,
  normalizeAgentCheckpointV1,
  verifyAgentCheckpointV1,
} from '../src/core/agent-checkpoint.js';

const CREATED_AT = '2026-09-25T02:40:00.000Z';
const OBSERVED_AT = '2026-09-25T02:45:00.000Z';
const SNAPSHOT_SHA = 'a'.repeat(64);

function checkpointInput(overrides = {}) {
  return {
    schemaVersion: 1,
    checkpointId: 'checkpoint-1',
    agentId: 'agent-1',
    jobId: 'job-1',
    planId: 'plan-1',
    planRevision: 4,
    internalStateRevision: 12,
    exactEffectLedgerRevision: 7,
    policyRevisionId: 'policy-current-at-checkpoint',
    snapshotArtifact: {
      schemaVersion: 1,
      artifactId: 'artifact-checkpoint-1',
      kind: 'agent-state-checkpoint',
      uri: 'artifact://agent-1/checkpoints/1',
      mediaType: 'application/json',
      sha256: SNAPSHOT_SHA,
      sizeBytes: 4096,
      createdAt: CREATED_AT,
      producerInvocationId: null,
      sensitive: true,
    },
    evidenceArtifactIds: ['evidence-1'],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function head(overrides = {}) {
  return {
    schemaVersion: 1,
    agentId: 'agent-1',
    jobId: 'job-1',
    planId: 'plan-1',
    planRevision: 6,
    internalStateRevision: 18,
    exactEffectLedgerRevision: 7,
    policyRevisionId: 'policy-latest',
    unresolvedEffectIds: [],
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

test('Agent checkpoint creation is deterministic, immutable and SHA-256 bound', async () => {
  const first = await createAgentCheckpointV1(checkpointInput());
  const second = await createAgentCheckpointV1(checkpointInput());

  assert.equal(first.checkpointDigest, second.checkpointDigest);
  assert.match(first.checkpointDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first.snapshotArtifact.sha256, SNAPSHOT_SHA);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.snapshotArtifact), true);
  assert.deepEqual(await verifyAgentCheckpointV1(first), first);
  assert.deepEqual(normalizeAgentCheckpointV1(first), first);
});

test('Agent checkpoint integrity rejects changed checkpoint material after restart', async () => {
  const checkpoint = await createAgentCheckpointV1(checkpointInput());
  const serialized = JSON.parse(JSON.stringify(checkpoint));
  serialized.internalStateRevision += 1;

  await assert.rejects(
    () => verifyAgentCheckpointV1(serialized),
    /checkpointDigest does not match checkpoint material/,
  );
});

test('rewind assessment allows only an internal-state rewind and preserves newer policy/effect authorities', async () => {
  const checkpoint = await createAgentCheckpointV1(checkpointInput());
  const result = await assessAgentCheckpointRewindV1({
    checkpoint,
    current: head({ policyRevisionId: 'policy-newer' }),
    snapshotSha256: SNAPSHOT_SHA,
  });

  assert.equal(result.status, AgentCheckpointRewindStatus.READY_FOR_RECONCILIATION);
  assert.equal(result.reasonCode, 'INTERNAL_STATE_ONLY_REWIND');
  assert.equal(result.targetPlanRevision, 4);
  assert.equal(result.targetInternalStateRevision, 12);
  assert.equal(result.preserveExactEffectLedgerRevision, 7);
  assert.equal(result.preservePolicyRevisionId, 'policy-newer');
  assert.equal(result.restoreAuthorized, false);
  assert.equal(result.requiresFreshPolicyEvaluation, true);
  assert.equal(result.requiresFreshReconciliation, true);
});

test('rewind blocks when any external effect was admitted after the checkpoint', async () => {
  const checkpoint = await createAgentCheckpointV1(checkpointInput());
  const result = await assessAgentCheckpointRewindV1({
    checkpoint,
    current: head({ exactEffectLedgerRevision: 8 }),
    snapshotSha256: SNAPSHOT_SHA,
  });

  assert.equal(result.status, AgentCheckpointRewindStatus.BLOCKED);
  assert.equal(result.reasonCode, 'EXTERNAL_EFFECTS_AFTER_CHECKPOINT');
  assert.equal(result.preserveExactEffectLedgerRevision, 8);
  assert.equal(result.restoreAuthorized, false);
});

test('rewind blocks unresolved external effects even when the durable ledger revision did not advance', async () => {
  const checkpoint = await createAgentCheckpointV1(checkpointInput());
  const result = await assessAgentCheckpointRewindV1({
    checkpoint,
    current: head({ unresolvedEffectIds: ['effect-ambiguous-1'] }),
    snapshotSha256: SNAPSHOT_SHA,
  });

  assert.equal(result.status, AgentCheckpointRewindStatus.BLOCKED);
  assert.equal(result.reasonCode, 'UNRESOLVED_EXTERNAL_EFFECTS');
});

test('rewind is a NOOP at the exact checkpoint state and still grants no restore authority', async () => {
  const checkpoint = await createAgentCheckpointV1(checkpointInput());
  const result = await assessAgentCheckpointRewindV1({
    checkpoint,
    current: head({ planRevision: 4, internalStateRevision: 12 }),
    snapshotSha256: SNAPSHOT_SHA,
  });

  assert.equal(result.status, AgentCheckpointRewindStatus.NOOP);
  assert.equal(result.reasonCode, 'ALREADY_AT_CHECKPOINT');
  assert.equal(result.restoreAuthorized, false);
});

test('rewind rejects cross-identity, wrong snapshot bytes and regressed current state', async () => {
  const checkpoint = await createAgentCheckpointV1(checkpointInput());

  await assert.rejects(
    () => assessAgentCheckpointRewindV1({
      checkpoint,
      current: head({ agentId: 'agent-other' }),
      snapshotSha256: SNAPSHOT_SHA,
    }),
    /agentId does not match checkpoint/,
  );
  await assert.rejects(
    () => assessAgentCheckpointRewindV1({
      checkpoint,
      current: head(),
      snapshotSha256: 'b'.repeat(64),
    }),
    /snapshot bytes do not match checkpoint artifact/,
  );
  await assert.rejects(
    () => assessAgentCheckpointRewindV1({
      checkpoint,
      current: head({ exactEffectLedgerRevision: 6 }),
      snapshotSha256: SNAPSHOT_SHA,
    }),
    /current state regressed behind checkpoint/,
  );
});

test('checkpoint boundaries reject accessors, hidden aliases and array accessors without executing getters', async () => {
  let reads = 0;
  const accessorCheckpoint = checkpointInput();
  Object.defineProperty(accessorCheckpoint, 'agentId', {
    enumerable: true,
    get() {
      reads += 1;
      return 'agent-1';
    },
  });
  await assert.rejects(
    () => createAgentCheckpointV1(accessorCheckpoint),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  const hiddenCheckpoint = checkpointInput();
  Object.defineProperty(hiddenCheckpoint, 'shadowAuthority', {
    enumerable: false,
    value: 'hidden',
  });
  await assert.rejects(
    () => createAgentCheckpointV1(hiddenCheckpoint),
    /unknown field: shadowAuthority/,
  );

  const evidence = ['evidence-1'];
  Object.defineProperty(evidence, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'evidence-1';
    },
  });
  await assert.rejects(
    () => createAgentCheckpointV1(checkpointInput({ evidenceArtifactIds: evidence })),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);
});

test('checkpoint material must be a non-empty exact checkpoint artifact', async () => {
  await assert.rejects(
    () => createAgentCheckpointV1(checkpointInput({
      snapshotArtifact: {
        ...checkpointInput().snapshotArtifact,
        kind: 'generic-json',
      },
    })),
    /kind must be agent-state-checkpoint/,
  );
  await assert.rejects(
    () => createAgentCheckpointV1(checkpointInput({
      snapshotArtifact: {
        ...checkpointInput().snapshotArtifact,
        sizeBytes: 0,
      },
    })),
    /requires non-empty material/,
  );
  await assert.rejects(
    () => createAgentCheckpointV1(checkpointInput({
      snapshotArtifact: {
        ...checkpointInput().snapshotArtifact,
        createdAt: '2026-09-25T02:41:00.000Z',
      },
    })),
    /cannot be created after checkpoint/,
  );
});

test('current checkpoint head is strict and bounded', () => {
  const normalized = normalizeAgentCheckpointHeadV1(head());
  assert.equal(normalized.planRevision, 6);
  assert.equal(Object.isFrozen(normalized), true);

  assert.throws(
    () => normalizeAgentCheckpointHeadV1(head({
      unresolvedEffectIds: Array.from({ length: 129 }, (_, index) => `effect-${index}`),
    })),
    /bounded plain array/,
  );
});
