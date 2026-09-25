import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GITHUB_PROVIDER_ID, GitHubToolId } from './github-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA = /^[a-f0-9]{40,64}$/u;
const REVIEW_EVENTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const REVIEW_STATE_BY_EVENT = Object.freeze({
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  COMMENT: 'COMMENTED',
});
const MAX_BODY = 100_000;

const VERIFIER_OPTION_KEYS = new Set(['githubClient', 'verifierId', 'now']);
const VERIFY_REQUEST_KEYS = new Set(['invocation', 'executionId', 'observation']);
const RECONCILE_REQUEST_KEYS = new Set([
  'invocation',
  'effectId',
  'executionId',
  'attempt',
  'policyDecisionId',
  'expectedOutcome',
  'priorObservation',
]);

function requireId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(label + ' is invalid');
  return value;
}

function snapshotRecord(value, label, allowed = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be a plain object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(label + ' must be a plain object');
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed && !allowed.has(key))) throw new Error(label + ' contains unknown field');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function bindDataMethod(target, method, label) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error(label + ' is required');
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, method);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new Error(label + '.' + method + ' must be a data method');
      }
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new Error(label + '.' + method + ' is required');
}

function repository(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 300
      || !REPOSITORY.test(value) || value.includes('..')) {
    throw new Error('repositoryFullName is invalid');
  }
  return value;
}

function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(label + ' is invalid');
  return value;
}

function exactSha(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !SHA.test(value)) throw new Error(label + ' is invalid');
  return value;
}

function reviewEvent(value) {
  if (typeof value !== 'string' || !REVIEW_EVENTS.has(value)) throw new Error('event is invalid');
  return value;
}

function reviewBody(value, event) {
  const body = value == null ? '' : value;
  if (typeof body !== 'string' || body.length > MAX_BODY) throw new Error('body is invalid');
  if (event !== 'APPROVE' && !body.trim()) throw new Error('body is required for COMMENT or REQUEST_CHANGES');
  return body;
}

function attemptFromExecutionId(value) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('executionId does not contain a valid attempt');
  const match = /:attempt:(\d+)$/u.exec(value);
  const attempt = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 64) throw new Error('executionId does not contain a valid attempt');
  return attempt;
}

function expectedReview(invocation) {
  const admitted = snapshotRecord(invocation, 'GitHub pull-request-review invocation');
  if (admitted.providerId !== GITHUB_PROVIDER_ID || admitted.toolId !== GitHubToolId.PULL_REQUEST_REVIEW_CREATE) {
    throw new Error('GitHub pull-request-review verifier accepts only the canonical formal-review invocation');
  }
  const args = snapshotRecord(
    admitted.arguments,
    'GitHub pull-request-review arguments',
    new Set(['repositoryFullName', 'pullRequestNumber', 'expectedHeadSha', 'event', 'body']),
  );
  const event = reviewEvent(args.event);
  return Object.freeze({
    invocationId: requireId(admitted.invocationId, 'invocationId'),
    policyDecisionId: requireId(admitted.policyDecisionId, 'policyDecisionId'),
    repositoryFullName: repository(args.repositoryFullName),
    pullRequestNumber: positiveInteger(args.pullRequestNumber, 'pullRequestNumber'),
    expectedHeadSha: exactSha(args.expectedHeadSha, 'expectedHeadSha'),
    event,
    body: reviewBody(args.body, event),
    expectedState: REVIEW_STATE_BY_EVENT[event],
  });
}

function observedReview(expected, observation) {
  const observed = snapshotRecord(observation, 'GitHub pull-request-review observation');
  if (requireId(observed.invocationId, 'observation.invocationId') !== expected.invocationId) {
    throw new Error('GitHub pull-request-review observation invocation identity mismatch');
  }
  if (observed.status !== 'OK') throw new Error('GitHub pull-request-review observation status is invalid');
  const data = snapshotRecord(
    observed.data,
    'GitHub pull-request-review observation data',
    new Set([
      'repositoryFullName', 'pullRequestNumber', 'reviewId', 'expectedHeadSha',
      'event', 'body', 'state', 'commitId', 'url',
    ]),
  );
  const event = reviewEvent(data.event);
  if (data.repositoryFullName !== expected.repositoryFullName
      || data.pullRequestNumber !== expected.pullRequestNumber
      || exactSha(data.expectedHeadSha, 'observed expectedHeadSha') !== expected.expectedHeadSha
      || event !== expected.event
      || reviewBody(data.body, event) !== expected.body
      || data.state !== expected.expectedState
      || exactSha(data.commitId, 'observed commitId') !== expected.expectedHeadSha
      || typeof data.url !== 'string') {
    throw new Error('GitHub pull-request-review observation identity mismatch');
  }
  return Object.freeze({
    ...expected,
    reviewId: positiveInteger(data.reviewId, 'reviewId'),
    observationId: requireId(observed.observationId, 'observationId'),
  });
}

