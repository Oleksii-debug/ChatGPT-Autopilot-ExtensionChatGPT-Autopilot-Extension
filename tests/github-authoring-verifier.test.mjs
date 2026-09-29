import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_PROVIDER_ID,
  GitHubAgentProviderV1,
  GitHubCapabilityId,
  GitHubToolId,
} from '../src/core/github-agent-provider.js';
import { GitHubExactEffectExecutorV1 } from '../src/core/github-exact-effect.js';
import { GitHubAuthoringVerifierV1 } from '../src/core/github-authoring-verifier.js';

const at = '2026-09-25T10:45:00.000Z';
const repo = 'owner/repo';
const fromSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const baseSha = 'c'.repeat(40);
const prUrl = 'https://github.com/owner/repo/pull/17';

function fullClient(overrides = {}) {
  return {
    readRepository: async args => args,
    readFile: async args => args,
    readTree: async args => args,
    readBranch: async ({ repositoryFullName, branch }) => ({
      repositoryFullName,
      branch,
      ref: `refs/heads/${branch}`,
      commitSha: fromSha,
    }),
    findPullRequests: async ({ repositoryFullName, head, base }) => ({
      repositoryFullName,
      head,
      base,
      matches: [{
        number: 17,
        state: 'open',
        title: 'Verified change',
        url: prUrl,
        headSha,
        baseSha,
      }],
    }),
    readPullRequest: async ({ repositoryFullName, pullRequestNumber }) => ({
      repositoryFullName,
      number: pullRequestNumber,
      title: 'Verified change',
      body: 'Exact body',
      state: 'open',
      merged: false,
      headSha,
      baseSha,
      mergeCommitSha: '',
      url: prUrl,
    }),
    readPullRequestComment: async args => args,
    readIssue: async args => args,
    readIssueComment: async args => args,
    createBranch: async ({ repositoryFullName, branch, fromSha: exactSha }) => ({
      repositoryFullName,
      branch,
      ref: `refs/heads/${branch}`,
      sha: exactSha,
    }),
    putFile: async args => args,
    deleteFile: async args => args,
    createPullRequest: async ({ repositoryFullName, title, body, head, base }) => ({
      repositoryFullName,
      number: 17,
      head,
      base,
      url: prUrl,
      title,
      body,
    }),
    createPullRequestComment: async args => args,
    createIssue: async args => args,
    createIssueComment: async args => args,
    ...overrides,
  };
}

function branchInvocation(id = 'github-branch-create-1', overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId: GitHubToolId.BRANCH_CREATE,
    providerId: GITHUB_PROVIDER_ID,
    requestedCapabilityIds: [GitHubCapabilityId.BRANCH_CREATE],
    policyDecisionId: `${id}:policy`,
    arguments: {
      repositoryFullName: repo,
      branch: 'work/verified',
      fromSha,
      ...overrides,
    },
    createdAt: at,
    parentInvocationId: null,
  };
}

function prInvocation(id = 'github-pr-create-1', overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId: GitHubToolId.PULL_REQUEST_CREATE,
    providerId: GITHUB_PROVIDER_ID,
    requestedCapabilityIds: [GitHubCapabilityId.PULL_REQUEST_CREATE],
    policyDecisionId: `${id}:policy`,
    arguments: {
      repositoryFullName: repo,
      title: 'Verified change',
      body: 'Exact body',
      head: 'work/verified',
      base: 'main',
      ...overrides,
    },
    createdAt: at,
    parentInvocationId: null,
  };
}

