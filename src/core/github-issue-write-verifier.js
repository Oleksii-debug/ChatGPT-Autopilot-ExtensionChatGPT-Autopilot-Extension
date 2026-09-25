import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GITHUB_PROVIDER_ID, GitHubToolId } from './github-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

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

function exactBody(value, label, { allowEmpty = false, max = 100_000 } = {}) {
  if (value == null && allowEmpty) return '';
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new Error(`${label} is invalid`);
  return value;
}

function exactTitle(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 1000) throw new Error('title is invalid');
  return value;
}

function attemptFromExecutionId(value) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('executionId does not contain a valid attempt');
  const match = /:attempt:(\d+)$/u.exec(value);
  const attempt = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 64) throw new Error('executionId does not contain a valid attempt');
  return attempt;
}

function expectedMutation(invocation) {
  const admitted = snapshotRecord(invocation, 'GitHub issue-write invocation');
  if (admitted.providerId !== GITHUB_PROVIDER_ID
      || ![
        GitHubToolId.ISSUE_CREATE,
        GitHubToolId.ISSUE_COMMENT_CREATE,
        GitHubToolId.PULL_REQUEST_COMMENT_CREATE,
      ].includes(admitted.toolId)) {
    throw new Error('GitHub conversation-write verifier accepts only canonical issue/issue-comment/pull-request-comment create invocations');
  }
  const invocationId = requireId(admitted.invocationId, 'invocationId');
  const policyDecisionId = requireId(admitted.policyDecisionId, 'policyDecisionId');

  if (admitted.toolId === GitHubToolId.ISSUE_CREATE) {
    const args = snapshotRecord(admitted.arguments, 'GitHub issue-create arguments', new Set(['repositoryFullName', 'title', 'body']));
    return Object.freeze({
      toolId: admitted.toolId,
      invocationId,
      policyDecisionId,
      repositoryFullName: repository(args.repositoryFullName),
      title: exactTitle(args.title),
      body: exactBody(args.body ?? '', 'body', { allowEmpty: true }),
    });
  }

  if (admitted.toolId === GitHubToolId.PULL_REQUEST_COMMENT_CREATE) {
    const args = snapshotRecord(admitted.arguments, 'GitHub pull-request-comment-create arguments', new Set(['repositoryFullName', 'pullRequestNumber', 'body']));
    return Object.freeze({
      toolId: admitted.toolId,
      invocationId,
      policyDecisionId,
      repositoryFullName: repository(args.repositoryFullName),
      pullRequestNumber: positiveInteger(args.pullRequestNumber, 'pullRequestNumber'),
      body: exactBody(args.body, 'body'),
    });
  }

  const args = snapshotRecord(admitted.arguments, 'GitHub issue-comment-create arguments', new Set(['repositoryFullName', 'issueNumber', 'body']));
  return Object.freeze({
    toolId: admitted.toolId,
    invocationId,
    policyDecisionId,
    repositoryFullName: repository(args.repositoryFullName),
    issueNumber: positiveInteger(args.issueNumber, 'issueNumber'),
    body: exactBody(args.body, 'body'),
  });
}

function observedMutation(expected, observation) {
  const observed = snapshotRecord(observation, 'GitHub issue-write observation');
  if (requireId(observed.invocationId, 'observation.invocationId') !== expected.invocationId) {
    throw new Error('GitHub issue-write observation invocation identity mismatch');
  }
  const data = snapshotRecord(observed.data, 'GitHub issue-write observation data');
  if (data.repositoryFullName !== expected.repositoryFullName) throw new Error('GitHub issue-write observation repository mismatch');

  if (expected.toolId === GitHubToolId.ISSUE_CREATE) {
    const number = positiveInteger(data.number, 'observed issue number');
    if (data.title !== expected.title || data.body !== expected.body) throw new Error('GitHub issue-create observation content mismatch');
    return Object.freeze({ ...expected, observationId: requireId(observed.observationId, 'observationId'), issueNumber: number });
  }

  if (expected.toolId === GitHubToolId.PULL_REQUEST_COMMENT_CREATE) {
    const pullRequestNumber = positiveInteger(data.pullRequestNumber, 'observed pull request number');
    const commentId = positiveInteger(data.commentId, 'observed comment id');
    if (pullRequestNumber !== expected.pullRequestNumber || data.body !== expected.body) {
      throw new Error('GitHub pull-request-comment observation parent/content mismatch');
    }
    return Object.freeze({ ...expected, observationId: requireId(observed.observationId, 'observationId'), commentId });
  }

  const issueNumber = positiveInteger(data.issueNumber, 'observed issue number');
  const commentId = positiveInteger(data.commentId, 'observed comment id');
  if (issueNumber !== expected.issueNumber || data.body !== expected.body) {
    throw new Error('GitHub issue-comment observation parent/content mismatch');
  }
  return Object.freeze({ ...expected, observationId: requireId(observed.observationId, 'observationId'), commentId });
}

