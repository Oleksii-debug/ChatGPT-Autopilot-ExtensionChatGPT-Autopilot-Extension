import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { StorageRepository } from '../../src/core/storage.js';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { ScenarioWorkManager } from '../../src/core/scenario-work-manager.js';
import { probeAssistantConversation } from '../../src/core/assistant-report-probe.js';
import { runRuntimeCycle, reconcileRuntimeColdStart } from '../../src/core/runtime-execution.js';
import { createRecordedOwnedTab, withTabLifecycle } from '../../src/core/owned-tab-lifecycle.js';
import { createSession, createTask, RunState, TabStrategy } from '../../src/core/schema.js';
import { waitForTaskTabReady } from '../../src/core/tabs.js';

function fixture() {
  const data = {}, tabs = new Map([[1, {id: 1, windowId: 11, url: 'https://chatgpt.com/', status: 'complete'}],
    [2, {id: 2, windowId: 22, url: 'https://www.youtube.com/', status: 'complete'}]]);
  let serial = 2, maxTabs = 2, now = 1_800_000_000_000, focused = 11, generated = 0;
  const drafts = new Map(), sends = [], closeFaults = new Set();
  let injectCloseFaults = false, failNavigation = false;
  const chrome = { storage: {local: {
    async get(key) { return {[key]: structuredClone(data[key])}; },
    async set(record) { Object.assign(data, structuredClone(record)); },
  }}, alarms: {async create(){}, async clear(){}}, windows: {async get(id){ return {id}; }}, tabs: {
    async query(q) { return [...tabs.values()].filter(t => !q?.url || t.url.startsWith('https://chatgpt.com/')).map(t => structuredClone(t)); },
    async get(id) { if (!tabs.has(id)) throw Error('No tab with id'); return structuredClone(tabs.get(id)); },
    async create(options) { const tab = {id: ++serial, windowId: options.windowId ?? focused, status: 'loading', ...options}; tabs.set(tab.id,tab); maxTabs = Math.max(maxTabs,tabs.size); return structuredClone(tab); },
    async update(id, patch) {
      if (!tabs.has(id)) throw Error('No tab with id');
      if (patch.url?.startsWith('https://chatgpt.com/')) {
        const state = await repo.load();
        assert.ok(Object.values(state.tabHintsByTaskId).some(h => h.tabId === id && h.ownedByExtension), 'navigation must follow durable ownership');
        if (failNavigation) { failNavigation = false; throw Error('synthetic navigation interruption'); }
      }
      Object.assign(tabs.get(id),patch); return structuredClone(tabs.get(id));
    },
    async remove(id) {
      if (injectCloseFaults && id % 9 === 0 && !closeFaults.has(id)) { closeFaults.add(id); throw Error('synthetic transient close refusal'); }
      if (!tabs.delete(id)) throw Error('No tab with id'); drafts.delete(id);
    },
    async reload(id) { if (!tabs.has(id)) throw Error('No tab with id'); },
  }};
  const repo = new StorageRepository(chrome);
  const transport = {async execute(id, req) {
    const tab = tabs.get(id); assert.ok(tab,'interaction tab exists');
    if (req.mode === 'CHECK_ONLY' || req.mode === 'ENSURE_HIGH_EFFORT' || req.mode === 'PREPARE_SEND') return {status:'READY'};
    if (req.mode === 'INSERT_ONLY') { drafts.set(id,req.promptText); return {status:'INSERTED_NOT_SENT',composerState:'VISIBLE_NONEMPTY',safeDiagnosticCode:'INSERTION_TEXT_PROVEN'}; }
    if (req.mode === 'SUBMIT_EXISTING') {
      assert.equal(drafts.get(id),req.promptText); assert.ok(!sends.some(s => s.operation === req.requestId), 'one Send per durable operation');
      drafts.delete(id); if (tab.url === 'https://chatgpt.com/') tab.url = `https://chatgpt.com/c/generated-${++generated}`;
      sends.push({operation:req.requestId,tabId:id,url:tab.url});
      return {status:'SENT_VERIFIED', normalizedObservedUrl:tab.url,assistantBaselineCount:0, submittedUserMessageKey:`message:${req.requestId}`};
    }
    if (req.mode === 'READ_ASSISTANT_REPORT') return {status:'READY',assistantComplete:true,assistantText:'OK',safeDiagnosticCode:'ASSISTANT_RESPONSE_READY'};
    throw Error(`Unexpected ${req.mode}`);
  }};
  let executor, manager;
  const restart = () => {
    executor = new AutomaticSessionExecutor(repo,chrome,transport,{now:()=>now,cryptoApi:webcrypto});
    manager = new ScenarioWorkManager({coreRepository:repo,chromeApi:chrome,now:()=>now,
      createId:()=>`scenario-${++serial}`,collectAssistantReport:job=>probeAssistantConversation(chrome,transport,job)});
  }; restart();
  return {chrome,repo,tabs,sends,restart,get executor(){return executor;},get manager(){return manager;},
    get maxTabs(){return maxTabs;},get now(){return now;},advance(ms=16000){now+=ms;focused=22;},
    faults(){injectCloseFaults=true;},navigationFault(){failNavigation=true;}};
}