function policy(inv) {
  return {
    schemaVersion: 1,
    decisionId: inv.policyDecisionId,
    invocationId: inv.invocationId,
    decision: 'ALLOW',
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

function executorFixture(client, capabilityId) {
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [capabilityId],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubAuthoringVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  return { executor, fx, verifier };
}

test('BRANCH_CREATE reaches COMMITTED only after exact ref + commit readback', async () => {
  let creates = 0;
  let reads = 0;
  const client = fullClient({
    createBranch: async ({ repositoryFullName, branch, fromSha: exactSha }) => {
      creates += 1;
      return { repositoryFullName, branch, ref: `refs/heads/${branch}`, sha: exactSha };
    },
    readBranch: async ({ repositoryFullName, branch }) => {
      reads += 1;
      return { repositoryFullName, branch, ref: `refs/heads/${branch}`, commitSha: fromSha };
    },
  });
  const { executor, fx } = executorFixture(client, GitHubCapabilityId.BRANCH_CREATE);
  const inv = branchInvocation();

  const result = await executor.invoke({ invocation: inv, policyDecision: policy(inv) });
  assert.equal(result.effectState.phase, 'COMMITTED');
  assert.equal(creates, 1);
  assert.equal(reads, 1);
  assert.equal(fx.snapshot(inv.invocationId).verification.reasonCode, 'GITHUB_BRANCH_CREATE_CONFIRMED');
});

test('PULL_REQUEST_CREATE binds immutable PR number to exact head/base query and exact title/body readback', async () => {
  let creates = 0;
  let finds = 0;
  let reads = 0;
  const client = fullClient({
    createPullRequest: async ({ repositoryFullName, head, base }) => {
      creates += 1;
      return { repositoryFullName, number: 17, head, base, url: prUrl };
    },
    findPullRequests: async ({ repositoryFullName, head, base }) => {
      finds += 1;
      return {
        repositoryFullName,
        head,
        base,
        matches: [{ number: 17, state: 'open', title: 'Verified change', url: prUrl, headSha, baseSha }],
      };
    },
    readPullRequest: async ({ repositoryFullName, pullRequestNumber }) => {
      reads += 1;
      return {
        repositoryFullName,
        number: pullRequestNumber,
        title: 'Verified change',
        body: 'Exact body',
        state: 'open',
        merged: false,
        headSha,
        baseSha,
        mergeCommitSha: '',
        url: prUrl,
      };
    },
  });
  const { executor, fx } = executorFixture(client, GitHubCapabilityId.PULL_REQUEST_CREATE);
  const inv = prInvocation();

  const result = await executor.invoke({ invocation: inv, policyDecision: policy(inv) });
  assert.equal(result.effectState.phase, 'COMMITTED');
  assert.equal(creates, 1);
  assert.equal(finds, 1);
  assert.equal(reads, 1);
  assert.equal(fx.snapshot(inv.invocationId).verification.reasonCode, 'GITHUB_PULL_REQUEST_CREATE_CONFIRMED');
});

test('branch readback mismatch is durable RECONCILE and can later verify without replay', async () => {
  let creates = 0;
  let reads = 0;
  const client = fullClient({
    createBranch: async ({ repositoryFullName, branch, fromSha: exactSha }) => {
      creates += 1;
      return { repositoryFullName, branch, ref: `refs/heads/${branch}`, sha: exactSha };
    },
    readBranch: async ({ repositoryFullName, branch }) => {
      reads += 1;
      return {
        repositoryFullName,
        branch,
        ref: `refs/heads/${branch}`,
        commitSha: reads === 1 ? 'f'.repeat(40) : fromSha,
      };
    },
  });
  const { executor, fx } = executorFixture(client, GitHubCapabilityId.BRANCH_CREATE);
  const inv = branchInvocation('github-branch-reconcile');

  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
    error => error.effectState?.phase === 'RECONCILE' && error.safeToRetry === false,
  );
  assert.equal(creates, 1);
  assert.equal(reads, 1);

  const reconciled = await executor.reconcile({
    invocationId: inv.invocationId,
    outcome: 'VERIFIED',
    reasonCode: 'EXACT_REF_READBACK_CONFIRMED',
  });
  assert.equal(reconciled.phase, 'COMMITTED');
  assert.equal(creates, 1, 'reconciliation must never recreate branch');
  assert.equal(reads, 2);
  assert.equal(fx.snapshot(inv.invocationId).phase, 'COMMITTED');
});

test('PR readback wrong parent result, number, URL, title, or body never verifies', async t => {
  const cases = [
    ['missing-number-in-parent-query', fullClient({
      findPullRequests: async ({ repositoryFullName, head, base }) => ({
        repositoryFullName, head, base,
        matches: [{ number: 18, state: 'open', title: 'Verified change', url: prUrl, headSha, baseSha }],
      }),
    })],
    ['wrong-title', fullClient({
      readPullRequest: async ({ repositoryFullName, pullRequestNumber }) => ({
        repositoryFullName, number: pullRequestNumber, title: 'Changed', body: 'Exact body',
        state: 'open', merged: false, headSha, baseSha, mergeCommitSha: '', url: prUrl,
      }),
    })],
    ['wrong-body', fullClient({
      readPullRequest: async ({ repositoryFullName, pullRequestNumber }) => ({
        repositoryFullName, number: pullRequestNumber, title: 'Verified change', body: 'Changed',
        state: 'open', merged: false, headSha, baseSha, mergeCommitSha: '', url: prUrl,
      }),
    })],
    ['wrong-url', fullClient({
      readPullRequest: async ({ repositoryFullName, pullRequestNumber }) => ({
        repositoryFullName, number: pullRequestNumber, title: 'Verified change', body: 'Exact body',
        state: 'open', merged: false, headSha, baseSha, mergeCommitSha: '', url: 'https://github.com/owner/repo/pull/999',
      }),
    })],
  ];

  for (const [label, client] of cases) {
    await t.test(label, async () => {
      const { executor, fx } = executorFixture(client, GitHubCapabilityId.PULL_REQUEST_CREATE);
      const inv = prInvocation(`github-pr-mismatch-${label}`);
      await assert.rejects(
        () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
        error => error.effectState?.phase === 'RECONCILE',
      );
      assert.equal(fx.snapshot(inv.invocationId).phase, 'RECONCILE');
    });
  }
});

test('ambiguous authoring dispatch without provider-created identity cannot auto-verify or claim SAFE_RETRY', async t => {
  for (const [label, inv, capability, method] of [
    ['branch', branchInvocation('github-branch-ambiguous'), GitHubCapabilityId.BRANCH_CREATE, 'createBranch'],
    ['pr', prInvocation('github-pr-ambiguous'), GitHubCapabilityId.PULL_REQUEST_CREATE, 'createPullRequest'],
  ]) {
    await t.test(label, async () => {
      let mutations = 0;
      let reads = 0;
      const ambiguous = Object.assign(new Error('transport ended after dispatch'), {
        code: 'GITHUB_TRANSPORT_ERROR',
        effectMayHaveOccurred: true,
        safeToRetry: false,
      });
      const client = fullClient({
        [method]: async () => {
          mutations += 1;
          throw ambiguous;
        },
        readBranch: async () => { reads += 1; throw new Error('must not read'); },
        findPullRequests: async () => { reads += 1; throw new Error('must not read'); },
        readPullRequest: async () => { reads += 1; throw new Error('must not read'); },
      });
      const { executor, fx } = executorFixture(client, capability);

      await assert.rejects(
        () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
        error => error.effectState?.phase === 'RECONCILE' && error.safeToRetry === false,
      );
      await assert.rejects(
        () => executor.reconcile({ invocationId: inv.invocationId, outcome: 'VERIFIED', reasonCode: 'TRY_READBACK' }),
        /provider-created identity/i,
      );
      await assert.rejects(
        () => executor.reconcile({ invocationId: inv.invocationId, outcome: 'SAFE_RETRY', reasonCode: 'NO_EFFECT' }),
        /cannot prove SAFE_RETRY/i,
      );
      assert.equal(mutations, 1);
      assert.equal(reads, 0);
      assert.equal(fx.snapshot(inv.invocationId).phase, 'RECONCILE');
    });
  }
});

test('provider observation identity mismatch is rejected before independent readback', async t => {
  for (const [label, inv, capability, client] of [
    ['branch-wrong-ref', branchInvocation('github-branch-observation-wrong'), GitHubCapabilityId.BRANCH_CREATE, fullClient({
      createBranch: async ({ repositoryFullName, branch, fromSha: exactSha }) => ({
        repositoryFullName, branch, ref: 'refs/heads/other', sha: exactSha,
      }),
      readBranch: async () => { throw new Error('must not read'); },
    })],
    ['pr-wrong-parent', prInvocation('github-pr-observation-wrong'), GitHubCapabilityId.PULL_REQUEST_CREATE, fullClient({
      createPullRequest: async ({ repositoryFullName, head }) => ({
        repositoryFullName, number: 17, head, base: 'other', url: prUrl,
      }),
      findPullRequests: async () => { throw new Error('must not read'); },
      readPullRequest: async () => { throw new Error('must not read'); },
    })],
  ]) {
    await t.test(label, async () => {
      const { executor, fx } = executorFixture(client, capability);
      await assert.rejects(
        () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
        error => error.effectState?.phase === 'RECONCILE',
      );
      assert.equal(fx.snapshot(inv.invocationId).phase, 'RECONCILE');
    });
  }
});

test('descriptor-hostile authoring arguments are rejected before any readback', async () => {
  let reads = 0;
  const client = fullClient({
    readBranch: async () => { reads += 1; throw new Error('must not read'); },
    findPullRequests: async () => { reads += 1; throw new Error('must not read'); },
    readPullRequest: async () => { reads += 1; throw new Error('must not read'); },
  });
  const verifier = new GitHubAuthoringVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const inv = prInvocation('github-authoring-hostile');
  const hostile = {
    repositoryFullName: repo,
    title: 'Verified change',
    body: 'Exact body',
    base: 'main',
  };
  Object.defineProperty(hostile, 'head', {
    get() { throw new Error('accessor executed'); },
    enumerable: true,
    configurable: true,
  });
  inv.arguments = hostile;
  const observation = {
    schemaVersion: 1,
    observationId: `${inv.invocationId}:observation`,
    invocationId: inv.invocationId,
    status: 'OK',
    summary: '',
    data: { repositoryFullName: repo, number: 17, head: 'work/verified', base: 'main', url: prUrl },
    artifactRefs: [],
    observedAt: at,
  };

  await assert.rejects(
    () => verifier.verify({
      invocation: inv,
      executionId: `${inv.invocationId}:attempt:1`,
      observation,
    }),
    /enumerable data property/i,
  );
  assert.equal(reads, 0);
});
