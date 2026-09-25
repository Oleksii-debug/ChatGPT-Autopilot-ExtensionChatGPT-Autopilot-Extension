import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GOOGLE_WORKSPACE_PROVIDER_ID, GoogleWorkspaceToolId } from './google-workspace-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,512}$/u;
const B64URL = /^[A-Za-z0-9_-]+$/u;

function requireId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function requireResourceId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !RESOURCE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function attemptFromExecutionId(value) {
  const match = /:attempt:(\d+)$/u.exec(String(value || ''));
  const attempt = match ? Number(match[1]) : 0;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 64) throw new Error('executionId does not contain a valid attempt');
  return attempt;
}
function canonicalRaw(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || !B64URL.test(value) || value.length % 4 === 1) {
    throw new Error('rawMessageBase64Url must be canonical unpadded base64url');
  }
  if (Math.floor((value.length * 3) / 4) > 10_000_000) throw new Error('rawMessageBase64Url exceeds the verifier bound');
  return value;
}
function requireInvocation(invocation) {
  if (!invocation || invocation.toolId !== GoogleWorkspaceToolId.GMAIL_DRAFT_SEND
      || invocation.providerId !== GOOGLE_WORKSPACE_PROVIDER_ID) {
    throw new Error('Gmail draft-send verifier accepts only canonical draft-send invocations');
  }
  const userId = invocation.arguments?.userId;
  if (typeof userId !== 'string' || !userId || userId !== userId.trim()) throw new Error('Gmail draft-send verifier requires exact userId');
  const draftId = requireResourceId(invocation.arguments?.draftId, 'draftId');
  canonicalRaw(invocation.arguments?.rawMessageBase64Url);
  return { userId, draftId };
}
function observedIdentity(invocation, observation) {
  const expected = requireInvocation(invocation);
  const data = observation?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Gmail draft-send observation data is invalid');
  if (data.userId !== expected.userId || data.draftId !== expected.draftId) {
    throw new Error('Gmail draft-send observation does not match the admitted owner/draft identity');
  }
  return {
    ...expected,
    messageId: requireResourceId(data.messageId, 'observed messageId'),
    threadId: requireResourceId(data.threadId, 'observed threadId'),
  };
}

export class GmailDraftSendVerifierV1 {
  constructor({ workspaceClient, verifierId = 'gmail-draft-send-readback-verifier', now = () => Date.now() } = {}) {
    if (!workspaceClient || typeof workspaceClient.getGmailSentMessage !== 'function') {
      throw new Error('Google Workspace sent-message readback client is required');
    }
    this.workspaceClient = workspaceClient;
    this.verifierId = requireId(verifierId, 'verifierId');
    if (this.verifierId === GOOGLE_WORKSPACE_PROVIDER_ID) throw new Error('Gmail send verifier identity must differ from effect provider identity');
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(invocation, observation) {
    const identity = observedIdentity(invocation, observation);
    const message = await this.workspaceClient.getGmailSentMessage({
      userId: identity.userId,
      messageId: identity.messageId,
    });
    if (message?.id !== identity.messageId || message?.threadId !== identity.threadId) {
      throw new Error('Gmail sent-message readback identity mismatch');
    }
    const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
    return { ...identity, sent: labels.includes('SENT'), labelIds: labels };
  }

  async verify({ invocation, executionId, observation } = {}) {
    const readback = await this.#readback(invocation, observation);
    const attempt = attemptFromExecutionId(executionId);
    return {
      schemaVersion: 1,
      verificationId: `${invocation.invocationId}:gmail-draft-send-verification:${attempt}`,
      invocationId: invocation.invocationId,
      observationId: observation.observationId,
      status: readback.sent ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: readback.sent ? 'GMAIL_SENT_MESSAGE_CONFIRMED' : 'GMAIL_SENT_LABEL_NOT_CONFIRMED',
      summary: readback.sent
        ? 'Fresh Gmail readback confirmed the returned message identity in the SENT mailbox state.'
        : 'Fresh Gmail readback did not confirm the returned message identity as SENT.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: invocation.policyDecisionId,
      effectId: invocation.invocationId,
      executionId,
      attempt,
    };
  }

  async reconcileVerify({
    invocation, effectId, executionId, attempt, policyDecisionId,
    expectedOutcome, priorObservation,
  } = {}) {
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) {
      throw new Error('Gmail draft send cannot prove SAFE_RETRY after dispatch');
    }
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED || !priorObservation) {
      throw new Error('Gmail draft-send reconciliation requires an observed sent-message identity; otherwise manual review is required');
    }
    const readback = await this.#readback(invocation, priorObservation);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: `${invocation.invocationId}:gmail-draft-send-readback:reconcile-${attempt}`,
      invocationId: invocation.invocationId,
      status: 'OK',
      summary: 'Fresh Gmail readback classified the provider-returned sent-message identity.',
      data: {
        committed: readback.sent,
        draftId: readback.draftId,
        messageId: readback.messageId,
        threadId: readback.threadId,
        labelIds: [...readback.labelIds],
      },
      artifactRefs: [],
      observedAt,
    };
    const verification = {
      schemaVersion: 1,
      verificationId: `${invocation.invocationId}:gmail-draft-send-verification:reconcile-${attempt}`,
      invocationId: invocation.invocationId,
      observationId: observation.observationId,
      status: readback.sent ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: readback.sent ? 'GMAIL_SENT_EFFECT_CONFIRMED' : 'GMAIL_SENT_EFFECT_NOT_CONFIRMED',
      summary: readback.sent
        ? 'Fresh Gmail readback confirms the exact returned message identity is SENT.'
        : 'Fresh Gmail readback cannot confirm the exact returned message identity as SENT.',
      evidenceArtifactIds: [],
      verifiedAt: observedAt,
      verifierId: this.verifierId,
      verificationAuthorityId: policyDecisionId,
      effectId,
      executionId,
      attempt,
    };
    return { verifierId: this.verifierId, verificationAuthorityId: policyDecisionId, effectId, executionId, attempt, observation, verification };
  }
}
