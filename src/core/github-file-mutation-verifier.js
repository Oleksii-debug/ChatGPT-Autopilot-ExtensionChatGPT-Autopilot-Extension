import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GITHUB_PROVIDER_ID, GitHubToolId } from './github-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA = /^[a-f0-9]{40,64}$/iu;
const REF = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\.lock(?:\/|$))[A-Za-z0-9._\/-]{1,240}$/u;
const MODES = new Set(['create', 'update']);
const MAX_PATH = 4096;
const MAX_CONTENT_BYTES = 750_000;

function requireId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function snapshotRecord(value, label, allowed = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed && !allowed.has(key))) throw new Error(`${label} contains unknown field`);
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

function repository(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 300 || !REPOSITORY.test(value) || value.includes('..')) {
    throw new Error('repositoryFullName is invalid');
  }
  return value;
}

function exactSha(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !SHA.test(value)) throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function exactRef(value, label = 'branch') {
  if (typeof value !== 'string' || value !== value.trim() || !REF.test(value)
      || value.endsWith('/') || value.startsWith('.') || value.includes('//')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactPath(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > MAX_PATH
      || value.startsWith('/') || value.endsWith('/') || value.includes('\\')) {
    throw new Error('path is invalid');
  }
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('path is invalid');
  return value;
}

function exactMessage(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 10_000) throw new Error('message is invalid');
  return value.trim();
}

function exactContent(value) {
  if (typeof value !== 'string') throw new Error('contentUtf8 must be text');
  if (new TextEncoder().encode(value).byteLength > MAX_CONTENT_BYTES) throw new Error('contentUtf8 exceeds the bounded GitHub file size');
  return value;
}

function exactMode(value) {
  const mode = value == null || value === '' ? 'create' : value;
  if (typeof mode !== 'string' || !MODES.has(mode)) throw new Error('mode is invalid');
  return mode;
}

function attemptFromExecutionId(value) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('executionId does not contain a valid attempt');
  const match = /:attempt:(\d+)$/u.exec(value);
  const attempt = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 64) throw new Error('executionId does not contain a valid attempt');
  return attempt;
}

function expectedMutation(invocation) {
  const admitted = snapshotRecord(invocation, 'GitHub file-mutation invocation');
  if (admitted.providerId !== GITHUB_PROVIDER_ID
      || ![GitHubToolId.FILE_PUT, GitHubToolId.FILE_DELETE].includes(admitted.toolId)) {
    throw new Error('GitHub file-mutation verifier accepts only canonical file put/delete invocations');
  }
  const invocationId = requireId(admitted.invocationId, 'invocationId');
  const policyDecisionId = requireId(admitted.policyDecisionId, 'policyDecisionId');

  if (admitted.toolId === GitHubToolId.FILE_PUT) {
    const args = snapshotRecord(
      admitted.arguments,
      'GitHub file-put arguments',
      new Set(['repositoryFullName', 'path', 'branch', 'message', 'contentUtf8', 'mode', 'expectedBlobSha']),
    );
    const mode = exactMode(args.mode);
    const expectedBlobSha = args.expectedBlobSha == null || args.expectedBlobSha === ''
      ? ''
      : exactSha(args.expectedBlobSha, 'expectedBlobSha');
    if (mode === 'update' && !expectedBlobSha) throw new Error('update mode requires expectedBlobSha');
    if (mode === 'create' && expectedBlobSha) throw new Error('create mode must not include expectedBlobSha');
    return Object.freeze({
      toolId: admitted.toolId,
      invocationId,
      policyDecisionId,
      repositoryFullName: repository(args.repositoryFullName),
      path: exactPath(args.path),
      branch: exactRef(args.branch),
      message: exactMessage(args.message),
      contentUtf8: exactContent(args.contentUtf8),
      mode,
      expectedBlobSha,
    });
  }

  const args = snapshotRecord(
    admitted.arguments,
    'GitHub file-delete arguments',
    new Set(['repositoryFullName', 'path', 'branch', 'message', 'expectedBlobSha']),
  );
  return Object.freeze({
    toolId: admitted.toolId,
    invocationId,
    policyDecisionId,
    repositoryFullName: repository(args.repositoryFullName),
    path: exactPath(args.path),
    branch: exactRef(args.branch),
    message: exactMessage(args.message),
    expectedBlobSha: exactSha(args.expectedBlobSha, 'expectedBlobSha'),
  });
}

