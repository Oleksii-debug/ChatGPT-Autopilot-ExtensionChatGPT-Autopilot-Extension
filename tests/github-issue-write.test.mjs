import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubRestClientV1, GITHUB_API_ORIGIN } from '../src/core/github-rest-client.js';
import { GITHUB_PROVIDER_ID, GitHubAgentProviderV1, GitHubCapabilityId, GitHubToolId } from '../src/core/github-agent-provider.js';
import { GitHubExactEffectExecutorV1 } from '../src/core/github-exact-effect.js';
import { GitHubIssueWriteVerifierV1 } from '../src/core/github-issue-write-verifier.js';

const at = '2026-09-25T09:15:00.000Z';
const repo = 'owner/repo';

function response(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}
function nativeClient() { return { resolveCredential: async () => ({ secret: 'opaque-test-token' }) }; }

test('REST issue/comment operations use fixed endpoints, exact identities and bounded bodies', async () => {
  const calls = [];
  const queue = [
    response(201, { number: 7, title: 'Issue title', body: 'Issue body', state: 'open', html_url: 'https://github.com/owner/repo/issues/7' }),
    response(200, { number: 7, title: 'Issue title', body: 'Issue body', state: 'open', html_url: 'https://github.com/owner/repo/issues/7' }),
    response(201, { id: 99, body: 'Exact comment', issue_url: `${GITHUB_API_ORIGIN}/repos/owner/repo/issues/7`, html_url: 'https://github.com/owner/repo/issues/7#issuecomment-99' }),
    response(200, { id: 99, body: 'Exact comment', issue_url: `${GITHUB_API_ORIGIN}/repos/owner/repo/issues/7`, html_url: 'https://github.com/owner/repo/issues/7#issuecomment-99' }),
  ];
  const client = new GitHubRestClientV1({
    nativeClient: nativeClient(), credentialId: 'github-main', allowedRepositories: [repo],
    fetchImpl: async (url, init) => { calls.push({ url, init }); const next = queue.shift(); if (!next) throw new Error('unexpected fetch'); return next; },
  });
  const issue = await client.createIssue({ repositoryFullName: repo, title: 'Issue title', body: 'Issue body' });
  assert.equal(issue.number, 7);
  assert.equal((await client.readIssue({ repositoryFullName: repo, issueNumber: 7 })).title, 'Issue title');
  assert.equal((await client.createIssueComment({ repositoryFullName: repo, issueNumber: 7, body: 'Exact comment' })).commentId, 99);
  assert.equal((await client.readIssueComment({ repositoryFullName: repo, issueNumber: 7, commentId: 99 })).body, 'Exact comment');
  assert.deepEqual(calls.map(call => [call.init.method, new URL(call.url).pathname]), [
    ['POST', '/repos/owner/repo/issues'], ['GET', '/repos/owner/repo/issues/7'],
    ['POST', '/repos/owner/repo/issues/7/comments'], ['GET', '/repos/owner/repo/issues/comments/99'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'Issue title', body: 'Issue body' });
  assert.deepEqual(JSON.parse(calls[2].init.body), { body: 'Exact comment' });
});

test('REST issue/comment mutation rejects aliases before network and marks transport ambiguity non-retryable', async () => {
  let calls = 0;
  const client = new GitHubRestClientV1({
    nativeClient: nativeClient(), credentialId: 'github-main', allowedRepositories: [repo],
    fetchImpl: async () => { calls += 1; throw new Error('socket closed after send'); },
  });
  await assert.rejects(() => client.createIssue({ repositoryFullName: ' owner/repo', title: 'x' }),
    error => error.code === 'GITHUB_INVALID_REQUEST' && error.effectMayHaveOccurred === false);
  await assert.rejects(() => client.createIssueComment({ repositoryFullName: repo, issueNumber: '7', body: 'x' }),
    error => error.code === 'GITHUB_INVALID_REQUEST');
  assert.equal(calls, 0);
  await assert.rejects(() => client.createIssue({ repositoryFullName: repo, title: 'x' }),
    error => error.code === 'GITHUB_TRANSPORT_ERROR' && error.effectMayHaveOccurred === true && error.safeToRetry === false);
  assert.equal(calls, 1);
});

function fullClient(overrides = {}) {
  return {
    readRepository: async args => args, readFile: async args => args, readTree: async args => args,
    readBranch: async args => args, findPullRequests: async args => args,
    readIssue: async ({ repositoryFullName, issueNumber }) => ({ repositoryFullName, number: issueNumber, title: 'Issue title', body: 'Issue body', state: 'open', url: 'https://example.invalid/issue' }),
    readIssueComment: async ({ repositoryFullName, issueNumber, commentId }) => ({ repositoryFullName, issueNumber, commentId, body: 'Exact comment', url: 'https://example.invalid/comment' }),
    createBranch: async args => args, putFile: async args => args, deleteFile: async args => args, createPullRequest: async args => args,
    createIssue: async ({ repositoryFullName, title, body }) => ({ repositoryFullName, number: 7, title, body, state: 'open', url: 'https://example.invalid/issue' }),
    createIssueComment: async ({ repositoryFullName, issueNumber, body }) => ({ repositoryFullName, issueNumber, commentId: 99, body, url: 'https://example.invalid/comment' }),
    ...overrides,
  };
}
function invocation(id, toolId, capabilityId, args) {
  return { schemaVersion: 1, invocationId: id, toolId, providerId: GITHUB_PROVIDER_ID, requestedCapabilityIds: [capabilityId], policyDecisionId: `${id}:policy`, arguments: args, createdAt: at, parentInvocationId: null };
}
function policy(inv) {
  return { schemaVersion: 1, decisionId: inv.policyDecisionId, invocationId: inv.invocationId, decision: 'ALLOW', reasonCode: 'OWNER_POLICY', reason: '', approvalId: null, decidedAt: at };
}
function storeFixture() {
  let root = { effectsById: {} };
  return {
    store: { async update(mutator) { const draft = structuredClone(root); const next = mutator(draft); root = structuredClone(next ?? draft); return structuredClone(root); } },
    snapshot(id) { return structuredClone(root.effectsById[id]?.state ?? null); },
  };
}

test('issue create is exact-effect fenced, independently read back and committed', async () => {
  let creates = 0, reads = 0;
  const client = fullClient({
    createIssue: async ({ repositoryFullName, title, body }) => { creates += 1; return { repositoryFullName, number: 7, title, body, state: 'open', url: 'https://example.invalid/issue' }; },
    readIssue: async ({ repositoryFullName, issueNumber }) => { reads += 1; return { repositoryFullName, number: issueNumber, title: 'Issue title', body: 'Issue body', state: 'open', url: 'https://example.invalid/issue' }; },
  });
  const provider = new GitHubAgentProviderV1({ githubClient: client, grantedCapabilityIds: [GitHubCapabilityId.ISSUE_CREATE], now: () => Date.parse(at) });
  const verifier = new GitHubIssueWriteVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({ provider, store: fx.store, now: () => Date.parse(at), verify: input => verifier.verify(input), reconcileVerify: input => verifier.reconcileVerify(input) });
  const inv = invocation('github-issue-create-1', GitHubToolId.ISSUE_CREATE, GitHubCapabilityId.ISSUE_CREATE, { repositoryFullName: repo, title: 'Issue title', body: 'Issue body' });
  const result = await executor.invoke({ invocation: inv, policyDecision: policy(inv) });
  assert.equal(result.effectState.phase, 'COMMITTED'); assert.equal(creates, 1); assert.equal(reads, 1);
  assert.equal(fx.snapshot(inv.invocationId).verification.reasonCode, 'GITHUB_CREATED_IDENTITY_CONFIRMED');
});

test('issue-comment create is independently bound to exact parent, id and body', async () => {
  let comments = 0, reads = 0;
  const client = fullClient({
    createIssueComment: async ({ repositoryFullName, issueNumber, body }) => { comments += 1; return { repositoryFullName, issueNumber, commentId: 99, body, url: 'https://example.invalid/comment' }; },
    readIssueComment: async ({ repositoryFullName, issueNumber, commentId }) => { reads += 1; return { repositoryFullName, issueNumber, commentId, body: 'Exact comment', url: 'https://example.invalid/comment' }; },
  });
  const provider = new GitHubAgentProviderV1({ githubClient: client, grantedCapabilityIds: [GitHubCapabilityId.ISSUE_COMMENT_CREATE], now: () => Date.parse(at) });
  const verifier = new GitHubIssueWriteVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({ provider, store: fx.store, now: () => Date.parse(at), verify: input => verifier.verify(input), reconcileVerify: input => verifier.reconcileVerify(input) });
  const inv = invocation('github-comment-create-1', GitHubToolId.ISSUE_COMMENT_CREATE, GitHubCapabilityId.ISSUE_COMMENT_CREATE, { repositoryFullName: repo, issueNumber: 7, body: 'Exact comment' });
  const result = await executor.invoke({ invocation: inv, policyDecision: policy(inv) });
  assert.equal(result.effectState.phase, 'COMMITTED'); assert.equal(comments, 1); assert.equal(reads, 1);
});

test('ambiguous create dispatch enters durable RECONCILE and cannot blind replay', async () => {
  let creates = 0;
  const ambiguous = Object.assign(new Error('transport ended after send'), { code: 'GITHUB_TRANSPORT_ERROR', effectMayHaveOccurred: true, safeToRetry: false });
  const client = fullClient({ createIssue: async () => { creates += 1; throw ambiguous; } });
  const provider = new GitHubAgentProviderV1({ githubClient: client, grantedCapabilityIds: [GitHubCapabilityId.ISSUE_CREATE], now: () => Date.parse(at) });
  const verifier = new GitHubIssueWriteVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const fx = storeFixture();
  const executor = new GitHubExactEffectExecutorV1({ provider, store: fx.store, now: () => Date.parse(at), verify: input => verifier.verify(input), reconcileVerify: input => verifier.reconcileVerify(input) });
  const inv = invocation('github-issue-ambiguous', GitHubToolId.ISSUE_CREATE, GitHubCapabilityId.ISSUE_CREATE, { repositoryFullName: repo, title: 'Issue title', body: 'Issue body' });
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy(inv) }),
    error => error.reconcileRequired === true && error.safeToRetry === false && error.effectState.phase === 'RECONCILE');
  await assert.rejects(() => executor.invoke({ invocation: structuredClone(inv), policyDecision: structuredClone(policy(inv)) }), /requires reconciliation/i);
  assert.equal(creates, 1);
  await assert.rejects(() => executor.reconcile({ invocationId: inv.invocationId, outcome: 'SAFE_RETRY' }), /cannot prove SAFE_RETRY/i);
  assert.equal(fx.snapshot(inv.invocationId).phase, 'RECONCILE');
});

