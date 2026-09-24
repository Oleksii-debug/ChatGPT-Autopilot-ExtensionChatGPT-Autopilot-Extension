import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { FilesystemWriteVerifierV1 } from '../src/core/filesystem-write-verifier.js';
import { FilesystemToolId, FILESYSTEM_PROVIDER_ID } from '../src/core/filesystem-agent-provider.js';

function digest(value) {
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

const at = '2026-09-24T16:00:00.000Z';
function invocation(text = 'after') {
  return {
    schemaVersion: 1,
    invocationId: 'fs-verify-1',
    toolId: FilesystemToolId.WRITE_EXISTING_TEXT,
    providerId: FILESYSTEM_PROVIDER_ID,
    requestedCapabilityIds: ['filesystem.writeExistingText'],
    policyDecisionId: 'decision-fs-verify-1',
    arguments: { rootId: 'workspace', relativePath: 'note.txt', text, expectedSha256: digest('before') },
    createdAt: at,
    parentInvocationId: null,
  };
}

test('normal filesystem verification trusts fresh readback rather than mutation response', async () => {
  let current = 'after';
  const verifier = new FilesystemWriteVerifierV1({
    nativeClient: { readText: async () => ({ text: current }) },
    now: () => Date.parse('2026-09-24T16:00:02.000Z'),
  });
  const inv = invocation();
  const observation = { observationId: 'fs-verify-1:observation' };
  const ok = await verifier.verify({ invocation: inv, executionId: 'fs-verify-1:attempt:1', observation });
  assert.equal(ok.status, 'VERIFIED');
  assert.equal(ok.effectId, inv.invocationId);
  assert.equal(ok.attempt, 1);

  current = 'diverged';
  const mismatch = await verifier.verify({ invocation: inv, executionId: 'fs-verify-1:attempt:1', observation });
  assert.equal(mismatch.status, 'AMBIGUOUS');
  assert.equal(mismatch.reasonCode, 'FILESYSTEM_POSTCONDITION_MISMATCH');
});

test('reconciliation classifies desired digest as committed and unchanged prior digest as safe retry proof', async () => {
  let current = 'after';
  let tick = Date.parse('2026-09-24T16:01:00.000Z');
  const verifier = new FilesystemWriteVerifierV1({
    nativeClient: { readText: async () => ({ text: current }) },
    verifierId: 'independent-filesystem-verifier',
    now: () => tick++,
  });
  const common = {
    invocation: invocation(),
    effectId: 'fs-verify-1',
    executionId: 'fs-verify-1:attempt:1',
    attempt: 1,
    policyDecisionId: 'decision-fs-verify-1',
  };

  const committed = await verifier.reconcileVerify({ ...common, expectedOutcome: 'VERIFIED' });
  assert.equal(committed.observation.data.committed, true);
  assert.equal(committed.verification.status, 'VERIFIED');
  assert.equal(JSON.stringify(committed).includes('after'), false, 'evidence must not persist file text');

  current = 'before';
  const safeRetry = await verifier.reconcileVerify({ ...common, expectedOutcome: 'SAFE_RETRY' });
  assert.equal(safeRetry.observation.data.committed, false);
  assert.equal(safeRetry.observation.data.unchanged, true);
  assert.equal(safeRetry.verification.status, 'FAILED');
  assert.equal(safeRetry.verification.reasonCode, 'NO_COMMITTED_EFFECT');
});
