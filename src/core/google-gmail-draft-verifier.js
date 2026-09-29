import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GOOGLE_WORKSPACE_PROVIDER_ID, GoogleWorkspaceToolId } from './google-workspace-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const B64URL = /^[A-Za-z0-9_-]+$/u;

function requireId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`);
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
function decodeBase64Url(value) {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = globalThis.atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}
async function digest(value) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const bytes = decodeBase64Url(canonicalRaw(value));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function requireInvocation(invocation) {
  if (!invocation || invocation.toolId !== GoogleWorkspaceToolId.GMAIL_DRAFT_CREATE
      || invocation.providerId !== GOOGLE_WORKSPACE_PROVIDER_ID) {
    throw new Error('Gmail draft verifier accepts only canonical draft-create invocations');
  }
  const userId = String(invocation.arguments?.userId ?? '');
  if (!userId || userId !== userId.trim()) throw new Error('Gmail draft verifier requires exact userId');
  const raw = canonicalRaw(invocation.arguments?.rawMessageBase64Url);
  return { userId, raw };
}
function draftIdFromObservation(observation) {
  const draftId = observation?.data?.draftId;
  return requireId(draftId, 'observed draftId');
}

export class GmailDraftVerifierV1 {
  constructor({ workspaceClient, verifierId = 'gmail-draft-readback-verifier', now = () => Date.now() } = {}) {
    if (!workspaceClient || typeof workspaceClient.getGmailDraft !== 'function') throw new Error('Google Workspace draft readback client is required');
    this.workspaceClient = workspaceClient;
    this.verifierId = requireId(verifierId, 'verifierId');
    if (this.verifierId === GOOGLE_WORKSPACE_PROVIDER_ID) throw new Error('Gmail verifier identity must differ from effect provider identity');
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(invocation, observation) {
    const expected = requireInvocation(invocation);
    const draftId = draftIdFromObservation(observation);
    const draft = await this.workspaceClient.getGmailDraft({ userId: expected.userId, draftId });
    if (draft?.userId !== expected.userId || draft?.draftId !== draftId) throw new Error('Gmail draft readback identity mismatch');
    const expectedSha256 = await digest(expected.raw);
    const observedSha256 = await digest(draft.rawMessageBase64Url);
    return { draftId, expectedSha256, observedSha256, matches: expectedSha256 === observedSha256 };
  }

  async verify({ invocation, executionId, observation } = {}) {
    const readback = await this.#readback(invocation, observation);
    const attempt = attemptFromExecutionId(executionId);
    return {
      schemaVersion: 1,
      verificationId: `${invocation.invocationId}:gmail-draft-verification:${attempt}`,
      invocationId: invocation.invocationId,
      observationId: observation.observationId,
      status: readback.matches ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: readback.matches ? 'GMAIL_DRAFT_CONTENT_MATCHED' : 'GMAIL_DRAFT_CONTENT_MISMATCH',
      summary: readback.matches
        ? 'Fresh Gmail draft readback matched the requested RFC822 bytes.'
        : 'Fresh Gmail draft readback did not match the requested RFC822 bytes.',
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
      throw new Error('Gmail draft create cannot prove SAFE_RETRY without a provider-issued draft identity');
    }
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED || !priorObservation) {
      throw new Error('Gmail draft reconciliation requires an observed draft identity');
    }
    const readback = await this.#readback(invocation, priorObservation);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: `${invocation.invocationId}:gmail-draft-readback:reconcile-${attempt}`,
      invocationId: invocation.invocationId,
      status: 'OK',
      summary: 'Fresh Gmail draft readback classified the intended draft bytes.',
      data: { committed: readback.matches, draftId: readback.draftId, expectedSha256: readback.expectedSha256, observedSha256: readback.observedSha256 },
      artifactRefs: [],
      observedAt,
    };
    const verification = {
      schemaVersion: 1,
      verificationId: `${invocation.invocationId}:gmail-draft-verification:reconcile-${attempt}`,
      invocationId: invocation.invocationId,
      observationId: observation.observationId,
      status: readback.matches ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: readback.matches ? 'GMAIL_DRAFT_COMMITTED_EFFECT_CONFIRMED' : 'GMAIL_DRAFT_STATE_DIVERGED',
      summary: readback.matches
        ? 'Fresh Gmail readback confirms the intended draft exists with matching RFC822 bytes.'
        : 'Fresh Gmail readback does not match the intended draft bytes.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: policyDecisionId,
      effectId,
      executionId,
      attempt,
    };
    return { verifierId: this.verifierId, verificationAuthorityId: policyDecisionId, effectId, executionId, attempt, observation, verification };
  }
}
