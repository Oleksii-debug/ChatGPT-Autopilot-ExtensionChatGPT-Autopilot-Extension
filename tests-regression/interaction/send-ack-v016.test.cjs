'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../src/interaction/chatgpt-adapter.js'), 'utf8');
const prompt = 'Особистий промпт\nДругий рядок';
function fixture({ackAt=0, formSubmit=false, nested=false, noOp=false, stale=false, startUrl='https://chatgpt.com/c/test', expectedUrl=startUrl, redirectAfterSend='', deliveredTextOverride='', suppressMessage=false, messageShape='author-role', ackOnlyWhenVisible=false, adapterSource=source}={}) {
  let clock=1000, clicks=0, submits=0, nativeSubmits=0, sentAt=null, acknowledged=false, model='', sentText='';
  const messages=[];
  class Clock extends Date { static now() { return clock; } }
  class Event { constructor(type, init) { this.type=type;Object.assign(this,init); } }
  const visible = {isConnected:true, getBoundingClientRect:()=>({left:0,top:0,width:200,height:40})};
  const form = {getAttribute:()=>null, querySelectorAll: s=>s==='button, [role="button"]'?[send]:[]};
  const composer = {...visible,tagName:'TEXTAREA',value:prompt,closest:()=>form,focus(){},getAttribute:n=>n==='aria-label'?'Message':null,dispatchEvent(e){if(e.type==='input') model=this.value;}};
  const leaf=(text)=>({...visible,innerText:text,children:[],closest:()=>null,getAttribute:n=>messageShape==='unlabeled'?null:n===(messageShape==='testid'?'data-testid':'data-message-author-role')?(messageShape==='testid'?'user-message':'user'):null,querySelectorAll:()=>[]});
  if(stale)messages.push(leaf(prompt));
  function attempt(){ sentAt=clock; sentText=composer.value; if(redirectAfterSend) sandbox.location.href=redirectAfterSend; }
  let send={...visible,tagName:'BUTTON',type:formSubmit?'submit':'button',form,scrollIntoView(){},contains(){return false;},
    setAttribute(name,value){if(name==='data-autopilot-native-target')this.marked=value;},removeAttribute(){this.marked=undefined;},
    getAttribute:n=>n==='data-testid'?'send-button':null,click(){clicks++;if(!noOp)attempt();}};
  const stop={...visible,tagName:'BUTTON',type:'button',getAttribute:n=>n==='aria-label'&&sentAt!==null?'Stop generating':null};
  class Form { requestSubmit(button){assert.equal(this,form);assert.equal(button,send);submits++;attempt();} }
  const document={visibilityState:'hidden',defaultView:{HTMLFormElement:Form,Event,InputEvent:Event},
    elementFromPoint:()=>send,
    querySelector:s=>s==='main, [role="main"]'?{querySelectorAll:()=>messageShape==='unlabeled'?messages:[]}:null,
    querySelectorAll(s){
      if(s==='textarea, [contenteditable="true"], [role="textbox"], input[type="text"]')return [composer];
      if(s==='button, [role="button"]')return sentAt!==null?[send,stop]:[send];
      if(s==='[data-message-author-role="user"], [data-author="user"], article')return messageShape==='testid'?[]:messages;
      if(s==='[data-testid="user-message"]')return messageShape==='testid'?messages:[];
      return [];
    }};
  composer.ownerDocument=document;
  const sandbox={URL,Date:Clock,Event,InputEvent:Event,setTimeout,clearTimeout,location:{href:startUrl},getComputedStyle:()=>({display:'block',visibility:'visible'})};
  vm.createContext(sandbox);vm.runInContext(adapterSource,sandbox);
  function acknowledge(){
    if(acknowledged)return;acknowledged=true;
    const deliveredText=deliveredTextOverride || sentText || prompt;
    const message=leaf(deliveredText);
    if(!suppressMessage){
      if(nested){
        const body={innerText:deliveredText};
        message.innerText='Ви сказали: '+deliveredText+' Копіювати';
        message.querySelectorAll=s=>s==='.whitespace-pre-wrap, [data-message-content]'?[body]:[];
        messages.push({...visible,innerText:message.innerText,getAttribute:n=>n==='aria-label'?'You said':null,contains:n=>n===message,querySelectorAll:()=>[]});
      }
      messages.push(message);
    }
    composer.value='';
  }
  async function wait(ms){clock+=ms;if(sentAt!==null && clock-sentAt>=ackAt && (!ackOnlyWhenVisible || document.visibilityState==='visible'))acknowledge();}
  function run(mode='SUBMIT_EXISTING', overrides={}, deps={}){return sandbox.ChatGPTInteractionAdapter.execute({mode,requestId:'op1',taskId:'t1',expectedUrl,promptText:prompt,...overrides},{document,wait,...deps});}
  function reloadAdapter(){ vm.runInContext(adapterSource,sandbox); }
  function replaceSend(){ const old=send;send={...old,isConnected:true};old.isConnected=false;return old; }
  return {run,wait,acknowledge,reloadAdapter,composer,messages,document,sandbox,replaceSend,send:()=>send,
    nativeSubmit(){nativeSubmits++;attempt();},clicks:()=>clicks,submits:()=>submits,nativeSubmits:()=>nativeSubmits,model:()=>model};
}

