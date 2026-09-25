import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_API_ORIGIN,
  GitHubRestClientV1,
} from '../src/core/github-rest-client.js';
import {
  GITHUB_PROVIDER_ID,
  GitHubAgentProviderV1,
  GitHubCapabilityId,
  GitHubToolId,
} from '../src/core/github-agent-provider.js';
import { GitHubExactEffectExecutorV1 } from '../src/core/github-exact-effect.js';
import { GitHubPullRequestReviewVerifierV1 } from '../src/core/github-pr-review-verifier.js';

const at = '2026-09-25T16:10:00.000Z';
const repo = 'owner/repo';
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const reviewBody = 'Independent source review: findings are clear.';

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function pullPayload({ state = 'open', merged = false, head = headSha } = {}) {
  return {
    number: 7,
    title: 'Review candidate',
    body: '',
    state,
    merged,
    merge_commit_sha: null,
    head: { sha: head },
    base: { sha: baseSha },
    html_url: 'https://github.com/owner/repo/pull/7',
  };
}

function reviewPayload({
  reviewId = 80,
  state = 'COMMENTED',
  commitId = headSha,
  body = reviewBody,
} = {}) {
  return {
    id: reviewId,
    body,
    state,
    commit_id: commitId,
    pull_request_url: GITHUB_API_ORIGIN + '/repos/owner/repo/pulls/7',
    html_url: 'https://github.com/owner/repo/pull/7#pullrequestreview-' + reviewId,
  };
}

function nativeClient() {
  return {
    async resolveCredential() {
      return { secret: 'test-token' };
    },
  };
}

function fullClient(overrides = {}) {
  return {
    readRepository: async args => args,
    readFile: async args => args,
    readTree: async args => args,
    readBranch: async args => args,
    findPullRequests: async args => args,
    readPullRequest: async ({ repositoryFullName, pullRequestNumber }) => ({
      repositoryFullName,
      number: pullRequestNumber,
      title: 'Review candidate',
      body: '',
      state: 'open',
      merged: false,
      headSha,
      baseSha,
      mergeCommitSha: '',
      url: 'https://example.invalid/pr',
    }),
    readPullRequestReview: async ({ repositoryFullName, pullRequestNumber, reviewId }) => ({
      repositoryFullName,
      pullRequestNumber,
      reviewId,
      body: reviewBody,
      state: 'COMMENTED',
      commitId: headSha,
      url: 'https://example.invalid/review',
    }),
    readPullRequestComment: async args => args,
    readIssue: async args => args,
    readIssueComment: async args => args,
    createBranch: async args => args,
    putFile: async args => args,
    deleteFile: async args => args,
    createPullRequest: async args => args,
    mergePullRequest: async args => args,
    createPullRequestReview: async args => ({
      repositoryFullName: args.repositoryFullName,
      pullRequestNumber: args.pullRequestNumber,
      reviewId: 80,
      expectedHeadSha: args.expectedHeadSha,
      event: args.event,
      body: args.body,
      state: args.event === 'COMMENT' ? 'COMMENTED' : args.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
      commitId: args.expectedHeadSha,
      url: 'https://example.invalid/review',
    }),
    createPullRequestComment: async args => args,
    createIssue: async args => args,
    createIssueComment: async args => args,
    ...overrides,
  };
}

function invocation(id = 'github-pr-review-1', overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId: GitHubToolId.PULL_REQUEST_REVIEW_CREATE,
    providerId: GITHUB_PROVIDER_ID,
    requestedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_REVIEW_CREATE],
    policyDecisionId: id + ':policy',
    arguments: {
      repositoryFullName: repo,
      pullRequestNumber: 7,
      expectedHeadSha: headSha,
      event: 'COMMENT',
      body: reviewBody,
    },
    createdAt: at,
    parentInvocationId: null,
    ...overrides,
  };
}

function policy(inv, decision = 'ALLOW') {
  return {
    schemaVersion: 1,
    decisionId: inv.policyDecisionId,
    invocationId: inv.invocationId,
    decision,
    reasonCode: 'OWNER_POLICY',
    reason: '',
    approvalId: null,
    decidedAt: at,
  };
}

function storeFixture() {
  let root = { effectsById: {} };
  return {
    store: {
      async update(mutator) {
        const draft = structuredClone(root);
        const next = mutator(draft);
        root = structuredClone(next ?? draft);
        return structuredClone(root);
      },
    },
    snapshot(id) {
      return structuredClone(root.effectsById[id]?.state ?? null);
    },
  };
}

test('REST formal review pins exact head and uses the fixed reviews endpoint', async () => {
  const calls = [];
  const queue = [
    response(200, pullPayload()),
    response(200, reviewPayload()),
  ];
  const client = new GitHubRestClientV1({
    nativeClient: nativeClient(),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (!next) throw new Error('unexpected fetch');
      return next;
    },
  });

  const result = await client.createPullRequestReview({
    repositoryFullName: repo,
    pullRequestNumber: 7,
    expectedHeadSha: headSha,
    event: 'COMMENT',
    body: reviewBody,
  });

  assert.equal(result.reviewId, 80);
  assert.equal(result.commitId, headSha);
  assert.equal(result.state, 'COMMENTED');
  assert.deepEqual(calls.map(call => [call.init.method, new URL(call.url).pathname]), [
    ['GET', '/repos/owner/repo/pulls/7'],
    ['POST', '/repos/owner/repo/pulls/7/reviews'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    commit_id: headSha,
    event: 'COMMENT',
    body: reviewBody,
  });
});

