import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GOOGLE_WORKSPACE_PROVIDER_ID, GoogleWorkspaceToolId } from './google-workspace-agent-provider.js';

const DRIVE_ID = /^[A-Za-z0-9_-]{1,512}$/u;
const VERIFIER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const INVOCATION_KEYS = new Set([
  'schemaVersion', 'invocationId', 'toolId', 'providerId', 'requestedCapabilityIds',
  'policyDecisionId', 'arguments', 'createdAt', 'parentInvocationId',
]);
const OBSERVATION_KEYS = new Set([
  'schemaVersion', 'observationId', 'invocationId', 'status', 'summary', 'data',
  'artifactRefs', 'observedAt',
]);

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

function bindDataMethod(target, method, label) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error(`${label} is required`);
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

function exactParents(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must be a plain array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 128) throw new Error(`${label} is invalid`);
  const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !expectedKeys.has(key))
      || Reflect.ownKeys(descriptors).length !== expectedKeys.size) {
    throw new Error(`${label} must be a dense canonical array`);
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
    out.push(requireDriveId(descriptor.value, `${label}[${index}]`));
  }
  return Object.freeze(out);
}

function snapshotDriveReadback(value) {
  const raw = exactDataRecord(
    value,
    new Set(['id', 'name', 'mimeType', 'parents', 'modifiedTime', 'size', 'md5Checksum', 'sha256Checksum', 'trashed', 'version', 'webViewLink']),
    'Drive readback file',
  );
  const fileId = requireDriveId(raw.id, 'Drive readback file id');
  if (typeof raw.name !== 'string' || raw.name.length > 4096 || /[\u0000-\u001f\u007f]/u.test(raw.name)) {
    throw new Error('Drive readback file name is invalid');
  }
  if (raw.trashed != null && typeof raw.trashed !== 'boolean') throw new Error('Drive readback trashed flag is invalid');
  return Object.freeze({
    id: fileId,
    name: raw.name,
    parents: exactParents(raw.parents ?? [], 'Drive readback parents'),
    trashed: raw.trashed === true,
  });
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

function snapshotInvocation(invocation) {
  const raw = exactDataRecord(invocation, INVOCATION_KEYS, 'Drive update invocation');
  if (raw.schemaVersion !== 1
      || raw.toolId !== GoogleWorkspaceToolId.DRIVE_FILE_UPDATE
      || raw.providerId !== GOOGLE_WORKSPACE_PROVIDER_ID) {
    throw new Error('Drive update verifier accepts only canonical Drive update invocations');
  }
  const invocationId = requireVerifierId(raw.invocationId, 'invocationId');
  const policyDecisionId = requireVerifierId(raw.policyDecisionId, 'policyDecisionId');
  const args = exactDataRecord(
    raw.arguments,
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
  return Object.freeze({
    invocationId,
    policyDecisionId,
    expected: Object.freeze({ fileId, hasName, name, hasDestination, destinationParentId }),
  });
}

function snapshotObservation(observation, invocationId) {
  const raw = exactDataRecord(observation, OBSERVATION_KEYS, 'Drive update observation');
  if (raw.schemaVersion !== 1) throw new Error('Drive update verifier requires canonical observation');
  const observationId = requireVerifierId(raw.observationId, 'observationId');
  if (requireVerifierId(raw.invocationId, 'observation.invocationId') !== invocationId) {
    throw new Error('Drive update observation invocation identity mismatch');
  }
  return Object.freeze({ observationId });
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
    this.getDriveFile = bindDataMethod(workspaceClient, 'getDriveFile', 'workspaceClient');
    this.verifierId = requireVerifierId(verifierId, 'verifierId');
    if (this.verifierId === GOOGLE_WORKSPACE_PROVIDER_ID) {
      throw new Error('Drive verifier identity must differ from effect provider identity');
    }
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(expected) {
    const file = snapshotDriveReadback(await this.getDriveFile({ fileId: expected.fileId }));
    if (file.id !== expected.fileId) throw new Error('Drive update readback identity mismatch');
    return Object.freeze({ expected, file, matches: matchesExpected(file, expected) });
  }

  async verify({ invocation, executionId, observation } = {}) {
    const attempt = attemptFromExecutionId(executionId);
    const safeInvocation = snapshotInvocation(invocation);
    const safeObservation = snapshotObservation(observation, safeInvocation.invocationId);
    const readback = await this.#readback(safeInvocation.expected);
    return {
      schemaVersion: 1,
      verificationId: `${safeInvocation.invocationId}:drive-update-verification:${attempt}`,
      invocationId: safeInvocation.invocationId,
      observationId: safeObservation.observationId,
      status: readback.matches ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: readback.matches ? 'DRIVE_FILE_UPDATE_MATCHED' : 'DRIVE_FILE_UPDATE_DIVERGED',
      summary: readback.matches
        ? 'Fresh independent Drive readback matched the requested file update.'
        : 'Fresh independent Drive readback did not match the requested file update.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: safeInvocation.policyDecisionId,
      effectId: safeInvocation.invocationId,
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
    const safeInvocation = snapshotInvocation(invocation);
    const readback = await this.#readback(safeInvocation.expected);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: `${safeInvocation.invocationId}:drive-update-readback:reconcile-${attempt}`,
      invocationId: safeInvocation.invocationId,
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
      verificationId: `${safeInvocation.invocationId}:drive-update-verification:reconcile-${attempt}`,
      invocationId: safeInvocation.invocationId,
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
