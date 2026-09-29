import test from 'node:test'; import assert from 'node:assert/strict';
import { StorageRepository } from '../src/core/storage.js';
import { createSession, createTask, RunState } from '../src/core/schema.js';
import { REMOTE_DISPATCH_CONFIG_STORAGE_KEY, REMOTE_DISPATCH_CACHE_STORAGE_KEY } from '../src/core/remote-dispatch-config.js';
import { REMOTE_DISPATCH_LEDGER_STORAGE_KEY } from '../src/core/remote-dispatch-ledger.js';
import { RemoteDispatchController, REMOTE_DISPATCH_ALARM } from '../src/core/remote-dispatch-controller.js';
import { remoteLocalSessionId, remoteLocalTaskId } from '../src/core/remote-dispatch-import.js';

function chromeFake(){const data={};const alarmCalls=[];return{data,alarmCalls,storage:{local:{async get(k){return{[k]:data[k]}},async set(r){Object.assign(data,structuredClone(r))},async remove(k){for(const key of Array.isArray(k)?k:[k]) delete data[key]}}},alarms:{async create(n,o){alarmCalls.push(['create',n,o]);},async clear(n){alarmCalls.push(['clear',n]);return true;}}};}
function body(){const d={schema_version:1,dispatch_id:'d1',strategy_revision:1,generated_at:'2026-09-11T18:00:00Z',expires_at:'2026-09-11T20:00:00Z',project_id:'p',target_repository:'o/r',supersedes_dispatch_ids:[],policy:{poll_interval_seconds:180,fallback_after_seconds:900,fallback_enabled:true,max_active_sessions:1},sessions:[{session_key:'s',name:'S',order:1,enabled:true,run_mode:'ONE_PASS',tab_strategy:'OPEN_CLOSE_PER_TASK',minimum_send_interval_seconds:60,pre_send_delay_seconds:1,busy_check_delay_seconds:1,retry_backoff_seconds:5,not_before:null,expires_at:null,tasks:[{task_id:'t',order:1,enabled:true,url:'https://chatgpt.com/',prompt:'work',not_before:null,expires_at:null,max_launches:1,supersedes_task_ids:[]}]}]};return `<!-- CHATGPT_AUTOPILOT_DISPATCH_V1 -->\n\`\`\`json\n${JSON.stringify(d)}\n\`\`\``;}
function response(j){return{ok:true,status:200,headers:{get(){return'50'}},async json(){return structuredClone(j)}};}
const NOW=Date.parse('2026-09-11T18:30:00Z');

test('disabled controller performs no fetch and clears remote alarm',async()=>{const chrome=chromeFake();const repo=new StorageRepository(chrome);let fetched=false;const c=new RemoteDispatchController({coreRepository:repo,chromeApi:chrome,fetchFn:async()=>{fetched=true;},now:()=>NOW});const r=await c.poll();assert.equal(r.kind,'DISABLED');assert.equal(fetched,false);assert.deepEqual(chrome.alarmCalls.at(-1).slice(0,2),['clear',REMOTE_DISPATCH_ALARM]);});

test('enabled controller fetches GitHub, caches, imports and auto-starts canonical Session',async()=>{const chrome=chromeFake();chrome.data[REMOTE_DISPATCH_CONFIG_STORAGE_KEY]={enabled:true,projectId:'p',repository:'o/r',issueNumber:121,minimumPollIntervalSeconds:300,fallbackEnabled:true,fallbackAfterSeconds:900,autoStart:true};const repo=new StorageRepository(chrome);const fetchFn=async url=>url.includes('/comments')?response([{id:7,body:body(),html_url:'x'}]):response({comments:1});const c=new RemoteDispatchController({coreRepository:repo,chromeApi:chrome,fetchFn,now:()=>NOW});const r=await c.poll();assert.equal(r.kind,'APPLIED');const state=await repo.load();const sid=remoteLocalSessionId('p','s');assert.equal(state.sessionsById[sid].runState,'RUNNING');assert.equal(chrome.data[REMOTE_DISPATCH_CACHE_STORAGE_KEY].dispatch.dispatch_id,'d1');assert.equal(chrome.data[REMOTE_DISPATCH_LEDGER_STORAGE_KEY].currentDispatchId,'d1');assert.equal(chrome.alarmCalls.at(-1)[1],REMOTE_DISPATCH_ALARM);});

