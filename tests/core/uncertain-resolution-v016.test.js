import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState, OperationPhase } from '../../src/core/schema.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { applyInteractionResult } from '../../src/core/execution.js';
import { StorageRepository } from '../../src/core/storage.js';
import { computeNextWake } from '../../src/core/recovery.js';
function setup(now=130000){
  const state=createEmptyState(1);
  const session=createSession({id:'s',name:'Шахи',tasks:[createTask({id:'t',url:'https://chatgpt.com/c/test'}),createTask({id:'next',url:'https://chatgpt.com/c/next'})],sharedPrompt:'test',now:1});
  session.runState=RunState.RECOVERING;
  session.operation={operationId:'op',sessionId:'s',taskId:'t',promptFingerprint:'fp',promptText:'test',targetUrl:session.tasksById.t.normalizedUrl,phase:OperationPhase.AMBIGUOUS,preSendDeadline:0,submitStartedAt:1000,createdAt:900,updatedAt:1000,verificationDeadline:121000};
  session.tasksById.t.status='SUBMISSION_UNCERTAIN';
  state.sessionsById.s=session;state.sessionOrder=['s'];
  let db={autopilotState:state}, interactions=[];
  const chrome={storage:{local:{get:async key=>({[key]:structuredClone(db[key])}),set:async rec=>{db={...db,...structuredClone(rec)};}}},tabs:{get:async()=>({id:1,url:'https://chatgpt.com/c/test'}),query:async()=>[{id:1,url:'https://chatgpt.com/c/test'}]}};
  const repo=new StorageRepository(chrome);
  const dispatcher=new CoreCommandDispatcher(repo,()=>now);
  const transport={execute:async(_tab,request)=>{interactions.push(request.mode);return {status:'SUBMISSION_UNCERTAIN',safeDiagnosticCode:'RECOVERY_UNCERTAIN'};}};
  return {repo,dispatcher,executor:new AutomaticSessionExecutor(repo,chrome,transport,{now:()=>now}),interactions,session};
}
const command=(f,resolution,extra={})=>f.dispatcher.execute('RESOLVE_UNCERTAIN',{sessionId:'s',operationId:'op',resolution,...extra});
test('recovery expires into actionable pause with original operation preserved',async()=>{
 const f=setup();await f.executor.runSessionOnce('s');const state=await f.repo.load(), s=state.sessionsById.s;
 assert.equal(s.runState,'PAUSED');assert.equal(s.operation.phase,'MANUAL_REVIEW');assert.equal(s.operation.operationId,'op');assert.equal(s.tasksById.t.manualReviewReason,'SEND_ACK_TIMEOUT');assert.equal(computeNextWake(state,130000),null);assert.deepEqual(f.interactions,['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
});
test('uncertainty establishes a stable deadline and useful last error',()=>{
 const f=setup();f.session.operation.verificationDeadline=0;
 applyInteractionResult(f.session,0,{status:'SUBMISSION_UNCERTAIN'},{now:10000});
 applyInteractionResult(f.session,0,{status:'SUBMISSION_UNCERTAIN'},{now:20000});
 assert.equal(f.session.operation.verificationDeadline,130000);assert.ok(f.session.lastError);assert.equal(f.session.lastSuccessfulSendAt,0);
});
test('repeat requires explicit confirmation and stale operation ids cannot reset work',async()=>{
 const f=setup();await assert.rejects(command(f,'retry'),/підтвердження/);
 await assert.rejects(command(f,'retry',{operationId:'other',confirmed:true}),/змінився/);
 assert.equal((await f.repo.load()).sessionsById.s.operation.operationId,'op');
});
test('explicit retry preserves tasks and waits for Resume without claiming success',async()=>{
 const f=setup();await command(f,'retry',{confirmed:true});const s=(await f.repo.load()).sessionsById.s;
 assert.equal(s.operation,null);assert.equal(s.runState,'PAUSED');assert.equal(s.tasksById.t.enabled,true);assert.equal(s.lastSuccessfulSendAt,0);assert.equal(s.currentTaskIndex,0);
 await f.dispatcher.execute('RESUME_SESSION',{sessionId:'s'});assert.equal((await f.repo.load()).sessionsById.s.runState,'RUNNING');
});
test('skip disables only uncertain task and never manufactures verified send',async()=>{
 const f=setup();await command(f,'skip',{confirmed:true});const s=(await f.repo.load()).sessionsById.s;
 assert.equal(s.tasksById.t.enabled,false);assert.equal(s.tasksById.next.enabled,true);assert.equal(s.currentTaskIndex,1);assert.equal(s.lastSuccessfulSendAt,0);assert.equal(s.tasksById.t.lastVerifiedSendAt,0);assert.equal(s.runState,'PAUSED');
});
test('check resolution schedules only verification and retains identity',async()=>{
 const f=setup();await command(f,'check');let s=(await f.repo.load()).sessionsById.s;assert.equal(s.operation.operationId,'op');assert.equal(s.operation.verificationDeadline,250000);
 await f.executor.runSessionOnce('s');assert.deepEqual(f.interactions,['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
});
test('fresh StorageRepository after restart retains timeout and unresolved operation',async()=>{
 const f=setup();await f.executor.runSessionOnce('s');const before=await f.repo.load();
 const newRepo=new StorageRepository(f.repo.chrome);const after=await newRepo.load();assert.deepEqual(after,before);assert.equal(after.sessionsById.s.operation.phase,'MANUAL_REVIEW');
});

test('long retry setting cannot postpone the acknowledgement deadline',()=>{
 const f=setup();f.session.operation.verificationDeadline=0;f.session.retryBackoffMs=180000;
 applyInteractionResult(f.session,0,{status:'SUBMISSION_UNCERTAIN'},{now:10000});
 assert.equal(f.session.tasksById.t.retryAfterAt,130000);
});
