import test from 'node:test';
import assert from 'node:assert/strict';
import { performNativeInput } from '../../src/core/native-input.js';
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
