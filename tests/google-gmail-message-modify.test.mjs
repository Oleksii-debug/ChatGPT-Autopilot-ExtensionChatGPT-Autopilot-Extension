import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GMAIL_API_ORIGIN,
  GMAIL_LABELS_SCOPE,
  GoogleWorkspaceRestClientV1,
} from '../src/core/google-workspace-rest-client.js';
import {
  GOOGLE_WORKSPACE_PROVIDER_ID,
  GoogleWorkspaceAgentProviderV1,
  GoogleWorkspaceCapabilityId,
  GoogleWorkspaceToolId,
} from '../src/core/google-workspace-agent-provider.js';
import { GoogleWorkspaceExactEffectExecutorV1 } from '../src/core/google-workspace-exact-effect.js';
import { GmailMessageModifyVerifierV1 } from '../src/core/google-gmail-message-modify-verifier.js';
import { ExactEffectPhase } from '../src/core/universal-agent-exact-effect.js';

const userId = 'owner@example.com';
const baseMs = Date.parse('2026-09-25T10:30:00.000Z');

function response(status, body) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

function nativeClient() {
  return {
    resolveCredential: async request => ({
      credentialId: request.credentialId,
      targetOrigin: request.targetOrigin,
      secret: 'test-token',
    }),
  };
}

function restConfig(fetchImpl) {
  return {
    nativeClient: nativeClient(),
    gmailCredentialId: 'gmail-main',
    allowedDriveRootIds: [],
    allowedDriveFileIds: [],
    allowedGmailUsers: [userId],
    fetchImpl,
  };
}

function fullClient(overrides = {}) {
  return {
    searchDrive: async () => ({}),
    getDriveFile: async () => ({}),
    readDriveText: async () => ({}),
    updateDriveFile: async () => ({}),
    searchGmail: async () => ({}),
    getGmailMessage: async ({ messageId }) => ({
      id: messageId,
      threadId: 'thread_1',
      labelIds: ['IMPORTANT'],
    }),
    modifyGmailMessage: async ({ messageId }) => ({
      userId,
      messageId,
      threadId: 'thread_1',
      labelIds: ['IMPORTANT'],
      historyId: '8',
      internalDate: String(baseMs),
      sizeEstimate: 10,
    }),
    getGmailThread: async () => ({}),
    getGmailAttachment: async () => ({}),
    createGmailDraft: async () => ({}),
    sendGmailDraft: async () => ({}),
    ...overrides,
  };
}

function invocation(id = 'gmail-modify-1', args = {
  userId,
  messageId: 'msg_1',
  addLabelIds: ['IMPORTANT'],
  removeLabelIds: ['INBOX'],
}) {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId: GoogleWorkspaceToolId.GMAIL_MESSAGE_MODIFY,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    requestedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_MESSAGE_MODIFY],
    policyDecisionId: `decision-${id}`,
    arguments: args,
    createdAt: new Date(baseMs).toISOString(),
    parentInvocationId: null,
  };
}

function policy(id = 'gmail-modify-1') {
  return {
    schemaVersion: 1,
    decisionId: `decision-${id}`,
    invocationId: id,
    decision: 'ALLOW',
    reasonCode: 'OWNER_POLICY',
    reason: '',
    approvalId: null,
    decidedAt: new Date(baseMs).toISOString(),
  };
}

function memoryStore() {
  let root = { effectsById: {} };
  return {
    store: {
      async update(mutator) {
        const draft = structuredClone(root);
        const returned = mutator(draft);
        root = structuredClone(returned === undefined ? draft : returned);
        return structuredClone(root);
      },
    },
    snapshot(id) {
      return structuredClone(root.effectsById?.[id]?.state ?? null);
    },
  };
}

test('Gmail labels use the narrow documented labels scope', () => {
  assert.equal(GMAIL_LABELS_SCOPE, 'https://www.googleapis.com/auth/gmail.labels');
});

