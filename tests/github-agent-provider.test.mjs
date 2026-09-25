import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_PROVIDER_ID,
  GitHubAgentProviderV1,
  GitHubCapabilityId,
  GitHubToolId,
} from '../src/core/github-agent-provider.js';

const at = '2026-09-24T16:30:00.000Z';

function invocation(toolId, capabilityId, args = {}) {
  return {
    schemaVersion: 1,
    invocationId: 'github-inv-1',
    toolId,
    providerId: GITHUB_PROVIDER_ID,
    requestedCapabilityIds: [capabilityId],
    policyDecisionId: 'decision-1',
    arguments: args,
    createdAt: at,
    parentInvocationId: null,
  };
}

const allow = {
  schemaVersion: 1,
  decisionId: 'decision-1',
  invocationId: 'github-inv-1',
  decision: 'ALLOW',
  reasonCode: 'OWNER_POLICY',
  reason: '',
  approvalId: null,
  decidedAt: at,
};

function githubClient(overrides = {}) {
  return {
    readRepository: async args => ({ operation: 'readRepository', args }),
    readFile: async args => ({ operation: 'readFile', args }),
    readTree: async args => ({ operation: 'readTree', args }),
    readBranch: async args => ({ operation: 'readBranch', args }),
    findPullRequests: async args => ({ operation: 'findPullRequests', args }),
    createBranch: async args => ({ operation: 'createBranch', args }),
    putFile: async args => ({ operation: 'putFile', args }),
    deleteFile: async args => ({ operation: 'deleteFile', args }),
    createPullRequest: async args => ({ operation: 'createPullRequest', args }),
    ...overrides,
  };
}

test('GitHub provider requires invocation-bound owner ALLOW and exact granted capability', async () => {
  const calls = [];
  const provider = new GitHubAgentProviderV1({
    githubClient: githubClient({ readFile: async args => { calls.push(args); return { sha: 'a'.repeat(40), text: 'ok' }; } }),
    grantedCapabilityIds: [GitHubCapabilityId.FILE_READ],
    now: () => Date.parse(at),
  });
  const inv = invocation(GitHubToolId.FILE_READ, GitHubCapabilityId.FILE_READ, { repositoryFullName: 'owner/repo', path: 'README.md' });

  await assert.rejects(() => provider.invoke({ invocation: inv, policyDecision: { ...allow, decision: 'DENY' } }), /not authorized/i);
  await assert.rejects(
    () => provider.invoke({ invocation: { ...inv, requestedCapabilityIds: [GitHubCapabilityId.FILE_WRITE] }, policyDecision: allow }),
    /capabilit|granted|tool/i,
  );

  const result = await provider.invoke({ invocation: inv, policyDecision: allow });
  assert.equal(result.providerId, GITHUB_PROVIDER_ID);
  assert.equal(result.invocationId, 'github-inv-1');
  assert.equal(result.observedAt, at);
  assert.equal(result.result.sha, 'a'.repeat(40));
  assert.deepEqual(calls, [{ repositoryFullName: 'owner/repo', path: 'README.md' }]);
});

test('ordinary session and specialist paths share the same ToolInvocation capability contract', async () => {
  const provider = new GitHubAgentProviderV1({
    githubClient: githubClient(),
    grantedCapabilityIds: [GitHubCapabilityId.REPOSITORY_READ, GitHubCapabilityId.TREE_READ],
    now: () => Date.parse(at),
  });
  const ordinary = invocation(GitHubToolId.REPOSITORY_READ, GitHubCapabilityId.REPOSITORY_READ, { repositoryFullName: 'owner/repo' });
  const specialist = {
    ...invocation(GitHubToolId.TREE_READ, GitHubCapabilityId.TREE_READ, { repositoryFullName: 'owner/repo', treeish: 'main' }),
    invocationId: 'github-inv-specialist',
    policyDecisionId: 'decision-specialist',
    parentInvocationId: 'parent-specialist-invocation',
  };
  const specialistAllow = { ...allow, decisionId: 'decision-specialist', invocationId: 'github-inv-specialist' };

  const first = await provider.invoke({ invocation: ordinary, policyDecision: allow });
  const second = await provider.invoke({ invocation: specialist, policyDecision: specialistAllow });
  assert.equal(first.result.operation, 'readRepository');
  assert.equal(second.result.operation, 'readTree');
  assert.equal(second.invocationId, 'github-inv-specialist');
});

