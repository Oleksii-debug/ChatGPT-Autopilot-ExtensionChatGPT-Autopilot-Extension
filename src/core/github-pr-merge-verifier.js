import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GITHUB_PROVIDER_ID, GitHubToolId } from './github-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA = /^[a-f0-9]{40,64}$/iu;
const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);

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

function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function exactSha(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !SHA.test(value)) throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function exactMergeMethod(value) {
  if (typeof value !== 'string' || !MERGE_METHODS.has(value)) throw new Error('mergeMethod is invalid');
  return value;
}

function attemptFromExecutionId(value) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('executionId does not contain a valid attempt');
  const match = /:attempt:(\d+)$/u.exec(value);
  const attempt = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 64) throw new Error('executionId does not contain a valid attempt');
  return attempt;
}

function expectedMerge(invocation) {
  const admitted = snapshotRecord(invocation, 'GitHub pull-request-merge invocation');
  if (admitted.providerId !== GITHUB_PROVIDER_ID || admitted.toolId !== GitHubToolId.PULL_REQUEST_MERGE) {
    throw new Error('GitHub pull-request-merge verifier accepts only the canonical merge invocation');
  }
  const args = snapshotRecord(
    admitted.arguments,
    'GitHub pull-request-merge arguments',
    new Set(['repositoryFullName', 'pullRequestNumber', 'expectedHeadSha', 'mergeMethod']),
  );
  return Object.freeze({
    invocationId: requireId(admitted.invocationId, 'invocationId'),
    policyDecisionId: requireId(admitted.policyDecisionId, 'policyDecisionId'),
    repositoryFullName: repository(args.repositoryFullName),
    pullRequestNumber: positiveInteger(args.pullRequestNumber, 'pullRequestNumber'),
    expectedHeadSha: exactSha(args.expectedHeadSha, 'expectedHeadSha'),
    mergeMethod: exactMergeMethod(args.mergeMethod),
  });
}

function observedMerge(expected, observation) {
  const observed = snapshotRecord(observation, 'GitHub pull-request-merge observation');
  if (requireId(observed.invocationId, 'observation.invocationId') !== expected.invocationId) {
    throw new Error('GitHub pull-request-merge observation invocation identity mismatch');
  }
  const data = snapshotRecord(
    observed.data,
    'GitHub pull-request-merge observation data',
    new Set(['repositoryFullName', 'pullRequestNumber', 'expectedHeadSha', 'mergeMethod', 'merged', 'mergeCommitSha']),
  );
  if (data.repositoryFullName !== expected.repositoryFullName
      || data.pullRequestNumber !== expected.pullRequestNumber
      || exactSha(data.expectedHeadSha, 'observed expectedHeadSha') !== expected.expectedHeadSha
      || data.mergeMethod !== expected.mergeMethod
      || data.merged !== true) {
    throw new Error('GitHub pull-request-merge observation identity mismatch');
  }
  return Object.freeze({
    ...expected,
    observationId: requireId(observed.observationId, 'observationId'),
    mergeCommitSha: exactSha(data.mergeCommitSha, 'mergeCommitSha'),
  });
}

export class GitHubPullRequestMergeVerifierV1 {
  constructor({ githubClient, verifierId = 'github-pr-merge-readback-verifier', now = () => Date.now() } = {}) {
    this.readPullRequest = bindDataMethod(githubClient, 'readPullRequest', 'GitHub readback client');
    this.verifierId = requireId(verifierId, 'verifierId');
    if (this.verifierId === GITHUB_PROVIDER_ID) throw new Error('GitHub merge verifier identity must differ from provider identity');
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(expected) {
    const pull = snapshotRecord(await this.readPullRequest({
      repositoryFullName: expected.repositoryFullName,
      pullRequestNumber: expected.pullRequestNumber,
    }), 'GitHub pull request merge readback');
    const matches = pull.repositoryFullName === expected.repositoryFullName
      && pull.number === expected.pullRequestNumber
      && pull.state === 'closed'
      && pull.merged === true
      && exactSha(pull.headSha, 'readback headSha') === expected.expectedHeadSha;
    return Object.freeze({ expected, matches, readback: pull });
  }

  #verification(readback, executionId, attempt, observationId, suffix = '') {
    const verified = readback.matches;
    return {
      schemaVersion: 1,
      verificationId: `${readback.expected.invocationId}:github-pr-merge-verification${suffix}:${attempt}`,
      invocationId: readback.expected.invocationId,
      observationId,
      status: verified ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: verified ? 'GITHUB_PULL_REQUEST_MERGE_CONFIRMED' : 'GITHUB_PULL_REQUEST_MERGE_NOT_CONFIRMED',
      summary: verified
        ? 'Fresh independent GitHub readback confirmed the exact pull request is closed and merged at the expected head.'
        : 'Fresh independent GitHub readback did not confirm the exact pull request merge at the expected head.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: readback.expected.policyDecisionId,
      effectId: readback.expected.invocationId,
      executionId,
      attempt,
    };
  }

  async verify({ invocation, executionId, observation } = {}) {
    const attempt = attemptFromExecutionId(executionId);
    const expected = expectedMerge(invocation);
    const observed = observedMerge(expected, observation);
    const readback = await this.#readback(expected);
    return this.#verification(readback, executionId, attempt, observed.observationId);
  }

  async reconcileVerify({
    invocation,
    effectId,
    executionId,
    attempt,
    policyDecisionId,
    expectedOutcome,
  } = {}) {
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) {
      throw new Error('GitHub pull-request merge cannot prove SAFE_RETRY after dispatch');
    }
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED) {
      throw new Error('GitHub pull-request merge reconciliation supports only VERIFIED or manual review');
    }

    const expected = expectedMerge(invocation);
    if (requireId(effectId, 'effectId') !== expected.invocationId) throw new Error('effectId is invalid');
    if (requireId(policyDecisionId, 'policyDecisionId') !== expected.policyDecisionId) throw new Error('policyDecisionId is invalid');
    const exactAttempt = attemptFromExecutionId(executionId);
    if (attempt !== exactAttempt) throw new Error('attempt does not match executionId');

    const readback = await this.#readback(expected);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: `${expected.invocationId}:github-pr-merge-readback:reconcile-${attempt}`,
      invocationId: expected.invocationId,
      status: 'OK',
      summary: 'Fresh GitHub pull request readback classified whether the expected-head merge is committed.',
      data: {
        committed: readback.matches,
        repositoryFullName: expected.repositoryFullName,
        pullRequestNumber: expected.pullRequestNumber,
        expectedHeadSha: expected.expectedHeadSha,
        mergeMethod: expected.mergeMethod,
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
