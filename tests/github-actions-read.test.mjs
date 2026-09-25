import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubRestClientV1,
} from '../src/core/github-rest-client.js';
import {
  GITHUB_PROVIDER_ID,
  GitHubAgentProviderV1,
  GitHubCapabilityId,
  GitHubToolId,
} from '../src/core/github-agent-provider.js';

const repo = 'owner/repo';
const at = '2026-09-25T10:30:00.000Z';
const headSha = 'a'.repeat(40);

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
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

function client(fetchImpl) {
  return new GitHubRestClientV1({
    nativeClient: nativeClient(),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl,
  });
}

function legacyProviderClient(overrides = {}) {
  return {
    readRepository: async args => args,
    readFile: async args => args,
    readTree: async args => args,
    readBranch: async args => args,
    findPullRequests: async args => args,
    readPullRequest: async args => args,
    readPullRequestComment: async args => args,
    readIssue: async args => args,
    readIssueComment: async args => args,
    createBranch: async args => args,
    putFile: async args => args,
    deleteFile: async args => args,
    createPullRequest: async args => args,
    createPullRequestComment: async args => args,
    createIssue: async args => args,
    createIssueComment: async args => args,
    ...overrides,
  };
}

function invocation(toolId, args, id = 'github-actions-read-1') {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId,
    providerId: GITHUB_PROVIDER_ID,
    requestedCapabilityIds: [GitHubCapabilityId.WORKFLOW_READ],
    policyDecisionId: `${id}:policy`,
    arguments: args,
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

test('workflow list uses fixed Actions endpoint and exposes pagination without hidden iteration', async () => {
  const calls = [];
  const github = client(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      total_count: 3,
      workflows: [
        {
          id: 11,
          name: 'Core',
          path: '.github/workflows/core.yml',
          state: 'active',
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-24T00:00:00Z',
          html_url: 'https://github.com/owner/repo/actions/workflows/core.yml',
        },
        {
          id: 12,
          name: 'Release',
          path: '.github/workflows/release.yml',
          state: 'active',
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-24T00:00:00Z',
          html_url: 'https://github.com/owner/repo/actions/workflows/release.yml',
        },
      ],
    });
  });

  const result = await github.listWorkflows({ repositoryFullName: repo, perPage: 2, page: 1 });
  assert.equal(result.totalCount, 3);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.workflows.map(item => item.id), [11, 12]);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/repos/owner/repo/actions/workflows');
  assert.equal(url.searchParams.get('per_page'), '2');
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(calls[0].init.method, 'GET');
});

test('workflow run list admits only bounded canonical filters and preserves exact head identity', async () => {
  const calls = [];
  const github = client(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      total_count: 1,
      workflow_runs: [{
        id: 101,
        workflow_id: 11,
        run_number: 44,
        run_attempt: 2,
        name: 'Core deterministic tests',
        event: 'pull_request',
        status: 'completed',
        conclusion: 'success',
        head_branch: 'work/x',
        head_sha: headSha,
        created_at: '2026-09-25T10:00:00Z',
        updated_at: '2026-09-25T10:05:00Z',
        html_url: 'https://github.com/owner/repo/actions/runs/101',
      }],
    });
  });

  const result = await github.listWorkflowRuns({
    repositoryFullName: repo,
    branch: 'work/x',
    status: 'success',
    headSha,
    perPage: 10,
    page: 1,
  });

  assert.equal(result.workflowRuns[0].headSha, headSha);
  assert.equal(result.workflowRuns[0].runAttempt, 2);
  assert.equal(result.hasMore, false);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/repos/owner/repo/actions/runs');
  assert.equal(url.searchParams.get('branch'), 'work/x');
  assert.equal(url.searchParams.get('status'), 'success');
  assert.equal(url.searchParams.get('head_sha'), headSha);
  assert.equal(url.searchParams.get('per_page'), '10');
  assert.equal(url.searchParams.get('page'), '1');

  await assert.rejects(
    () => github.listWorkflowRuns({ repositoryFullName: repo, status: ' success ' }),
    error => error.code === 'GITHUB_INVALID_REQUEST',
  );
  await assert.rejects(
    () => github.listWorkflowRuns({ repositoryFullName: repo, perPage: 101 }),
    error => error.code === 'GITHUB_INVALID_REQUEST',
  );
  assert.equal(calls.length, 1, 'invalid filters must fail before network');
});

