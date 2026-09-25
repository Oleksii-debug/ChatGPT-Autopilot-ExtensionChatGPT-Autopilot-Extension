import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveFileUpdateVerifierV1 } from '../src/core/google-drive-update-verifier.js';
import {
  GOOGLE_WORKSPACE_PROVIDER_ID,
  GoogleWorkspaceToolId,
} from '../src/core/google-workspace-agent-provider.js';
import { ReconciliationOutcome } from '../src/core/universal-agent-exact-effect.js';

const baseMs = Date.parse('2026-09-25T08:50:00.000Z');

function invocation(args = { fileId: 'file_1', name: 'new.txt', destinationParentId: 'folder_2' }) {
  return {
    schemaVersion: 1,
    invocationId: 'drive-update-effect-1',
    toolId: GoogleWorkspaceToolId.DRIVE_FILE_UPDATE,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    requestedCapabilityIds: ['google.drive.file.update'],
    policyDecisionId: 'decision-drive-update-effect-1',
    arguments: args,
    createdAt: new Date(baseMs).toISOString(),
    parentInvocationId: null,
  };
}

function observation() {
  return {
    schemaVersion: 1,
    observationId: 'drive-update-effect-1:observation:1',
    invocationId: 'drive-update-effect-1',
    status: 'OK',
    summary: 'provider result',
    data: { file: { id: 'file_1' } },
    artifactRefs: [],
    observedAt: new Date(baseMs + 1000).toISOString(),
  };
}

test('fresh Drive readback verifies exact rename and destination', async () => {
  let reads = 0;
  const verifier = new DriveFileUpdateVerifierV1({
    workspaceClient: {
      getDriveFile: async ({ fileId }) => {
        reads += 1;
        return { id: fileId, name: 'new.txt', parents: ['folder_2'], trashed: false };
      },
    },
    now: () => baseMs + 2000,
  });
  const out = await verifier.verify({
    invocation: invocation(),
    executionId: 'drive-update-effect-1:attempt:1',
    observation: observation(),
  });
  assert.equal(out.status, 'VERIFIED');
  assert.equal(out.reasonCode, 'DRIVE_FILE_UPDATE_MATCHED');
  assert.equal(out.verificationAuthorityId, 'decision-drive-update-effect-1');
  assert.equal(out.effectId, 'drive-update-effect-1');
  assert.equal(out.attempt, 1);
  assert.equal(reads, 1);
});

test('Drive readback mismatch remains AMBIGUOUS rather than fabricating success', async () => {
  const verifier = new DriveFileUpdateVerifierV1({
    workspaceClient: {
      getDriveFile: async ({ fileId }) => ({ id: fileId, name: 'old.txt', parents: ['folder_1'], trashed: false }),
    },
    now: () => baseMs + 2000,
  });
  const out = await verifier.verify({
    invocation: invocation(),
    executionId: 'drive-update-effect-1:attempt:1',
    observation: observation(),
  });
  assert.equal(out.status, 'AMBIGUOUS');
  assert.equal(out.reasonCode, 'DRIVE_FILE_UPDATE_DIVERGED');
});

test('reconciliation confirms committed Drive state but refuses SAFE_RETRY from negative readback', async () => {
  const verifier = new DriveFileUpdateVerifierV1({
    workspaceClient: {
      getDriveFile: async ({ fileId }) => ({ id: fileId, name: 'new.txt', parents: ['folder_2'], trashed: false }),
    },
    now: () => baseMs + 3000,
  });
  const proof = await verifier.reconcileVerify({
    invocation: invocation(),
    effectId: 'drive-update-effect-1',
    executionId: 'drive-update-effect-1:attempt:1',
    attempt: 1,
    policyDecisionId: 'decision-drive-update-effect-1',
    expectedOutcome: ReconciliationOutcome.VERIFIED,
  });
  assert.equal(proof.verification.status, 'VERIFIED');
  assert.equal(proof.observation.data.committed, true);
  assert.deepEqual(proof.observation.data.parents, ['folder_2']);

  await assert.rejects(
    () => verifier.reconcileVerify({
      invocation: invocation(),
      effectId: 'drive-update-effect-1',
      executionId: 'drive-update-effect-1:attempt:1',
      attempt: 1,
      policyDecisionId: 'decision-drive-update-effect-1',
      expectedOutcome: ReconciliationOutcome.SAFE_RETRY,
    }),
    /cannot prove SAFE_RETRY/i,
  );
});

test('Drive verifier rejects actor/provider identity and hostile mutation arguments', async () => {
  assert.throws(
    () => new DriveFileUpdateVerifierV1({
      workspaceClient: { getDriveFile: async () => ({}) },
      verifierId: GOOGLE_WORKSPACE_PROVIDER_ID,
    }),
    /identity must differ/i,
  );

  let getterReads = 0;
  const args = { fileId: 'file_1' };
  Object.defineProperty(args, 'name', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'new.txt';
    },
  });
  const verifier = new DriveFileUpdateVerifierV1({
    workspaceClient: {
      getDriveFile: async () => {
        throw new Error('must not read');
      },
    },
  });
  await assert.rejects(
    () => verifier.verify({
      invocation: invocation(args),
      executionId: 'drive-update-effect-1:attempt:1',
      observation: observation(),
    }),
    /enumerable data property/i,
  );
  assert.equal(getterReads, 0);
});

test('Drive verifier preserves exact Unicode/spaces in requested name', async () => {
  const exactName = '  Звіт — готово  ';
  const verifier = new DriveFileUpdateVerifierV1({
    workspaceClient: {
      getDriveFile: async ({ fileId }) => ({ id: fileId, name: exactName, parents: ['folder_1'], trashed: false }),
    },
  });
  const out = await verifier.verify({
    invocation: invocation({ fileId: 'file_1', name: exactName }),
    executionId: 'drive-update-effect-1:attempt:2',
    observation: observation(),
  });
  assert.equal(out.status, 'VERIFIED');
  assert.equal(out.attempt, 2);
});