test('cached valid dispatch continues after transient GitHub error',async()=>{const chrome=chromeFake();chrome.data[REMOTE_DISPATCH_CONFIG_STORAGE_KEY]={enabled:true,projectId:'p',repository:'o/r',issueNumber:121,minimumPollIntervalSeconds:300,fallbackEnabled:true,fallbackAfterSeconds:900,autoStart:true};const repo=new StorageRepository(chrome);let fail=false;const fetchFn=async url=>{if(fail)throw new Error('offline');return url.includes('/comments')?response([{id:7,body:body()}]):response({comments:1});};const c=new RemoteDispatchController({coreRepository:repo,chromeApi:chrome,fetchFn,now:()=>NOW});await c.poll();fail=true;const r=await c.poll();assert.equal(r.kind,'CACHED_AFTER_FETCH_ERROR');assert.equal(r.dispatch.dispatch_id,'d1');});

test('after-core sync counts verified fingerprint and governance disables maxed task',async()=>{const chrome=chromeFake();chrome.data[REMOTE_DISPATCH_CONFIG_STORAGE_KEY]={enabled:true,projectId:'p',repository:'o/r',issueNumber:121,minimumPollIntervalSeconds:300,fallbackEnabled:true,fallbackAfterSeconds:900,autoStart:true};const repo=new StorageRepository(chrome);const fetchFn=async url=>url.includes('/comments')?response([{id:7,body:body()}]):response({comments:1});const c=new RemoteDispatchController({coreRepository:repo,chromeApi:chrome,fetchFn,now:()=>NOW});await c.poll();const sid=remoteLocalSessionId('p','s'),tid=remoteLocalTaskId('p','s','t');await repo.update(d=>{d.sessionsById[sid].tasksById[tid].lastVerifiedFingerprint='sha256:sent';d.sessionsById[sid].tasksById[tid].lastVerifiedSendAt=NOW;return d;});const sync=await c.syncAfterCoreCycle();assert.equal(sync.counted.length,1);const state=await repo.load();assert.equal(state.sessionsById[sid].tasksById[tid].enabled,false);assert.equal(chrome.data[REMOTE_DISPATCH_LEDGER_STORAGE_KEY].launchCounts[Object.keys(chrome.data[REMOTE_DISPATCH_LEDGER_STORAGE_KEY].launchCounts)[0]],1);});


test('disabling Remote Dispatch revokes future remote launch authority but keeps unresolved operation evidence', async () => {
  const chrome = chromeFake();
  chrome.data[REMOTE_DISPATCH_CONFIG_STORAGE_KEY] = { enabled:true, projectId:'p', repository:'o/r', issueNumber:121, minimumPollIntervalSeconds:300, fallbackEnabled:true, fallbackAfterSeconds:900, autoStart:true };
  const repo = new StorageRepository(chrome);
  const fetchFn = async url => url.includes('/comments') ? response([{ id:7, body:body() }]) : response({ comments:1 });
  const c = new RemoteDispatchController({ coreRepository:repo, chromeApi:chrome, fetchFn, now:()=>NOW });
  await c.poll();
  const sid = remoteLocalSessionId('p','s');
  let state = await repo.load();
  assert.equal(state.sessionsById[sid].runState, 'RUNNING');
  await c.updateConfig({ ...chrome.data[REMOTE_DISPATCH_CONFIG_STORAGE_KEY], enabled:false });
  state = await repo.load();
  assert.equal(state.sessionsById[sid].enabled, false);
  assert.equal(state.sessionsById[sid].runState, 'STOPPED');
});

