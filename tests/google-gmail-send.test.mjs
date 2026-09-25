import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GMAIL_API_ORIGIN,
  GoogleWorkspaceRestClientV1,
} from '../src/core/google-workspace-rest-client.js';
import {
  GOOGLE_WORKSPACE_PROVIDER_ID,
  GoogleWorkspaceAgentProviderV1,
  GoogleWorkspaceCapabilityId,
  GoogleWorkspaceToolId,
} from '../src/core/google-workspace-agent-provider.js';
import { GoogleWorkspaceExactEffectExecutorV1 } from '../src/core/google-workspace-exact-effect.js';
import { GmailDraftSendVerifierV1 } from '../src/core/google-gmail-send-verifier.js';
import { ExactEffectPhase } from '../src/core/universal-agent-exact-effect.js';

const userId='owner@example.com';
const baseMs=Date.parse('2026-09-25T09:00:00.000Z');
const raw='RnJvbTogb3duZXJAZXhhbXBsZS5jb20NClRvOiByZWNpcGllbnRAZXhhbXBsZS5jb20NClN1YmplY3Q6IFRlc3QNCg0KSGVsbG8';
function response(status, body){const bytes=new TextEncoder().encode(JSON.stringify(body));return{status,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};}
function nativeClient(){return{resolveCredential:async request=>({credentialId:request.credentialId,targetOrigin:request.targetOrigin,secret:'test-token'})};}
function config(fetchImpl){return{nativeClient:nativeClient(),gmailCredentialId:'gmail-main',allowedDriveRootIds:[],allowedDriveFileIds:[],allowedGmailUsers:[userId],fetchImpl};}
function invocation(id='gmail-send-1'){return{schemaVersion:1,invocationId:id,toolId:GoogleWorkspaceToolId.GMAIL_DRAFT_SEND,providerId:GOOGLE_WORKSPACE_PROVIDER_ID,requestedCapabilityIds:[GoogleWorkspaceCapabilityId.GMAIL_DRAFT_SEND],policyDecisionId:`decision-${id}`,arguments:{userId,draftId:'draft_1',rawMessageBase64Url:raw},createdAt:new Date(baseMs).toISOString(),parentInvocationId:null};}
function policy(id='gmail-send-1'){return{schemaVersion:1,decisionId:`decision-${id}`,invocationId:id,decision:'ALLOW',reasonCode:'OWNER_POLICY',reason:'',approvalId:null,decidedAt:new Date(baseMs).toISOString()};}
function memoryStore(){let root={effectsById:{}};return{async update(mutator){const draft=structuredClone(root);const returned=mutator(draft);root=structuredClone(returned===undefined?draft:returned);return structuredClone(root);},async load(id){return structuredClone(root.effectsById?.[id]?.state||null);}};}

test('draft send uses only fixed drafts.send endpoint with exact owner, draft id and RFC822 bytes', async()=>{
  const calls=[];
  const client=new GoogleWorkspaceRestClientV1(config(async(url,options)=>{
    calls.push({url,options});
    return response(200,{id:'sent_1',threadId:'thread_1',labelIds:['SENT'],historyId:'7',internalDate:String(baseMs+1000),sizeEstimate:321});
  }));
  const result=await client.sendGmailDraft({userId,draftId:'draft_1',rawMessageBase64Url:raw});
  assert.equal(calls.length,1);
  const u=new URL(calls[0].url);
  assert.equal(u.origin,GMAIL_API_ORIGIN);
  assert.equal(u.pathname,'/gmail/v1/users/owner%40example.com/drafts/send');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.redirect,'error');
  assert.deepEqual(JSON.parse(calls[0].options.body),{id:'draft_1',message:{raw}});
  assert.equal(result.draftId,'draft_1');
  assert.equal(result.messageId,'sent_1');
  assert.ok(result.labelIds.includes('SENT'));
  assert.equal(JSON.stringify(result).includes('test-token'),false);
});

test('draft send rejects aliases and malformed bytes before any network dispatch', async()=>{
  let calls=0;
  const client=new GoogleWorkspaceRestClientV1(config(async()=>{calls+=1;return response(500,{})}));
  await assert.rejects(()=>client.sendGmailDraft({userId:'me',draftId:'draft_1',rawMessageBase64Url:raw}),/exact owner-configured email/i);
  await assert.rejects(()=>client.sendGmailDraft({userId,draftId:' draft_1',rawMessageBase64Url:raw}),/draftId|invalid/i);
  await assert.rejects(()=>client.sendGmailDraft({userId,draftId:'draft_1',rawMessageBase64Url:'bad='}),/base64url/i);
  assert.equal(calls,0);
});

