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
import { GitHubFileMutationVerifierV1 } from '../src/core/github-file-mutation-verifier.js';

const at = '2026-09-25T10:30:00.000Z';
const repo = 'owner/repo';
const oldBlobSha = 'a'.repeat(40);
const newBlobSha = 'b'.repeat(40);
const commitSha = 'c'.repeat(40);
const treeSha = 'd'.repeat(40);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
    readFile: async ({ repositoryFullName, path, ref = '' }) => ({
      repositoryFullName,
      path,
      sha: newBlobSha,
      sizeBytes: 5,
      text: 'hello',
      ref,
    }),
    readCommitObject: async ({ repositoryFullName, commitSha: exactCommitSha }) => ({
      repositoryFullName,
      commitSha: exactCommitSha,
      treeSha,
      parentShas: ['e'.repeat(40)],
    }),
    readTree: async args => args,
    readBranch: async args => args,
    findPullRequests: async args => args,
    readPullRequest: async args => args,
    readPullRequestComment: async args => args,
    readIssue: async args => args,
    readIssueComment: async args => args,
    createBranch: async args => args,
    putFile: async args => ({
      repositoryFullName: args.repositoryFullName,
      path: args.path,
      branch: args.branch,
      blobSha: newBlobSha,
      commitSha,
      mode: args.mode ?? 'create',
    }),
    deleteFile: async args => ({
      repositoryFullName: args.repositoryFullName,
      path: args.path,
      branch: args.branch,
      deletedBlobSha: args.expectedBlobSha,
      commitSha,
    }),
    createPullRequest: async args => args,
    mergePullRequest: async args => args,
    createPullRequestComment: async args => args,
    createIssue: async args => args,
    createIssueComment: async args => args,
    ...overrides,
  };
}

function invocation(toolId, id, args) {
  const capability = toolId === GitHubToolId.FILE_PUT
    ? GitHubCapabilityId.FILE_WRITE
    : GitHubCapabilityId.FILE_DELETE;
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId,
    providerId: GITHUB_PROVIDER_ID,
    requestedCapabilityIds: [capability],
    policyDecisionId: `${id}:policy`,
    arguments: args,
    createdAt: at,
    parentInvocationId: null,
  };
}

function putInvocation(id = 'github-file-put-1', overrides = {}) {
  return invocation(GitHubToolId.FILE_PUT, id, {
    repositoryFullName: repo,
    path: 'docs/result.txt',
    branch: 'work/file-proof',
    message: 'Write verified result',
    contentUtf8: 'hello',
    mode: 'update',
    expectedBlobSha: oldBlobSha,
    ...overrides,
  });
}

