import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState, OperationPhase } from '../../src/core/schema.js';
import { restorePendingSendTabs } from '../../src/core/native-input.js';

function setup(phase) {
  const state = createEmptyState(0);
  const session = createSession({ id:'s',name:'S',tasks:[createTask({id:'t',url:'https://chatgpt.com/'})],now:0,postSendDelayMs:600000 });
  session.runState = RunState.RUNNING;
  session.operation = {operationId:'op',taskId:'t',phase,targetUrl:'https://chatgpt.com/',
    previousSendTabId:1,previousSendWindowId:42,postSendHoldUntil:Date.now()+600000};
  state.sessionsById.s = session;
  state.sessionOrder.push('s');
  state.tabHintsByTaskId.t = {tabId:2,sessionId:'s',ownedByExtension:true,kind:'TASK'};
  let activeId=2;
  const chromeApi={tabs:{
    get:async id=>({id,windowId:42,active:activeId===id,url:'https://chatgpt.com/'}),
    update:async(id,options)=>{assert.equal(options.active,true);activeId=id;return {id,windowId:42,active:true};},
  }};
  const repo={load:async()=>state,update:async fn=>{fn(state);return state;}};
  return {state,chromeApi,repo,activeId:()=>activeId};
}
test('verified Send releases foreground focus before long post-Send tab hold expires',async()=>{
  const f=setup(OperationPhase.SENT_VERIFIED);
  await restorePendingSendTabs(f.chromeApi,f.repo,{sessionId:'s'});
  assert.equal(f.activeId(),1);
  assert.equal(f.state.sessionsById.s.operation.previousSendTabId,0);
  assert.ok(f.state.sessionsById.s.operation.postSendHoldUntil>Date.now());
  assert.equal(f.state.tabHintsByTaskId.t.tabId,2);
});
test('in-flight Send retains active tab until effect result is resolved',async()=>{
  const f=setup(OperationPhase.SUBMITTING);
  await restorePendingSendTabs(f.chromeApi,f.repo,{sessionId:'s'});
  assert.equal(f.activeId(),2);
  assert.equal(f.state.sessionsById.s.operation.previousSendTabId,1);
});