export class GitHubIssueWriteVerifierV1 {
  constructor({ githubClient, verifierId = 'github-issue-write-readback-verifier', now = () => Date.now() } = {}) {
    this.readIssue = bindDataMethod(githubClient, 'readIssue', 'GitHub readback client');
    this.readIssueComment = bindDataMethod(githubClient, 'readIssueComment', 'GitHub readback client');
    this.readPullRequestComment = bindDataMethod(githubClient, 'readPullRequestComment', 'GitHub readback client');
    this.verifierId = requireId(verifierId, 'verifierId');
    if (this.verifierId === GITHUB_PROVIDER_ID) throw new Error('GitHub issue-write verifier identity must differ from provider identity');
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(invocation, observation) {
    const expected = expectedMutation(invocation);
    const identity = observedMutation(expected, observation);
    if (expected.toolId === GitHubToolId.ISSUE_CREATE) {
      const issue = snapshotRecord(await this.readIssue({
        repositoryFullName: expected.repositoryFullName,
        issueNumber: identity.issueNumber,
      }), 'GitHub issue readback');
      const matches = issue.repositoryFullName === expected.repositoryFullName
        && issue.number === identity.issueNumber
        && issue.title === expected.title
        && issue.body === expected.body;
      return Object.freeze({ ...identity, matches, readback: issue });
    }
    if (expected.toolId === GitHubToolId.PULL_REQUEST_COMMENT_CREATE) {
      const comment = snapshotRecord(await this.readPullRequestComment({
        repositoryFullName: expected.repositoryFullName,
        pullRequestNumber: expected.pullRequestNumber,
        commentId: identity.commentId,
      }), 'GitHub pull request timeline comment readback');
      const matches = comment.repositoryFullName === expected.repositoryFullName
        && comment.pullRequestNumber === expected.pullRequestNumber
        && comment.commentId === identity.commentId
        && comment.body === expected.body;
      return Object.freeze({ ...identity, matches, readback: comment });
    }
    const comment = snapshotRecord(await this.readIssueComment({
      repositoryFullName: expected.repositoryFullName,
      issueNumber: expected.issueNumber,
      commentId: identity.commentId,
    }), 'GitHub issue comment readback');
    const matches = comment.repositoryFullName === expected.repositoryFullName
      && comment.issueNumber === expected.issueNumber
      && comment.commentId === identity.commentId
      && comment.body === expected.body;
    return Object.freeze({ ...identity, matches, readback: comment });
  }

  #verification(readback, executionId, attempt, observationId, suffix = '') {
    const kind = readback.toolId === GitHubToolId.ISSUE_CREATE
      ? 'issue-create'
      : (readback.toolId === GitHubToolId.PULL_REQUEST_COMMENT_CREATE
        ? 'pull-request-comment-create'
        : 'issue-comment-create');
    const verified = readback.matches;
    return {
      schemaVersion: 1,
      verificationId: `${readback.invocationId}:github-${kind}-verification${suffix}:${attempt}`,
      invocationId: readback.invocationId,
      observationId,
      status: verified ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: verified ? 'GITHUB_CREATED_IDENTITY_CONFIRMED' : 'GITHUB_CREATED_IDENTITY_DIVERGED',
      summary: verified
        ? 'Fresh independent GitHub readback confirmed the exact created issue/comment identity and requested content.'
        : 'Fresh independent GitHub readback did not confirm the exact created issue/comment identity and requested content.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: readback.policyDecisionId,
      effectId: readback.invocationId,
      executionId,
      attempt,
    };
  }

  async verify({ invocation, executionId, observation } = {}) {
    const attempt = attemptFromExecutionId(executionId);
    const readback = await this.#readback(invocation, observation);
    return this.#verification(readback, executionId, attempt, readback.observationId);
  }

  async reconcileVerify({
    invocation, effectId, executionId, attempt, policyDecisionId, expectedOutcome, priorObservation,
  } = {}) {
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) {
      throw new Error('GitHub conversation create cannot prove SAFE_RETRY after dispatch');
    }
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED || !priorObservation) {
      throw new Error('GitHub conversation create requires an observed immutable created identity for automatic reconciliation; otherwise manual review is required');
    }
    const safeInvocation = expectedMutation(invocation);
    if (requireId(effectId, 'effectId') !== safeInvocation.invocationId) throw new Error('effectId is invalid');
    if (requireId(policyDecisionId, 'policyDecisionId') !== safeInvocation.policyDecisionId) {
      throw new Error('policyDecisionId is invalid');
    }
    const exactAttempt = attemptFromExecutionId(executionId);
    if (attempt !== exactAttempt) throw new Error('attempt does not match executionId');

    const readback = await this.#readback(invocation, priorObservation);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: `${readback.invocationId}:github-issue-write-readback:reconcile-${attempt}`,
      invocationId: readback.invocationId,
      status: 'OK',
      summary: 'Fresh GitHub readback classified the exact provider-returned created identity.',
      data: {
        committed: readback.matches,
        repositoryFullName: readback.repositoryFullName,
        ...(readback.toolId === GitHubToolId.ISSUE_CREATE
          ? { issueNumber: readback.issueNumber }
          : (readback.toolId === GitHubToolId.PULL_REQUEST_COMMENT_CREATE
            ? { pullRequestNumber: readback.pullRequestNumber, commentId: readback.commentId }
            : { issueNumber: readback.issueNumber, commentId: readback.commentId })),
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
