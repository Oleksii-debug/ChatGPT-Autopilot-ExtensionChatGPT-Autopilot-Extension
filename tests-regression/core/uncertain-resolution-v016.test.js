import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState, OperationPhase } from '../../src/core/schema.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { applyInteractionResult } from '../../src/core/execution.js';
import { StorageRepository } from '../../src/core/storage.js';
import { computeNextWake } from '../../src/core/recovery.js';
function setup(now=130000,{retryPolicy='safe'}={}){
  const state=createEmptyState(1);
  const session=createSession({id:'s',name:'Шахи',tasks:[createTask({id:'t',url:'https://chatgpt.com/c/test'}),createTask({id:'next',url:'https://chatgpt.com/c/next'})],sharedPrompt:'test',now:1});
  session.runState=RunState.RECOVERING;
  session.retryPolicy=retryPolicy;
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
test('safe ordinary recovery expiry settles the exact ambiguous operation without blind resend or permanent Session stall',async()=>{
 const f=setup();const result=await f.executor.runSessionOnce('s');const state=await f.repo.load(), s=state.sessionsById.s;
 assert.equal(result.kind,'UNCERTAIN_SETTLED_NO_RESEND');
 assert.equal(s.runState,'RUNNING');assert.equal(s.operation.phase,'FAILED_SAFE');assert.equal(s.operation.operationId,'op');
 assert.equal(s.currentTaskIndex,0);assert.equal(s.tasksById.t.status,'RETRY_WAIT');assert.ok(s.tasksById.t.retryAfterAt>130000);
 assert.notEqual(computeNextWake(state,130000),null);assert.deepEqual(f.interactions,[], 'expired safe ordinary recovery must settle before any browser verification round trip');
 assert.match(s.lastError,/Повтор того самого Send не виконувався/);
});


test('managed orchestration never auto-resends an ambiguous submit after timeout',async()=>{
 const f=setup();f.session.orchestrationCoordinator={managed:true,projectId:'proj',generation:1};
 let dbState=await f.repo.load();
 dbState.sessionsById.s.orchestrationCoordinator={managed:true,projectId:'proj',generation:1};
 await f.repo.save(dbState);
 const result=await f.executor.runSessionOnce('s');
 const state=await f.repo.load(), s=state.sessionsById.s;
 assert.equal(result.kind,'UNCERTAIN_VERIFY_HOLD');
 assert.equal(s.runState,'RECOVERING');
 assert.equal(s.operation.phase,'AMBIGUOUS');
 assert.equal(s.tasksById.t.status,'SUBMISSION_UNCERTAIN');
 assert.ok(s.tasksById.t.retryAfterAt>130000);
 assert.equal(s.lastSuccessfulSendAt,0);
 assert.match(s.lastError,/повторний Send заборонено/);
 assert.deepEqual(f.interactions,['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
});

test('scenario-managed Session never auto-resends an ambiguous submit after timeout',async()=>{
 const f=setup();
 let dbState=await f.repo.load();
 dbState.sessionsById.s.scenarioWork={managed:true,scenarioId:'night-scenario',participantKey:'worker-1',generation:1,stage:'FIRST'};
 await f.repo.save(dbState);
 const result=await f.executor.runSessionOnce('s');
 const state=await f.repo.load(), s=state.sessionsById.s;
 assert.equal(result.kind,'UNCERTAIN_VERIFY_HOLD');
 assert.equal(s.runState,'RECOVERING');
 assert.equal(s.operation.phase,'AMBIGUOUS');
 assert.equal(s.tasksById.t.status,'SUBMISSION_UNCERTAIN');
 assert.ok(s.tasksById.t.retryAfterAt>130000);
 assert.equal(s.lastSuccessfulSendAt,0);
 assert.match(s.lastError,/повторний Send заборонено/);
 assert.deepEqual(f.interactions,['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
});

test('manual policy still expires into actionable pause with original operation preserved',async()=>{
 const f=setup(130000,{retryPolicy:'manual'});await f.executor.runSessionOnce('s');const state=await f.repo.load(), s=state.sessionsById.s;
 assert.equal(s.runState,'PAUSED');assert.equal(s.operation.phase,'MANUAL_REVIEW');assert.equal(s.operation.operationId,'op');assert.equal(s.tasksById.t.manualReviewReason,'SEND_ACK_TIMEOUT');assert.equal(computeNextWake(state,130000),null);assert.deepEqual(f.interactions,['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
});
test('safe uncertainty establishes a bounded unattended deadline and useful last error',()=>{
 const f=setup();f.session.operation.verificationDeadline=0;
 applyInteractionResult(f.session,0,{status:'SUBMISSION_UNCERTAIN'},{now:10000});
 applyInteractionResult(f.session,0,{status:'SUBMISSION_UNCERTAIN'},{now:20000});
 assert.equal(f.session.operation.verificationDeadline,55000);assert.match(f.session.lastError,/Автоматичне відновлення/);assert.equal(f.session.lastSuccessfulSendAt,0);
});
test('repeat requires explicit confirmation and stale operation ids cannot reset work',async()=>{
 const f=setup(130000,{retryPolicy:'manual'});await assert.rejects(command(f,'retry'),/підтвердження/);
 await assert.rejects(command(f,'retry',{operationId:'other',confirmed:true}),/змінився/);
 assert.equal((await f.repo.load()).sessionsById.s.operation.operationId,'op');
});
test('explicit retry preserves tasks and waits for Resume without claiming success',async()=>{
 const f=setup(130000,{retryPolicy:'manual'});await command(f,'retry',{confirmed:true});const s=(await f.repo.load()).sessionsById.s;
 assert.equal(s.operation,null);assert.equal(s.runState,'PAUSED');assert.equal(s.tasksById.t.enabled,true);assert.equal(s.lastSuccessfulSendAt,0);assert.equal(s.currentTaskIndex,0);
 await f.dispatcher.execute('RESUME_SESSION',{sessionId:'s'});assert.equal((await f.repo.load()).sessionsById.s.runState,'RUNNING');
});
test('skip disables only uncertain task and never manufactures verified send',async()=>{
 const f=setup(130000,{retryPolicy:'manual'});await command(f,'skip',{confirmed:true});const s=(await f.repo.load()).sessionsById.s;
 assert.equal(s.tasksById.t.enabled,false);assert.equal(s.tasksById.next.enabled,true);assert.equal(s.currentTaskIndex,1);assert.equal(s.lastSuccessfulSendAt,0);assert.equal(s.tasksById.t.lastVerifiedSendAt,0);assert.equal(s.runState,'PAUSED');
});
test('check resolution schedules only verification and retains identity',async()=>{
 const f=setup(130000,{retryPolicy:'manual'});await command(f,'check');let s=(await f.repo.load()).sessionsById.s;assert.equal(s.operation.operationId,'op');assert.equal(s.operation.verificationDeadline,250000);
 await f.executor.runSessionOnce('s');assert.deepEqual(f.interactions,['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
});
test('fresh StorageRepository after restart retains bounded ordinary fail-safe settlement instead of resurrecting AMBIGUOUS',async()=>{
 const f=setup();await f.executor.runSessionOnce('s');const before=await f.repo.load();
 const newRepo=new StorageRepository(f.repo.chrome);const after=await newRepo.load();assert.deepEqual(after,before);assert.equal(after.sessionsById.s.operation.phase,'FAILED_SAFE');assert.equal(after.sessionsById.s.runState,'RUNNING');
});

test('long retry setting cannot postpone the unattended acknowledgement deadline beyond its cap',()=>{
 const f=setup();f.session.operation.verificationDeadline=0;f.session.retryBackoffMs=180000;
 applyInteractionResult(f.session,0,{status:'SUBMISSION_UNCERTAIN'},{now:10000});
 assert.equal(f.session.operation.verificationDeadline,55000);assert.equal(f.session.tasksById.t.retryAfterAt,55000);
});
