'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../src/interaction/chatgpt-adapter.js'), 'utf8');
const prompt = 'Особистий промпт\nДругий рядок';
function fixture({ackAt=0, formSubmit=false, nested=false, noOp=false, stale=false, startUrl='https://chatgpt.com/c/test', expectedUrl=startUrl, redirectAfterSend='', deliveredTextOverride='', suppressMessage=false}={}) {
  let clock=1000, clicks=0, submits=0, nativeSubmits=0, sentAt=null, acknowledged=false, model='', sentText='';
  const messages=[];
  class Clock extends Date { static now() { return clock; } }
  class Event { constructor(type, init) { this.type=type;Object.assign(this,init); } }
  const visible = {isConnected:true, getBoundingClientRect:()=>({width:200,height:40})};
  const form = {getAttribute:()=>null, querySelectorAll: s=>s==='button, [role="button"]'?[send]:[]};
  const composer = {...visible,tagName:'TEXTAREA',value:prompt,closest:()=>form,focus(){},getAttribute:n=>n==='aria-label'?'Message':null,dispatchEvent(e){if(e.type==='input') model=this.value;}};
  const leaf=(text)=>({...visible,innerText:text,getAttribute:n=>n==='data-message-author-role'?'user':null,querySelectorAll:()=>[]});
  if(stale)messages.push(leaf(prompt));
  function attempt(){ sentAt=clock; sentText=composer.value; if(redirectAfterSend) sandbox.location.href=redirectAfterSend; }
  const send={...visible,tagName:'BUTTON',type:formSubmit?'submit':'button',form,
    getAttribute:n=>n==='data-testid'?'send-button':null,click(){clicks++;if(!noOp)attempt();}};
  const stop={...visible,tagName:'BUTTON',type:'button',getAttribute:n=>n==='aria-label'&&sentAt!==null?'Stop generating':null};
  class Form { requestSubmit(button){assert.equal(this,form);assert.equal(button,send);submits++;attempt();} }
  const document={visibilityState:'hidden',defaultView:{HTMLFormElement:Form,Event,InputEvent:Event},
    querySelectorAll(s){
      if(s==='textarea, [contenteditable="true"], [role="textbox"], input[type="text"]')return [composer];
      if(s==='button, [role="button"]')return sentAt!==null?[send,stop]:[send];
      if(s==='[data-message-author-role="user"], [data-author="user"], article')return messages;
      return [];
    }};
  composer.ownerDocument=document;
  const sandbox={URL,Date:Clock,Event,InputEvent:Event,setTimeout,clearTimeout,location:{href:startUrl},getComputedStyle:()=>({display:'block',visibility:'visible'})};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
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
  async function wait(ms){clock+=ms;if(sentAt!==null && clock-sentAt>=ackAt)acknowledge();}
  function run(mode='SUBMIT_EXISTING', overrides={}, deps={}){return sandbox.ChatGPTInteractionAdapter.execute({mode,requestId:'op1',taskId:'t1',expectedUrl,promptText:prompt,...overrides},{document,wait,...deps});}
  return {run,wait,acknowledge,composer,messages,sandbox,clicks:()=>clicks,submits:()=>submits,nativeSubmits:()=>nativeSubmits,model:()=>model};
}

test('new-chat launch URL may transition from root to the created conversation after Send',async()=>{
  const f=fixture({startUrl:'https://chatgpt.com/',redirectAfterSend:'https://chatgpt.com/c/generated-123'});
  const r=await f.run();
  assert.equal(r.status,'SENT_VERIFIED');
  assert.equal(r.safeDiagnosticCode,'SEND_VERIFIED_OPERATION_LOCAL_APPEND');
  assert.equal(f.clicks(),1);
});


test('fresh launch verifies accepted Send from concrete conversation plus active generation before user history renders',async()=>{
  const f=fixture({
    startUrl:'https://chatgpt.com/',
    redirectAfterSend:'https://chatgpt.com/c/generated-stop-proof',
    suppressMessage:true
  });
  const r=await f.run();
  assert.equal(r.status,'SENT_VERIFIED');
  assert.equal(r.safeDiagnosticCode,'SEND_VERIFIED_FRESH_GENERATION_STARTED');
  assert.equal(r.submissionEvidence,'FRESH_CONVERSATION_GENERATION_STARTED');
  assert.equal(f.messages.length,0,'semantic user-message history may legitimately lag generation');
  assert.equal(f.clicks(),1);
});

test('fresh launch accepts operation-bound structural append when ChatGPT re-renders user text',async()=>{
  const f=fixture({
    startUrl:'https://chatgpt.com/',
    redirectAfterSend:'https://chatgpt.com/c/generated-structural',
    deliveredTextOverride:'Ви сказали: [rendered wrapper changed by UI]'
  });
  const r=await f.run();
  assert.equal(r.status,'SENT_VERIFIED');
  assert.equal(r.safeDiagnosticCode,'SEND_VERIFIED_FRESH_STRUCTURAL_APPEND');
  assert.equal(f.clicks(),1);
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