test('successful draft send is committed only after independent SENT readback', async()=>{
  let sends=0,reads=0,now=baseMs;
  const workspaceClient={
    searchDrive:async()=>({}),getDriveFile:async()=>({}),readDriveText:async()=>({}),searchGmail:async()=>({}),
    getGmailMessage:async()=>({}),getGmailThread:async()=>({}),getGmailAttachment:async()=>({}),createGmailDraft:async()=>({}),
    sendGmailDraft:async()=>{sends+=1;return{userId,draftId:'draft_1',messageId:'sent_1',threadId:'thread_1',labelIds:['SENT']};},
    getGmailSentMessage:async({userId:seen,messageId})=>{reads+=1;assert.equal(seen,userId);assert.equal(messageId,'sent_1');return{id:'sent_1',threadId:'thread_1',labelIds:['SENT']};},
  };
  const provider=new GoogleWorkspaceAgentProviderV1({workspaceClient,grantedCapabilityIds:[GoogleWorkspaceCapabilityId.GMAIL_DRAFT_SEND],now:()=>{now+=100;return now;}});
  const verifier=new GmailDraftSendVerifierV1({workspaceClient,now:()=>{now+=100;return now;}});
  const store=memoryStore();
  const executor=new GoogleWorkspaceExactEffectExecutorV1({provider,store,verify:input=>verifier.verify(input),reconcileVerify:input=>verifier.reconcileVerify(input),now:()=>{now+=100;return now;}});
  const inv=invocation();
  const result=await executor.invoke({invocation:inv,policyDecision:policy()});
  assert.equal(result.effectState.phase,ExactEffectPhase.COMMITTED);
  assert.equal(sends,1);
  assert.equal(reads,1);
  await assert.rejects(()=>executor.invoke({invocation:inv,policyDecision:policy()}),/cannot execute from COMMITTED/);
  assert.equal(sends,1);
});

test('transport-ambiguous draft send never blind-retries and cannot auto-verify without returned message identity', async()=>{
  let sends=0,now=baseMs;
  const workspaceClient={
    searchDrive:async()=>({}),getDriveFile:async()=>({}),readDriveText:async()=>({}),searchGmail:async()=>({}),
    getGmailMessage:async()=>({}),getGmailSentMessage:async()=>{throw new Error('must not read arbitrary candidates');},getGmailThread:async()=>({}),getGmailAttachment:async()=>({}),createGmailDraft:async()=>({}),
    sendGmailDraft:async()=>{sends+=1;const e=new Error('lost response');e.effectMayHaveOccurred=true;e.safeToRetry=false;throw e;},
  };
  const provider=new GoogleWorkspaceAgentProviderV1({workspaceClient,grantedCapabilityIds:[GoogleWorkspaceCapabilityId.GMAIL_DRAFT_SEND],now:()=>{now+=100;return now;}});
  const verifier=new GmailDraftSendVerifierV1({workspaceClient,now:()=>{now+=100;return now;}});
  const store=memoryStore();
  const executor=new GoogleWorkspaceExactEffectExecutorV1({provider,store,verify:input=>verifier.verify(input),reconcileVerify:input=>verifier.reconcileVerify(input),now:()=>{now+=100;return now;}});
  const inv=invocation('gmail-send-ambiguous'),decision=policy(inv.invocationId);
  await assert.rejects(()=>executor.invoke({invocation:inv,policyDecision:decision}),error=>error.effectState?.phase===ExactEffectPhase.RECONCILE&&error.safeToRetry===false);
  await assert.rejects(()=>executor.invoke({invocation:inv,policyDecision:decision}),/requires reconciliation before retry/);
  await assert.rejects(()=>executor.reconcile({invocationId:inv.invocationId,outcome:'SAFE_RETRY',reasonCode:'NO_EFFECT'}),/cannot prove SAFE_RETRY/i);
  await assert.rejects(()=>executor.reconcile({invocationId:inv.invocationId,outcome:'VERIFIED',reasonCode:'SENT'}),/observed sent-message identity|manual review/i);
  assert.equal((await store.load(inv.invocationId)).phase,ExactEffectPhase.RECONCILE);
  const reviewed=await executor.reconcile({invocationId:inv.invocationId,outcome:'MANUAL_REVIEW',reasonCode:'OWNER_REVIEW_REQUIRED',summary:'No returned sent-message identity after ambiguous POST.'});
  assert.notEqual(reviewed.phase,ExactEffectPhase.COMMITTED);
  assert.equal(sends,1);
});

test('send verifier rejects coercive owner identity without invoking caller conversion hooks', async()=>{
  let coercions=0;
  const hostile={toString(){coercions+=1;return userId;}};
  const inv=invocation('gmail-send-hostile-user');
  inv.arguments={...inv.arguments,userId:hostile};
  const verifier=new GmailDraftSendVerifierV1({workspaceClient:{getGmailSentMessage:async()=>{throw new Error('must not read Gmail');}}});
  await assert.rejects(
    ()=>verifier.verify({
      invocation:inv,
      executionId:`${inv.invocationId}:attempt:1`,
      observation:{data:{userId,draftId:'draft_1',messageId:'sent_1',threadId:'thread_1'}},
    }),
    /requires exact userId/i,
  );
  assert.equal(coercions,0);
});

test('send verifier rejects mismatched returned identity and missing SENT label', async()=>{
  let now=baseMs;
  const inv=invocation('gmail-send-verifier');
  const observation={schemaVersion:1,observationId:'obs-1',invocationId:inv.invocationId,status:'OK',summary:'sent',data:{userId,draftId:'draft_1',messageId:'sent_1',threadId:'thread_1'},artifactRefs:[],observedAt:new Date(baseMs+100).toISOString()};
  const noSent=new GmailDraftSendVerifierV1({workspaceClient:{getGmailSentMessage:async()=>({id:'sent_1',threadId:'thread_1',labelIds:['INBOX']})},now:()=>{now+=100;return now;}});
  const verification=await noSent.verify({invocation:inv,executionId:`${inv.invocationId}:attempt:1`,observation});
  assert.equal(verification.status,'AMBIGUOUS');
  const mismatch=new GmailDraftSendVerifierV1({workspaceClient:{getGmailSentMessage:async()=>({id:'other',threadId:'thread_1',labelIds:['SENT']})}});
  await assert.rejects(()=>mismatch.verify({invocation:inv,executionId:`${inv.invocationId}:attempt:1`,observation}),/identity mismatch/i);
});
