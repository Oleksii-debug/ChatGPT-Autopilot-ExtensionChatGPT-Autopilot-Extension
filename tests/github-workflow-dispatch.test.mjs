import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubRestClientV1, GITHUB_API_ORIGIN } from '../src/core/github-rest-client.js';
import { GITHUB_PROVIDER_ID, GitHubAgentProviderV1, GitHubCapabilityId, GitHubToolId } from '../src/core/github-agent-provider.js';
import { GitHubExactEffectExecutorV1 } from '../src/core/github-exact-effect.js';
import { GitHubWorkflowDispatchVerifierV1 } from '../src/core/github-workflow-dispatch-verifier.js';

const repositoryFullName = 'Oleksii-debug/example';
const at = '2026-09-25T12:20:00.000Z';
const workflowId = 12345; const runId = 67890; const headSha = 'a'.repeat(40); const encoder = new TextEncoder();
function jsonResponse(status, payload) { const bytes = encoder.encode(JSON.stringify(payload)); let sent = false; return { status, headers: { get() { return null; } }, body: { getReader() { return { async read() { if (sent) return { done: true, value: undefined }; sent = true; return { done: false, value: bytes }; }, releaseLock() {} }; } } }; }
function nativeCredential(calls = []) { return { async resolveCredential(request) { calls.push(request); return { credentialId: request.credentialId, kind: 'username-password', targetOrigin: request.targetOrigin, username: '', secret: 'secret-token' }; } }; }
function clientConfig(overrides = {}) { return { nativeClient: nativeCredential([]), credentialId: 'github-main', allowedRepositories: [repositoryFullName], fetchImpl: async () => jsonResponse(200, {}), ...overrides }; }
function invocation(id = 'workflow-dispatch-1') { return { schemaVersion: 1, invocationId: id, toolId: GitHubToolId.WORKFLOW_DISPATCH, providerId: GITHUB_PROVIDER_ID, requestedCapabilityIds: [GitHubCapabilityId.WORKFLOW_DISPATCH], policyDecisionId: 'decision-' + id, arguments: { repositoryFullName, workflowId, ref: 'main', inputs: { deploy: true, shard: 2, note: 'bounded' } }, createdAt: at, parentInvocationId: null }; }
function policy(id = 'workflow-dispatch-1') { return { schemaVersion: 1, decisionId: 'decision-' + id, invocationId: id, decision: 'ALLOW', reasonCode: 'OWNER_POLICY', reason: '', approvalId: null, decidedAt: at }; }
function completeClient(extra = {}) { const noop = async () => ({}); return { readRepository: noop, readFile: noop, readTree: noop, readBranch: noop, findPullRequests: noop, readPullRequest: noop, readPullRequestComment: noop, readIssue: noop, readIssueComment: noop, createBranch: noop, putFile: noop, deleteFile: noop, createPullRequest: noop, createPullRequestComment: noop, createIssue: noop, createIssueComment: noop, ...extra }; }
function memoryStore() { let root = { effectsById: {} }; return { async update(mutator) { const draft = structuredClone(root); const returned = mutator(draft); root = structuredClone(returned === undefined ? draft : returned); return structuredClone(root); } }; }
function providerResult(input) { return { providerId: GITHUB_PROVIDER_ID, invocationId: input.invocationId, observedAt: at, result: { repositoryFullName, workflowId, ref: input.arguments.ref, inputs: structuredClone(input.arguments.inputs), runId, runUrl: GITHUB_API_ORIGIN + '/repos/Oleksii-debug/example/actions/runs/' + runId, htmlUrl: 'https://github.com/Oleksii-debug/example/actions/runs/' + runId } }; }
function runReadback(overrides = {}) { return { repositoryFullName, id: runId, workflowId, runNumber: 17, runAttempt: 1, event: 'workflow_dispatch', status: 'queued', conclusion: '', headBranch: 'main', headSha, createdAt: at, updatedAt: at, url: 'https://github.com/Oleksii-debug/example/actions/runs/' + runId, ...overrides }; }