test('verifier rejects accessor/coercive boundaries before any GitHub readback', async () => {
  let getterReads = 0, remoteReads = 0;
  const client = fullClient({ readIssue: async () => { remoteReads += 1; return {}; } });
  const verifier = new GitHubIssueWriteVerifierV1({ githubClient: client, now: () => Date.parse(at) });
  const inv = invocation('github-issue-hostile', GitHubToolId.ISSUE_CREATE, GitHubCapabilityId.ISSUE_CREATE, { repositoryFullName: repo, title: 'Issue title', body: 'Issue body' });
  const hostile = {};
  Object.defineProperty(hostile, 'toolId', { enumerable: true, get() { getterReads += 1; return GitHubToolId.ISSUE_CREATE; } });
  await assert.rejects(() => verifier.verify({ invocation: hostile, executionId: 'github-issue-hostile:attempt:1', observation: { observationId: 'obs-1', invocationId: inv.invocationId, data: {} } }), /enumerable data property/i);
  assert.equal(getterReads, 0); assert.equal(remoteReads, 0);
  const coercive = { toString() { getterReads += 1; return 'github-issue-hostile:attempt:1'; } };
  await assert.rejects(() => verifier.verify({ invocation: inv, executionId: coercive, observation: { observationId: 'obs-2', invocationId: inv.invocationId, data: { repositoryFullName: repo, number: 7, title: 'Issue title', body: 'Issue body' } } }), /executionId does not contain a valid attempt/i);
  assert.equal(getterReads, 0); assert.equal(remoteReads, 0);
});

test('verifier rejects accessor-backed read dependency without executing getter', () => {
  let getterReads = 0;
  const client = fullClient();
  Object.defineProperty(client, 'readIssue', { enumerable: true, configurable: true, get() { getterReads += 1; return async () => ({}); } });
  assert.throws(() => new GitHubIssueWriteVerifierV1({ githubClient: client }), /data method/i);
  assert.equal(getterReads, 0);
});
