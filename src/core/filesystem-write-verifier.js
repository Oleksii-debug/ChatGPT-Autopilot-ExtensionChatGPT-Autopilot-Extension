import { VerificationStatus, normalizeArtifactRefV1 } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { FILESYSTEM_PROVIDER_ID, FilesystemToolId } from './filesystem-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function requireId(value, label) {
  const out = String(value ?? '').trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

async function sha256Text(value) {
  if (typeof value !== 'string') throw new Error('Filesystem write verifier requires UTF-8 readback text');
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function observationId(invocationId, suffix) {
  return `${invocationId}:filesystem-readback:${suffix}`;
}

function verificationId(invocationId, suffix) {
  return `${invocationId}:filesystem-verification:${suffix}`;
}

/**
 * Independent postcondition path for filesystem.writeExistingText.  It never trusts the
 * mutation response as proof: it performs a fresh read through Native Companion and keeps
 * only hashes/commit classification in exact-effect evidence. Desired bytes remain behind
 * the durable hash-bound ArtifactRef carried by the invocation; raw content is not stored.
 */
export class FilesystemWriteVerifierV1 {
  constructor({ nativeClient, verifierId = 'filesystem-readback-verifier', now = () => Date.now() } = {}) {
    if (!nativeClient?.readText) throw new Error('Filesystem Native Companion readback client is required');
    this.nativeClient = nativeClient;
    this.verifierId = requireId(verifierId, 'verifierId');
    if (this.verifierId === FILESYSTEM_PROVIDER_ID) throw new Error('Filesystem verifier identity must differ from effect provider identity');
    this.now = now;
  }

  async #readback(invocation) {
    if (invocation?.toolId !== FilesystemToolId.WRITE_EXISTING_TEXT) throw new Error('Filesystem verifier accepts only writeExistingText');
    const args = invocation.arguments || {};
    const artifactRef = normalizeArtifactRefV1(args.contentArtifactRef);
    if (!SHA256.test(artifactRef.sha256)) throw new Error('Filesystem write ArtifactRef sha256 is required');
    const expectedBeforeSha256 = String(args.expectedSha256 || '').trim().toLowerCase();
    if (!SHA256.test(expectedBeforeSha256)) throw new Error('Filesystem expectedSha256 is invalid');
    const read = await this.nativeClient.readText({
      rootId: args.rootId,
      relativePath: args.relativePath,
      maxBytes: Math.max(1, artifactRef.sizeBytes + 1),
    });
    const observedSha256 = await sha256Text(read.text);
    const observedBytes = new TextEncoder().encode(read.text).byteLength;
    return Object.freeze({
      rootId: args.rootId,
      relativePath: args.relativePath,
      desiredSha256: artifactRef.sha256,
      desiredBytes: artifactRef.sizeBytes,
      expectedBeforeSha256,
      observedSha256,
      sizeBytes: observedBytes,
      artifactId: artifactRef.artifactId,
    });
  }

  async verify({ invocation, executionId, observation } = {}) {
    const readback = await this.#readback(invocation);
    const committed = readback.observedSha256 === readback.desiredSha256 && readback.sizeBytes === readback.desiredBytes;
    return {
      schemaVersion: 1,
      verificationId: verificationId(invocation.invocationId, 'normal'),
      invocationId: invocation.invocationId,
      observationId: observation.observationId,
      status: committed ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: committed ? 'FILESYSTEM_POSTCONDITION_MATCHED' : 'FILESYSTEM_POSTCONDITION_MISMATCH',
      summary: committed
        ? 'Fresh Native Companion readback matched the desired ArtifactRef digest and size.'
        : 'Fresh Native Companion readback did not match the desired ArtifactRef digest and size.',
      evidenceArtifactIds: [readback.artifactId],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: invocation.policyDecisionId,
      effectId: invocation.invocationId,
      executionId,
      attempt: Number(String(executionId || '').split(':').at(-1)) || 0,
    };
  }

  async reconcileVerify({ invocation, effectId, executionId, attempt, policyDecisionId, expectedOutcome } = {}) {
    const readback = await this.#readback(invocation);
    const committed = readback.observedSha256 === readback.desiredSha256 && readback.sizeBytes === readback.desiredBytes;
    const unchanged = readback.observedSha256 === readback.expectedBeforeSha256;
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: observationId(invocation.invocationId, `reconcile-${attempt}`),
      invocationId: invocation.invocationId,
      status: 'OK',
      summary: 'Fresh filesystem readback classified whether the desired ArtifactRef effect is committed.',
      data: {
        committed,
        unchanged,
        rootId: readback.rootId,
        relativePath: readback.relativePath,
        observedSha256: readback.observedSha256,
        desiredSha256: readback.desiredSha256,
        expectedBeforeSha256: readback.expectedBeforeSha256,
        desiredArtifactId: readback.artifactId,
      },
      artifactRefs: [],
      observedAt,
    };

    let status = VerificationStatus.AMBIGUOUS;
    let reasonCode = 'FILESYSTEM_STATE_DIVERGED';
    let summary = 'Filesystem readback matches neither the desired effect nor the admitted pre-effect digest.';
    if (expectedOutcome === ReconciliationOutcome.VERIFIED && committed) {
      status = VerificationStatus.VERIFIED;
      reasonCode = 'FILESYSTEM_COMMITTED_EFFECT_CONFIRMED';
      summary = 'Fresh readback confirms the desired filesystem effect is committed.';
    } else if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY && unchanged && !committed) {
      status = VerificationStatus.FAILED;
      reasonCode = 'NO_COMMITTED_EFFECT';
      summary = 'Fresh readback confirms the pre-effect digest is unchanged and the desired effect is absent.';
    }

    const verifiedAt = new Date(this.now()).toISOString();
    const verification = {
      schemaVersion: 1,
      verificationId: verificationId(invocation.invocationId, `reconcile-${attempt}`),
      invocationId: invocation.invocationId,
      observationId: observation.observationId,
      status,
      reasonCode,
      summary,
      evidenceArtifactIds: [readback.artifactId],
      verifiedAt,
      verifierId: this.verifierId,
      verificationAuthorityId: policyDecisionId,
      effectId,
      executionId,
      attempt,
    };
    return {
      verifierId: this.verifierId,
      verificationAuthorityId: policyDecisionId,
      effectId,
      executionId,
      attempt,
      observation,
      verification,
    };
  }
}
