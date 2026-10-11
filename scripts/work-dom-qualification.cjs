'use strict';
// Offline Chromium qualification. Fixtures retain the owner's Work DOM structure;
// account data, prompts, IDs, scripts and remote assets are removed. No service
// requests or signed-in browser are used. App acknowledgements are modeled.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.AUTOPILOT_PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(process.env.AUTOPILOT_ADAPTER_SOURCE || path.join(ROOT, 'src/interaction/chatgpt-adapter.js'), 'utf8');
const results = [];

async function main() {
  const browser = await chromium.launch({headless:true,
    ...(process.env.CHROMIUM_BIN ? {executablePath:process.env.CHROMIUM_BIN} : {}),
    args:['--no-sandbox', '--disable-dev-shm-usage']});
  async function fixture(name='pending', hidden=false) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const html = fs.readFileSync(path.join(ROOT, 'tests-regression/fixtures/chatgpt/work-2026-10-02', name+'.html'), 'utf8');
    await page.route('**/*', route => route.request().resourceType()==='document'
      ? route.fulfill({contentType:'text/html',body:html}) : route.abort());
    await page.goto('https://chatgpt.com/c/fixture');
    await page.addStyleTag({content:'[contenteditable]{min-height:40px;min-width:200px} button{min-width:25px;min-height:25px}'});
    await page.evaluate(hidden => {
      Object.defineProperty(document,'visibilityState',{configurable:true,value:hidden?'hidden':'visible'});
      const t=window.fixtureState={clock:1000,sends:0,activations:0,checkpoints:0,ack:true,keepSend:false};
      Date.now=()=>t.clock;
      const prompt='Fixture prompt [APSTEP:fixture:1]';
      t.accept=()=>{
        const main=document.querySelector('main');
        let thread=main.querySelector('[data-thread-user-message-navigation-content]');
        if(!thread){thread=document.createElement('div');thread.setAttribute('data-thread-user-message-navigation-content','true');main.prepend(thread);}
        const turn=document.createElement('div');turn.setAttribute('data-turn-key','submitted-fixture');
        const user=document.createElement('div');user.setAttribute('data-user-message-bubble','true');user.textContent=t.sentText||prompt;
        turn.append(user);thread.append(turn);
        const busy=document.createElement('span');busy.setAttribute('role','status');busy.setAttribute('aria-busy','true');busy.textContent='ChatGPT відповідає';turn.append(busy);
        document.querySelector('[contenteditable]').textContent='';
        if(!t.keepSend)document.querySelector('form button[type="submit"]')?.setAttribute('aria-label','Зупинити');
        t.accepted=true;
      };
      document.querySelector('form').addEventListener('submit',event=>{
        event.preventDefault();t.sends++;t.sentText=document.querySelector('[contenteditable]').innerText;
      });
      t.run=(mode='SUBMIT_EXISTING',overrides={})=>window.ChatGPTInteractionAdapter.execute({mode,
        requestId:'fixture-operation',taskId:'fixture-task',expectedUrl:location.href,promptText:prompt,
        requireGenerationAcknowledgement:true,...overrides},{document,
        wait:async ms=>{t.clock+=ms;if(t.sends&&t.ack&&!t.accepted)t.accept();},
        activate:async()=>{t.activations++;return false;},
        checkpointSubmit:async()=>{t.checkpoints++;},
      });
    },hidden);
    await page.addScriptTag({content:source});
    return {page,context};
  }
  async function check(name,fn){
    try{await fn();results.push({name,status:'PASS'});}
    catch(error){results.push({name,status:'FAIL',error:error.message});}
  }
  try {
    await check('HTML 1: empty Work composer is ready',async()=>{
      const f=await fixture('empty');try{assert.equal((await f.page.evaluate(()=>fixtureState.run('CHECK_ONLY'))).status,'READY');}finally{await f.context.close();}
    });
    await check('HTML 2: actual localized Send is recognized before submission',async()=>{
      const f=await fixture();try{assert.equal((await f.page.evaluate(()=>fixtureState.run('PREPARE_SEND'))).status,'READY');}finally{await f.context.close();}
    });
    for(const name of ['generating-empty','generating-draft'])await check('HTML '+name+': generation blocks another send',async()=>{
      const f=await fixture(name);try{
        for(const mode of ['CHECK_ONLY','INSERT_ONLY','PREPARE_SEND','SUBMIT_EXISTING']){
          assert.equal((await f.page.evaluate(mode=>fixtureState.run(mode),mode)).status,'BUSY',mode);
        }
        const state=await f.page.evaluate(()=>({sends:fixtureState.sends,checkpoints:fixtureState.checkpoints}));
        assert.deepEqual(state,{sends:0,checkpoints:0});
      }finally{await f.context.close();}
    });
    for(const scenario of [false,true])await check((scenario?'scenario':'ordinary')+': hidden window sends without foreground activation',async()=>{
      const f=await fixture('pending',true);try{
        const result=await f.page.evaluate(scenario=>fixtureState.run('SUBMIT_EXISTING',{requireGenerationAcknowledgement:scenario}),scenario);
        assert.equal(result.status,'SENT_VERIFIED');
        assert.deepEqual(await f.page.evaluate(()=>({sends:fixtureState.sends,activations:fixtureState.activations,checkpoints:fixtureState.checkpoints})),{sends:1,activations:0,checkpoints:1});
      }finally{await f.context.close();}
    });
    await check('configured dwell is honored even when activation cannot make the window visible',async()=>{
      const f=await fixture('pending',true);try{
        const result=await f.page.evaluate(()=>fixtureState.run('SUBMIT_EXISTING',{postSendDelayMs:6000}));
        assert.equal(result.status,'SENT_VERIFIED');
        const t=await f.page.evaluate(()=>({sends:fixtureState.sends,clock:fixtureState.clock}));
        assert.equal(t.sends,1);assert.ok(t.clock>=7000);
      }finally{await f.context.close();}
    });
    await check('generation status acknowledges Send even when the composer button stays Send',async()=>{
      const f=await fixture();try{
        await f.page.evaluate(()=>{fixtureState.keepSend=true;});
        assert.equal((await f.page.evaluate(()=>fixtureState.run())).status,'SENT_VERIFIED');
      }finally{await f.context.close();}
    });
    await check('reinjection preserves late acknowledgement evidence and never repeats Send',async()=>{
      const f=await fixture();try{
        await f.page.evaluate(()=>{fixtureState.ack=false;});
        assert.equal((await f.page.evaluate(()=>fixtureState.run())).status,'SUBMISSION_UNCERTAIN');
        await f.page.addScriptTag({content:source});
        await f.page.evaluate(()=>fixtureState.accept());
        assert.equal((await f.page.evaluate(()=>fixtureState.run('VERIFY_AFTER_UNCERTAIN_SUBMIT'))).status,'SENT_VERIFIED');
        await f.page.evaluate(()=>fixtureState.run());
        assert.equal(await f.page.evaluate(()=>fixtureState.sends),1);
      }finally{await f.context.close();}
    });
    await check('a genuine context reset does not invent evidence from old identical text',async()=>{
      const f=await fixture();try{
        await f.page.evaluate(()=>{fixtureState.accept();delete window.ChatGPTInteractionAdapter;});
        await f.page.addScriptTag({content:source});
        assert.equal((await f.page.evaluate(()=>fixtureState.run('VERIFY_AFTER_UNCERTAIN_SUBMIT'))).status,'SUBMISSION_UNCERTAIN');
      }finally{await f.context.close();}
    });
    await check('sidebar/profile busy indicators do not block an idle conversation',async()=>{
      const f=await fixture('empty');try{
        await f.page.evaluate(()=>{document.body.insertAdjacentHTML('afterbegin','<aside><span role="status" aria-busy="true">ChatGPT відповідає</span></aside><button aria-busy="true">Profile</button>');});
        assert.equal((await f.page.evaluate(()=>fixtureState.run('CHECK_ONLY'))).status,'READY');
      }finally{await f.context.close();}
    });
    await check('a hidden generation status does not block the conversation',async()=>{
      const f=await fixture('generating-draft');try{
        await f.page.evaluate(()=>{document.querySelector('[role="status"][aria-busy="true"]').hidden=true;});
        assert.equal((await f.page.evaluate(()=>fixtureState.run('CHECK_ONLY'))).status,'READY');
      }finally{await f.context.close();}
    });
    await check('assistant completion waits for busy status to end even with draft text and Send visible',async()=>{
      const f=await fixture('generating-draft');try{
        await f.page.evaluate(()=>{const reply=document.createElement('div');reply.setAttribute('data-markdown-text-style','assistant-message');reply.textContent='Completed fixture answer';document.querySelector('[data-thread-user-message-navigation-content]').append(reply);});
        const request={assistantBaselineKnown:true,assistantBaselineCount:0,responseCorrelationToken:'[APSTEP:fixture:1]',requireStableResponse:true};
        let r=await f.page.evaluate(request=>fixtureState.run('READ_ASSISTANT_REPORT',request),request);
        assert.equal(r.status,'BUSY');assert.equal(r.assistantComplete,false);
        await f.page.evaluate(()=>document.querySelector('[role="status"][aria-busy="true"]').remove());
        r=await f.page.evaluate(request=>fixtureState.run('READ_ASSISTANT_REPORT',request),request);
        assert.equal(r.assistantComplete,false);
        await f.page.evaluate(()=>{fixtureState.clock+=1100;});
        r=await f.page.evaluate(request=>fixtureState.run('READ_ASSISTANT_REPORT',request),request);
        assert.equal(r.status,'READY');assert.equal(r.assistantComplete,true);
      }finally{await f.context.close();}
    });
  }finally{await browser.close();}
  const output={browser:'Chromium, offline HTML fixtures; modeled app acknowledgements',passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results};
  console.log(JSON.stringify(output,null,2));
  if(output.failed)process.exitCode=1;
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
