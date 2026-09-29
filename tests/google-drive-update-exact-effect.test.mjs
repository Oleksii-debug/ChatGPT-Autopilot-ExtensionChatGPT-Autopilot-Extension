import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_WORKSPACE_PROVIDER_ID,
  GoogleWorkspaceAgentProviderV1,
  GoogleWorkspaceCapabilityId,
  GoogleWorkspaceToolId,
} from '../src/core/google-workspace-agent-provider.js';
import { GoogleWorkspaceExactEffectExecutorV1 } from '../src/core/google-workspace-exact-effect.js';
import { DriveFileUpdateVerifierV1 } from '../src/core/google-drive-update-verifier.js';
import { ExactEffectPhase, ReconciliationOutcome } from '../src/core/universal-agent-exact-effect.js';

const baseMs = Date.parse('2026-09-25T09:00:00.000Z');

function invocation(id = 'drive-update-effect-1') {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId: GoogleWorkspaceToolId.DRIVE_FILE_UPDATE,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    requestedCapabilityIds: [GoogleWorkspaceCapabilityId.DRIVE_FILE_UPDATE],
    policyDecisionId: `decision-${id}`,
    arguments: {
      fileId: 'file_1',
      name: 'renamed.txt',
      destinationParentId: 'folder_2',
    },
    createdAt: new Date(baseMs).toISOString(),
    parentInvocationId: null,
  };
}

function policy(id = 'drive-update-effect-1', decision = 'ALLOW') {
  return {
    schemaVersion: 1,
    decisionId: `decision-${id}`,
    invocationId: id,
    decision,
    reasonCode: 'OWNER_POLICY',
    reason: '',
    approvalId: null,
    decidedAt: new Date(baseMs).toISOString(),
  };
}

function memoryStore() {
  let root = { effectsById: {} };
  return {
    async update(mutator) {
      const draft = structuredClone(root);
      const returned = mutator(draft);
      root = structuredClone(returned === undefined ? draft : returned);
      return structuredClone(root);
    },
    async load(id) {
      return structuredClone(root.effectsById?.[id]?.state || null);
    },
    snapshot() {
      return structuredClone(root);
    },
  };
}

function workspace({ onUpdate } = {}) {
  let current = {
    id: 'file_1',
    name: 'old.txt',
    mimeType: 'text/plain',
    parents: ['folder_1'],
    modifiedTime: new Date(baseMs).toISOString(),
    size: '4',
    md5Checksum: '',
    sha256Checksum: '',
    trashed: false,
    version: '1',
    webViewLink: '',
  };
  let updateCalls = 0;
  const api = {
    searchDrive: async () => ({ files: [] }),
    getDriveFile: async ({ fileId }) => {
      assert.equal(fileId, 'file_1');
      return structuredClone(current);
    },
    readDriveText: async () => ({ text: '' }),
    readSheetsValues: async () => ({ values: [] }),
    updateDriveFile: async args => {
      updateCalls += 1;
      const next = {
        ...current,
        name: args.name ?? current.name,
        parents: args.destinationParentId ? [args.destinationParentId] : current.parents,
        version: String(Number(current.version) + 1),
      };
      current = next;
      if (onUpdate) await onUpdate({ args, current: structuredClone(current), updateCalls });
      return { file: structuredClone(current) };
    },
    searchGmail: async () => ({ messages: [] }),
    getGmailMessage: async () => ({}),
    modifyGmailMessage: async () => ({}),
    getGmailThread: async () => ({}),
    getGmailAttachment: async () => ({}),
    createGmailDraft: async () => ({}),
    sendGmailDraft: async () => ({}),
    get updateCalls() { return updateCalls; },
  };
  return api;
}

function harness({ onUpdate } = {}) {
  const client = workspace({ onUpdate });
  let now = baseMs;
  const clock = () => { now += 1000; return now; };
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client,
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.DRIVE_FILE_UPDATE],
    now: clock,
  });
  const verifier = new DriveFileUpdateVerifierV1({
    workspaceClient: client,
    now: clock,
  });
  const store = memoryStore();
  const executor = new GoogleWorkspaceExactEffectExecutorV1({
    provider,
    store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: clock,
  });
  return { client, store, executor };
}

test('Drive update traverses provider -> durable exact effect -> independent readback -> COMMITTED exactly once', async () => {
  const { client, executor } = harness();
  const inv = invocation();
  const result = await executor.invoke({ invocation: inv, policyDecision: policy() });
  assert.equal(result.effectState.phase, ExactEffectPhase.COMMITTED);
  assert.equal(result.effectState.invocation.toolId, GoogleWorkspaceToolId.DRIVE_FILE_UPDATE);
  assert.equal(client.updateCalls, 1);

  await assert.rejects(
    () => executor.invoke({ invocation: structuredClone(inv), policyDecision: policy() }),
    /cannot execute from COMMITTED/i,
  );
  assert.equal(client.updateCalls, 1);
});

test('owner policy denial occurs before durable execution admission and before Drive mutation', async () => {
  const { client, store, executor } = harness();
  const inv = invocation('drive-update-denied');
  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId, 'DENY') }),
    /not authorized/i,
  );
  assert.equal(client.updateCalls, 0);
  assert.equal(await store.load(inv.invocationId), null);
});

test('lost Drive mutation response becomes RECONCILE, never blind replays, and fresh independent proof can commit it', async () => {
  const { client, executor } = harness({
    onUpdate: async ({ updateCalls }) => {
      if (updateCalls === 1) {
        const error = new Error('response lost after Drive accepted PATCH');
        error.code = 'GOOGLE_MUTATION_TRANSPORT_UNCERTAIN';
        error.effectMayHaveOccurred = true;
        error.safeToRetry = false;
        throw error;
      }
    },
  });
  const inv = invocation('drive-update-ambiguous');
  const decision = policy(inv.invocationId);

  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: decision }),
    error => error.effectState?.phase === ExactEffectPhase.RECONCILE
      && error.reconcileRequired === true
      && error.safeToRetry === false,
  );
  assert.equal(client.updateCalls, 1);

  await assert.rejects(
    () => executor.invoke({ invocation: structuredClone(inv), policyDecision: decision }),
    /requires reconciliation before retry/i,
  );
  assert.equal(client.updateCalls, 1);

  const reconciled = await executor.reconcile({
    invocationId: inv.invocationId,
    outcome: ReconciliationOutcome.VERIFIED,
    reasonCode: 'DRIVE_READBACK_CONFIRMED',
    summary: 'Independent Drive readback confirms the requested state.',
  });
  assert.equal(reconciled.phase, ExactEffectPhase.COMMITTED);
  assert.equal(client.updateCalls, 1);
});

test('Drive update refuses SAFE_RETRY after uncertain dispatch because negative readback cannot prove no effect', async () => {
  const { executor } = harness({
    onUpdate: async () => {
      const error = new Error('response lost');
      error.effectMayHaveOccurred = true;
      error.safeToRetry = false;
      throw error;
    },
  });
  const inv = invocation('drive-update-no-safe-retry');
  const decision = policy(inv.invocationId);
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: decision }));

  await assert.rejects(
    () => executor.reconcile({
      invocationId: inv.invocationId,
      outcome: ReconciliationOutcome.SAFE_RETRY,
      reasonCode: 'NO_COMMITTED_EFFECT',
      summary: 'Caller requests retry.',
    }),
    /cannot prove SAFE_RETRY/i,
  );
});