async function addSession(f, id='ordinary', strategy=TabStrategy.OPEN_CLOSE_PER_TASK) {
  await f.repo.update(state=> {
    const session = createSession({id,name:id,tasks:[createTask({id:`${id}-task`,url:'https://chatgpt.com/'})],sharedPrompt:'Continue',
      minimumSendIntervalMs:1000,preSendDelayMs:1000,tabStrategy:strategy,now:f.now});
    session.runState=RunState.RUNNING; state.sessionsById[id]=session;state.sessionOrder.push(id); return state;
  });
}

test('open-close exceeds 12 sends through restart and failed closes without orphan tabs or other-window drafts',async()=>{
  const f=fixture(); await addSession(f); f.faults();
  for(let i=0;i<90;i++) {
    await runRuntimeCycle({repository:f.repo,chromeApi:f.chrome,executor:f.executor,executionAvailable:true,now:()=>f.now});
    f.advance(2000);
    if(i===27 || i===61) f.restart();
    const state=await f.repo.load();
    const hints=Object.values(state.tabHintsByTaskId);
    assert.ok(hints.length<=1);
    for(const tab of f.tabs.values()) if(tab.id>2) {
      assert.equal(tab.windowId,11); assert.ok(hints.some(h=>h.tabId===tab.id),'every created tab stays owned');
    }
  }
  assert.ok(f.sends.length>=35,`verified sends=${f.sends.length}`);
  assert.ok(f.maxTabs<=3,`peak=${f.maxTabs}`);
  assert.equal(f.tabs.get(2).url,'https://www.youtube.com/');
});

test('five scenario slots complete 17 turns and one replacement each with bounded live tabs through restart',async()=>{
  const f=fixture(); f.faults();
  await f.manager.createChatPool({count:5,replacementBudget:5,config:{mode:'CHAT_CYCLE',roundsPerGeneration:1,
    launchUrl:'https://chatgpt.com/',steps:[{prompt:'START',repeat:1},{prompt:'CONTINUE',repeat:15},{prompt:'FINAL',repeat:1}],
    closeTabsBetweenChecks:true,pollSeconds:15,preSendDelaySeconds:1,retryBackoffSeconds:5,responseTimeoutMinutes:10}});
  await f.manager.startChatPool((await f.manager.list()).pools[0].id);
  for(let i=0;i<360;i++) {
    await Promise.all([f.manager.cycleAll(),f.manager.cycleAll()]);
    await runRuntimeCycle({repository:f.repo,chromeApi:f.chrome,executor:f.executor,executionAvailable:true,now:()=>f.now});
    await f.manager.cycleAll(); f.advance();
    if(i===62 || i===185) f.restart();
    const state=await f.repo.load(); const hints=Object.values(state.tabHintsByTaskId);
    const ids=hints.map(h=>h.tabId); assert.equal(new Set(ids).size,ids.length,'one physical owner per tab');
    assert.ok(hints.length<=5,`hints=${hints.length}`);
    for(const tab of f.tabs.values()) if(tab.id>2) {
      assert.equal(tab.windowId,11); assert.ok(hints.some(h=>h.tabId===tab.id),'no untracked probe or draft');
    }
    if(f.sends.length===170) break;
  }
  assert.equal(f.sends.length,170);
  assert.ok(f.maxTabs<=7,`peak=${f.maxTabs}`);
  for(let i=0;i<5;i++){f.advance();await f.manager.cycleAll();await runRuntimeCycle({repository:f.repo,chromeApi:f.chrome,executor:f.executor,now:()=>f.now});}
  assert.equal(f.tabs.size,2,'all owned scenario tabs retired');
});

