import test from 'node:test';
import assert from 'node:assert/strict';

import { GitHubRestClientV1 } from '../src/core/github-rest-client.js';
import {
  GITHUB_PROVIDER_ID,
  GitHubAgentProviderV1,
  GitHubCapabilityId,
  GitHubToolId,
} from '../src/core/github-agent-provider.js';
import { GitHubExactEffectExecutorV1 } from '../src/core/github-exact-effect.js';
import { GitHubWorkflowRunControlVerifierV1 } from '../src/core/github-workflow-control-verifier.js';

const repositoryFullName = 'Oleksii-debug/example';
const runId = 67890;
const workflowId = 12345;
const headSha = 'a'.repeat(40);
const at = '2026-09-25T12:30:00.000Z';
const beforeAt = '2026-09-25T12:20:00.000Z';

function response(status, body = '') {
  return new Response(body === '' ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function credential(counter) {
  return { async resolveCredential() { counter.count += 1; return { secret: 'test-token' }; } };
}
function client(fetchImpl, counter = { count: 0 }) {
  return new GitHubRestClientV1({
    nativeClient: credential(counter),
    credentialId: 'github-main',
    allowedRepositories: [repositoryFullName],
    fetchImpl,
  });
}
function run(overrides = {}) {
  return {
    id: runId, workflow_id: workflowId, run_number: 17, run_attempt: 2,
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    head_branch: 'main', head_sha: headSha,
    created_at: '2026-09-25T12:00:00.000Z', updated_at: beforeAt,
    html_url: 'https://github.com/Oleksii-debug/example/actions/runs/' + runId,
    ...overrides,
  };
}
function readback(overrides = {}) {
  const raw=run(overrides);
  return {
    repositoryFullName, id:raw.id, workflowId:raw.workflow_id, runNumber:raw.run_number,
    runAttempt:raw.run_attempt, event:raw.event, status:raw.status, conclusion:raw.conclusion ?? '',
    headBranch:raw.head_branch, headSha:raw.head_sha, createdAt:raw.created_at, updatedAt:raw.updated_at, url:raw.html_url,
  };
}
function completeClient(extra = {}) {
  const noop=async args=>args;
  return {
    readRepository:noop, readFile:noop, readTree:noop, readBranch:noop, findPullRequests:noop,
    readPullRequest:noop, readPullRequestComment:noop, readIssue:noop, readIssueComment:noop,
    createBranch:noop, putFile:noop, deleteFile:noop, createPullRequest:noop,
    createPullRequestComment:noop, createIssue:noop, createIssueComment:noop, ...extra,
  };
}
function controlInvocation(toolId, idValue='workflow-control-1') {
  const capability=toolId===GitHubToolId.WORKFLOW_RUN_RERUN
    ? GitHubCapabilityId.WORKFLOW_RUN_RERUN : GitHubCapabilityId.WORKFLOW_RUN_CANCEL;
  return {
    schemaVersion:1, invocationId:idValue, toolId, providerId:GITHUB_PROVIDER_ID,
    requestedCapabilityIds:[capability], policyDecisionId:'decision-'+idValue,
    arguments:{repositoryFullName,runId,expectedWorkflowId:workflowId,expectedRunAttempt:2,expectedHeadSha:headSha},
    createdAt:at, parentInvocationId:null,
  };
}
function policy(invocation, decision='ALLOW') {
  return {
    schemaVersion:1, decisionId:invocation.policyDecisionId, invocationId:invocation.invocationId,
    decision, reasonCode:'OWNER_POLICY', reason:'', approvalId:null, decidedAt:at,
  };
}
function providerResult(invocation, operation, previousStatus='completed', previousConclusion='success') {
  return {
    providerId:GITHUB_PROVIDER_ID, invocationId:invocation.invocationId, observedAt:at,
    result:{
      operation,repositoryFullName,runId,workflowId,runNumber:17,headSha,event:'workflow_dispatch',
      previousRunAttempt:2,previousStatus,previousConclusion,previousUpdatedAt:beforeAt,
    },
  };
}
function memoryStore() {
  let root={effectsById:{}};
  return { async update(mutator) {
    const draft=structuredClone(root); const returned=mutator(draft);
    root=structuredClone(returned===undefined?draft:returned); return structuredClone(root);
  }};
}

test('REST rerun preflights exact run identity then uses fixed 201 endpoint', async()=>{
  const calls=[];
  const github=client(async(url,init)=>{calls.push({url,init}); return init.method==='GET'?response(200,run()):response(201);});
  const result=await github.rerunWorkflowRun({repositoryFullName,runId,expectedWorkflowId:workflowId,expectedRunAttempt:2,expectedHeadSha:headSha});
  assert.equal(result.operation,'RERUN'); assert.equal(result.previousRunAttempt,2); assert.equal(calls.length,2);
  assert.equal(new URL(calls[0].url).pathname,'/repos/Oleksii-debug/example/actions/runs/'+runId);
  assert.equal(new URL(calls[1].url).pathname,'/repos/Oleksii-debug/example/actions/runs/'+runId+'/rerun');
  assert.equal(calls[1].init.method,'POST');
});

test('REST cancel preflights exact run identity then uses fixed 202 endpoint', async()=>{
  const calls=[];
  const github=client(async(url,init)=>{calls.push({url,init}); return init.method==='GET'?response(200,run({status:'in_progress',conclusion:null})):response(202);});
  const result=await github.cancelWorkflowRun({repositoryFullName,runId,expectedWorkflowId:workflowId,expectedRunAttempt:2,expectedHeadSha:headSha});
  assert.equal(result.operation,'CANCEL'); assert.equal(result.previousStatus,'in_progress'); assert.equal(calls.length,2);
  assert.equal(new URL(calls[1].url).pathname,'/repos/Oleksii-debug/example/actions/runs/'+runId+'/cancel');
  assert.equal(calls[1].init.method,'POST');
});

test('stale identity, terminal cancel and hostile or noncanonical input fail before mutation POST', async()=>{
  const counter={count:0}; let fetches=0; let posts=0;
  const github=client(async(url,init)=>{fetches+=1;if(init.method==='POST')posts+=1;return response(200,run());},counter);
  await assert.rejects(
    ()=>github.rerunWorkflowRun({repositoryFullName,runId,expectedWorkflowId:workflowId,expectedRunAttempt:3,expectedHeadSha:headSha}),
    e=>e.code==='GITHUB_WORKFLOW_RUN_PRECONDITION_FAILED'&&e.effectMayHaveOccurred===false);
  assert.equal(posts,0);
  await assert.rejects(
    ()=>github.cancelWorkflowRun({repositoryFullName,runId,expectedWorkflowId:workflowId,expectedRunAttempt:2,expectedHeadSha:headSha}),
    e=>e.code==='GITHUB_WORKFLOW_RUN_PRECONDITION_FAILED'&&e.effectMayHaveOccurred===false);
  assert.equal(posts,0);
  await assert.rejects(
    ()=>github.rerunWorkflowRun({repositoryFullName,runId,expectedWorkflowId:workflowId,expectedRunAttempt:2,expectedHeadSha:headSha.toUpperCase()}),
    e=>e.code==='GITHUB_INVALID_REQUEST');
  assert.equal(posts,0);
  const hostile={repositoryFullName,runId,expectedWorkflowId:workflowId,expectedRunAttempt:2,expectedHeadSha:headSha};
  let getterReads=0; Object.defineProperty(hostile,'expectedRunAttempt',{enumerable:true,get(){getterReads+=1;return 2;}});
  const fetchesBefore=fetches, credentialsBefore=counter.count;
  await assert.rejects(()=>github.rerunWorkflowRun(hostile),e=>e.code==='GITHUB_INVALID_REQUEST'&&/data property/i.test(e.message));
  assert.equal(getterReads,0); assert.equal(fetches,fetchesBefore); assert.equal(counter.count,credentialsBefore);
});

test('provider uses separate owner capabilities and policy denial happens before control mutation', async()=>{
  let reruns=0,cancels=0;
  const githubClient=completeClient({
    async rerunWorkflowRun(args){reruns+=1;return {operation:'RERUN',...args};},
    async cancelWorkflowRun(args){cancels+=1;return {operation:'CANCEL',...args};},
  });
  const provider=new GitHubAgentProviderV1({
    githubClient,grantedCapabilityIds:[GitHubCapabilityId.WORKFLOW_RUN_RERUN,GitHubCapabilityId.WORKFLOW_RUN_CANCEL],
    now:()=>Date.parse(at),
  });
  assert.equal(provider.tools().find(x=>x.toolId===GitHubToolId.WORKFLOW_RUN_RERUN).readOnly,false);
  assert.equal(provider.tools().find(x=>x.toolId===GitHubToolId.WORKFLOW_RUN_CANCEL).readOnly,false);
  const denied=controlInvocation(GitHubToolId.WORKFLOW_RUN_CANCEL,'cancel-denied');
  await assert.rejects(()=>provider.invoke({invocation:denied,policyDecision:policy(denied,'DENY')}),/not authorized/i);
  assert.equal(cancels,0);
  const allowed=controlInvocation(GitHubToolId.WORKFLOW_RUN_RERUN,'rerun-allowed');
  const result=await provider.invoke({invocation:allowed,policyDecision:policy(allowed)});
  assert.equal(result.result.operation,'RERUN'); assert.equal(reruns,1);
});

test('rerun verifier requires exactly one newer attempt on the same immutable run identity', async()=>{
  const invocation=controlInvocation(GitHubToolId.WORKFLOW_RUN_RERUN,'verify-rerun');
  const observation={schemaVersion:1,observationId:invocation.invocationId+':observation',invocationId:invocation.invocationId,status:'OK',summary:'',data:providerResult(invocation,'RERUN').result,artifactRefs:[],observedAt:at};
  const good=new GitHubWorkflowRunControlVerifierV1({
    githubClient:{async readWorkflowRun(){return readback({run_attempt:3,status:'queued',conclusion:null,updated_at:at});}},
    now:()=>Date.parse(at),
  });
  assert.equal((await good.verify({invocation,executionId:invocation.invocationId+':attempt:1',observation})).status,'VERIFIED');
  const raced=new GitHubWorkflowRunControlVerifierV1({
    githubClient:{async readWorkflowRun(){return readback({run_attempt:4,status:'queued',conclusion:null,updated_at:at});}},
    now:()=>Date.parse(at),
  });
  assert.equal((await raced.verify({invocation,executionId:invocation.invocationId+':attempt:1',observation})).status,'AMBIGUOUS');
});

test('cancel verifier stays ambiguous until the same attempt is terminal cancelled', async()=>{
  const invocation=controlInvocation(GitHubToolId.WORKFLOW_RUN_CANCEL,'verify-cancel');
  const observation={schemaVersion:1,observationId:invocation.invocationId+':observation',invocationId:invocation.invocationId,status:'OK',summary:'',data:providerResult(invocation,'CANCEL','in_progress','').result,artifactRefs:[],observedAt:at};
  let terminal=false;
  const verifier=new GitHubWorkflowRunControlVerifierV1({
    githubClient:{async readWorkflowRun(){return terminal?readback({status:'completed',conclusion:'cancelled',updated_at:at}):readback({status:'in_progress',conclusion:null,updated_at:at});}},
    now:()=>Date.parse(at),
  });
  assert.equal((await verifier.verify({invocation,executionId:invocation.invocationId+':attempt:1',observation})).status,'AMBIGUOUS');
  terminal=true;
  const proof=await verifier.reconcileVerify({
    invocation,effectId:invocation.invocationId,executionId:invocation.invocationId+':attempt:1',attempt:1,
    policyDecisionId:invocation.policyDecisionId,expectedOutcome:'VERIFIED',priorObservation:observation,
  });
  assert.equal(proof.verification.status,'VERIFIED');
  await assert.rejects(()=>verifier.reconcileVerify({
    invocation,effectId:invocation.invocationId,executionId:invocation.invocationId+':attempt:1',attempt:1,
    policyDecisionId:invocation.policyDecisionId,expectedOutcome:'SAFE_RETRY',priorObservation:observation,
  }),/cannot prove SAFE_RETRY/i);
});

test('exact-effect workflow control commits once and ambiguous transport never blind-replays', async()=>{
  const invocation=controlInvocation(GitHubToolId.WORKFLOW_RUN_RERUN,'exact-rerun');
  const verifier=new GitHubWorkflowRunControlVerifierV1({
    githubClient:{async readWorkflowRun(){return readback({run_attempt:3,status:'queued',conclusion:null,updated_at:at});}},
    now:()=>Date.parse(at),
  });
  let calls=0;
  const provider={
    authorize({invocation:input,policyDecision}){return {invocation:structuredClone(input),policyDecision:structuredClone(policyDecision)};},
    async invoke({invocation:input}){calls+=1;return providerResult(input,'RERUN');},
  };
  const executor=new GitHubExactEffectExecutorV1({provider,store:memoryStore(),verify:verifier.verify.bind(verifier),reconcileVerify:verifier.reconcileVerify.bind(verifier),now:()=>Date.parse(at)});
  const result=await executor.invoke({invocation,policyDecision:policy(invocation)});
  assert.equal(result.effectState.phase,'COMMITTED'); assert.equal(calls,1);
  await assert.rejects(()=>executor.invoke({invocation,policyDecision:policy(invocation)}),/cannot execute from COMMITTED/i);
  assert.equal(calls,1);

  const uncertainInvocation=controlInvocation(GitHubToolId.WORKFLOW_RUN_CANCEL,'exact-cancel-uncertain');
  let uncertainCalls=0;
  const uncertainProvider={
    authorize({invocation:input,policyDecision}){return {invocation:structuredClone(input),policyDecision:structuredClone(policyDecision)};},
    async invoke(){uncertainCalls+=1;const e=new Error('response lost after POST');e.effectMayHaveOccurred=true;e.safeToRetry=false;throw e;},
  };
  const uncertain=new GitHubExactEffectExecutorV1({provider:uncertainProvider,store:memoryStore(),verify:verifier.verify.bind(verifier),reconcileVerify:verifier.reconcileVerify.bind(verifier),now:()=>Date.parse(at)});
  await assert.rejects(()=>uncertain.invoke({invocation:uncertainInvocation,policyDecision:policy(uncertainInvocation)}),e=>e.effectState.phase==='RECONCILE'&&e.safeToRetry===false);
  await assert.rejects(()=>uncertain.invoke({invocation:uncertainInvocation,policyDecision:policy(uncertainInvocation)}),/requires reconciliation before retry/i);
  assert.equal(uncertainCalls,1);
});
