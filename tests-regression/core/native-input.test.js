import test from 'node:test';
import assert from 'node:assert/strict';
import { performNativeInput, activateOwnedSendTab, restoreOwnedSendTab, restorePendingSendTabs } from '../../src/core/native-input.js';
import { createEmptyState,createSession,createTask } from '../../src/core/schema.js';
import { StorageRepository } from '../../src/core/storage.js';
function setup(kind='submit'){
 const state=createEmptyState(1); const task=createTask({id:'t',url:'https://chatgpt.com/c/native'});
 const session=createSession({id:'s',name:'Native',tasks:[task],sharedPrompt:'canonical prompt',now:1});
 session.runState='RUNNING';session.operation={operationId:'op',sessionId:'s',taskId:'t',targetUrl:task.url,promptText:'canonical prompt',promptFingerprint:'fp',phase:kind==='submit'?'SUBMITTING':'INSERTING',createdAt:1,updatedAt:1,preSendDeadline:0,submitStartedAt:kind==='submit'?1:0,verificationDeadline:0};
 state.sessionsById.s=session;state.sessionOrder=['s'];state.tabHintsByTaskId.t={tabId:7,sessionId:'s',normalizedUrl:task.url,kind:'TASK'};
 let db=state;const calls=[];
 const chrome={runtime:{id:'ext'},storage:{local:{get:async()=>({autopilotState:structuredClone(db)}),set:async r=>{db=structuredClone(r.autopilotState);}}},tabs:{get:async()=>({id:7,url:task.url})},scripting:{executeScript:async()=>[{result:{url:task.url,x:20,y:30}}]},debugger:{attach:async()=>calls.push('attach'),detach:async()=>calls.push('detach'),sendCommand:async(_target,method,args)=>{
  if(method==='Input.dispatchMouseEvent')assert.equal(db.sessionsById.s.operation.nativeSubmitDispatched,true);
  calls.push({method,args});
 }}};
 const repo=new StorageRepository(chrome);const sender={id:'ext',frameId:0,tab:{id:7}};
 const message={kind,requestId:'op',taskId:'t',x:100,y:100};
 return {chrome,repo,sender,message,calls,run(){return performNativeInput(chrome,repo,message,sender);}};
}
test('native click persists effect checkpoint, presses and releases once, detaches',async()=>{
 const f=setup();await f.run();assert.deepEqual(f.calls.map(c=>typeof c==='string'?c:c.args.type),['attach','mousePressed','mouseReleased','detach']);
 await assert.rejects(f.run(),/NATIVE_SUBMIT_ALREADY_DISPATCHED/);assert.equal(f.calls.length,4);
});

test('owned tab activation occurs before Send and restores the prior tab after durable dispatch',async()=>{
 const f=setup();let activeTabId=3;
 f.chrome.tabs.get=async id=>({id,url:id===7?'https://chatgpt.com/c/native':'https://example.com/',active:id===activeTabId,windowId:9});
 f.chrome.tabs.query=async()=>[{id:activeTabId,windowId:9}];
 f.chrome.tabs.update=async id=>{activeTabId=id;return {id,active:true};};
 assert.deepEqual(await activateOwnedSendTab(f.chrome,f.repo,f.message,f.sender),{previousTabId:3});
 assert.equal(activeTabId,7);
 await f.run();
 await restoreOwnedSendTab(f.chrome,f.repo,{...f.message,previousTabId:3},f.sender);
 assert.equal(activeTabId,3);
});

test('invalid sender cannot activate a tab and never reaches Chrome tab mutation',async()=>{
 const f=setup();let touched=0;
 f.chrome.tabs.update=async()=>{touched++;};
 await assert.rejects(activateOwnedSendTab(f.chrome,f.repo,f.message,{...f.sender,id:'foreign'},),/NATIVE_INPUT_SENDER_INVALID/);
 assert.equal(touched,0);
});

