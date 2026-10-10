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

export function fixture() {
  const data = {}, tabs = new Map([[1, {id: 1, windowId: 11, url: 'https://chatgpt.com/', status: 'complete'}],
    [2, {id: 2, windowId: 22, url: 'https://www.youtube.com/', status: 'complete'}]]);
  let serial = 2, maxTabs = 2, now = 1_800_000_000_000, focused = 11, generated = 0;
  const drafts = new Map(), sends = [], closeFaults = new Set();
  let injectCloseFaults = false, failNavigation = false, requiredTurnsBeforeClose = 0, reportOverride = null;
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
      if (requiredTurnsBeforeClose && tabs.get(id)?.url.includes('/c/')) {
        const url = tabs.get(id).url;
        assert.equal(sends.filter(send => send.url === url).length, requiredTurnsBeforeClose,
          'a scenario physical tab is never closed between prompts or polling');
      }
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
    if (req.mode === 'READ_ASSISTANT_REPORT' && reportOverride) return typeof reportOverride==='function'
      ? reportOverride(id,req,tab) : structuredClone(reportOverride);
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
    setReport(report){reportOverride=report;},guardCycle(turns){requiredTurnsBeforeClose=turns;},faults(){injectCloseFaults=true;},navigationFault(){failNavigation=true;}};
}
