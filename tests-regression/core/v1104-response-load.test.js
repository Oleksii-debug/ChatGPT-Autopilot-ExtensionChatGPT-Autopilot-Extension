import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { planChatRecovery } from '../../src/core/chat-recovery.js';
import { probeAssistantConversation } from '../../src/core/assistant-report-probe.js';
import { ScenarioWorkManager } from '../../src/core/scenario-work-manager.js';
import { createEmptyState } from '../../src/core/schema.js';
const adapter = createRequire(import.meta.url)('../../src/interaction/chatgpt-adapter.js');

test('incident trace cannot reset recovery budget on navigation/no-response/frozen reports', () => {
  const policy = { reopenAttempts: 0, requireCompletedResponse: true, cooldownMs: 1000 };
  const failure = { status: 'TEMPORARY_ERROR', chatRecoveryRequired: true, recoveryCategory: 'TRANSPORT_UNAVAILABLE' };
  let state = null; let reloads = 0;
  for (let i = 0; i < 30; i++) {
    const failed = planChatRecovery(state, failure, 1000 + i * 2000, policy);
    state = failed.state; if (failed.action === 'SAME_URL_RELOAD') reloads++;
    for (const code of ['ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING', 'ASSISTANT_NEW_RESPONSE_NOT_STARTED', 'ASSISTANT_RESPONSE_TAB_FROZEN']) {
      const pending = planChatRecovery(state, { status: 'TEMPORARY_ERROR', safeDiagnosticCode: code, tabRecoveryPending: true }, 1100 + i * 2000, policy);
      assert.notEqual(pending.action, 'RECOVERY_SUCCESS'); state = pending.state;
    }
  }
  assert.equal(reloads, 1); assert.equal(state.reloadAttempts, 1);
  const recovered = planChatRecovery(state, { status: 'READY', assistantComplete: true }, 65000, policy);
  assert.equal(recovered.action, 'RECOVERY_SUCCESS');
});

test('100 reads of a frozen tab never activate/reload/create it; old residency override is cleared once', async () => {
  const tab = { id: 7, url: 'https://chatgpt.com/c/saved', status: 'complete', frozen: true, autoDiscardable: false };
  const patches = [];
  const chrome = { tabs: {
    async get() { return { ...tab }; },
    async query() { throw Error('A bound read does not need a global query'); },
    async update(id, patch) { patches.push(patch); Object.assign(tab, patch); return { ...tab }; },
    async reload() { throw Error('No automatic wake'); }, async create() { throw Error('No duplicate'); },
  } };
  for (let i = 0; i < 100; i++) {
    const report = await probeAssistantConversation(chrome, { execute() { throw Error('Frozen'); } },
      { managedTabId: 7, managedTabOwned: true, persistentManagedTab: true, conversationUrl: tab.url });
    assert.equal(report.safeDiagnosticCode, 'ASSISTANT_RESPONSE_TAB_FROZEN');
  }
  assert.deepEqual(patches, [{ autoDiscardable: true }]);
});

test('Chrome API overload does not become proof of a missing tab', async () => {
  const chrome = { tabs: { async get() { throw Error('Browser API temporarily unavailable'); },
    async create() { throw Error('No duplicate'); } } };
  await assert.rejects(probeAssistantConversation(chrome, {}, { managedTabId: 7, persistentManagedTab: true,
    conversationUrl: 'https://chatgpt.com/c/saved' }), /temporarily unavailable/);
});

test('failed close plus unavailable existence check preserves the owned binding for retry', async () => {
  const state = createEmptyState(0);
  state.sessionsById.s = { id: 's', enabled: true, runState: 'RUNNING', scenarioWork: { managed: true }, tasksById: {} };
  state.tabHintsByTaskId.t = { sessionId: 's', tabId: 7, ownedByExtension: true };
  const core = { async load() { return structuredClone(state); }, async update(change) { Object.assign(state, await change(structuredClone(state))); } };
  const chrome = { storage: { local: {} }, tabs: { async remove() { throw Error('Browser unavailable'); }, async get() { throw Error('Browser unavailable'); } } };
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, collectAssistantReport: async () => null });
  const closed = await manager.performCloseOwnedScenarioTab('t', 's');
  assert.equal(closed.closed, false);
  assert.equal(state.tabHintsByTaskId.t.tabId, 7);
  const cleaned = await manager.cleanupManagedSession('s');
  assert.equal(cleaned.pending, true);
  assert.equal(state.tabHintsByTaskId.t.tabId, 7);
  assert.ok(state.sessionsById.s);
});

