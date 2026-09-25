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
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error('executionId does not contain a valid attempt');
  }
  const match = /:attempt:(\d+)$/u.exec(value);
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
function snapshotDataRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains an invalid field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}
function bindDataMethod(target, method, label) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
    throw new Error(`${label} is required`);
  }
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, method);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new Error(`${label}.${method} must be a data method`);
      }
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new Error(`${label}.${method} is required`);
}

function requireInvocation(invocation) {
  const admitted = snapshotDataRecord(invocation, 'Gmail draft-send invocation');
  if (admitted.toolId !== GoogleWorkspaceToolId.GMAIL_DRAFT_SEND
      || admitted.providerId !== GOOGLE_WORKSPACE_PROVIDER_ID) {
    throw new Error('Gmail draft-send verifier accepts only canonical draft-send invocations');
  }
  const args = snapshotDataRecord(admitted.arguments, 'Gmail draft-send invocation arguments');
  const userId = args.userId;
  if (typeof userId !== 'string' || !userId || userId !== userId.trim()) throw new Error('Gmail draft-send verifier requires exact userId');
  const draftId = requireResourceId(args.draftId, 'draftId');
  canonicalRaw(args.rawMessageBase64Url);
  return {
    userId,
    draftId,
    invocationId: requireId(admitted.invocationId, 'invocationId'),
    policyDecisionId: requireId(admitted.policyDecisionId, 'policyDecisionId'),
  };
}
function observedIdentity(invocation, observation) {
  const expected = requireInvocation(invocation);
  const observed = snapshotDataRecord(observation, 'Gmail draft-send observation');
  const data = snapshotDataRecord(observed.data, 'Gmail draft-send observation data');
  if (data.userId !== expected.userId || data.draftId !== expected.draftId) {
    throw new Error('Gmail draft-send observation does not match the admitted owner/draft identity');
  }
  return {
    ...expected,
    observationId: observed.observationId,
    messageId: requireResourceId(data.messageId, 'observed messageId'),
    threadId: requireResourceId(data.threadId, 'observed threadId'),
  };
}

export class GmailDraftSendVerifierV1 {
  constructor({ workspaceClient, verifierId = 'gmail-draft-send-readback-verifier', now = () => Date.now() } = {}) {
    this.getGmailSentMessage = bindDataMethod(
      workspaceClient,
      'getGmailSentMessage',
      'Google Workspace sent-message readback client',
    );
    this.verifierId = requireId(verifierId, 'verifierId');
    if (this.verifierId === GOOGLE_WORKSPACE_PROVIDER_ID) throw new Error('Gmail send verifier identity must differ from effect provider identity');
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(invocation, observation) {
    const identity = observedIdentity(invocation, observation);
    const message = await this.getGmailSentMessage({
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
    const attempt = attemptFromExecutionId(executionId);
    const readback = await this.#readback(invocation, observation);
    return {
      schemaVersion: 1,
      verificationId: `${readback.invocationId}:gmail-draft-send-verification:${attempt}`,
      invocationId: readback.invocationId,
      observationId: readback.observationId,
      status: readback.sent ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: readback.sent ? 'GMAIL_SENT_MESSAGE_CONFIRMED' : 'GMAIL_SENT_LABEL_NOT_CONFIRMED',
      summary: readback.sent
        ? 'Fresh Gmail readback confirmed the returned message identity in the SENT mailbox state.'
        : 'Fresh Gmail readback did not confirm the returned message identity as SENT.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: readback.policyDecisionId,
      effectId: readback.invocationId,
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
      observationId: `${readback.invocationId}:gmail-draft-send-readback:reconcile-${attempt}`,
      invocationId: readback.invocationId,
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
      verificationId: `${readback.invocationId}:gmail-draft-send-verification:reconcile-${attempt}`,
      invocationId: readback.invocationId,
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