function observedMutation(expected, observation) {
  const observed = snapshotRecord(observation, 'GitHub file-mutation observation');
  if (requireId(observed.invocationId, 'observation.invocationId') !== expected.invocationId) {
    throw new Error('GitHub file-mutation observation invocation identity mismatch');
  }
  const observationId = requireId(observed.observationId, 'observationId');

  if (expected.toolId === GitHubToolId.FILE_PUT) {
    const data = snapshotRecord(
      observed.data,
      'GitHub file-put observation data',
      new Set(['repositoryFullName', 'path', 'branch', 'blobSha', 'commitSha', 'mode']),
    );
    if (data.repositoryFullName !== expected.repositoryFullName
        || data.path !== expected.path
        || data.branch !== expected.branch
        || data.mode !== expected.mode) {
      throw new Error('GitHub file-put observation identity mismatch');
    }
    return Object.freeze({
      ...expected,
      observationId,
      blobSha: exactSha(data.blobSha, 'observed blobSha'),
      commitSha: exactSha(data.commitSha, 'observed commitSha'),
    });
  }

  const data = snapshotRecord(
    observed.data,
    'GitHub file-delete observation data',
    new Set(['repositoryFullName', 'path', 'branch', 'deletedBlobSha', 'commitSha']),
  );
  if (data.repositoryFullName !== expected.repositoryFullName
      || data.path !== expected.path
      || data.branch !== expected.branch
      || exactSha(data.deletedBlobSha, 'observed deletedBlobSha') !== expected.expectedBlobSha) {
    throw new Error('GitHub file-delete observation identity mismatch');
  }
  return Object.freeze({
    ...expected,
    observationId,
    commitSha: exactSha(data.commitSha, 'observed commitSha'),
  });
}

function exact404(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const values = Object.create(null);
  for (const key of ['code', 'status', 'effectMayHaveOccurred', 'safeToRetry']) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
    values[key] = descriptor.value;
  }
  return values.code === 'GITHUB_HTTP_404'
    && values.status === 404
    && values.effectMayHaveOccurred === false
    && values.safeToRetry === true;
}

