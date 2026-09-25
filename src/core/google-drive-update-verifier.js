import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GOOGLE_WORKSPACE_PROVIDER_ID, GoogleWorkspaceToolId } from './google-workspace-agent-provider.js';

const DRIVE_ID = /^[A-Za-z0-9_-]{1,512}$/u;
const VERIFIER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function exactDataRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`${label} contains unknown field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${String(key)} must be an enumerable data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function requireVerifierId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !VERIFIER_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireDriveId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !DRIVE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Drive update name is invalid');
  }
  return value;
}

function attemptFromExecutionId(value) {
  if (typeof value !== 'string') throw new Error('executionId is invalid');
  const match = /:attempt:(\d+)$/u.exec(value);
  const attempt = match ? Number(match[1]) : 0;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 64) throw new Error('executionId does not contain a valid attempt');
  return attempt;
}

function expectedUpdate(invocation) {
  if (!invocation || invocation.toolId !== GoogleWorkspaceToolId.DRIVE_FILE_UPDATE
      || invocation.providerId !== GOOGLE_WORKSPACE_PROVIDER_ID) {
    throw new Error('Drive update verifier accepts only canonical Drive update invocations');
  }
  const args = exactDataRecord(
    invocation.arguments,
    new Set(['fileId', 'name', 'destinationParentId']),
    'Drive update verifier arguments',
  );
  const fileId = requireDriveId(args.fileId, 'fileId');
  const hasName = Object.prototype.hasOwnProperty.call(args, 'name');
  const hasDestination = Object.prototype.hasOwnProperty.call(args, 'destinationParentId');
  if (!hasName && !hasDestination) throw new Error('Drive update verifier requires a requested mutation');
  const name = hasName ? requireName(args.name) : null;
  const destinationParentId = hasDestination ? requireDriveId(args.destinationParentId, 'destinationParentId') : null;
  if (destinationParentId === fileId) throw new Error('Drive file cannot be moved into itself');
  return Object.freeze({ fileId, hasName, name, hasDestination, destinationParentId });
}

function matchesExpected(file, expected) {
  if (!file || file.id !== expected.fileId || file.trashed === true) return false;
  if (expected.hasName && file.name !== expected.name) return false;
  if (expected.hasDestination) {
    if (!Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== expected.destinationParentId) return false;
  }
  return true;
}

export class DriveFileUpdateVerifierV1 {
  constructor({ workspaceClient, verifierId = 'google-drive-update-readback-verifier', now = () => Date.now() } = {}) {
    if (!workspaceClient || typeof workspaceClient.getDriveFile !== 'function') {
      throw new Error('Google Workspace Drive readback client is required');
    }
    this.workspaceClient = workspaceClient;
    this.verifierId = requireVerifierId(verifierId, 'verifierId');
    if (this.verifierId === GOOGLE_WORKSPACE_PROVIDER_ID) {
      throw new Error('Drive verifier identity must differ from effect provider identity');
    }
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(invocation) {
    const expected = expectedUpdate(invocation);
    const file = await this.workspaceClient.getDriveFile({ fileId: expected.fileId });
    if (!file || file.id !== expected.fileId) throw new Error('Drive update readback identity mismatch');
    return Object.freeze({ expected, file, matches: matchesExpected(file, expected) });
  }

  async verify({ invocation, executionId, observation } = {}) {
    if (!observation || typeof observation.observationId !== 'string') throw new Error('Drive update verifier requires canonical observation');
    const readback = await this.#readback(invocation);
    const attempt = attemptFromExecutionId(executionId);
    return {
      schemaVersion: 1,
      verificationId: `${invocation.invocationId}:drive-update-verification:${attempt}`,
      invocationId: invocation.invocationId,
      observationId: observation.observationId,
      status: readback.matches ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: readback.matches ? 'DRIVE_FILE_UPDATE_MATCHED' : 'DRIVE_FILE_UPDATE_DIVERGED',
      summary: readback.matches
        ? 'Fresh independent Drive readback matched the requested file update.'
        : 'Fresh independent Drive readback did not match the requested file update.',
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
    expectedOutcome,
  } = {}) {
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) {
      throw new Error('Drive update cannot prove SAFE_RETRY from a negative readback after an uncertain mutation dispatch');
    }
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED) {
      throw new Error('Drive update reconciliation supports only independently verified committed state');
    }
    const readback = await this.#readback(invocation);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: `${invocation.invocationId}:drive-update-readback:reconcile-${attempt}`,
      invocationId: invocation.invocationId,
      status: 'OK',
      summary: 'Fresh Drive readback classified the requested update state.',
      data: {
        committed: readback.matches,
        fileId: readback.expected.fileId,
        name: readback.file.name,
        parents: [...readback.file.parents],
      },
      artifactRefs: [],
      observedAt,
    };
    const verification = {
      schemaVersion: 1,
      verificationId: `${invocation.invocationId}:drive-update-verification:reconcile-${attempt}`,
      invocationId: invocation.invocationId,
      observationId: observation.observationId,
      status: readback.matches ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: readback.matches ? 'DRIVE_FILE_UPDATE_COMMITTED_EFFECT_CONFIRMED' : 'DRIVE_FILE_UPDATE_STATE_DIVERGED',
      summary: readback.matches
        ? 'Fresh independent Drive readback confirms the requested update is committed.'
        : 'Fresh independent Drive readback does not prove the requested update is committed.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
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
