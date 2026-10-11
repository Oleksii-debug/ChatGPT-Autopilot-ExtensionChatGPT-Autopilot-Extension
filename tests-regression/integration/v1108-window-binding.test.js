import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './v1108-fixture.mjs';
import { runRuntimeCycle } from '../../src/core/runtime-execution.js';
import { createChatTab } from '../../src/core/tabs.js';
import { ChromeInteractionTransport } from '../../src/core/interaction-transport.js';
import { resolveLaunchWindow, openWindowPilotPanel } from '../../src/core/window-binding.js';
import { projectGlobalStatus } from '../../src/core/global-status.js';
import { scenarioProgressText } from '../../src/ui/scenario-progress.js';

const config = { steps: [{prompt:'ONE',repeat:1},{prompt:'TWO',repeat:1}],
  pollSeconds:15, preSendDelaySeconds:1, responseTimeoutMinutes:35 };
async function tick(f) {
  await f.manager.cycleAll();
  await runRuntimeCycle({repository:f.repo,chromeApi:f.chrome,executor:f.executor,executionAvailable:true,now:()=>f.now});
  await f.manager.cycleAll(); f.advance();
}

test('two five-chat pools stay in distinct launch windows through replacements, focus changes and restart', async () => {
  const f=fixture();
  await f.manager.createChatPool({name:'A',count:5,replacementBudget:5,autoStart:true,preferredWindowId:11,config});
  await f.manager.createChatPool({name:'B',count:5,replacementBudget:5,autoStart:true,preferredWindowId:33,config});
  for (let i=0;i<110;i++) {
    await tick(f);
    if (i===7 || i===35) f.restart();
    const core=await f.repo.load();
    for (const hint of Object.values(core.tabHintsByTaskId)) {
      const owner=core.sessionsById[hint.sessionId];
      assert.equal(f.tabs.get(hint.tabId).windowId, owner.name.startsWith('A') ? 11 : 33);
    }
  }
  assert.equal(f.sends.length,40);
  const state=await f.manager.list();
  for(const pool of state.pools) {
    assert.equal(pool.totalSentPrompts,20); assert.equal(pool.totalReceivedResponses,20);
    assert.equal(scenarioProgressText(pool),'Надіслано промптів: 20. Отримано відповідей: 20.');
  }
  const global=projectGlobalStatus({coreState:await f.repo.load(),scenarios:state.scenarios});
  for(const pool of global.scenarioPools) { assert.equal(pool.totalSentPrompts,20); assert.equal(pool.totalReceivedResponses,20); }
  assert.equal(f.tabs.get(2).url,'https://www.youtube.com/');
});

test('vanished owner window never falls back to the focused window', async () => {
  let created=0;
  const chrome={windows:{get:async()=>{throw Error('No window with id');}},tabs:{create:async()=>{created++;}}};
  await assert.rejects(createChatTab(chrome,'https://chatgpt.com/',11),/No window/);
  assert.equal(created,0);
  delete chrome.windows;
  chrome.tabs.create=async()=>{created++;throw Error('Invalid window id');};
  await assert.rejects(createChatTab(chrome,'https://chatgpt.com/',11),/Invalid window/);
  assert.equal(created,1,'exactly one explicit-window attempt, no fallback');
});

test('moved owned task blocks before insertion and remains owned without a replacement', async () => {
  const f=fixture();
  await f.manager.createChatPool({count:1,replacementBudget:1,autoStart:true,preferredWindowId:11,config});
  const session=(await f.repo.load()).sessionsById[(await f.repo.load()).sessionOrder[0]];
  const tab=await f.executor.bindTaskTab(session.id,session.taskOrder[0]);
  f.tabs.get(tab.id).windowId=22;
  await assert.rejects(f.executor.bindTaskTab(session.id,session.taskOrder[0]),error=>error.safeDiagnosticCode==='SCENARIO_TAB_WINDOW_MISMATCH');
  assert.equal(f.sends.length,0); assert.equal(f.tabs.size,3);
  assert.equal((await f.repo.load()).sessionsById[session.id].scenarioWork.preferredWindowId,11);
});

test('transport rechecks a window after binding for insert and submit', async () => {
  let sent=0;
  const transport=new ChromeInteractionTransport({tabs:{get:async()=>({windowId:22}),sendMessage:async()=>{sent++;}}});
  for(const mode of ['INSERT_ONLY','SUBMIT_EXISTING','READ_ASSISTANT_REPORT']) {
    await assert.rejects(transport.execute(7,{mode,expectedUrl:'https://chatgpt.com/',expectedWindowId:11}),error=>error.safeDiagnosticCode==='SCENARIO_TAB_WINDOW_MISMATCH');
  }
  assert.equal(sent,0);
});

test('launch comes from this profile actual options tab; payload window and browser focus cannot supply authority', async () => {
  const url='chrome-extension://local/src/ui/options.html';
  const chrome={runtime:{id:'local',getURL:()=>url},tabs:{get:async id=>{if(id!==8)throw Error('No tab with id');return {id,url,windowId:33};}}};
  assert.equal(await resolveLaunchWindow(chrome,{id:'local',url},8),33);
  await assert.rejects(resolveLaunchWindow(chrome,{id:'foreign',url},8));
  await assert.rejects(resolveLaunchWindow(chrome,{id:'local',url:'https://chatgpt.com/'},8));
  await assert.rejects(resolveLaunchWindow(chrome,{id:'local',url},888));
  await assert.rejects(resolveLaunchWindow(chrome,{id:'local',url,tab:{id:8}},9));
});