test('workflow run jobs bind every job to the exact run and expose bounded step evidence', async () => {
  const calls = [];
  const github = client(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      total_count: 1,
      jobs: [{
        id: 9001,
        run_id: 101,
        head_sha: headSha,
        name: 'core-tests',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-09-25T10:00:01Z',
        completed_at: '2026-09-25T10:02:00Z',
        html_url: 'https://github.com/owner/repo/actions/runs/101/job/9001',
        workflow_name: 'Core deterministic tests',
        steps: [
          {
            name: 'Set up job',
            status: 'completed',
            conclusion: 'success',
            number: 1,
            started_at: '2026-09-25T10:00:01Z',
            completed_at: '2026-09-25T10:00:02Z',
          },
          {
            name: 'Run npm test',
            status: 'completed',
            conclusion: 'failure',
            number: 2,
            started_at: '2026-09-25T10:00:02Z',
            completed_at: '2026-09-25T10:02:00Z',
          },
        ],
      }],
    });
  });

  const result = await github.listWorkflowRunJobs({
    repositoryFullName: repo,
    runId: 101,
    filter: 'latest',
    perPage: 25,
    page: 1,
  });

  assert.equal(result.runId, 101);
  assert.equal(result.jobs[0].runId, 101);
  assert.equal(result.jobs[0].steps[1].conclusion, 'failure');
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/repos/owner/repo/actions/runs/101/jobs');
  assert.equal(url.searchParams.get('filter'), 'latest');
  assert.equal(url.searchParams.get('per_page'), '25');
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(calls[0].init.method, 'GET');
});

test('workflow run jobs fail closed on parent mismatch, duplicate identities, and oversized step arrays', async () => {
  for (const [label, payload] of [
    ['wrong-parent', {
      total_count: 1,
      jobs: [{
        id: 1, run_id: 102, head_sha: headSha, name: 'job', status: 'completed',
        conclusion: 'success', started_at: null, completed_at: null, html_url: '', workflow_name: 'Core', steps: [],
      }],
    }],
    ['duplicate-job', {
      total_count: 2,
      jobs: [
        { id: 1, run_id: 101, head_sha: headSha, name: 'a', status: 'queued', conclusion: null, started_at: null, completed_at: null, html_url: '', workflow_name: 'Core', steps: [] },
        { id: 1, run_id: 101, head_sha: headSha, name: 'b', status: 'queued', conclusion: null, started_at: null, completed_at: null, html_url: '', workflow_name: 'Core', steps: [] },
      ],
    }],
    ['too-many-steps', {
      total_count: 1,
      jobs: [{
        id: 1, run_id: 101, head_sha: headSha, name: 'job', status: 'completed',
        conclusion: 'success', started_at: null, completed_at: null, html_url: '', workflow_name: 'Core',
        steps: Array.from({ length: 257 }, (_, index) => ({
          name: `step-${index + 1}`, status: 'completed', conclusion: 'success', number: index + 1,
          started_at: null, completed_at: null,
        })),
      }],
    }],
  ]) {
    const github = client(async () => jsonResponse(payload));
    await assert.rejects(
      () => github.listWorkflowRunJobs({ repositoryFullName: repo, runId: 101 }),
      error => error.code === 'GITHUB_RESPONSE_INVALID',
      label,
    );
  }
});