test('repeated Core callbacks honor frozen-tab backoff; recovery cannot schedule a 250ms wake loop', async () => {
  let now = 1000, reads = 0; const data = {};
  const chrome = { storage: { local: {
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(value) { Object.assign(data, structuredClone(value)); },
  } }, alarms: { async create() {}, async clear() {} } };
  const core = { state: createEmptyState(0), async load() { return structuredClone(this.state); },
    async update(change) { this.state = await change(structuredClone(this.state)); return this.load(); } };
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome, now: () => now,
    createId: () => 'throttled', collectAssistantReport: async () => { reads++; return {
      status: 'TEMPORARY_ERROR', safeDiagnosticCode: 'ASSISTANT_RESPONSE_TAB_FROZEN', tabRecoveryPending: true,
    }; } });
  await manager.create({ config: { steps: [{ prompt: 'Привіт' }], pollSeconds: 1 } });
  await manager.start('throttled'); const sessionId = core.state.sessionOrder[0];
  const taskId = core.state.sessionsById[sessionId].taskOrder[0];
  core.state.sessionsById[sessionId].tasksById[taskId].lastVerifiedSendAt = 1000;
  core.state.sessionsById[sessionId].tasksById[taskId].lastConversationUrl = 'https://chatgpt.com/c/saved';
  await manager.cycleOne('throttled');
  for (let i = 0; i < 50; i++) { now += 10; await manager.cycleOne('throttled'); }
  assert.equal(reads, 1); assert.ok(await manager.nextWakeAt() >= 61000);
  now = 61001; await manager.cycleOne('throttled'); assert.equal(reads, 2);
});

function currentDom(token, { hugeButtons = false } = {}) {
  const main = {};
  const body = { textContent: 'Привіт! Як можу допомогти?' };
  const user = { textContent: `Привіт\n${token}`, getAttribute(name) { return name === 'data-turn' ? 'user' : null; },
    closest() { return main; }, querySelectorAll() { return []; }, contains() { return false; }, compareDocumentPosition() { return 4; } };
  const assistant = { getAttribute(name) { return name === 'data-turn' ? 'assistant' : null; },
    closest() { return main; }, querySelectorAll() { return [body]; }, contains(other) { return other === body; } };
  Object.defineProperty(body, 'innerText', { get() { throw Error('Message extraction must not force layout'); } });
  const parent = {}; Object.defineProperty(parent, 'innerText', { get() { throw Error('Do not read ancestors of non-Retry buttons'); } });
  const buttons = hugeButtons ? Array.from({ length: 1000 }, () => ({ parentElement: parent, textContent: 'Copy',
    innerText: 'Copy', getAttribute() { return null; }, getBoundingClientRect() { return { width: 10, height: 10 }; } })) : [];
  return { querySelectorAll(selector) {
    if (selector.includes('[data-message-author-role="assistant"]')) return [assistant];
    if (selector.includes('[data-message-author-role="user"]')) return [user];
    if (selector === 'button, [role="button"]') return buttons;
    return [];
  } };
}

test('current data-turn articles correlate the simple reply after a reload without legacy author attributes', async () => {
  const saved = globalThis.location; const clock = Date.now;
  globalThis.location = { href: 'https://chatgpt.com/c/saved' }; let now = 1000; Date.now = () => now;
  try {
    const token = '[APSTEP:scenario:1]'; const doc = currentDom(token, { hugeButtons: true });
    const request = { requestId: 'reply', taskId: 't', mode: 'READ_ASSISTANT_REPORT',
      expectedUrl: globalThis.location.href, assistantBaselineKnown: true, assistantBaselineCount: 0,
      responseCorrelationToken: token, requireStableResponse: true };
    const first = await adapter.execute(request, { document: doc });
    assert.equal(first.safeDiagnosticCode, 'ASSISTANT_RESPONSE_STABILITY_PENDING');
    assert.equal(first.observedUserCount, 1); assert.equal(first.observedAssistantCount, 1);
    now += 1000; const final = await adapter.execute(request, { document: doc });
    assert.equal(final.assistantComplete, true); assert.equal(final.responseAnchorKind, 'STEP_MARKER');
    assert.equal(final.assistantText, 'Привіт! Як можу допомогти?');
    const stale = await adapter.execute({ ...request, responseCorrelationToken: '[APSTEP:scenario:2]' }, { document: doc });
    assert.equal(stale.assistantComplete, false);
  } finally { globalThis.location = saved; Date.now = clock; }
});


