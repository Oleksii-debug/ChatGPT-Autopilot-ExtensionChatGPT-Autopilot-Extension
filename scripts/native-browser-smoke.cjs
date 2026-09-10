// Runs the shipped adapter, content-script, transport, executor and native-input
// module against a local intercepted fixture in real Chromium. Chrome APIs are
// bridged to real CDP here; extension installation/permissions remain a separate gate.
const { chromium } = require('playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const fixture = `<!doctype html><html><head><style>
body{margin:30px;font:16px sans-serif}#prompt-textarea{white-space:pre-wrap;border:1px solid black;min-height:100px;width:600px}button{width:120px;height:40px}.whitespace-pre-wrap{white-space:pre-wrap}</style></head><body>
<main id="history"></main><form id="composer"><div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Message"></div><button type="button" data-testid="send-button" aria-label="Надіслати">Надіслати</button></form>
<script>
window.receipts=[];window.inputTrust=[];window.clickTrust=[];let model='';
const editor=document.getElementById('prompt-textarea');
editor.addEventListener('input',event=>{inputTrust.push(event.isTrusted);if(event.isTrusted)model=editor.innerText;});
document.querySelector('button').addEventListener('click',event=>{
 clickTrust.push(event.isTrusted);if(!event.isTrusted||!model)return;
 const submitted=model;receipts.push(submitted);window.receiptTimes=window.receiptTimes||[];window.receiptTimes.push(Date.now());setTimeout(()=>{const article=document.createElement('article');article.setAttribute('aria-label','You said');
 const message=document.createElement('div');message.setAttribute('data-message-author-role','user');
 const body=document.createElement('div');body.className='whitespace-pre-wrap';body.textContent=submitted;message.append(body);article.append(message);document.getElementById('history').append(article);
 editor.textContent='';model='';},window.ackDelayMs||0);
});
</script></body></html>`;
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.AUTOPILOT_CHROMIUM_EXECUTABLE,headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
 try{
 const context=await browser.newContext();
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='chatgpt.com' && new URL(route.request().url()).pathname.includes('fixture-')?route.fulfill({contentType:'text/html',body:fixture}):route.abort());
 let baselineResult=null;
 if(process.env.AUTOPILOT_BASELINE_ADAPTER){
   const oldPage=await context.newPage();await oldPage.goto('https://chatgpt.com/c/fixture-baseline');
   await oldPage.addScriptTag({path:process.env.AUTOPILOT_BASELINE_ADAPTER});
   const result=await oldPage.evaluate(()=>window.ChatGPTInteractionAdapter.execute({requestId:'baseline',taskId:'baseline',expectedUrl:location.href,promptText:'Native input regression',mode:'INSERT_AND_SEND',preSendDelayMs:1000}));
   const observed=await oldPage.evaluate(()=>({receipts:window.receipts.length,clickTrust:window.clickTrust}));
   assert.equal(result.status,'SUBMISSION_UNCERTAIN');assert.equal(observed.receipts,0);assert.deepEqual(observed.clickTrust,[false]);
   baselineResult={status:result.status,receiptCount:observed.receipts,clickTrusted:false};await oldPage.close();
 }
 const imp=relative=>import(pathToFileURL(path.join(root,relative)).href);
 const {StorageRepository}=await imp('src/core/storage.js');
 const {AutomaticSessionExecutor}=await imp('src/core/automatic-executor.js');
 const {ChromeInteractionTransport}=await imp('src/core/interaction-transport.js');
 const {performNativeInput}=await imp('src/core/native-input.js');
 const {createEmptyState,createSession,createTask}=await imp('src/core/schema.js');
 let db={},nextTab=1,clock=Date.now();const pages=new Map(),debuggers=new Map(),nativeCommands=[];
 let repo;
 async function newTab(url){
   const page=await context.newPage(),id=nextTab++;pages.set(id,page);
   await page.exposeFunction('__nativeExtensionMessage',async message=>{
     try{await performNativeInput(api,repo,message,{id:'test-extension',frameId:0,tab:{id}});return {ok:true};}
     catch(error){return {ok:false,error:{safeDiagnosticCode:error.safeDiagnosticCode||error.message}};}
   });
   await page.goto(url);
   await page.evaluate(()=>{
     window.__interactionListeners=[];
     window.chrome=window.chrome||{};
     window.chrome.runtime={id:'test-extension',sendMessage:message=>window.__nativeExtensionMessage(message),onMessage:{addListener:fn=>window.__interactionListeners.push(fn),hasListener:fn=>window.__interactionListeners.includes(fn)}};
   });
   await page.addScriptTag({path:path.join(root,'src/interaction/chatgpt-adapter.js')});
   await page.addScriptTag({path:path.join(root,'src/interaction/content-script.js')});
   return {id,url,status:'complete'};
 }
 const api={runtime:{id:'test-extension'},storage:{local:{get:async key=>({[key]:structuredClone(db[key])}),set:async record=>Object.assign(db,structuredClone(record))}},
   tabs:{get:async id=>{const p=pages.get(id);if(!p)throw Error('missing tab');return {id,url:p.url(),status:'complete'};},query:async()=>Array.from(pages,([id,p])=>({id,url:p.url(),status:'complete'})),create:async({url})=>newTab(url),
     sendMessage:async(id,message)=>pages.get(id).evaluate(message=>new Promise(resolve=>window.__interactionListeners[0](message,{},resolve)),message)},
   debugger:{attach:async({tabId})=>{debuggers.set(tabId,await context.newCDPSession(pages.get(tabId)));},detach:async({tabId})=>{await debuggers.get(tabId).detach();debuggers.delete(tabId);},sendCommand:async({tabId},method,params)=>{nativeCommands.push({tabId,method,type:params.type});return debuggers.get(tabId).send(method,params);}},
   scripting:{executeScript:async({target,func,args})=>[{result:await pages.get(target.tabId).evaluate(({source,args})=>(0,eval)('('+source+')')(...args),{source:func.toString(),args})}]}
 };
 repo=new StorageRepository(api);
 const state=createEmptyState(clock);
 const prompt=Array.from({length:119},(_,i)=>'Рядок '+i+': перевірка введення і надсилання.').join('\n');
 const scenarios=[
   {url:'https://chatgpt.com/c/fixture-1',prompt,pauseMs:2000,ackDelayMs:0},
   {url:'https://chatgpt.com/c/fixture-2?test=two',prompt:'Коротке повідомлення №2. ♞',pauseMs:3000,ackDelayMs:2000},
   {url:'https://chatgpt.com/g/fixture-project/c/fixture-3',prompt:'Перший рядок\nДругий рядок\nТретій рядок',pauseMs:5000,ackDelayMs:6500},
   {url:'https://chatgpt.com/c/fixture-4#test',prompt:'Same text repeated',pauseMs:2000,ackDelayMs:0},
   {url:'https://chatgpt.com/c/fixture-5',prompt:'Same text repeated',pauseMs:4000,ackDelayMs:9000},
   {url:'https://chatgpt.com/c/fixture-6',prompt:'Фінальний тест: 1. e4 e5 2. Nf3 Nc6',pauseMs:3000,ackDelayMs:300}
 ];
 const session=createSession({id:'native-browser',name:'Native browser fixture',tasks:scenarios.map((item,i)=>createTask({id:'t'+(i+1),url:item.url,promptOverride:item.prompt})),promptMode:'UNIQUE',minimumSendIntervalMs:2000,preSendDelayMs:1000,now:clock});
 session.runState='RUNNING';state.sessionsById[session.id]=session;state.sessionOrder=[session.id];await repo.save(state);
 let executor=new AutomaticSessionExecutor(repo,api,new ChromeInteractionTransport(api),{now:()=>clock});
 const observations=[];
 for(let i=0;i<scenarios.length;i++){
   const scenario=scenarios[i];
   const inserted=await executor.runSessionOnce(session.id);
   assert.equal(inserted.kind,'WAIT_PRE_SEND',JSON.stringify(inserted));
   await pages.get(i+1).evaluate(delay=>{window.ackDelayMs=delay;},scenario.ackDelayMs);
   const waitStart=Date.now();await new Promise(resolve=>setTimeout(resolve,scenario.pauseMs));
   clock=Date.now();
   if(i%2===0)executor=new AutomaticSessionExecutor(new StorageRepository(api),api,new ChromeInteractionTransport(api),{now:()=>clock});
   const sent=await executor.runSessionOnce(session.id);
   const current=(await repo.load()).sessionsById[session.id];
   assert.equal(current.operation.phase,'SENT_VERIFIED',JSON.stringify({sent,error:current.lastError,diagnostics:db.autopilotState.diagnostics.slice(-3)}));
   observations.push({url:scenario.url,timeThroughVerificationMs:Date.now()-waitStart,requestedPauseMs:scenario.pauseMs,ackDelayMs:scenario.ackDelayMs,phase:current.operation.phase});
   await new Promise(resolve=>setTimeout(resolve,2100));clock=Date.now();
 }
 const results=[];
 for(const [id,page] of pages){
   const receipts=await page.evaluate(()=>({count:receipts.length,text:receipts[0],receiptTime:window.receiptTimes[0],inputTrust,clickTrust,composerEmpty:document.getElementById('prompt-textarea').innerText===''}));
   assert.equal(receipts.count,1);assert.equal(receipts.text,scenarios[id-1].prompt);assert.deepEqual(receipts.clickTrust,[true]);assert.ok(receipts.inputTrust.every(Boolean));assert.equal(receipts.composerEmpty,true);
   results.push({tabId:id,receiptCount:receipts.count,allInputTrusted:true,clickTrusted:receipts.clickTrust[0],receiptTime:receipts.receiptTime});
 }
 for(let i=1;i<results.length;i++) assert.ok(results[i].receiptTime-results[i-1].receiptTime>=2000,'real send gap must respect minimum interval');
 assert.equal(nativeCommands.filter(x=>x.type==='mousePressed').length,scenarios.length);assert.equal(nativeCommands.filter(x=>x.type==='mouseReleased').length,scenarios.length);
 console.log(JSON.stringify({status:'PASS',browser:browser.version(),scope:'Real Chromium DOM and CDP; Chrome extension APIs bridged in test, no live ChatGPT account',baselineResult,verifiedTasks:scenarios.length,realTimePauses:true,observations,restartedExecutorAfterInsertion:true,nativeCommands,results},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