test('opening Pilot in a second window creates a second panel rather than focusing the first', async () => {
  const url='chrome-extension://local/src/ui/options.html',created=[];
  const chrome={runtime:{getURL:()=>url},tabs:{query:async()=>[{id:1,url,windowId:11}],create:async options=>{created.push(options);return options;},update:async()=>{throw Error('Wrong panel');}}};
  await openWindowPilotPanel(chrome,{windowId:33}); assert.equal(created[0].windowId,33);
});

test('already completed correlated response reconciles a failed-safe send once without replay', async () => {
  const f=fixture();
  await f.manager.createChatPool({count:1,replacementBudget:0,autoStart:true,preferredWindowId:11,config});
  const core=await f.repo.load(),session=core.sessionsById[core.sessionOrder[0]],task=session.tasksById[session.taskOrder[0]];
  const tab=await f.executor.bindTaskTab(session.id,task.id);
  await f.executor.runSessionOnce(session.id);
  f.tabs.get(tab.id).url='https://chatgpt.com/c/actual';
  await f.repo.update(state=>{
    const live=state.sessionsById[session.id];live.enabled=false;live.runState='STOPPED';
    Object.assign(live.operation,{phase:'FAILED_SAFE',submitStartedAt:f.now,targetUrl:'https://chatgpt.com/c/actual'});
    live.tasksById[task.id].url=live.tasksById[task.id].normalizedUrl='https://chatgpt.com/c/actual';
    live.tasksById[task.id].lastConversationUrl='https://chatgpt.com/c/actual';
    live.tasksById[task.id].manualReviewReason='MANAGED_SEND_ACK_TIMEOUT_NO_RESEND';
    return state;
  });
  f.setReport({status:'READY',assistantComplete:true,assistantText:'Done',responseAnchorMatched:true,correlationTokenMatched:true,normalizedObservedUrl:'https://chatgpt.com/c/actual'});
  await f.manager.cycleAll(); await f.manager.cycleAll();
  const after=await f.repo.load();assert.equal(after.sessionsById[session.id].successfulSendCount,1);
  assert.equal(f.sends.length,0,'no physical replay');
  assert.equal((await f.manager.list()).pools[0].totalReceivedResponses,1);
});

test('uncorrelated response never turns an empty/unsent chat into a success', async () => {
  const f=fixture();await f.manager.createChatPool({count:1,replacementBudget:0,autoStart:true,preferredWindowId:11,config});
  const state=await f.repo.load(),session=state.sessionsById[state.sessionOrder[0]],task=session.tasksById[session.taskOrder[0]];
  await f.executor.bindTaskTab(session.id,task.id);
  await f.executor.runSessionOnce(session.id);
  await f.repo.update(state=>{Object.assign(state.sessionsById[session.id].operation,{phase:'FAILED_SAFE',submitStartedAt:f.now});return state;});
  f.setReport({status:'READY',assistantComplete:true,assistantText:'Old answer',responseAnchorMatched:true,correlationTokenMatched:false,normalizedObservedUrl:'https://chatgpt.com/c/actual'});
  await f.manager.cycleAll();assert.equal((await f.repo.load()).sessionsById[session.id].successfulSendCount,0);
});

test('upgrade fences legacy running scenarios before any unknown-window continuation', async () => {
  const f=fixture();await f.manager.createChatPool({count:2,replacementBudget:0,autoStart:true,config});
  await f.manager.enforceWindowBindings();
  const state=await f.manager.list();assert.ok(state.scenarios.every(s=>s.runtime.runState==='PAUSED' && s.runtime.preferredWindowId===null));
  await assert.rejects(f.manager.resumeChatPool(state.pools[0].id));
  await f.manager.startChatPool(state.pools[0].id,{preferredWindowId:11});
  assert.ok((await f.manager.list()).scenarios.every(s=>s.runtime.runState==='RUNNING' && s.runtime.preferredWindowId===11));
});

test('failed-safe managed submit stays fenced even if Start/Resume reenables the session', async () => {
  const f=fixture();await f.manager.createChatPool({count:1,replacementBudget:0,autoStart:true,preferredWindowId:11,config});
  const core=await f.repo.load(),session=core.sessionsById[core.sessionOrder[0]];
  await f.executor.runSessionOnce(session.id);
  await f.repo.update(state=>{Object.assign(state.sessionsById[session.id].operation,{phase:'FAILED_SAFE',submitStartedAt:f.now});return state;});
  f.advance();
  const result=await f.executor.runSessionOnce(session.id);
  assert.equal(result.kind,'MANAGED_SEND_HELD_NO_RESEND');assert.equal(f.sends.length,0);
});

test('repeated Start in the same window retains Core liveness and the binding', async () => {
  const f=fixture();const result=await f.manager.createChatPool({count:2,replacementBudget:0,autoStart:true,preferredWindowId:11,config});
  await f.manager.startChatPool(result.pool.id,{preferredWindowId:11});
  assert.ok(Object.values((await f.repo.load()).sessionsById).every(s=>s.enabled && s.runState==='RUNNING' && s.scenarioWork.preferredWindowId===11));
});

test('copied runtime from another local profile is paused and cannot adopt matching numeric window/tab IDs', async () => {
  const a=fixture(),b=fixture();
  await a.manager.createChatPool({count:1,replacementBudget:0,autoStart:true,preferredWindowId:11,config});
  const original=await a.manager.load();
  await b.manager.save(original);
  await b.repo.update(()=>a.repo.load());
  await b.manager.enforceWindowBindings();
  const scenario=(await b.manager.list()).scenarios[0];
  assert.equal(scenario.runtime.runState,'PAUSED'); assert.equal(scenario.runtime.preferredWindowId,null);
  await assert.rejects(b.manager.startChatPool(scenario.pool.id,{preferredWindowId:11}),/іншому локальному профілю/);
  assert.equal(b.sends.length,0);assert.equal(b.tabs.size,2);
});