test('message modify uses one fixed messages.modify endpoint and exact label delta', async () => {
  const calls = [];
  const client = new GoogleWorkspaceRestClientV1(restConfig(async (url, options) => {
    calls.push({ url, options });
    return response(200, {
      id: 'msg_1',
      threadId: 'thread_1',
      labelIds: ['IMPORTANT', 'STARRED'],
      historyId: '8',
      internalDate: String(baseMs),
      sizeEstimate: 10,
    });
  }));

  const result = await client.modifyGmailMessage({
    userId,
    messageId: 'msg_1',
    addLabelIds: ['IMPORTANT'],
    removeLabelIds: ['INBOX'],
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, GMAIL_API_ORIGIN);
  assert.equal(url.pathname, '/gmail/v1/users/owner%40example.com/messages/msg_1/modify');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    addLabelIds: ['IMPORTANT'],
    removeLabelIds: ['INBOX'],
  });
  assert.equal(result.messageId, 'msg_1');
  assert.ok(result.labelIds.includes('IMPORTANT'));
  assert.equal(result.labelIds.includes('INBOX'), false, 'removing INBOX is the Gmail archive operation');
  assert.equal(JSON.stringify(result).includes('test-token'), false);
});

test('message modify rejects aliases, empty/overlapping deltas, and accessors before dispatch', async () => {
  let calls = 0;
  let getterReads = 0;
  const client = new GoogleWorkspaceRestClientV1(restConfig(async () => {
    calls += 1;
    return response(500, {});
  }));

  await assert.rejects(
    () => client.modifyGmailMessage({ userId: 'me', messageId: 'msg_1', removeLabelIds: ['INBOX'] }),
    /exact owner-configured email/i,
  );
  await assert.rejects(
    () => client.modifyGmailMessage({ userId, messageId: ' msg_1', removeLabelIds: ['INBOX'] }),
    /messageId|exact resource/i,
  );
  await assert.rejects(
    () => client.modifyGmailMessage({ userId, messageId: 'msg_1' }),
    /at least one label change/i,
  );
  await assert.rejects(
    () => client.modifyGmailMessage({
      userId,
      messageId: 'msg_1',
      addLabelIds: ['IMPORTANT'],
      removeLabelIds: ['IMPORTANT'],
    }),
    /same label/i,
  );
  const hostile = [];
  Object.defineProperty(hostile, '0', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'IMPORTANT';
    },
  });
  hostile.length = 1;
  await assert.rejects(
    () => client.modifyGmailMessage({ userId, messageId: 'msg_1', addLabelIds: hostile }),
    /enumerable data property/i,
  );
  assert.equal(getterReads, 0);
  assert.equal(calls, 0);
});

test('message modify treats a post-dispatch response that misses the requested labels as ambiguous', async () => {
  let calls = 0;
  const client = new GoogleWorkspaceRestClientV1(restConfig(async () => {
    calls += 1;
    return response(200, {
      id: 'msg_1',
      threadId: 'thread_1',
      labelIds: ['INBOX'],
      historyId: '8',
      internalDate: String(baseMs),
      sizeEstimate: 10,
    });
  }));
  await assert.rejects(
    () => client.modifyGmailMessage({
      userId,
      messageId: 'msg_1',
      addLabelIds: ['IMPORTANT'],
      removeLabelIds: ['INBOX'],
    }),
    error => error.code === 'GOOGLE_GMAIL_POSTCONDITION_UNCERTAIN'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false,
  );
  assert.equal(calls, 1);
});

