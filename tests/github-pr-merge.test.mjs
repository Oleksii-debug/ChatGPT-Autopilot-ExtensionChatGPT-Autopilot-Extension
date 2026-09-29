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
import { GitHubPullRequestMergeVerifierV1 } from '../src/core/github-pr-merge-verifier.js';

const at = '2026-09-25T10:00:00.000Z';
const repo = 'owner/repo';
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const mergeSha = 'c'.repeat(40);

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function pullPayload({
  state = 'open',
  merged = false,
  head = headSha,
  mergeCommitSha = null,
} = {}) {
  return {
    number: 7,
    title: 'Merge candidate',
    body: '',
    state,
    merged,
    merge_commit_sha: mergeCommitSha,
    head: { sha: head },
    base: { sha: baseSha },
    html_url: 'https://github.com/owner/repo/pull/7',
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
      title: 'Merge candidate',
      body: '',
      state: 'open',
      merged: false,
      headSha,
      baseSha,
      mergeCommitSha: '',
      url: 'https://example.invalid/pr',
    }),
    readPullRequestComment: async args => args,
    readIssue: async args => args,
    readIssueComment: async args => args,
    createBranch: async args => args,
    putFile: async args => args,
    deleteFile: async args => args,
    createPullRequest: async args => args,
    mergePullRequest: async args => ({
      repositoryFullName: args.repositoryFullName,
      pullRequestNumber: args.pullRequestNumber,
      expectedHeadSha: args.expectedHeadSha,
      mergeMethod: args.mergeMethod,
      merged: true,
      mergeCommitSha: mergeSha,
    }),
    createPullRequestComment: async args => args,
    createIssue: async args => args,
    createIssueComment: async args => args,
    ...overrides,
  };
}

function invocation(id = 'github-pr-merge-1') {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId: GitHubToolId.PULL_REQUEST_MERGE,
    providerId: GITHUB_PROVIDER_ID,
    requestedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_MERGE],
    policyDecisionId: `${id}:policy`,
    arguments: {
      repositoryFullName: repo,
      pullRequestNumber: 7,
      expectedHeadSha: headSha,
      mergeMethod: 'squash',
    },
    createdAt: at,
    parentInvocationId: null,
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

test('REST merge uses exact expected-head preflight and fixed GitHub merge endpoint', async () => {
  const calls = [];
  const queue = [
    response(200, pullPayload()),
    response(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' }),
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

  const result = await client.mergePullRequest({
    repositoryFullName: repo,
    pullRequestNumber: 7,
    expectedHeadSha: headSha,
    mergeMethod: 'squash',
  });

  assert.deepEqual(result, {
    repositoryFullName: repo,
    pullRequestNumber: 7,
    expectedHeadSha: headSha,
    mergeMethod: 'squash',
    merged: true,
    mergeCommitSha: mergeSha,
  });
  assert.deepEqual(calls.map(call => [call.init.method, new URL(call.url).pathname]), [
    ['GET', '/repos/owner/repo/pulls/7'],
    ['PUT', '/repos/owner/repo/pulls/7/merge'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    sha: headSha,
    merge_method: 'squash',
  });
});

test('REST merge rejects stale expected head before mutation', async () => {
  const calls = [];
  const client = new GitHubRestClientV1({
    nativeClient: nativeClient(),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, pullPayload({ head: 'd'.repeat(40) }));
    },
  });

  await assert.rejects(
    () => client.mergePullRequest({
      repositoryFullName: repo,
      pullRequestNumber: 7,
      expectedHeadSha: headSha,
      mergeMethod: 'merge',
    }),
    error => error.code === 'GITHUB_PULL_REQUEST_HEAD_MISMATCH'
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === true,
  );
  assert.deepEqual(calls.map(call => call.init.method), ['GET']);
});

test('REST merge marks transport loss after PUT as ambiguous and non-retryable', async () => {
  let call = 0;
  const client = new GitHubRestClientV1({
    nativeClient: nativeClient(),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return response(200, pullPayload());
      throw new Error('socket ended after write');
    },
  });

  await assert.rejects(
    () => client.mergePullRequest({
      repositoryFullName: repo,
      pullRequestNumber: 7,
      expectedHeadSha: headSha,
      mergeMethod: 'rebase',
    }),
    error => error.code === 'GITHUB_TRANSPORT_ERROR'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false,
  );
  assert.equal(call, 2);
});