test('REST dispatch is fixed, bounded and returns independently readable run identity', async () => {
  const requests = [];
  const client = new GitHubRestClientV1(clientConfig({ fetchImpl: async (url, options) => { requests.push({ url, options }); if (options.method === 'POST') return jsonResponse(200, { workflow_run_id: runId, run_url: GITHUB_API_ORIGIN + '/repos/Oleksii-debug/example/actions/runs/' + runId, html_url: 'https://github.com/Oleksii-debug/example/actions/runs/' + runId }); return jsonResponse(200, { id: runId, workflow_id: workflowId, run_number: 17, run_attempt: 1, event: 'workflow_dispatch', status: 'queued', conclusion: null, head_branch: 'main', head_sha: headSha, created_at: at, updated_at: at, html_url: 'https://github.com/Oleksii-debug/example/actions/runs/' + runId }); } }));
  const result = await client.dispatchWorkflow({ repositoryFullName, workflowId, ref: 'main', inputs: { shard: 2, deploy: true } });
  assert.equal(result.runId, runId); assert.deepEqual(Object.keys(result.inputs), ['deploy', 'shard']);
  assert.equal(requests[0].url, GITHUB_API_ORIGIN + '/repos/Oleksii-debug/example/actions/workflows/' + workflowId + '/dispatches');
  const body = JSON.parse(requests[0].options.body); assert.equal(body.ref, 'main'); assert.equal(body.return_run_details, true); assert.deepEqual(body.inputs, { deploy: true, shard: 2 }); assert.equal(requests[0].options.body.includes('secret-token'), false);
  const readback = await client.readWorkflowRun({ repositoryFullName, runId }); assert.equal(readback.id, runId); assert.equal(readback.workflowId, workflowId); assert.equal(readback.event, 'workflow_dispatch');
});

test('dispatch rejects aliases, hostile descriptors and >25 inputs before credentials/network', async () => {
  let networkCalls = 0; const credentialCalls = [];
  const client = new GitHubRestClientV1({ ...clientConfig(), nativeClient: nativeCredential(credentialCalls), fetchImpl: async () => { networkCalls += 1; return jsonResponse(200, {}); } });
  await assert.rejects(() => client.dispatchWorkflow({ repositoryFullName, workflowId, ref: ' main', inputs: {} }), e => e.code === 'GITHUB_INVALID_REQUEST');
  await assert.rejects(() => client.dispatchWorkflow({ repositoryFullName, workflowId, ref: 'main', inputs: Object.fromEntries(Array.from({ length: 26 }, (_, i) => ['k' + i, 'x'])) }), e => e.code === 'GITHUB_INVALID_REQUEST');
  let getterCalls = 0; const hostile = {}; Object.defineProperty(hostile, 'token', { enumerable: true, get() { getterCalls += 1; return 'must-not-run'; } });
  await assert.rejects(() => client.dispatchWorkflow({ repositoryFullName, workflowId, ref: 'main', inputs: hostile }), e => e.code === 'GITHUB_INVALID_REQUEST');
  assert.equal(getterCalls, 0); assert.equal(networkCalls, 0); assert.deepEqual(credentialCalls, []);
});

test('no-details dispatch outcome is ambiguous and never retry-safe', async () => {
  const client = new GitHubRestClientV1(clientConfig({ fetchImpl: async () => jsonResponse(204, {}) }));
  await assert.rejects(() => client.dispatchWorkflow({ repositoryFullName, workflowId, ref: 'main', inputs: {} }), e => e.code === 'GITHUB_HTTP_204' && e.effectMayHaveOccurred === true && e.safeToRetry === false);
});