test('message label/archive mutation commits only after fresh independent readback', async () => {
  let modifies = 0;
  let reads = 0;
  let now = baseMs;
  const client = fullClient({
    modifyGmailMessage: async ({ messageId }) => {
      modifies += 1;
      return {
        userId,
        messageId,
        threadId: 'thread_1',
        labelIds: ['IMPORTANT'],
        historyId: '8',
        internalDate: String(baseMs),
        sizeEstimate: 10,
      };
    },
    getGmailMessage: async ({ userId: seenUser, messageId, format }) => {
      reads += 1;
      assert.equal(seenUser, userId);
      assert.equal(messageId, 'msg_1');
      assert.equal(format, 'METADATA');
      return { id: messageId, threadId: 'thread_1', labelIds: ['IMPORTANT'] };
    },
  });
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client,
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_MESSAGE_MODIFY],
    now: () => { now += 100; return now; },
  });
  const verifier = new GmailMessageModifyVerifierV1({
    workspaceClient: client,
    now: () => { now += 100; return now; },
  });
  const memory = memoryStore();
  const executor = new GoogleWorkspaceExactEffectExecutorV1({
    provider,
    store: memory.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => { now += 100; return now; },
  });
  const inv = invocation();
  const result = await executor.invoke({ invocation: inv, policyDecision: policy() });
  assert.equal(result.effectState.phase, ExactEffectPhase.COMMITTED);
  assert.equal(modifies, 1);
  assert.equal(reads, 1);
  assert.equal(memory.snapshot(inv.invocationId).verification.reasonCode, 'GMAIL_MESSAGE_LABEL_STATE_MATCHED');
});

test('ambiguous message modify never blind-replays and can reconcile only from matching fresh state', async () => {
  let modifies = 0;
  let reads = 0;
  let now = baseMs;
  let labels = ['INBOX'];
  const client = fullClient({
    modifyGmailMessage: async () => {
      modifies += 1;
      const error = new Error('response lost after dispatch');
      error.effectMayHaveOccurred = true;
      error.safeToRetry = false;
      throw error;
    },
    getGmailMessage: async ({ messageId }) => {
      reads += 1;
      return { id: messageId, threadId: 'thread_1', labelIds: [...labels] };
    },
  });
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client,
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_MESSAGE_MODIFY],
    now: () => { now += 100; return now; },
  });
  const verifier = new GmailMessageModifyVerifierV1({
    workspaceClient: client,
    now: () => { now += 100; return now; },
  });
  const memory = memoryStore();
  const executor = new GoogleWorkspaceExactEffectExecutorV1({
    provider,
    store: memory.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => { now += 100; return now; },
  });
  const inv = invocation('gmail-modify-ambiguous');
  const decision = policy(inv.invocationId);

  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: decision }),
    error => error.effectState?.phase === ExactEffectPhase.RECONCILE && error.safeToRetry === false,
  );
  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: decision }),
    /requires reconciliation before retry/i,
  );
  await assert.rejects(
    () => executor.reconcile({
      invocationId: inv.invocationId,
      outcome: 'SAFE_RETRY',
      reasonCode: 'NO_EFFECT',
    }),
    /cannot prove SAFE_RETRY/i,
  );
  assert.equal(reads, 0, 'SAFE_RETRY is rejected without a remote read');
  assert.equal(modifies, 1);

  labels = ['IMPORTANT'];
  const reconciled = await executor.reconcile({
    invocationId: inv.invocationId,
    outcome: 'VERIFIED',
    reasonCode: 'READBACK_CONFIRMED',
  });
  assert.equal(reconciled.phase, ExactEffectPhase.COMMITTED);
  assert.equal(modifies, 1, 'reconciliation must not replay messages.modify');
  assert.equal(reads, 1);
});