test('navigation interruption resumes the recorded blank tab without creating another page',async()=>{
  const f=fixture();await addSession(f);f.navigationFault();
  await assert.rejects(f.executor.bindTaskTab('ordinary','ordinary-task'),/navigation interruption/);
  assert.equal(f.tabs.size,3);
  const id=(await f.repo.load()).tabHintsByTaskId['ordinary-task'].tabId;
  assert.match(f.tabs.get(id).url,/^about:blank#autopilot-owned:/);
  f.restart();const resumed=await f.executor.bindTaskTab('ordinary','ordinary-task');
  assert.equal(resumed.id,id);assert.equal(f.tabs.size,3);
});

test('cold start removes only identifiable unrecorded blank placeholders',async()=>{
  const f=fixture();
  const orphan=await f.chrome.tabs.create({url:'about:blank#autopilot-owned:missing:task',active:false});
  await reconcileRuntimeColdStart({repository:f.repo,chromeApi:f.chrome,executionAvailable:true,now:()=>f.now});
  assert.ok(!f.tabs.has(orphan.id));assert.equal(f.tabs.size,2);
});

test('parallel run requests join the same operation and create one draft only',async()=>{
  const f=fixture();await addSession(f);
  const results=await Promise.all(Array.from({length:20},()=>f.executor.runSessionOnce('ordinary')));
  assert.ok(results.every(result=>result.kind==='WAIT_PRE_SEND'));assert.equal(f.tabs.size,3);
  f.advance(2000);
  await Promise.all(Array.from({length:20},()=>f.executor.runSessionOnce('ordinary')));
  assert.equal(f.sends.length,1);assert.equal(f.tabs.size,2);
});

test('usable loading document can be checked, but a conflicting pending navigation stays blocked',async()=>{
  let now=0;
  const chrome={tabs:{async get(){return {id:7,url:'https://chatgpt.com/c/current',status:'loading'};}}};
  const ready=await waitForTaskTabReady(chrome,7,'https://chatgpt.com/c/current',
    {allowLoadingDocument:true,now:()=>now,wait:async ms=>{now+=ms;}});
  assert.equal(ready.id,7);assert.equal(now,1500);
  chrome.tabs.get=async()=>({id:7,url:'https://chatgpt.com/c/current',pendingUrl:'https://chatgpt.com/c/other',status:'loading'});
  await assert.rejects(waitForTaskTabReady(chrome,7,'https://chatgpt.com/c/current',
    {allowLoadingDocument:true,timeoutMs:2000,now:()=>now,wait:async ms=>{now+=ms;}}),error=>error.safeDiagnosticCode==='TAB_NAVIGATION_TIMEOUT');
});

test('physical tab budget applies to held drafts across the whole profile, not just concurrent promises',async()=>{
  const f=fixture();await f.repo.update(state=>{state.profile.maxConcurrentSessionOperations=3;return state;});
  for(let i=0;i<12;i++)await addSession(f,`bounded-${i}`);
  const results=await Promise.allSettled(Array.from({length:12},(_,i)=>f.executor.bindTaskTab(`bounded-${i}`,`bounded-${i}-task`)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,3);
  assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.safeDiagnosticCode==='TAB_RESOURCE_CAPACITY_WAIT'));
  assert.equal(f.tabs.size,5);assert.equal(Object.values((await f.repo.load()).tabHintsByTaskId).length,3);
});