test('the production submit callback must not turn a working Pilot 10 form into a debugger-dependent Send',async()=>{
  const pre10=fs.readFileSync(path.join(__dirname,'../fixtures/chatgpt/pilot10-adapter.js'),'utf8');
  let nativeCalls=0;
  const unavailableNative=async()=>{nativeCalls++;const error=new Error('debugger unavailable');error.safeDiagnosticCode='NATIVE_INPUT_ATTACH_FAILED';throw error;};
  const old=fixture({formSubmit:true,adapterSource:pre10});
  assert.equal((await old.run('SUBMIT_EXISTING',{}, {submit:unavailableNative})).status,'SENT_VERIFIED');
  assert.equal(old.submits(),1);
  const current=fixture({formSubmit:true,startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/pilot10-parity'});
  const result=await current.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true},{submit:unavailableNative,
    activate:async()=>{current.document.visibilityState='visible';return true;}});
  assert.equal(result.status,'SENT_VERIFIED');
  assert.equal(current.submits(),1);
  assert.equal(nativeCalls,0);
});

test('the real content-script bridge checkpoints one form Send through Core with debugger unavailable', async()=>{
  const {checkpointDomSubmit,activateOwnedSendTab,restoreOwnedSendTab}=await import('../../src/core/native-input.js');
  const {createEmptyState,createSession,createTask}=await import('../../src/core/schema.js');
  const {StorageRepository}=await import('../../src/core/storage.js');
  const f=fixture({formSubmit:true,startUrl:'https://chatgpt.com/c/native'});
  const task=createTask({id:'t',url:'https://chatgpt.com/c/native'});
  const session=createSession({id:'s',name:'Real bridge',tasks:[task],sharedPrompt:prompt,now:1});
  session.runState='RUNNING';session.tabWindowId=9;
  session.operation={operationId:'op',sessionId:'s',taskId:'t',targetUrl:task.url,promptText:prompt,promptFingerprint:'fp',
    phase:'SUBMITTING',createdAt:1,updatedAt:1,preSendDeadline:0,submitStartedAt:1,verificationDeadline:0};
  const state=createEmptyState(1);state.sessionsById.s=session;state.sessionOrder=['s'];
  state.tabHintsByTaskId.t={tabId:7,sessionId:'s',normalizedUrl:task.url,kind:'TASK',ownedByExtension:true};
  let stored=state,activeId=3,listener;const messages=[];
  const sender={id:'ext',frameId:0,tab:{id:7,windowId:9}};
  const chrome={runtime:{id:'ext'},storage:{local:{async get(){return {autopilotState:structuredClone(stored)};},
    async set(record){stored=structuredClone(record.autopilotState);}}},tabs:{
    async get(id){return {id,windowId:9,active:id===activeId,url:id===7?task.url:'https://example.com/'};},
    async query(){return [{id:activeId,windowId:9}];},
    async update(id){activeId=id;f.document.visibilityState=id===7?'visible':'hidden';return this.get(id);},
  }};
  const repo=new StorageRepository(chrome);
  const formPrototype=f.document.defaultView.HTMLFormElement.prototype;
  const physicalSubmit=formPrototype.requestSubmit;
  formPrototype.requestSubmit=function(button){
    assert.equal(stored.sessionsById.s.operation.domSubmitDispatched,true,'Core persists the boundary before physical submit');
    return physicalSubmit.call(this,button);
  };
  const runtime={onMessage:{addListener(fn){listener=fn;}},async sendMessage(message){
    messages.push(message.channel);
    if(message.channel==='autopilot-native-input')throw Error('Chrome debugger is unavailable');
    if(message.channel==='autopilot-send-tab-activation') {
      if(message.action==='activate')return {ok:true,data:await activateOwnedSendTab(chrome,repo,message,sender)};
      await restoreOwnedSendTab(chrome,repo,message,sender);return {ok:true};
    }
    assert.equal(message.channel,'autopilot-dom-submit-checkpoint');
    await checkpointDomSubmit(chrome,repo,message,sender);return {ok:true};
  }};
  f.sandbox.chrome={runtime};f.sandbox.document=f.document;
  f.sandbox.setTimeout=(fn,ms)=>{Promise.resolve().then(()=>f.wait(ms)).then(fn);return 1;};
  const bridgeSource=fs.readFileSync(path.join(__dirname,'../../src/interaction/content-script.js'),'utf8');
  vm.runInContext(bridgeSource,f.sandbox);
  const request={mode:'SUBMIT_EXISTING',requestId:'op',taskId:'t',expectedUrl:task.url,promptText:prompt,
    expectedWindowId:9,requireGenerationAcknowledgement:true};
  const invoke=()=>new Promise(resolve=>listener({channel:'autopilot-interaction',request},{},resolve));
  const result=await invoke();
  assert.equal(result.ok,true);assert.equal(result.data.status,'SENT_VERIFIED');
  assert.equal(f.submits(),1);assert.equal(activeId,3);
  assert.equal(messages.filter(m=>m==='autopilot-dom-submit-checkpoint').length,1);
  assert.equal(messages.includes('autopilot-native-input'),false);
  const repeated=await invoke();
  assert.ok(['SENT_VERIFIED','SUBMISSION_UNCERTAIN'].includes(repeated.data.status));
  assert.equal(f.submits(),1,'duplicate delivery must remain observation-only');
  assert.equal(messages.filter(m=>m==='autopilot-dom-submit-checkpoint').length,1);
});