test('provider requires owner ALLOW plus explicit pull-request merge capability', async () => {
  let merges = 0;
  const client = fullClient({
    mergePullRequest: async args => {
      merges += 1;
      return {
        repositoryFullName: args.repositoryFullName,
        pullRequestNumber: args.pullRequestNumber,
        expectedHeadSha: args.expectedHeadSha,
        mergeMethod: args.mergeMethod,
        merged: true,
        mergeCommitSha: mergeSha,
      };
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_MERGE],
    now: () => Date.parse(at),
  });
  const inv = invocation('github-pr-merge-provider');

  await assert.rejects(
    () => provider.invoke({ invocation: inv, policyDecision: policy(inv, 'DENY') }),
    /not authorized/i,
  );
  assert.equal(merges, 0);

  const result = await provider.invoke({ invocation: inv, policyDecision: policy(inv) });
  assert.equal(result.result.mergeCommitSha, mergeSha);
  assert.equal(merges, 1);
});

test('pull-request merge commits only after independent closed+merged expected-head readback', async () => {
  let merges = 0;
  let reads = 0;
  const client = fullClient({
    mergePullRequest: async args => {
      merges += 1;
      return {
        repositoryFullName: args.repositoryFullName,
        pullRequestNumber: args.pullRequestNumber,
        expectedHeadSha: args.expectedHeadSha,
        mergeMethod: args.mergeMethod,
        merged: true,
        mergeCommitSha: mergeSha,
      };
    },
    readPullRequest: async ({ repositoryFullName, pullRequestNumber }) => {
      reads += 1;
      return {
        repositoryFullName,
        number: pullRequestNumber,
        title: 'Merge candidate',
        body: '',
        state: 'closed',
        merged: true,
        headSha,
        baseSha,
        mergeCommitSha: mergeSha,
        url: 'https://example.invalid/pr',
      };
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_MERGE],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubPullRequestMergeVerifierV1({
    githubClient: client,
    now: () => Date.parse(at),
  });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  const inv = invocation('github-pr-merge-verified');

  const result = await executor.invoke({ invocation: inv, policyDecision: policy(inv) });
  assert.equal(result.effectState.phase, 'COMMITTED');
  assert.equal(merges, 1);
  assert.equal(reads, 1);
  assert.equal(fx.snapshot(inv.invocationId).verification.reasonCode, 'GITHUB_PULL_REQUEST_MERGE_CONFIRMED');
});

test('independent verification rejects missing or different resulting merge commit SHA', async () => {
  for (const [suffix, readbackMergeCommitSha] of [
    ['different', 'd'.repeat(40)],
    ['missing', ''],
  ]) {
    let merges = 0;
    let reads = 0;
    const client = fullClient({
      mergePullRequest: async args => {
        merges += 1;
        return {
          repositoryFullName: args.repositoryFullName,
          pullRequestNumber: args.pullRequestNumber,
          expectedHeadSha: args.expectedHeadSha,
          mergeMethod: args.mergeMethod,
          merged: true,
          mergeCommitSha: mergeSha,
        };
      },
      readPullRequest: async ({ repositoryFullName, pullRequestNumber }) => {
        reads += 1;
        return {
          repositoryFullName,
          number: pullRequestNumber,
          title: 'Merge candidate',
          body: '',
          state: 'closed',
          merged: true,
          headSha,
          baseSha,
          mergeCommitSha: readbackMergeCommitSha,
          url: 'https://example.invalid/pr',
        };
      },
    });
    const provider = new GitHubAgentProviderV1({
      githubClient: client,
      grantedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_MERGE],
      now: () => Date.parse(at),
    });
    const verifier = new GitHubPullRequestMergeVerifierV1({ githubClient: client, now: () => Date.parse(at) });
    const fx = storeFixture();
    const executor = new GitHubExactEffectExecutorV1({
      provider,
      store: fx.store,
      verify: input => verifier.verify(input),
      reconcileVerify: input => verifier.reconcileVerify(input),
      now: () => Date.parse(at),
    });
    const inv = invocation(`github-pr-merge-result-${suffix}`);

    await assert.rejects(
      () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
      error => error.effectState?.phase === 'RECONCILE' && error.safeToRetry === false,
    );
    assert.equal(merges, 1);
    assert.equal(reads, 1);
    assert.equal(fx.snapshot(inv.invocationId).phase, 'RECONCILE');
  }
});

test('successful merge response with temporarily divergent readback reconciles without replay', async () => {
  let merges = 0;
  let reads = 0;
  const client = fullClient({
    mergePullRequest: async args => {
      merges += 1;
      return {
        repositoryFullName: args.repositoryFullName,
        pullRequestNumber: args.pullRequestNumber,
        expectedHeadSha: args.expectedHeadSha,
        mergeMethod: args.mergeMethod,
        merged: true,
        mergeCommitSha: mergeSha,
      };
    },
    readPullRequest: async ({ repositoryFullName, pullRequestNumber }) => {
      reads += 1;
      return {
        repositoryFullName,
        number: pullRequestNumber,
        title: 'Merge candidate',
        body: '',
        state: 'closed',
        merged: true,
        headSha,
        baseSha,
        mergeCommitSha: reads > 1 ? mergeSha : 'd'.repeat(40),
        url: 'https://example.invalid/pr',
      };
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_MERGE],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubPullRequestMergeVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  const inv = invocation('github-pr-merge-reconcile');

  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
    error => error.effectState?.phase === 'RECONCILE' && error.safeToRetry === false,
  );
  assert.equal(merges, 1);
  assert.equal(reads, 1);

  const reconciled = await executor.reconcile({
    invocationId: inv.invocationId,
    outcome: 'VERIFIED',
    reasonCode: 'READBACK_CONFIRMED',
  });
  assert.equal(reconciled.phase, 'COMMITTED');
  assert.equal(merges, 1, 'reconciliation must never replay merge');
  assert.equal(reads, 2);
});

test('ambiguous merge dispatch without provider merge identity requires manual review and never replays', async () => {
  let merges = 0;
  let reads = 0;
  const ambiguous = Object.assign(new Error('transport ended after merge request'), {
    code: 'GITHUB_TRANSPORT_ERROR',
    effectMayHaveOccurred: true,
    safeToRetry: false,
  });
  const client = fullClient({
    mergePullRequest: async () => {
      merges += 1;
      throw ambiguous;
    },
    readPullRequest: async ({ repositoryFullName, pullRequestNumber }) => {
      reads += 1;
      return {
        repositoryFullName,
        number: pullRequestNumber,
        title: 'Merge candidate',
        body: '',
        state: 'closed',
        merged: true,
        headSha,
        baseSha,
        mergeCommitSha: mergeSha,
        url: 'https://example.invalid/pr',
      };
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_MERGE],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubPullRequestMergeVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  const inv = invocation('github-pr-merge-ambiguous');

  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
    error => error.reconcileRequired === true && error.safeToRetry === false,
  );
  await assert.rejects(
    () => executor.invoke({ invocation: structuredClone(inv), policyDecision: structuredClone(policy(inv)) }),
    /requires reconciliation/i,
  );
  assert.equal(merges, 1);
  await assert.rejects(
    () => executor.reconcile({ invocationId: inv.invocationId, outcome: 'SAFE_RETRY' }),
    /cannot prove SAFE_RETRY/i,
  );
  await assert.rejects(
    () => executor.reconcile({ invocationId: inv.invocationId, outcome: 'VERIFIED' }),
    /provider merge identity|manual review/i,
  );
  assert.equal(merges, 1);
  assert.equal(reads, 0, 'automatic verifier must not misattribute an externally merged PR without provider identity');
  assert.equal(fx.snapshot(inv.invocationId).phase, 'RECONCILE');
});

test('merge verifier rejects accessor-backed arguments before any remote readback', async () => {
  let getterReads = 0;
  let remoteReads = 0;
  const client = fullClient({
    readPullRequest: async () => {
      remoteReads += 1;
      return {};
    },
  });
  const verifier = new GitHubPullRequestMergeVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const args = {
    repositoryFullName: repo,
    pullRequestNumber: 7,
    mergeMethod: 'squash',
  };
  Object.defineProperty(args, 'expectedHeadSha', {
    enumerable: true,
    get() {
      getterReads += 1;
      return headSha;
    },
  });
  const inv = invocation('github-pr-merge-hostile');
  inv.arguments = args;

  await assert.rejects(
    () => verifier.verify({
      invocation: inv,
      executionId: 'github-pr-merge-hostile:attempt:1',
      observation: {
        schemaVersion: 1,
        observationId: 'github-pr-merge-hostile:obs',
        invocationId: 'github-pr-merge-hostile',
        status: 'OK',
        summary: '',
        data: {
          repositoryFullName: repo,
          pullRequestNumber: 7,
          expectedHeadSha: headSha,
          mergeMethod: 'squash',
          merged: true,
          mergeCommitSha: mergeSha,
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