function deleteInvocation(id = 'github-file-delete-1', overrides = {}) {
  return invocation(GitHubToolId.FILE_DELETE, id, {
    repositoryFullName: repo,
    path: 'docs/result.txt',
    branch: 'work/file-proof',
    message: 'Delete verified result',
    expectedBlobSha: oldBlobSha,
    ...overrides,
  });
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

function notFound() {
  return Object.assign(new Error('Not Found'), {
    name: 'GitHubRestClientError',
    code: 'GITHUB_HTTP_404',
    status: 404,
    effectMayHaveOccurred: false,
    safeToRetry: true,
  });
}

test('REST commit readback uses the fixed Git commit-object endpoint and exact SHA identity', async () => {
  const calls = [];
  const client = new GitHubRestClientV1({
    nativeClient: nativeClient(),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, {
        sha: commitSha,
        tree: { sha: treeSha },
        parents: [{ sha: 'e'.repeat(40) }],
      });
    },
  });

  const result = await client.readCommitObject({ repositoryFullName: repo, commitSha });
  assert.deepEqual(result, {
    repositoryFullName: repo,
    commitSha,
    treeSha,
    parentShas: ['e'.repeat(40)],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(new URL(calls[0].url).origin, GITHUB_API_ORIGIN);
  assert.equal(new URL(calls[0].url).pathname, `/repos/owner/repo/git/commits/${commitSha}`);
});

test('REST commit readback rejects a different returned commit identity', async () => {
  const client = new GitHubRestClientV1({
    nativeClient: nativeClient(),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl: async () => jsonResponse(200, {
      sha: 'f'.repeat(40),
      tree: { sha: treeSha },
      parents: [],
    }),
  });
  await assert.rejects(
    () => client.readCommitObject({ repositoryFullName: repo, commitSha }),
    error => error.code === 'GITHUB_RESPONSE_INVALID'
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === false,
  );
});

test('FILE_PUT reaches COMMITTED only after immutable commit + exact blob/content readback', async () => {
  let writes = 0;
  let commitReads = 0;
  let fileReads = 0;
  const client = fullClient({
    putFile: async args => {
      writes += 1;
      return {
        repositoryFullName: args.repositoryFullName,
        path: args.path,
        branch: args.branch,
        blobSha: newBlobSha,
        commitSha,
        mode: args.mode,
      };
    },
    readCommitObject: async args => {
      commitReads += 1;
      return { repositoryFullName: args.repositoryFullName, commitSha: args.commitSha, treeSha, parentShas: [] };
    },
    readFile: async args => {
      fileReads += 1;
      assert.equal(args.ref, commitSha);
      return { repositoryFullName: args.repositoryFullName, path: args.path, sha: newBlobSha, sizeBytes: 5, text: 'hello' };
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.FILE_WRITE],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubFileMutationVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  const inv = putInvocation();

  const result = await executor.invoke({ invocation: inv, policyDecision: policy(inv) });
  assert.equal(result.effectState.phase, 'COMMITTED');
  assert.equal(writes, 1);
  assert.equal(commitReads, 1);
  assert.equal(fileReads, 1);
  assert.equal(fx.snapshot(inv.invocationId).verification.reasonCode, 'GITHUB_FILE_WRITE_CONFIRMED');
});

test('FILE_DELETE reaches COMMITTED only when the exact returned commit exists and path is absent there', async () => {
  let deletes = 0;
  let commitReads = 0;
  let fileReads = 0;
  const client = fullClient({
    deleteFile: async args => {
      deletes += 1;
      return {
        repositoryFullName: args.repositoryFullName,
        path: args.path,
        branch: args.branch,
        deletedBlobSha: args.expectedBlobSha,
        commitSha,
      };
    },
    readCommitObject: async args => {
      commitReads += 1;
      return { repositoryFullName: args.repositoryFullName, commitSha: args.commitSha, treeSha, parentShas: [] };
    },
    readFile: async args => {
      fileReads += 1;
      assert.equal(args.ref, commitSha);
      throw notFound();
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.FILE_DELETE],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubFileMutationVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  const inv = deleteInvocation();

  const result = await executor.invoke({ invocation: inv, policyDecision: policy(inv) });
  assert.equal(result.effectState.phase, 'COMMITTED');
  assert.equal(deletes, 1);
  assert.equal(commitReads, 1);
  assert.equal(fileReads, 1);
  assert.equal(fx.snapshot(inv.invocationId).verification.reasonCode, 'GITHUB_FILE_DELETE_CONFIRMED');
});

test('content mismatch after successful FILE_PUT is durable RECONCILE, then exact readback commits without replay', async () => {
  let writes = 0;
  let fileReads = 0;
  const client = fullClient({
    putFile: async args => {
      writes += 1;
      return {
        repositoryFullName: args.repositoryFullName,
        path: args.path,
        branch: args.branch,
        blobSha: newBlobSha,
        commitSha,
        mode: args.mode,
      };
    },
    readFile: async args => {
      fileReads += 1;
      return {
        repositoryFullName: args.repositoryFullName,
        path: args.path,
        sha: newBlobSha,
        sizeBytes: 5,
        text: fileReads === 1 ? 'stale' : 'hello',
      };
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.FILE_WRITE],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubFileMutationVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  const inv = putInvocation('github-file-put-reconcile');

  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
    error => error.effectState?.phase === 'RECONCILE' && error.safeToRetry === false,
  );
  assert.equal(writes, 1);
  assert.equal(fileReads, 1);

  const reconciled = await executor.reconcile({
    invocationId: inv.invocationId,
    outcome: 'VERIFIED',
    reasonCode: 'IMMUTABLE_READBACK_CONFIRMED',
  });
  assert.equal(reconciled.phase, 'COMMITTED');
  assert.equal(writes, 1, 'reconciliation must never replay FILE_PUT');
  assert.equal(fileReads, 2);
});

test('ambiguous mutation without immutable provider observation cannot auto-verify or claim SAFE_RETRY', async () => {
  let writes = 0;
  let readbacks = 0;
  const ambiguous = Object.assign(new Error('transport ended after dispatch'), {
    code: 'GITHUB_TRANSPORT_ERROR',
    effectMayHaveOccurred: true,
    safeToRetry: false,
  });
  const client = fullClient({
    putFile: async () => {
      writes += 1;
      throw ambiguous;
    },
    readCommitObject: async args => {
      readbacks += 1;
      return { repositoryFullName: args.repositoryFullName, commitSha: args.commitSha, treeSha, parentShas: [] };
    },
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: client,
    grantedCapabilityIds: [GitHubCapabilityId.FILE_WRITE],
    now: () => Date.parse(at),
  });
  const verifier = new GitHubFileMutationVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => Date.parse(at),
  });
  const inv = putInvocation('github-file-put-ambiguous');

  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
    error => error.effectState?.phase === 'RECONCILE' && error.safeToRetry === false,
  );
  assert.equal(writes, 1);
  assert.equal(readbacks, 0);

  await assert.rejects(
    () => executor.reconcile({
      invocationId: inv.invocationId,
      outcome: 'VERIFIED',
      reasonCode: 'TRY_READBACK',
    }),
    /immutable provider commit identity/i,
  );
  await assert.rejects(
    () => executor.reconcile({
      invocationId: inv.invocationId,
      outcome: 'SAFE_RETRY',
      reasonCode: 'NO_EFFECT',
    }),
    /cannot prove SAFE_RETRY/i,
  );
  assert.equal(writes, 1);
  assert.equal(readbacks, 0);
  assert.equal(fx.snapshot(inv.invocationId).phase, 'RECONCILE');
});

test('wrong blob SHA, wrong commit identity, and non-exact delete absence never verify', async t => {
  const cases = [
    ['wrong blob', {
      inv: putInvocation('github-file-wrong-blob'),
      client: fullClient({
        readFile: async args => ({ repositoryFullName: args.repositoryFullName, path: args.path, sha: 'f'.repeat(40), sizeBytes: 5, text: 'hello' }),
      }),
    }],
    ['wrong commit', {
      inv: putInvocation('github-file-wrong-commit'),
      client: fullClient({
        readCommitObject: async args => ({ repositoryFullName: args.repositoryFullName, commitSha: 'f'.repeat(40), treeSha, parentShas: [] }),
      }),
    }],
    ['delete still present', {
      inv: deleteInvocation('github-file-delete-still-present'),
      client: fullClient({
        readFile: async args => ({ repositoryFullName: args.repositoryFullName, path: args.path, sha: oldBlobSha, sizeBytes: 5, text: 'hello' }),
      }),
    }],
  ];

  for (const [label, entry] of cases) {
    await t.test(label, async () => {
      const cap = entry.inv.toolId === GitHubToolId.FILE_PUT ? GitHubCapabilityId.FILE_WRITE : GitHubCapabilityId.FILE_DELETE;
      const provider = new GitHubAgentProviderV1({
        githubClient: entry.client,
        grantedCapabilityIds: [cap],
        now: () => Date.parse(at),
      });
      const verifier = new GitHubFileMutationVerifierV1({ githubClient: entry.client, now: () => Date.parse(at) });
      const fx = storeFixture();
      const executor = new GitHubExactEffectExecutorV1({
        provider,
        store: fx.store,
        verify: input => verifier.verify(input),
        reconcileVerify: input => verifier.reconcileVerify(input),
        now: () => Date.parse(at),
      });
      await assert.rejects(
        () => executor.invoke({ invocation: entry.inv, policyDecision: policy(entry.inv) }),
        error => error.effectState?.phase === 'RECONCILE',
      );
      assert.equal(fx.snapshot(entry.inv.invocationId).phase, 'RECONCILE');
    });
  }
});

test('descriptor-hostile invocation is rejected before any independent GitHub readback', async () => {
  let commitReads = 0;
  let fileReads = 0;
  const client = fullClient({
    readCommitObject: async () => {
      commitReads += 1;
      throw new Error('must not be called');
    },
    readFile: async () => {
      fileReads += 1;
      throw new Error('must not be called');
    },
  });
  const verifier = new GitHubFileMutationVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const inv = putInvocation('github-file-hostile');
  const hostile = {
    repositoryFullName: repo,
    branch: 'work/file-proof',
    message: 'Write verified result',
    contentUtf8: 'hello',
    mode: 'update',
    expectedBlobSha: oldBlobSha,
  };
  Object.defineProperty(hostile, 'path', {
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
    data: {
      repositoryFullName: repo,
      path: 'docs/result.txt',
      branch: 'work/file-proof',
      blobSha: newBlobSha,
      commitSha,
      mode: 'update',
    },
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
  assert.equal(commitReads, 0);
  assert.equal(fileReads, 0);
});