test('cold-start restoration reads the durable previous tab after a completed native click',async()=>{
 const f=setup();let activeTabId=3;
 f.chrome.tabs.get=async id=>({id,url:id===7?'https://chatgpt.com/c/native':'https://example.com/',active:id===activeTabId,windowId:9});
 f.chrome.tabs.query=async()=>[{id:activeTabId,windowId:9}];
 f.chrome.tabs.update=async id=>{activeTabId=id;return {id,active:true};};
 await activateOwnedSendTab(f.chrome,f.repo,f.message,f.sender);
 const activated=await f.repo.load();
 assert.equal(activated.sessionsById.s.operation.previousSendTabId,3);
 assert.equal(activated.sessionsById.s.operation.previousSendWindowId,9);
 await f.run();
 const restartedRepo=new StorageRepository(f.chrome);
 await restorePendingSendTabs(f.chrome,restartedRepo);
 assert.equal(activeTabId,3);
 const restored=await restartedRepo.load();
 assert.equal(restored.sessionsById.s.operation.previousSendTabId,0);
 assert.equal(restored.sessionsById.s.operation.previousSendWindowId,0);
});
test('same-window parallel activation preserves original owner focus across restart reconciliation',async()=>{
 const f=setup();
 await f.repo.update(state=>{
  const task=createTask({id:'t2',url:'https://chatgpt.com/c/native-two'});
  const session=createSession({id:'s2',name:'Native two',tasks:[task],sharedPrompt:'second prompt',now:1});
  session.runState='RUNNING';
  session.operation={operationId:'op2',sessionId:'s2',taskId:'t2',targetUrl:task.url,promptText:'second prompt',promptFingerprint:'fp2',phase:'SUBMITTING',createdAt:1,updatedAt:1,preSendDeadline:0,submitStartedAt:1,verificationDeadline:0};
  state.sessionsById.s2=session;
  state.sessionOrder.push('s2');
  state.tabHintsByTaskId.t2={tabId:8,sessionId:'s2',normalizedUrl:task.url,kind:'TASK'};
  return state;
 });
 let activeTabId=3;
 const urls={3:'https://example.com/',7:'https://chatgpt.com/c/native',8:'https://chatgpt.com/c/native-two'};
 f.chrome.tabs.get=async id=>({id,url:urls[id],active:id===activeTabId,windowId:9});
 f.chrome.tabs.query=async()=>[{id:activeTabId,windowId:9}];
 f.chrome.tabs.update=async id=>{activeTabId=id;return {id,url:urls[id],active:true,windowId:9};};
 const sender2={id:'ext',frameId:0,tab:{id:8}};
 const message2={kind:'submit',requestId:'op2',taskId:'t2'};

 assert.deepEqual(await activateOwnedSendTab(f.chrome,f.repo,f.message,f.sender),{previousTabId:3});
 assert.equal(activeTabId,7);
 let state=await f.repo.load();
 assert.equal(state.sessionsById.s.operation.previousSendTabId,3);
 assert.equal(state.sessionsById.s.operation.previousSendWindowId,9);

 // A service-worker restart has a new repository queue but the focus lease is
 // durable. Session B cannot interpret A's active worker tab as the owner tab.
 const restartedRepo=new StorageRepository(f.chrome);
 await assert.rejects(
  activateOwnedSendTab(f.chrome,restartedRepo,message2,sender2),
  /SEND_TAB_WINDOW_BUSY/
 );
 assert.equal(activeTabId,7);

 await restorePendingSendTabs(f.chrome,restartedRepo,{sessionId:'s'});
 assert.equal(activeTabId,3);
 state=await restartedRepo.load();
 assert.equal(state.sessionsById.s.operation.previousSendTabId,0);
 assert.equal(state.sessionsById.s.operation.previousSendWindowId,0);

 assert.deepEqual(await activateOwnedSendTab(f.chrome,restartedRepo,message2,sender2),{previousTabId:3});
 assert.equal(activeTabId,8);
 await restoreOwnedSendTab(f.chrome,restartedRepo,{...message2,previousTabId:3},sender2);
 assert.equal(activeTabId,3);
});

test('native insertion replaces the focused composer and uses durable prompt text',async()=>{
 const f=setup('insert');
 f.message.promptText='injected different prompt';
 await f.run();
 const commands=f.calls.filter(c=>typeof c!=='string');
 assert.deepEqual(commands.map(c=>c.method),['Input.dispatchKeyEvent','Input.dispatchKeyEvent','Input.insertText']);
 assert.equal(commands[0].args.type,'rawKeyDown');
 assert.equal(commands[0].args.key,'a');
 assert.equal(commands[0].args.modifiers,2);
 assert.equal(commands[1].args.type,'keyUp');
 assert.equal(commands[2].args.text,'canonical prompt');
});
test('wrong sender, frame, phase, tab and target URL produce no native input',async()=>{
 const mutations=[f=>f.sender.id='other',f=>f.sender.frameId=2,f=>f.sender.tab.id=999,f=>f.message.kind='insert',f=>f.chrome.tabs.get=async()=>({url:'https://chatgpt.com/c/wrong'})];
 for(const mutate of mutations){const f=setup();mutate(f);await assert.rejects(f.run());assert.equal(f.calls.length,0);}
});
test('changed or covered DOM target detaches without input',async()=>{
 const f=setup();f.chrome.scripting.executeScript=async()=>[{result:false}];await assert.rejects(f.run(),/NATIVE_INPUT_TARGET_CHANGED/);assert.deepEqual(f.calls,['attach','detach']);
});
test('pause during attach prevents effects',async()=>{
 const f=setup();f.chrome.debugger.attach=async()=>{f.calls.push('attach');await f.repo.update(s=>{s.sessionsById.s.runState='PAUSED';return s;});};await assert.rejects(f.run(),/NATIVE_INPUT_SESSION_PAUSED/);assert.deepEqual(f.calls,['attach','detach']);
});
test('native failure after press never retries and still detaches',async()=>{
 const f=setup();f.chrome.debugger.sendCommand=async()=>{f.calls.push('press attempted');throw Error('transport lost');};await assert.rejects(f.run());await assert.rejects(f.run(),/NATIVE_SUBMIT_ALREADY_DISPATCHED/);assert.deepEqual(f.calls,['attach','press attempted','detach']);
});
test('debugger already occupied is not detached or bypassed',async()=>{
 const f=setup();f.chrome.debugger.attach=async()=>{throw Error('already attached');};await assert.rejects(f.run(),/NATIVE_INPUT_ATTACH_FAILED/);assert.equal(f.calls.length,0);
});

test('coordinates are recomputed after debugger attach instead of using stale content coordinates',async()=>{
 const f=setup();f.message.x=999;f.message.y=999;await f.run();
 assert.equal(f.calls[1].args.x,20);assert.equal(f.calls[1].args.y,30);
});

test('native insertion forwards a 50000-character prompt without truncation',async()=>{
 const f=setup('insert');
 const huge='x'.repeat(50000);
 await f.repo.update(state=>{state.sessionsById.s.operation.promptText=huge;return state;});
 await f.run();
 const insert=f.calls.find(c=>typeof c!=='string'&&c.method==='Input.insertText');
 assert.ok(insert);
 assert.equal(insert.args.text.length,50000);
 assert.equal(insert.args.text,huge);
});