test('workflow list rejects inconsistent page metadata and duplicate workflow ids', async () => {
  const inconsistent = client(async () => jsonResponse({
    total_count: 0,
    workflows: [{
      id: 11,
      name: 'Core',
      path: '.github/workflows/core.yml',
      state: 'active',
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-24T00:00:00Z',
      html_url: '',
    }],
  }));
  await assert.rejects(
    () => inconsistent.listWorkflows({ repositoryFullName: repo }),
    error => error.code === 'GITHUB_RESPONSE_INVALID',
  );

  const duplicate = client(async () => jsonResponse({
    total_count: 2,
    workflows: [
      { id: 11, name: 'Core', path: 'a.yml', state: 'active', created_at: '', updated_at: '', html_url: '' },
      { id: 11, name: 'Core 2', path: 'b.yml', state: 'active', created_at: '', updated_at: '', html_url: '' },
    ],
  }));
  await assert.rejects(
    () => duplicate.listWorkflows({ repositoryFullName: repo }),
    error => error.code === 'GITHUB_RESPONSE_INVALID',
  );
});

test('new Actions methods reject accessor-backed input without executing the getter', async () => {
  let getterReads = 0;
  let fetches = 0;
  const github = client(async () => {
    fetches += 1;
    return jsonResponse({ total_count: 0, workflow_runs: [] });
  });
  const input = { repositoryFullName: repo };
  Object.defineProperty(input, 'status', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'success';
    },
  });

  await assert.rejects(
    () => github.listWorkflowRuns(input),
    error => error.code === 'GITHUB_INVALID_REQUEST' && /data property/i.test(error.message),
  );
  assert.equal(getterReads, 0);
  assert.equal(fetches, 0);
});

test('workflow provider capability is conditional for legacy clients and required when granted', async () => {
  assert.doesNotThrow(() => new GitHubAgentProviderV1({
    githubClient: legacyProviderClient(),
    grantedCapabilityIds: [],
  }));

  assert.throws(
    () => new GitHubAgentProviderV1({
      githubClient: legacyProviderClient(),
      grantedCapabilityIds: [GitHubCapabilityId.WORKFLOW_READ],
    }),
    /complete workflow read support/i,
  );

  assert.doesNotThrow(() => new GitHubAgentProviderV1({
    githubClient: legacyProviderClient({
      listWorkflows: async args => args,
      listWorkflowRuns: async args => args,
      listWorkflowRunJobs: async args => args,
    }),
    grantedCapabilityIds: [GitHubCapabilityId.WORKFLOW_READ],
  }));
});

test('provider policy and capability gates occur before any Actions call', async () => {
  let calls = 0;
  const workflowClient = legacyProviderClient({
    listWorkflows: async args => { calls += 1; return { operation: 'listWorkflows', args }; },
    listWorkflowRuns: async args => { calls += 1; return { operation: 'listWorkflowRuns', args }; },
    listWorkflowRunJobs: async args => { calls += 1; return { operation: 'listWorkflowRunJobs', args }; },
  });

  const provider = new GitHubAgentProviderV1({
    githubClient: workflowClient,
    grantedCapabilityIds: [GitHubCapabilityId.WORKFLOW_READ],
    now: () => Date.parse(at),
  });
  const inv = invocation(GitHubToolId.WORKFLOW_RUN_JOBS_LIST, {
    repositoryFullName: repo,
    runId: 101,
  }, 'github-actions-jobs');

  await assert.rejects(
    () => provider.invoke({ invocation: inv, policyDecision: policy(inv, 'DENY') }),
    /not authorized/i,
  );
  assert.equal(calls, 0);

  const allowed = await provider.invoke({ invocation: inv, policyDecision: policy(inv) });
  assert.equal(allowed.result.operation, 'listWorkflowRunJobs');
  assert.equal(calls, 1);

  const underGranted = new GitHubAgentProviderV1({
    githubClient: workflowClient,
    grantedCapabilityIds: [],
  });
  await assert.rejects(
    () => underGranted.invoke({ invocation: inv, policyDecision: policy(inv) }),
    /granted|capabilit/i,
  );
  assert.equal(calls, 1);
});