test('negative reconciliation readback remains RECONCILE instead of becoming retry authority', async () => {
  let modifies = 0;
  let reads = 0;
  let now = baseMs;
  const client = fullClient({
    modifyGmailMessage: async () => {
      modifies += 1;
      const error = new Error('lost response');
      error.effectMayHaveOccurred = true;
      error.safeToRetry = false;
      throw error;
    },
    getGmailMessage: async ({ messageId }) => {
      reads += 1;
      return { id: messageId, threadId: 'thread_1', labelIds: ['INBOX'] };
    },
  });
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client,
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_MESSAGE_MODIFY],
    now: () => { now += 100; return now; },
  });
  const verifier = new GmailMessageModifyVerifierV1({
    workspaceClient: client,
    now: () => { now += 100; return now; },
  });
  const memory = memoryStore();
  const executor = new GoogleWorkspaceExactEffectExecutorV1({
    provider,
    store: memory.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => { now += 100; return now; },
  });
  const inv = invocation('gmail-modify-negative');
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }));
  await assert.rejects(
    () => executor.reconcile({
      invocationId: inv.invocationId,
      outcome: 'VERIFIED',
      reasonCode: 'READBACK_CONFIRMED',
    }),
    /VERIFIED reconciliation requires fresh independent verified evidence/i,
  );
  assert.equal(memory.snapshot(inv.invocationId).phase, ExactEffectPhase.RECONCILE);
  assert.equal(modifies, 1);
  assert.equal(reads, 1);
});

test('message-modify verifier rejects hostile identities before any Gmail readback', async () => {
  let getterReads = 0;
  let remoteReads = 0;
  const verifier = new GmailMessageModifyVerifierV1({
    workspaceClient: {
      getGmailMessage: async () => {
        remoteReads += 1;
        return { id: 'msg_1', threadId: 'thread_1', labelIds: ['IMPORTANT'] };
      },
    },
  });

  const hostile = {};
  Object.defineProperty(hostile, 'invocationId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'gmail-modify-hostile';
    },
  });
  await assert.rejects(
    () => verifier.verify({
      invocation: hostile,
      executionId: 'gmail-modify-hostile:attempt:1',
      observation: {},
    }),
    /enumerable data property/i,
  );
  assert.equal(getterReads, 0);
  assert.equal(remoteReads, 0);

  const inv = invocation('gmail-modify-coercive');
  const coercive = {
    toString() {
      getterReads += 1;
      return `${inv.invocationId}:attempt:1`;
    },
  };
  await assert.rejects(
    () => verifier.verify({
      invocation: inv,
      executionId: coercive,
      observation: {
        schemaVersion: 1,
        observationId: 'obs-coercive',
        invocationId: inv.invocationId,
        status: 'OK',
        summary: '',
        data: {
          userId,
          messageId: 'msg_1',
          threadId: 'thread_1',
          labelIds: ['IMPORTANT'],
          historyId: '8',
          internalDate: String(baseMs),
          sizeEstimate: 10,
        },
        artifactRefs: [],
        observedAt: new Date(baseMs).toISOString(),
      },
    }),
    /executionId does not contain a valid attempt/i,
  );
  assert.equal(getterReads, 0);
  assert.equal(remoteReads, 0);
});

test('reconciliation validates effect and policy bindings before remote readback', async () => {
  let reads = 0;
  const inv = invocation('gmail-modify-binding');
  const verifier = new GmailMessageModifyVerifierV1({
    workspaceClient: {
      getGmailMessage: async () => {
        reads += 1;
        return { id: 'msg_1', threadId: 'thread_1', labelIds: ['IMPORTANT'] };
      },
    },
  });

  await assert.rejects(
    () => verifier.reconcileVerify({
      invocation: inv,
      effectId: 'other-effect',
      executionId: `${inv.invocationId}:attempt:1`,
      attempt: 1,
      policyDecisionId: inv.policyDecisionId,
      expectedOutcome: 'VERIFIED',
    }),
    /effectId is invalid/i,
  );
  await assert.rejects(
    () => verifier.reconcileVerify({
      invocation: inv,
      effectId: inv.invocationId,
      executionId: `${inv.invocationId}:attempt:1`,
      attempt: 1,
      policyDecisionId: 'other-policy',
      expectedOutcome: 'VERIFIED',
    }),
    /policyDecisionId is invalid/i,
  );
  assert.equal(reads, 0);
});