test('role-marked div turns without article wrappers still produce a correlated completed reply',async()=>{
  const saved=globalThis.location;globalThis.location={href:'https://chatgpt.com/c/div-turns'};
  try {
    const token='[APSTEP:div:1]';const base=currentDom(token);
    const doc={querySelectorAll(selector){
      if(selector.includes('[data-message-author-role="user"]')) return [];
      if(selector==='[data-turn="user"]') return base.querySelectorAll('[data-message-author-role="user"]');
      if(selector.includes('[data-message-author-role="assistant"]')) return [];
      if(selector==='[data-turn="assistant"]') return base.querySelectorAll('[data-message-author-role="assistant"]');
      return base.querySelectorAll(selector);
    }};
    const report=await adapter.execute({requestId:'div-read',taskId:'div-task',mode:'READ_ASSISTANT_REPORT',expectedUrl:globalThis.location.href,
      assistantBaselineKnown:true,assistantBaselineCount:0,responseCorrelationToken:token},{document:doc});
    assert.equal(report.assistantComplete,true);assert.equal(report.responseAnchorKind,'STEP_MARKER');
  } finally {globalThis.location=saved;}
});


test('saved provisional URL is replaced only by the sending document with the exact current step marker',async()=>{
  const saved=globalThis.location;globalThis.location={href:'https://chatgpt.com/c/canonical'};
  let navigations=0,reloads=0,creates=0;
  const chrome={tabs:{async get(){return {id:7,url:globalThis.location.href,status:'complete'};},
    async update(){navigations++;},async reload(){reloads++;},async create(){creates++;}}};
  const token='[APSTEP:canonical:1]';const doc=currentDom(token);
  const transport={execute:(_,request)=>adapter.execute(request,{document:doc})};
  const job={id:'canonical',taskId:'t',managedTabId:7,managedTabOwned:true,persistentManagedTab:true,
    conversationUrl:'https://chatgpt.com/c/provisional',responseCorrelationToken:token,
    assistantBaselineKnown:true,assistantBaselineCount:0,requireStableResponse:false};
  try {
    const result=await probeAssistantConversation(chrome,transport,job);
    assert.equal(result.assistantComplete,true);assert.equal(result.correlationTokenMatched,true);
    assert.equal(result.correlatedConversationRebind,true);assert.equal(result.observedTabId,7);
    assert.equal(result.normalizedObservedUrl,globalThis.location.href);
    const wrong=await probeAssistantConversation(chrome,transport,{...job,responseCorrelationToken:'[APSTEP:other:2]'});
    assert.equal(wrong.assistantComplete,false);assert.equal(wrong.safeDiagnosticCode,'ASSISTANT_BOUND_CONVERSATION_UNPROVEN');
    const staleRecovery=await probeAssistantConversation(chrome,transport,{...job,recoveryAction:'SAME_URL_RELOAD'});
    assert.equal(staleRecovery.safeDiagnosticCode,'ASSISTANT_BOUND_CONVERSATION_UNPROVEN');
    assert.equal(navigations+reloads+creates,0);
  } finally {globalThis.location=saved;}
});


test('correlated bound read still reports login and never treats it as a recoverable conversation',async()=>{
  const chrome={tabs:{async get(){return {id:7,url:'https://chatgpt.com/auth/login',status:'complete'};}}};
  const result=await probeAssistantConversation(chrome,{execute(){throw Error('Never read login');}},
    {managedTabId:7,managedTabOwned:true,persistentManagedTab:true,responseCorrelationToken:'[APSTEP:auth:1]',
      conversationUrl:'https://chatgpt.com/c/saved'});
  assert.equal(result.status,'AUTH_REQUIRED');assert.notEqual(result.chatRecoveryRequired,true);
});