export class GitHubFileMutationVerifierV1 {
  constructor({ githubClient, verifierId = 'github-file-mutation-readback-verifier', now = () => Date.now() } = {}) {
    this.readCommitObject = bindDataMethod(githubClient, 'readCommitObject', 'GitHub readback client');
    this.readFile = bindDataMethod(githubClient, 'readFile', 'GitHub readback client');
    this.verifierId = requireId(verifierId, 'verifierId');
    if (this.verifierId === GITHUB_PROVIDER_ID) throw new Error('GitHub file-mutation verifier identity must differ from provider identity');
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(identity) {
    const commit = snapshotRecord(
      await this.readCommitObject({
        repositoryFullName: identity.repositoryFullName,
        commitSha: identity.commitSha,
      }),
      'GitHub file-mutation commit readback',
      new Set(['repositoryFullName', 'commitSha', 'treeSha', 'parentShas']),
    );
    const commitMatches = commit.repositoryFullName === identity.repositoryFullName
      && exactSha(commit.commitSha, 'readback commitSha') === identity.commitSha
      && SHA.test(commit.treeSha);

    if (!commitMatches) {
      return Object.freeze({ identity, matches: false, reason: 'COMMIT_IDENTITY_MISMATCH' });
    }

    if (identity.toolId === GitHubToolId.FILE_PUT) {
      const file = snapshotRecord(
        await this.readFile({
          repositoryFullName: identity.repositoryFullName,
          path: identity.path,
          ref: identity.commitSha,
        }),
        'GitHub file-put readback',
        new Set(['repositoryFullName', 'path', 'sha', 'sizeBytes', 'text']),
      );
      const matches = file.repositoryFullName === identity.repositoryFullName
        && file.path === identity.path
        && exactSha(file.sha, 'readback blobSha') === identity.blobSha
        && file.text === identity.contentUtf8;
      return Object.freeze({ identity, matches, reason: matches ? 'PUT_CONFIRMED' : 'PUT_MISMATCH' });
    }

    try {
      await this.readFile({
        repositoryFullName: identity.repositoryFullName,
        path: identity.path,
        ref: identity.commitSha,
      });
      return Object.freeze({ identity, matches: false, reason: 'DELETE_PATH_STILL_PRESENT' });
    } catch (error) {
      if (!exact404(error)) throw error;
      return Object.freeze({ identity, matches: true, reason: 'DELETE_CONFIRMED' });
    }
  }

  #verification(readback, executionId, attempt, observationId, suffix = '') {
    const verified = readback.matches;
    const operation = readback.identity.toolId === GitHubToolId.FILE_PUT ? 'write' : 'delete';
    return {
      schemaVersion: 1,
      verificationId: `${readback.identity.invocationId}:github-file-mutation-verification${suffix}:${attempt}`,
      invocationId: readback.identity.invocationId,
      observationId,
      status: verified ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: verified
        ? (operation === 'write' ? 'GITHUB_FILE_WRITE_CONFIRMED' : 'GITHUB_FILE_DELETE_CONFIRMED')
        : 'GITHUB_FILE_MUTATION_NOT_CONFIRMED',
      summary: verified
        ? `Fresh independent GitHub readback confirmed the exact file ${operation} at the provider-returned immutable commit.`
        : 'Fresh independent GitHub readback did not confirm the exact file mutation at the provider-returned immutable commit.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: readback.identity.policyDecisionId,
      effectId: readback.identity.invocationId,
      executionId,
      attempt,
    };
  }

  async verify({ invocation, executionId, observation } = {}) {
    const attempt = attemptFromExecutionId(executionId);
    const expected = expectedMutation(invocation);
    const identity = observedMutation(expected, observation);
    const readback = await this.#readback(identity);
    return this.#verification(readback, executionId, attempt, identity.observationId);
  }

  async reconcileVerify({
    invocation,
    effectId,
    executionId,
    attempt,
    policyDecisionId,
    expectedOutcome,
    priorObservation,
  } = {}) {
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) {
      throw new Error('GitHub file mutation cannot prove SAFE_RETRY after dispatch');
    }
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED) {
      throw new Error('GitHub file-mutation reconciliation supports only VERIFIED or manual review');
    }

    const expected = expectedMutation(invocation);
    if (requireId(effectId, 'effectId') !== expected.invocationId) throw new Error('effectId is invalid');
    if (requireId(policyDecisionId, 'policyDecisionId') !== expected.policyDecisionId) throw new Error('policyDecisionId is invalid');
    const exactAttempt = attemptFromExecutionId(executionId);
    if (attempt !== exactAttempt) throw new Error('attempt does not match executionId');
    if (!priorObservation) {
      throw new Error('GitHub file mutation requires the immutable provider commit identity for automatic reconciliation; otherwise manual review is required');
    }
    const identity = observedMutation(expected, priorObservation);
    const readback = await this.#readback(identity);

    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: `${expected.invocationId}:github-file-mutation-readback:reconcile-${attempt}`,
      invocationId: expected.invocationId,
      status: 'OK',
      summary: 'Fresh GitHub immutable-commit readback classified whether the exact file mutation is committed.',
      data: {
        committed: readback.matches,
        repositoryFullName: expected.repositoryFullName,
        path: expected.path,
        commitSha: identity.commitSha,
        toolId: expected.toolId,
      },
      artifactRefs: [],
      observedAt,
    };
    const verification = this.#verification(readback, executionId, attempt, observation.observationId, ':reconcile');
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