test('reconciliation reads are separately capability-gated and remain read-only', async () => {
  const provider = new GitHubAgentProviderV1({
    githubClient: githubClient(),
    grantedCapabilityIds: [GitHubCapabilityId.BRANCH_READ, GitHubCapabilityId.PULL_REQUEST_READ],
    now: () => Date.parse(at),
  });

  const branch = await provider.invoke({
    invocation: invocation(GitHubToolId.BRANCH_READ, GitHubCapabilityId.BRANCH_READ, { repositoryFullName: 'owner/repo', branch: 'work/x' }),
    policyDecision: allow,
  });
  assert.equal(branch.result.operation, 'readBranch');

  const pullInvocation = {
    ...invocation(GitHubToolId.PULL_REQUEST_FIND, GitHubCapabilityId.PULL_REQUEST_READ, { repositoryFullName: 'owner/repo', head: 'work/x', base: 'main' }),
    invocationId: 'github-inv-pr-find',
    policyDecisionId: 'decision-pr-find',
  };
  const pullAllow = { ...allow, decisionId: 'decision-pr-find', invocationId: 'github-inv-pr-find' };
  const pulls = await provider.invoke({ invocation: pullInvocation, policyDecision: pullAllow });
  assert.equal(pulls.result.operation, 'findPullRequests');

  await assert.rejects(
    () => provider.invoke({
      invocation: invocation(GitHubToolId.BRANCH_CREATE, GitHubCapabilityId.BRANCH_CREATE, { repositoryFullName: 'owner/repo', branch: 'work/y', fromSha: 'a'.repeat(40) }),
      policyDecision: allow,
    }),
    /granted|capabilit/i,
  );
});

test('effectful transport ambiguity is never marked retry-safe by provider', async () => {
  const ambiguous = Object.assign(new Error('socket ended after send'), {
    code: 'GITHUB_TRANSPORT_ERROR',
    effectMayHaveOccurred: true,
    safeToRetry: false,
  });
  const provider = new GitHubAgentProviderV1({
    githubClient: githubClient({ createBranch: async () => { throw ambiguous; } }),
    grantedCapabilityIds: [GitHubCapabilityId.BRANCH_CREATE],
  });
  const inv = invocation(GitHubToolId.BRANCH_CREATE, GitHubCapabilityId.BRANCH_CREATE, {
    repositoryFullName: 'owner/repo', branch: 'work/x', fromSha: 'a'.repeat(40),
  });
  await assert.rejects(
    () => provider.invoke({ invocation: inv, policyDecision: allow }),
    error => error.code === 'GITHUB_TRANSPORT_ERROR'
      && error.invocationId === 'github-inv-1'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false,
  );
});

test('read-only failure remains retry-safe and deterministic pre-effect rejection remains safe', async () => {
  const transport = Object.assign(new Error('offline'), {
    code: 'GITHUB_TRANSPORT_ERROR',
    effectMayHaveOccurred: false,
    safeToRetry: true,
  });
  const readProvider = new GitHubAgentProviderV1({
    githubClient: githubClient({ readTree: async () => { throw transport; } }),
    grantedCapabilityIds: [GitHubCapabilityId.TREE_READ],
  });
  await assert.rejects(
    () => readProvider.invoke({
      invocation: invocation(GitHubToolId.TREE_READ, GitHubCapabilityId.TREE_READ, { repositoryFullName: 'owner/repo', treeish: 'main' }),
      policyDecision: allow,
    }),
    error => error.effectMayHaveOccurred === false && error.safeToRetry === true,
  );

  const rejected = Object.assign(new Error('repo denied'), {
    code: 'GITHUB_REPOSITORY_NOT_ALLOWED',
    effectMayHaveOccurred: false,
    safeToRetry: true,
  });
  const writeProvider = new GitHubAgentProviderV1({
    githubClient: githubClient({ putFile: async () => { throw rejected; } }),
    grantedCapabilityIds: [GitHubCapabilityId.FILE_WRITE],
  });
  await assert.rejects(
    () => writeProvider.invoke({
      invocation: invocation(GitHubToolId.FILE_PUT, GitHubCapabilityId.FILE_WRITE, { repositoryFullName: 'other/repo' }),
      policyDecision: allow,
    }),
    error => error.code === 'GITHUB_REPOSITORY_NOT_ALLOWED'
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === true,
  );
});