test('new-chat launch URL may transition from root to the created conversation after Send',async()=>{
  const f=fixture({startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/generated-123'});
  const r=await f.run();
  assert.equal(r.status,'SENT_VERIFIED');
  assert.equal(r.safeDiagnosticCode,'SEND_VERIFIED_OPERATION_LOCAL_APPEND');
  assert.equal(f.clicks(),1);
});

test('acknowledgement stops bounded DOM work even when wakeups do not advance the clock', async () => {
  const f = fixture({ noOp: true });
  let wakeups = 0;
  const result = await f.run('SUBMIT_EXISTING', {}, { wait: async () => { wakeups++; } });
  assert.equal(result.status, 'SUBMISSION_UNCERTAIN');
  assert.equal(f.clicks(), 1);
  assert.equal(wakeups, 200);
});


test('fresh unique conversation transition with empty composer and generation proves the one local submit',async()=>{
  const f=fixture({
    startUrl:'https://chatgpt.com/',
    redirectAfterSend:'https://chatgpt.com/c/generated-stop-proof',
    suppressMessage:true
  });
  const r=await f.run();
  assert.equal(r.status,'SENT_VERIFIED');
  assert.equal(r.safeDiagnosticCode,'SEND_VERIFIED_FRESH_CONVERSATION_GENERATION');
  assert.equal(f.messages.length,0,'this fresh transition does not require materialized hidden user bubbles');
  assert.equal(f.clicks(),1);
});

test('fresh launch with a non-matching rendered user turn remains uncertain',async()=>{
  const f=fixture({
    startUrl:'https://chatgpt.com/',
    redirectAfterSend:'https://chatgpt.com/c/generated-structural',
    deliveredTextOverride:'Ви сказали: [rendered wrapper changed by UI]'
  });
  const r=await f.run();
  assert.equal(r.status,'SUBMISSION_UNCERTAIN');
  assert.equal(r.safeDiagnosticCode,'SEND_CLICK_UNCERTAIN');
  assert.equal(f.clicks(),1);
});

test('same-document recovery cannot promote fresh launch without exact prompt evidence',async()=>{
  const f=fixture({
    startUrl:'https://chatgpt.com/',
    redirectAfterSend:'https://chatgpt.com/c/generated-unrelated-shape',
    deliveredTextOverride:'Інший текст, що не ідентифікує цей ефект'
  });
  assert.equal((await f.run()).status,'SUBMISSION_UNCERTAIN');
  const recovered=await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT');
  assert.equal(recovered.status,'SUBMISSION_UNCERTAIN');
  assert.notEqual(recovered.safeDiagnosticCode,'RECOVERY_TEXT_OPERATION_VERIFIED');
  assert.notEqual(recovered.safeDiagnosticCode,'RECOVERY_MAIN_PROMPT_VERIFIED');
  assert.equal(f.clicks(),1,'recovery remains verification-only');
});

test('late acknowledgement on a newly created conversation can be verified without resending',async()=>{
  const f=fixture({ackAt:25000,startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/generated-late'});
  assert.equal((await f.run()).status,'SUBMISSION_UNCERTAIN');
  f.acknowledge();
  const r=await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT');
  assert.equal(r.status,'SENT_VERIFIED');
  assert.equal(r.safeDiagnosticCode,'RECOVERY_TEXT_OPERATION_VERIFIED');
  assert.equal(f.clicks(),1);
});
test('acknowledgement after 7 seconds verifies with exactly one click',async()=>{
  const f=fixture({ackAt:7000});const r=await f.run();assert.equal(r.status,'SENT_VERIFIED');assert.equal(f.clicks(),1);
});

test('testid-only user turn confirms one Send and recovery never clicks a second time',async()=>{
  const f=fixture({messageShape:'testid',ackAt:25000});
  assert.equal((await f.run()).status,'SUBMISSION_UNCERTAIN');
  assert.equal(f.clicks(),1);
  f.acknowledge();
  const recovered=await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT');
  assert.equal(recovered.status,'SENT_VERIFIED');
  assert.equal(f.clicks(),1);
});

test('testid-only stale equal turn cannot confirm a no-op Send',async()=>{
  const f=fixture({messageShape:'testid',stale:true,noOp:true});
  assert.equal((await f.run()).status,'SUBMISSION_UNCERTAIN');
  assert.equal((await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT')).status,'SUBMISSION_UNCERTAIN');
  assert.equal(f.clicks(),1);
});
test('unlabeled main user turn verifies the changed account UI with one Send',async()=>{
  const f=fixture({messageShape:'unlabeled',startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/new-account'});
  const r=await f.run();
  assert.equal(r.status,'SENT_VERIFIED');
  assert.equal(r.safeDiagnosticCode,'SEND_VERIFIED_MAIN_PROMPT_APPEND');
  assert.equal(f.clicks(),1);
});
test('hidden form submission wakes a deferred changed UI once and observes its exact turn',async()=>{
  const f=fixture({messageShape:'unlabeled',formSubmit:true,ackOnlyWhenVisible:true,
    startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/deferred-render'});
  let activations=0;
  const r=await f.run('SUBMIT_EXISTING',{}, {activate:async()=>{
    activations++;
    f.document.visibilityState='visible';
    return true;
  }});
  assert.equal(r.status,'SENT_VERIFIED');
  assert.equal(r.submissionEvidence,'OPERATION_LOCAL_MAIN_PROMPT_APPEND');
  assert.equal(f.submits(),1);
  assert.equal(f.clicks(),0);
  assert.equal(activations,1);
});

test('managed hidden form is activated before physical Send and requires its appended turn', async()=>{
  const f=fixture({formSubmit:true,startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/managed'});
  let activated=0;
  const result=await f.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true},{activate:async()=>{
    activated++;f.document.visibilityState='visible';return true;
  }});
  assert.equal(result.status,'SENT_VERIFIED');
  assert.equal(activated,1);
  assert.equal(f.submits(),1);
  assert.equal(f.clicks(),0);
});

test('managed hidden form cannot send when activation fails', async()=>{
  const f=fixture({formSubmit:true,startUrl:'https://chatgpt.com/'});
  const result=await f.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true},{activate:async()=>false});
  assert.equal(result.safeDiagnosticCode,'SEND_TAB_NOT_VISIBLE_BEFORE_EFFECT');
  assert.equal(result.submissionEvidence,'PROVEN_NO_EFFECT');
  assert.equal(f.submits(),0);
  assert.equal(f.clicks(),0);
});

test('a proven no-effect activation failure leaves the same request eligible for its first Send', async()=>{
  const f=fixture({formSubmit:true,startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/retry-no-effect'});
  const failed=await f.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true},{activate:async()=>false});
  assert.equal(failed.submissionEvidence,'PROVEN_NO_EFFECT');
  const result=await f.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true},{activate:async()=>{
    f.document.visibilityState='visible';return true;
  },submit:async()=>f.nativeSubmit()});
  assert.equal(result.status,'SENT_VERIFIED');
  assert.equal(f.nativeSubmits(),0);
  assert.equal(f.submits(),1);
  assert.equal(f.clicks(),0);
});

test('scenario form Send uses the current button and history after activation rerenders the document', async()=>{
  const f=fixture({formSubmit:true,startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/native-rerender'});
  let stale;
  const result=await f.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true},{activate:async()=>{
    f.document.visibilityState='visible';stale=f.replaceSend();
    return true;
  },checkpointSubmit:async()=>{
    assert.equal(stale.isConnected,false);
    assert.equal(f.send().isConnected,true);
  }});
  assert.equal(result.status,'SENT_VERIFIED');
  assert.equal(f.nativeSubmits(),0);
  assert.equal(f.submits(),1);
});

test('a rejected DOM checkpoint is retryable without replaying an actual Send', async()=>{
  const f=fixture({formSubmit:true,startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/native-no-effect'});
  f.document.visibilityState='visible';
  const failed=await f.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true},{checkpointSubmit:async()=>{
    const error=new Error('focus lost before dispatch');error.safeDiagnosticCode='SEND_TAB_NOT_VISIBLE_BEFORE_EFFECT';throw error;
  }});
  assert.equal(failed.submissionEvidence,'PROVEN_NO_EFFECT');
  assert.equal(f.nativeSubmits(),0);
  const result=await f.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true},{checkpointSubmit:async()=>{}});
  assert.equal(result.status,'SENT_VERIFIED');
  assert.equal(f.nativeSubmits(),0);
  assert.equal(f.submits(),1);
});
test('waking the same hidden tab preserves fresh-conversation acknowledgement without another submit',async()=>{
  const f=fixture({messageShape:'unlabeled',formSubmit:true,suppressMessage:true,
    startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/no-turn'});
  let activations=0;
  const r=await f.run('SUBMIT_EXISTING',{}, {activate:async()=>{
    activations++;
    f.document.visibilityState='visible';
    return true;
  }});
  assert.equal(r.status,'SENT_VERIFIED');
  assert.equal(f.submits(),1);
  assert.equal(f.clicks(),0);
  assert.equal(activations,0,'already observed acknowledgement does not need a focus change');
});
test('unlabeled main user turn recovers after navigation without resending',async()=>{
  const f=fixture({messageShape:'unlabeled',ackAt:25000,startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/new-account'});
  assert.equal((await f.run()).status,'SUBMISSION_UNCERTAIN');
  f.acknowledge();
  const r=await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT',{recoveryLaunchUrl:'https://chatgpt.com/'});
  assert.equal(r.status,'SENT_VERIFIED');
  assert.equal(f.clicks(),1);
});
test('fresh-launch restart cannot verify an unrelated conversation from historical prompt text',async()=>{
  const f=fixture({messageShape:'unlabeled',noOp:true,startUrl:'https://chatgpt.com/'});
  assert.equal((await f.run()).status,'SUBMISSION_UNCERTAIN');
  assert.equal(f.clicks(),1);
  f.sandbox.location.href='https://chatgpt.com/c/unrelated';
  f.acknowledge();
  f.reloadAdapter();
  const r=await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT',{
    expectedUrl:'https://chatgpt.com/',
    recoveryLaunchUrl:'https://chatgpt.com/'
  });
  assert.equal(r.status,'SUBMISSION_UNCERTAIN');
  assert.notEqual(r.safeDiagnosticCode,'RECOVERY_FRESH_MAIN_PROMPT_VERIFIED');
  assert.notEqual(r.safeDiagnosticCode,'RECOVERY_FRESH_LAUNCH_DURABLE_VERIFIED');
  assert.equal(f.clicks(),1);
});
test('an old identical unlabeled turn cannot verify another Send',async()=>{
  const f=fixture({messageShape:'unlabeled',stale:true,noOp:true});
  assert.equal((await f.run()).status,'SUBMISSION_UNCERTAIN');
  assert.equal((await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT')).status,'SUBMISSION_UNCERTAIN');
  assert.equal(f.clicks(),1);
});
test('late acknowledgement survives a recovery call with retained text baseline',async()=>{
  const f=fixture({ackAt:25000});assert.equal((await f.run()).status,'SUBMISSION_UNCERTAIN');
  f.acknowledge();const r=await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT');assert.equal(r.status,'SENT_VERIFIED');assert.equal(r.safeDiagnosticCode,'RECOVERY_TEXT_OPERATION_VERIFIED');assert.equal(f.clicks(),1);
});
test('nested article plus user-role body counts once and excludes UI labels',async()=>{
  const f=fixture({nested:true});assert.equal((await f.run()).status,'SENT_VERIFIED');assert.equal(f.clicks(),1);
});
test('genuine form submitter invokes native submit once and never also clicks',async()=>{
  const f=fixture({formSubmit:true,noOp:true});assert.equal((await f.run()).status,'SENT_VERIFIED');assert.equal(f.submits(),1);assert.equal(f.clicks(),0);
});
test('no-op click retains draft and reports uncertainty without a second send',async()=>{
  const f=fixture({noOp:true});const r=await f.run();assert.equal(r.status,'SUBMISSION_UNCERTAIN');assert.match(r.safeDiagnosticMessage,/pendingMatch=yes/);
  assert.ok(!r.safeDiagnosticMessage.includes(prompt));assert.equal((await f.run()).status,'SUBMISSION_UNCERTAIN');assert.equal(f.clicks(),1);
});
test('unchanged draft plus lost baseline cannot authorize automatic duplicate',async()=>{
  const f=fixture({stale:true});const r=await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT');assert.equal(r.status,'SUBMISSION_UNCERTAIN');assert.equal(r.safeDiagnosticCode,'RECOVERY_BASELINE_MISSING');assert.equal(f.clicks(),0);
});
test('old identical historical message cannot satisfy current no-op send',async()=>{
  const f=fixture({stale:true,noOp:true});await f.run();f.composer.value='';assert.equal((await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT')).status,'SUBMISSION_UNCERTAIN');
});
test('matching existing draft is accepted without reinsertion that could duplicate background text',async()=>{
  const f=fixture();assert.equal(f.model(),'');
  const r=await f.run('INSERT_ONLY');
  assert.equal(r.status,'INSERTED_NOT_SENT');assert.equal(r.safeDiagnosticCode,'PROMPT_ALREADY_INSERTED_MATCH');
  assert.equal(f.model(),'');assert.equal(f.composer.value,prompt);assert.equal(f.clicks(),0);
});

test('hidden tab bypasses Chrome native mouse submit and sends through DOM semantics',async()=>{
  const f=fixture();let nativeCalls=0;
  const r=await f.run('SUBMIT_EXISTING',{}, {submit:async()=>{nativeCalls++;}});
  assert.equal(r.status,'SENT_VERIFIED');assert.equal(nativeCalls,0);assert.equal(f.clicks(),1);
});

test('a rejected checkpoint restores selection and is reported as proven no DOM Send effect',async()=>{
  const f=fixture();let restores=0;
  const result=await f.run('SUBMIT_EXISTING',{}, {
    activate:async()=>{f.document.visibilityState='visible';return true;},
    checkpointSubmit:async()=>{
      const error=new Error('owner focus already restored');
      error.safeDiagnosticCode='SEND_TAB_NOT_VISIBLE_BEFORE_EFFECT';
      throw error;
    },
    restore:async()=>{restores++;f.document.visibilityState='hidden';return true;},
  });
  assert.equal(result.status,'TEMPORARY_ERROR');
  assert.equal(result.submissionEvidence,'PROVEN_NO_EFFECT');
  assert.equal(result.safeDiagnosticCode,'SEND_DOM_CHECKPOINT_REJECTED');
  assert.equal(restores,1);
  assert.equal(f.clicks(),0);
});

test('hidden non-submit control activates for DOM click and restores focus after acknowledgement completes',async()=>{
  const f=fixture();let activation=0,nativeCalls=0,restores=0;
  const order=[];
  const result=await f.run('SUBMIT_EXISTING',{}, {
    activate:async()=>{activation++;order.push('activate');f.document.visibilityState='visible';return true;},
    submit:async()=>{nativeCalls++;throw Error('Debugger must not be used');},
    checkpointSubmit:async()=>{order.push('checkpoint');},
    restore:async()=>{restores++;order.push('restore');f.document.visibilityState='hidden';return true;},
  });
  assert.equal(result.status,'SENT_VERIFIED');
  assert.equal(activation,1);
  assert.equal(nativeCalls,0);
  assert.equal(restores,1);
  assert.deepEqual(order,['activate','checkpoint','restore']);
  assert.equal(f.clicks(),1);
});

test('activation failure has zero Send effects and returns a technical error',async()=>{
  const f=fixture();let nativeCalls=0;
  const result=await f.run('SUBMIT_EXISTING',{}, {
    activate:async()=>false,
    submit:async()=>{nativeCalls++;},
  });
  assert.equal(result.status,'TEMPORARY_ERROR');
  assert.equal(result.safeDiagnosticCode,'SEND_TAB_NOT_VISIBLE_BEFORE_EFFECT');
  assert.equal(nativeCalls,0);
  assert.equal(f.clicks(),0);
});

test('repeated expected prompt is allowed to send and is not a stop condition',async()=>{
  const f=fixture();f.composer.value=prompt.repeat(3);
  const r=await f.run('SUBMIT_EXISTING');
  assert.equal(r.status,'SENT_VERIFIED');assert.equal(f.clicks(),1);
});
test('wrong conversation is blocked without sending',async()=>{
  const f=fixture();f.sandbox.location.href='https://chatgpt.com/c/wrong';assert.equal((await f.run()).safeDiagnosticCode,'URL_MISMATCH_PRE_SEND');assert.equal(f.clicks(),0);
});
test('repeated submit request after success returns proof without another send',async()=>{
  const f=fixture();assert.equal((await f.run()).status,'SENT_VERIFIED');assert.equal((await f.run()).status,'SENT_VERIFIED');assert.equal(f.clicks(),1);
});


test('Scenario optimistic user bubble without generation is not counted as Send, including recovery',async()=>{
  const f=fixture({startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/client-only'});
  const query=f.document.querySelectorAll.bind(f.document);
  f.document.querySelectorAll=s=>s==='button, [role="button"]'?query(s).slice(0,1):query(s);
  const result=await f.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true});
  assert.equal(result.status,'SUBMISSION_UNCERTAIN');assert.equal(f.clicks(),1);
  const recovered=await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT',{requireGenerationAcknowledgement:true});
  assert.notEqual(recovered.status,'SENT_VERIFIED');assert.equal(f.clicks(),1);
});

test('Scenario first Send requires its own appended turn and stable concrete URL with generation',async()=>{
  const f=fixture({startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/provisional'});
  const wait=f.wait;let canonicalized=false;
  const result=await f.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true},{wait:async ms=>{
    await wait(ms);if(!canonicalized && f.clicks()){canonicalized=true;f.sandbox.location.href='https://chatgpt.com/c/canonical';}
  }});
  assert.equal(result.status,'SENT_VERIFIED');assert.equal(result.normalizedObservedUrl,'https://chatgpt.com/c/canonical');assert.equal(f.clicks(),1);
});

test('Scenario URL-only generation fallback cannot count an absent submitted message',async()=>{
  const f=fixture({startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/client-only',suppressMessage:true});
  const result=await f.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:true});
  assert.equal(result.status,'SUBMISSION_UNCERTAIN');
  const recovered=await f.run('VERIFY_AFTER_UNCERTAIN_SUBMIT',{requireGenerationAcknowledgement:true,recoveryLaunchUrl:'https://chatgpt.com/'});
  assert.notEqual(recovered.status,'SENT_VERIFIED');assert.equal(f.clicks(),1);
});


test('configured post-Send dwell keeps the activated tab through verification, then restores it once', async () => {
  const f=fixture(); let clickedAt=0, restoredAt=0, restores=0;
  const result=await f.run('SUBMIT_EXISTING',{postSendDelayMs:7000},{
    activate:async()=>{f.document.visibilityState='visible';return true;},
    submit:async()=>{clickedAt=f.sandbox.Date.now();f.acknowledge();},
    restore:async()=>{restores++;restoredAt=f.sandbox.Date.now();f.document.visibilityState='hidden';},
  });
  assert.equal(result.status,'SENT_VERIFIED');
  assert.ok(restoredAt-clickedAt>=7000); assert.equal(restores,1);
});