test('changing feed identity while enabled is blocked; disabled identity change clears old cache and ledger', async () => {
  const chrome = chromeFake();
  chrome.data[REMOTE_DISPATCH_CONFIG_STORAGE_KEY] = { enabled:true, projectId:'p', repository:'o/r', issueNumber:121, minimumPollIntervalSeconds:300, fallbackEnabled:true, fallbackAfterSeconds:900, autoStart:true };
  chrome.data[REMOTE_DISPATCH_CACHE_STORAGE_KEY] = { stale:true };
  chrome.data[REMOTE_DISPATCH_LEDGER_STORAGE_KEY] = { stale:true };
  const repo = new StorageRepository(chrome);
  const c = new RemoteDispatchController({ coreRepository:repo, chromeApi:chrome, fetchFn:async()=>response({comments:0}), now:()=>NOW });
  await assert.rejects(() => c.updateConfig({ ...chrome.data[REMOTE_DISPATCH_CONFIG_STORAGE_KEY], projectId:'q' }), /Вимкніть Remote Dispatch/);
  await c.updateConfig({ ...chrome.data[REMOTE_DISPATCH_CONFIG_STORAGE_KEY], enabled:false });
  await c.updateConfig({ enabled:false, projectId:'q', repository:'x/y', issueNumber:22, minimumPollIntervalSeconds:300, fallbackEnabled:true, fallbackAfterSeconds:900, autoStart:true });
  assert.equal(chrome.data[REMOTE_DISPATCH_CACHE_STORAGE_KEY], undefined);
  assert.equal(chrome.data[REMOTE_DISPATCH_LEDGER_STORAGE_KEY], undefined);
});

test('testFeed validates supplied disabled-form settings as an executable feed without mutating runtime', async () => {
  const chrome = chromeFake();
  const repo = new StorageRepository(chrome);
  const fetchFn = async url => url.includes('/comments') ? response([{ id:7, body:body() }]) : response({ comments:1 });
  const c = new RemoteDispatchController({ coreRepository:repo, chromeApi:chrome, fetchFn, now:()=>NOW });
  const result = await c.testFeed({ enabled:false, projectId:'p', repository:'o/r', issueNumber:121, minimumPollIntervalSeconds:300, fallbackEnabled:true, fallbackAfterSeconds:900, autoStart:true });
  assert.equal(result.selected.dispatchId, 'd1');
  const state = await repo.load();
  assert.equal(Object.keys(state.sessionsById).length, 0);
});


test('fallback auto-starts configured local Session only after threshold and auto-stops when valid remote returns', async () => {
  const chrome = chromeFake();
  let now = NOW;
  let publishRemote = false;
  chrome.data[REMOTE_DISPATCH_CONFIG_STORAGE_KEY] = {
    enabled:true, projectId:'p', repository:'o/r', issueNumber:121,
    minimumPollIntervalSeconds:180, fallbackEnabled:true, fallbackAfterSeconds:180,
    fallbackSessionId:'fallback-local', autoStart:true,
  };
  const repo = new StorageRepository(chrome);
  await repo.update(state => {
    const task = createTask({ id:'fallback-task', url:'https://chatgpt.com/', promptOverride:'' });
    const session = createSession({ id:'fallback-local', name:'Fallback', tasks:[task], sharedPrompt:'fallback work', now:1 });
    session.runState = RunState.STOPPED;
    state.sessionsById[session.id] = session;
    state.sessionOrder.push(session.id);
    return state;
  });
  const fetchFn = async url => url.includes('/comments')
    ? response(publishRemote ? [{ id:7, body:body() }] : [])
    : response({ comments: publishRemote ? 1 : 0 });
  const c = new RemoteDispatchController({ coreRepository:repo, chromeApi:chrome, fetchFn, now:()=>now });

  await c.poll();
  let state = await repo.load();
  assert.equal(state.sessionsById['fallback-local'].runState, RunState.STOPPED);
  assert.equal(chrome.data[REMOTE_DISPATCH_LEDGER_STORAGE_KEY].fallbackActive, false);

  now += 180_000;
  const fallbackPoll = await c.poll();
  state = await repo.load();
  assert.equal(fallbackPoll.fallback.thresholdReached, true);
  assert.equal(state.sessionsById['fallback-local'].runState, RunState.RUNNING);
  assert.equal(chrome.data[REMOTE_DISPATCH_LEDGER_STORAGE_KEY].fallbackAutoStarted, true);

  publishRemote = true;
  now += 1_000;
  await c.poll();
  state = await repo.load();
  assert.equal(state.sessionsById['fallback-local'].runState, RunState.STOPPED);
  assert.equal(chrome.data[REMOTE_DISPATCH_LEDGER_STORAGE_KEY].fallbackActive, false);
  assert.equal(chrome.data[REMOTE_DISPATCH_LEDGER_STORAGE_KEY].fallbackAutoStarted, false);
});
