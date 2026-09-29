import test from 'node:test';
import assert from 'node:assert/strict';
import { GmailDraftVerifierV1 } from '../src/core/google-gmail-draft-verifier.js';
import { GOOGLE_WORKSPACE_PROVIDER_ID, GoogleWorkspaceCapabilityId, GoogleWorkspaceToolId } from '../src/core/google-workspace-agent-provider.js';

const raw = 'QUJD';
function invocation() {
  return {
    schemaVersion: 1,
    invocationId: 'gmail-draft-verify-1',
    toolId: GoogleWorkspaceToolId.GMAIL_DRAFT_CREATE,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    requestedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_DRAFT_CREATE],
    policyDecisionId: 'decision-gmail-draft-verify-1',
    arguments: { userId: 'owner@example.com', rawMessageBase64Url: raw },
    createdAt: '2026-09-25T07:00:00.000Z',
    parentInvocationId: null,
  };
}
function observation(draftId = 'draft_1') {
  return { observationId: 'gmail-draft-verify-1:observation', data: { draftId } };
}

test('Gmail draft verifier trusts fresh draft readback bytes rather than the mutation response', async () => {
  let readbackRaw = raw;
  const verifier = new GmailDraftVerifierV1({
    workspaceClient: { getGmailDraft: async ({ userId, draftId }) => ({ userId, draftId, rawMessageBase64Url: readbackRaw }) },
    now: () => Date.parse('2026-09-25T07:00:03.000Z'),
  });
  const inv = invocation();
  const ok = await verifier.verify({ invocation: inv, executionId: 'gmail-draft-verify-1:attempt:1', observation: observation() });
  assert.equal(ok.status, 'VERIFIED');
  assert.equal(ok.effectId, inv.invocationId);
  readbackRaw = 'REVG';
  const mismatch = await verifier.verify({ invocation: inv, executionId: 'gmail-draft-verify-1:attempt:1', observation: observation() });
  assert.equal(mismatch.status, 'AMBIGUOUS');
  assert.equal(mismatch.reasonCode, 'GMAIL_DRAFT_CONTENT_MISMATCH');
});

test('Gmail draft reconciliation can re-verify an observed draft but never invent SAFE_RETRY after uncertain create', async () => {
  const verifier = new GmailDraftVerifierV1({
    workspaceClient: { getGmailDraft: async ({ userId, draftId }) => ({ userId, draftId, rawMessageBase64Url: raw }) },
    now: () => Date.parse('2026-09-25T07:01:00.000Z'),
  });
  const common = {
    invocation: invocation(),
    effectId: 'gmail-draft-verify-1',
    executionId: 'gmail-draft-verify-1:attempt:1',
    attempt: 1,
    policyDecisionId: 'decision-gmail-draft-verify-1',
  };
  const verified = await verifier.reconcileVerify({ ...common, expectedOutcome: 'VERIFIED', priorObservation: observation() });
  assert.equal(verified.observation.data.committed, true);
  assert.equal(verified.verification.status, 'VERIFIED');
  await assert.rejects(() => verifier.reconcileVerify({ ...common, expectedOutcome: 'SAFE_RETRY', priorObservation: null }), /cannot prove SAFE_RETRY/);
});