test('REST formal review fails closed on stale head and validates event/body before mutation', async () => {
  const calls = [];
  const client = new GitHubRestClientV1({
    nativeClient: nativeClient(),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, pullPayload({ head: 'c'.repeat(40) }));
    },
  });

  await assert.rejects(
    () => client.createPullRequestReview({
      repositoryFullName: repo,
      pullRequestNumber: 7,
      expectedHeadSha: headSha,
      event: 'COMMENT',
      body: reviewBody,
    }),
    error => error.code === 'GITHUB_PULL_REQUEST_HEAD_MISMATCH'
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === true,
  );
  assert.equal(calls.length, 1);

  await assert.rejects(
    () => client.createPullRequestReview({
      repositoryFullName: repo,
      pullRequestNumber: 7,
      expectedHeadSha: headSha,
      event: 'COMMENT',
      body: '   ',
    }),
    error => error.code === 'GITHUB_INVALID_REQUEST' && error.safeToRetry === true,
  );
  await assert.rejects(
    () => client.createPullRequestReview({
      repositoryFullName: repo,
      pullRequestNumber: 7,
      expectedHeadSha: headSha,
      event: ' comment ',
      body: reviewBody,
    }),
    error => error.code === 'GITHUB_INVALID_REQUEST' && error.safeToRetry === true,
  );
  assert.equal(calls.length, 1, 'invalid event/body must fail before another remote call');
});

test('REST review readback binds immutable review to exact repository, pull request and commit', async () => {
  const calls = [];
  const client = new GitHubRestClientV1({
    nativeClient: nativeClient(),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, reviewPayload());
    },
  });

  const result = await client.readPullRequestReview({
    repositoryFullName: repo,
    pullRequestNumber: 7,
    reviewId: 80,
  });
  assert.deepEqual(result, {
    repositoryFullName: repo,
    pullRequestNumber: 7,
    reviewId: 80,
    body: reviewBody,
    state: 'COMMENTED',
    commitId: headSha,
    url: 'https://github.com/owner/repo/pull/7#pullrequestreview-80',
  });
  assert.deepEqual(calls.map(call => [call.init.method, new URL(call.url).pathname]), [
    ['GET', '/repos/owner/repo/pulls/7/reviews/80'],
  ]);
});

test('provider gates formal review read and create with separate owner capabilities', async () => {
  let creates = 0;
  const client = fullClient({
    createPullRequestReview: async args => {
      creates += 1;
      return {
        repositoryFullName: args.repositoryFullName,
        pullRequestNumber: args.pullRequestNumber,
        reviewId: 80,
        expectedHeadSha: args.expectedHeadSha,
        event: args.event,
        body: args.body,
        state: 'COMMENTED',
        commitId: args.expectedHeadSha,
        url: 'https://example.invalid/review',
      };
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [
      GitHubCapabilityId.PULL_REQUEST_REVIEW_READ,
      GitHubCapabilityId.PULL_REQUEST_REVIEW_CREATE,
    ],
    now: () => Date.parse(at),
  });
  const createInv = invocation('github-pr-review-provider');

  await assert.rejects(
    () => provider.invoke({ invocation: createInv, policyDecision: policy(createInv, 'DENY') }),
    /not authorized/i,
  );
  assert.equal(creates, 0);

  const created = await provider.invoke({ invocation: createInv, policyDecision: policy(createInv) });
  assert.equal(created.result.reviewId, 80);
  assert.equal(creates, 1);

  const readInv = {
    ...invocation('github-pr-review-read'),
    toolId: GitHubToolId.PULL_REQUEST_REVIEW_READ,
    requestedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_REVIEW_READ],
    arguments: { repositoryFullName: repo, pullRequestNumber: 7, reviewId: 80 },
  };
  const read = await provider.invoke({ invocation: readInv, policyDecision: policy(readInv) });
  assert.equal(read.result.reviewId, 80);
});