test('provider requires explicit workflow-dispatch capability before mutation', async () => {
  let calls = 0; const githubClient = completeClient({ async dispatchWorkflow(args) { calls += 1; return { ...args, runId, runUrl: 'api', htmlUrl: 'html' }; } });
  const denied = new GitHubAgentProviderV1({ githubClient, grantedCapabilityIds: [] }); const deniedInv = invocation('provider-denied');
  assert.throws(() => denied.authorize({ invocation: deniedInv, policyDecision: policy(deniedInv.invocationId) }), /capabilit|grant|authorized/i); assert.equal(calls, 0);
  const provider = new GitHubAgentProviderV1({ githubClient, grantedCapabilityIds: [GitHubCapabilityId.WORKFLOW_DISPATCH], now: () => Date.parse(at) });
  assert.equal(provider.tools().find(x => x.toolId === GitHubToolId.WORKFLOW_DISPATCH).readOnly, false);
  const inv = invocation(); const result = await provider.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }); assert.equal(result.result.runId, runId); assert.equal(calls, 1);
});

test('verifier accepts only exact workflow/ref run evidence and never fabricates SAFE_RETRY', async () => {
  const verifier = new GitHubWorkflowDispatchVerifierV1({ githubClient: { async readWorkflowRun() { return runReadback(); } }, now: () => Date.parse(at) });
  const inv = invocation(); const observation = { schemaVersion: 1, observationId: inv.invocationId + ':observation', invocationId: inv.invocationId, status: 'OK', summary: '', data: providerResult(inv).result, artifactRefs: [], observedAt: at };
  const verified = await verifier.verify({ invocation: inv, executionId: inv.invocationId + ':attempt:1', observation }); assert.equal(verified.status, 'VERIFIED');
  const wrong = new GitHubWorkflowDispatchVerifierV1({ githubClient: { async readWorkflowRun() { return runReadback({ workflowId: workflowId + 1 }); } }, now: () => Date.parse(at) });
  const mismatch = await wrong.verify({ invocation: inv, executionId: inv.invocationId + ':attempt:1', observation }); assert.equal(mismatch.status, 'AMBIGUOUS');
  await assert.rejects(() => verifier.reconcileVerify({ invocation: inv, effectId: inv.invocationId, executionId: inv.invocationId + ':attempt:1', attempt: 1, policyDecisionId: inv.policyDecisionId, expectedOutcome: 'SAFE_RETRY', priorObservation: null }), /cannot prove SAFE_RETRY/i);
});

test('exact-effect dispatch commits once; ambiguous transport enters RECONCILE with zero blind replay', async () => {
  const verifier = new GitHubWorkflowDispatchVerifierV1({ githubClient: { async readWorkflowRun() { return runReadback(); } }, now: () => Date.parse(at) });
  let calls = 0; const provider = { authorize({ invocation: input, policyDecision }) { return { invocation: structuredClone(input), policyDecision: structuredClone(policyDecision) }; }, async invoke({ invocation: input }) { calls += 1; return providerResult(input); } };
  const executor = new GitHubExactEffectExecutorV1({ provider, store: memoryStore(), verify: verifier.verify.bind(verifier), reconcileVerify: verifier.reconcileVerify.bind(verifier), now: () => Date.parse(at) });
  const inv = invocation('exact-dispatch'); const result = await executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }); assert.equal(result.effectState.phase, 'COMMITTED'); assert.equal(calls, 1);
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }), /cannot execute from COMMITTED/i); assert.equal(calls, 1);
  let uncertainCalls = 0; const uncertainProvider = { authorize({ invocation: input, policyDecision }) { return { invocation: structuredClone(input), policyDecision: structuredClone(policyDecision) }; }, async invoke() { uncertainCalls += 1; const e = new Error('response lost'); e.effectMayHaveOccurred = true; e.safeToRetry = false; throw e; } };
  const uncertain = new GitHubExactEffectExecutorV1({ provider: uncertainProvider, store: memoryStore(), verify: verifier.verify.bind(verifier), reconcileVerify: verifier.reconcileVerify.bind(verifier), now: () => Date.parse(at) });
  const amb = invocation('ambiguous-dispatch'); await assert.rejects(() => uncertain.invoke({ invocation: amb, policyDecision: policy(amb.invocationId) }), e => e.effectState.phase === 'RECONCILE' && e.safeToRetry === false);
  await assert.rejects(() => uncertain.invoke({ invocation: amb, policyDecision: policy(amb.invocationId) }), /requires reconciliation before retry/i); assert.equal(uncertainCalls, 1);
});