export class GitHubPullRequestReviewVerifierV1 {
  constructor(input = {}) {
    const options = snapshotRecord(input, 'GitHub pull-request-review verifier options', VERIFIER_OPTION_KEYS);
    const githubClient = options.githubClient;
    const verifierId = options.verifierId === undefined
      ? 'github-pr-review-readback-verifier'
      : options.verifierId;
    const now = options.now === undefined ? (() => Date.now()) : options.now;
    this.readPullRequest = bindDataMethod(githubClient, 'readPullRequest', 'GitHub pull-request parent readback client');
    this.readPullRequestReview = bindDataMethod(githubClient, 'readPullRequestReview', 'GitHub review readback client');
    this.verifierId = requireId(verifierId, 'verifierId');
    if (this.verifierId === GITHUB_PROVIDER_ID) throw new Error('GitHub review verifier identity must differ from provider identity');
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(expected, reviewId) {
    const id = positiveInteger(reviewId, 'reviewId');
    const review = snapshotRecord(await this.readPullRequestReview({
      repositoryFullName: expected.repositoryFullName,
      pullRequestNumber: expected.pullRequestNumber,
      reviewId: id,
    }), 'GitHub pull request review readback');
    const parent = snapshotRecord(await this.readPullRequest({
      repositoryFullName: expected.repositoryFullName,
      pullRequestNumber: expected.pullRequestNumber,
    }), 'GitHub pull request parent readback');

    const reviewMatches = review.repositoryFullName === expected.repositoryFullName
      && review.pullRequestNumber === expected.pullRequestNumber
      && review.reviewId === id
      && review.body === expected.body
      && review.state === expected.expectedState
      && exactSha(review.commitId, 'readback commitId') === expected.expectedHeadSha;
    const parentMatches = parent.repositoryFullName === expected.repositoryFullName
      && parent.number === expected.pullRequestNumber
      && parent.state === 'open'
      && parent.merged === false
      && exactSha(parent.headSha, 'parent readback headSha') === expected.expectedHeadSha;
    return Object.freeze({
      expected,
      reviewId: id,
      matches: reviewMatches && parentMatches,
      reviewMatches,
      parentMatches,
      readback: review,
      parentReadback: parent,
    });
  }

  #verification(readback, executionId, attempt, observationId, suffix = '') {
    const verified = readback.matches;
    const staleParent = readback.reviewMatches && !readback.parentMatches;
    return {
      schemaVersion: 1,
      verificationId: readback.expected.invocationId + ':github-pr-review-verification' + suffix + ':' + attempt,
      invocationId: readback.expected.invocationId,
      observationId,
      status: verified ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: verified
        ? 'GITHUB_PULL_REQUEST_REVIEW_CONFIRMED'
        : staleParent
          ? 'GITHUB_PULL_REQUEST_REVIEW_PARENT_HEAD_STALE'
          : 'GITHUB_PULL_REQUEST_REVIEW_NOT_CONFIRMED',
      summary: verified
        ? 'Fresh independent GitHub readback confirmed the exact formal review and the parent pull request remains on the expected open head.'
        : staleParent
          ? 'The exact formal review exists, but the parent pull request no longer remains on the expected open head.'
          : 'Fresh independent GitHub readback did not confirm the exact formal review on the expected pull request head.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: readback.expected.policyDecisionId,
      effectId: readback.expected.invocationId,
      executionId,
      attempt,
    };
  }

  async verify(input = {}) {
    const request = snapshotRecord(
      input,
      'GitHub pull-request-review verify request',
      VERIFY_REQUEST_KEYS,
    );
    const invocation = request.invocation;
    const executionId = request.executionId;
    const observation = request.observation;
    const attempt = attemptFromExecutionId(executionId);
    const expected = expectedReview(invocation);
    const observed = observedReview(expected, observation);
    const readback = await this.#readback(expected, observed.reviewId);
    return this.#verification(readback, executionId, attempt, observed.observationId);
  }

  async reconcileVerify(input = {}) {
    const request = snapshotRecord(
      input,
      'GitHub pull-request-review reconciliation request',
      RECONCILE_REQUEST_KEYS,
    );
    const invocation = request.invocation;
    const effectId = request.effectId;
    const executionId = request.executionId;
    const attempt = request.attempt;
    const policyDecisionId = request.policyDecisionId;
    const expectedOutcome = request.expectedOutcome;
    const priorObservation = request.priorObservation;
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) {
      throw new Error('GitHub pull-request review cannot prove SAFE_RETRY after dispatch');
    }
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED) {
      throw new Error('GitHub pull-request review reconciliation supports only VERIFIED or manual review');
    }

    const expected = expectedReview(invocation);
    if (requireId(effectId, 'effectId') !== expected.invocationId) throw new Error('effectId is invalid');
    if (requireId(policyDecisionId, 'policyDecisionId') !== expected.policyDecisionId) throw new Error('policyDecisionId is invalid');
    const exactAttempt = attemptFromExecutionId(executionId);
    if (attempt !== exactAttempt) throw new Error('attempt does not match executionId');
    if (!priorObservation) {
      throw new Error('GitHub pull-request review requires the immutable provider review identity for automatic reconciliation; otherwise manual review is required');
    }
    const observed = observedReview(expected, priorObservation);
    const readback = await this.#readback(expected, observed.reviewId);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: expected.invocationId + ':github-pr-review-readback:reconcile-' + attempt,
      invocationId: expected.invocationId,
      status: 'OK',
      summary: 'Fresh GitHub review readback classified whether the exact formal review is committed.',
      data: {
        committed: readback.matches,
        reviewMatches: readback.reviewMatches,
        parentHeadMatches: readback.parentMatches,
        repositoryFullName: expected.repositoryFullName,
        pullRequestNumber: expected.pullRequestNumber,
        reviewId: observed.reviewId,
        expectedHeadSha: expected.expectedHeadSha,
        event: expected.event,
        state: expected.expectedState,
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