test('formal review commits only after independent immutable review readback', async () => {
  let creates = 0;
  let reads = 0;
  const client = fullClient({
    createPullRequestReview: async args => {
      creates += 1;
      return {
        repositoryFullName: args.repositoryFullName,
        pullRequestNumber: args.pullRequestNumber,
        reviewId: 80,
        expectedHeadSha: args.expectedHeadSha,
        event: args.event,
        body: args.body,
        state: 'COMMENTED',
        commitId: args.expectedHeadSha,
        url: 'https://example.invalid/review',
      };
    },
    readPullRequestReview: async ({ repositoryFullName, pullRequestNumber, reviewId }) => {
      reads += 1;
      return {
        repositoryFullName,
        pullRequestNumber,
        reviewId,
        body: reviewBody,
        state: 'COMMENTED',
        commitId: headSha,
        url: 'https://example.invalid/review',
      };
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_REVIEW_CREATE],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubPullRequestReviewVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  const inv = invocation('github-pr-review-verified');

  const result = await executor.invoke({ invocation: inv, policyDecision: policy(inv) });
  assert.equal(result.effectState.phase, 'COMMITTED');
  assert.equal(creates, 1);
  assert.equal(reads, 1);
  assert.equal(fx.snapshot(inv.invocationId).verification.reasonCode, 'GITHUB_PULL_REQUEST_REVIEW_CONFIRMED');
});

test('temporarily divergent review readback reconciles without replay', async () => {
  let creates = 0;
  let reads = 0;
  const client = fullClient({
    createPullRequestReview: async args => {
      creates += 1;
      return {
        repositoryFullName: args.repositoryFullName,
        pullRequestNumber: args.pullRequestNumber,
        reviewId: 80,
        expectedHeadSha: args.expectedHeadSha,
        event: args.event,
        body: args.body,
        state: 'COMMENTED',
        commitId: args.expectedHeadSha,
        url: 'https://example.invalid/review',
      };
    },
    readPullRequestReview: async ({ repositoryFullName, pullRequestNumber, reviewId }) => {
      reads += 1;
      return {
        repositoryFullName,
        pullRequestNumber,
        reviewId,
        body: reads === 1 ? 'stale body' : reviewBody,
        state: 'COMMENTED',
        commitId: headSha,
        url: 'https://example.invalid/review',
      };
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_REVIEW_CREATE],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubPullRequestReviewVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  const inv = invocation('github-pr-review-reconcile');

  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
    error => error.effectState?.phase === 'RECONCILE' && error.safeToRetry === false,
  );
  assert.equal(creates, 1);
  assert.equal(reads, 1);

  const reconciled = await executor.reconcile({
    invocationId: inv.invocationId,
    outcome: 'VERIFIED',
    reasonCode: 'READBACK_CONFIRMED',
  });
  assert.equal(reconciled.phase, 'COMMITTED');
  assert.equal(creates, 1, 'reconciliation must never replay a formal review');
  assert.equal(reads, 2);
});

test('ambiguous formal-review dispatch without immutable reviewId requires manual review', async () => {
  let creates = 0;
  let reads = 0;
  const ambiguous = Object.assign(new Error('transport ended after review request'), {
    code: 'GITHUB_TRANSPORT_ERROR',
    effectMayHaveOccurred: true,
    safeToRetry: false,
  });
  const client = fullClient({
    createPullRequestReview: async () => {
      creates += 1;
      throw ambiguous;
    },
    readPullRequestReview: async () => {
      reads += 1;
      return {};
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_REVIEW_CREATE],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubPullRequestReviewVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  const inv = invocation('github-pr-review-ambiguous');

  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
    error => error.reconcileRequired === true && error.safeToRetry === false,
  );
  await assert.rejects(
    () => executor.invoke({ invocation: structuredClone(inv), policyDecision: structuredClone(policy(inv)) }),
    /requires reconciliation/i,
  );
  await assert.rejects(
    () => executor.reconcile({ invocationId: inv.invocationId, outcome: 'SAFE_RETRY' }),
    /cannot prove SAFE_RETRY/i,
  );
  await assert.rejects(
    () => executor.reconcile({ invocationId: inv.invocationId, outcome: 'VERIFIED' }),
    /provider review identity|manual review/i,
  );
  assert.equal(creates, 1);
  assert.equal(reads, 0);
  assert.equal(fx.snapshot(inv.invocationId).phase, 'RECONCILE');
});

test('review verifier rejects accessor-backed arguments before any remote readback', async () => {
  let getterReads = 0;
  let remoteReads = 0;
  const client = fullClient({
    readPullRequestReview: async () => {
      remoteReads += 1;
      return {};
    },
  });
  const verifier = new GitHubPullRequestReviewVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const args = {
    repositoryFullName: repo,
    pullRequestNumber: 7,
    event: 'COMMENT',
    body: reviewBody,
  };
  Object.defineProperty(args, 'expectedHeadSha', {
    enumerable: true,
    get() {
      getterReads += 1;
      return headSha;
    },
  });
  const inv = invocation('github-pr-review-hostile');
  inv.arguments = args;

  await assert.rejects(
    () => verifier.verify({
      invocation: inv,
      executionId: 'github-pr-review-hostile:attempt:1',
      observation: {
        schemaVersion: 1,
        observationId: 'github-pr-review-hostile:obs',
        invocationId: 'github-pr-review-hostile',
        status: 'OK',
        summary: '',
        data: {
          repositoryFullName: repo,
          pullRequestNumber: 7,
          reviewId: 80,
          expectedHeadSha: headSha,
          event: 'COMMENT',
          body: reviewBody,
          state: 'COMMENTED',
          commitId: headSha,
          url: 'https://example.invalid/review',
        },
        artifactRefs: [],
        observedAt: at,
      },
    }),
    /enumerable data property/i,
  );
  assert.equal(getterReads, 0);
  assert.equal(remoteReads, 0);
});
