'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAdapter(extra = {}) {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/chatgpt-adapter.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sandbox = Object.assign({
    URL,
    Date,
    setTimeout,
    clearTimeout,
    console,
    location: { href: 'https://chatgpt.com/c/abc' }
  }, extra);
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: sourcePath });
  return { adapter: sandbox.ChatGPTInteractionAdapter, sandbox };
}

function validRequest(overrides = {}) {
  return Object.assign({
    requestId: 'op-1',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText: 'Продовжуй роботу.\nExact text ✅',
    preSendDelayMs: 1000,
    allowBenignRetry: false,
    mode: 'INSERT_AND_SEND'
  }, overrides);
}

test('normalizeUrl removes query/hash/trailing slash only', () => {
  const { adapter } = loadAdapter();
  assert.equal(adapter.normalizeUrl('https://chatgpt.com/c/abc/?x=1#frag'), 'https://chatgpt.com/c/abc');
});

test('sameExpectedChat rejects another conversation and origin', () => {
  const { adapter } = loadAdapter();
  assert.equal(adapter.sameExpectedChat('https://chatgpt.com/c/abc', 'https://chatgpt.com/c/abc'), true);
  assert.equal(adapter.sameExpectedChat('https://chatgpt.com/c/def', 'https://chatgpt.com/c/abc'), false);
  assert.equal(adapter.sameExpectedChat('https://example.com/c/abc', 'https://chatgpt.com/c/abc'), false);
});

test('request validation rejects unsafe/malformed operations', () => {
  const { adapter } = loadAdapter();
  assert.equal(adapter.validateRequest(validRequest()), null);
  assert.equal(adapter.validateRequest(validRequest({ preSendDelayMs: 999 })), 'PRE_SEND_DELAY_INVALID');
  assert.equal(adapter.validateRequest(validRequest({ preSendDelayMs: 30001 })), 'PRE_SEND_DELAY_INVALID');
  assert.equal(adapter.validateRequest(validRequest({ promptText: undefined })), 'PROMPT_MISSING');
  assert.equal(adapter.validateRequest(validRequest({ mode: 'CLICK_EVERYTHING' })), 'MODE_INVALID');
});

test('CHECK_ONLY rejects URL mismatch before DOM work', async () => {
  let queried = 0;
  const { adapter, sandbox } = loadAdapter();
  sandbox.location.href = 'https://chatgpt.com/c/other';
  const fakeDocument = { querySelectorAll: () => { queried += 1; return []; }, body: { innerText: '' } };
  const result = await adapter.execute(validRequest({ mode: 'CHECK_ONLY' }), { document: fakeDocument });
  assert.equal(result.status, adapter.STATUS.TEMPORARY_ERROR);
  assert.equal(result.safeDiagnosticCode, 'URL_MISMATCH');
  assert.equal(queried, 0);
});

test('malformed request fails closed before DOM mutation', async () => {
  let queried = 0;
  const { adapter } = loadAdapter();
  const fakeDocument = { querySelectorAll: () => { queried += 1; return []; }, body: { innerText: '' } };
  const result = await adapter.execute(validRequest({ preSendDelayMs: 10 }), { document: fakeDocument });
  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.safeDiagnosticCode, 'PRE_SEND_DELAY_INVALID');
  assert.equal(queried, 0);
});

test('rate limit is classified from a visible accessibility alert without recovery clicks', () => {
  const rateAlert = {
    isConnected: true,
    hidden: false,
    disabled: false,
    innerText: 'Too many requests. Try again later.',
    getAttribute(name) { return name === 'role' ? 'alert' : null; },
    getBoundingClientRect() { return { width: 100, height: 20 }; }
  };
  const { adapter } = loadAdapter({ getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const fakeDocument = {
    body: { innerText: 'Conversation transcript may contain arbitrary text.' },
    querySelectorAll(selector) {
      if (selector === '[role="alert"], [role="status"], [aria-live="assertive"]') return [rateAlert];
      return [];
    }
  };
  const block = adapter.detectBlockingState(fakeDocument);
  assert.equal(block.status, adapter.STATUS.RATE_LIMITED);
  assert.equal(block.code, 'RATE_LIMIT_SURFACE_VISIBLE');
});

test('visible Stop control is classified BUSY', () => {
  const stopButton = {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'BUTTON',
    innerText: 'Stop generating',
    getAttribute(name) { return name === 'aria-label' ? 'Stop generating' : null; },
    getBoundingClientRect() { return { width: 10, height: 10 }; }
  };
  const { adapter } = loadAdapter({ getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const fakeDocument = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return [stopButton];
      return [];
    }
  };
  const block = adapter.detectBlockingState(fakeDocument);
  assert.equal(block.status, adapter.STATUS.BUSY);
  assert.equal(block.code, 'STOP_CONTROL_VISIBLE');
});

test('two equally plausible visible composers fail closed', () => {
  const { adapter } = loadAdapter({ getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const makeEditor = () => ({
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'DIV',
    getAttribute(name) {
      if (name === 'contenteditable') return 'true';
      if (name === 'aria-label') return 'Message';
      return null;
    },
    getBoundingClientRect() { return { width: 100, height: 20 }; },
    closest() { return null; }
  });
  const fakeDocument = { querySelectorAll: () => [makeEditor(), makeEditor()] };
  const found = adapter.findVisibleComposer(fakeDocument);
  assert.equal(found.element, null);
  assert.equal(found.ambiguous, true);
});

// Minimal DOM surface copied from the Work UI's keyed turn structure. The
// second/third sends matter: an existing assistant reply must be the baseline,
// and a new user bubble must be appended rather than matched in old history.
function workChat() {
  const users = [];
  const assistants = [];
  let sends = 0;
  const visible = { isConnected: true, hidden: false, disabled: false,
    getBoundingClientRect: () => ({ width: 100, height: 20 }) };
  const node = (attrs, innerText, children = {}) => ({
    ...visible, innerText,
    getAttribute: key => attrs[key] ?? null,
    hasAttribute: key => Object.hasOwn(attrs, key),
    querySelector: key => children[key] || null,
    querySelectorAll: key => key.includes('data-markdown-text-style')
      ? [children['[data-markdown-text-style="assistant-message"]']].filter(Boolean) : [],
    contains: other => Object.values(children).includes(other),
  });
  const bubble = text => node({ 'data-user-message-bubble': 'true' }, text);
  const reply = text => {
    const heading = node({ 'data-conversation-role': 'assistant' }, 'ChatGPT сказал:');
    const body = node({ 'data-markdown-text-style': 'assistant-message' }, text);
    return node({ 'data-chatgpt-search-unit-key': 'fallback-turn:assistant' }, `ChatGPT сказал:\n${text}`, {
      '[data-conversation-role="assistant"]': heading,
      '[data-markdown-text-style="assistant-message"]': body,
    });
  };
  const form = { querySelectorAll: key => key.includes('button') ? [send] : [] };
  const composer = { ...visible, tagName: 'DIV', innerText: '',
    getAttribute: key => ({ contenteditable: 'true', 'aria-label': 'Спросить ChatGPT' })[key] ?? null,
    closest: key => key === 'form' ? form : null };
  const send = { ...visible, tagName: 'BUTTON', type: 'button',
    getAttribute: key => key === 'aria-label' ? 'Отправить' : null,
    click() { sends += 1; users.push(bubble(composer.innerText)); composer.innerText = ''; } };
  const main = { querySelector: key => key.includes('data-user-message-bubble') ? users[0] || null : null,
    querySelectorAll: () => [] };
  const document = { body: { innerText: '' }, visibilityState: 'visible',
    querySelector: key => key.includes('main') ? main : null,
    querySelectorAll(key) {
      if (key === '[data-user-message-bubble="true"]') return users;
      if (key.includes('[data-message-author-role="assistant"]')) return assistants;
      if (key.includes('[contenteditable="true"]')) return [composer];
      if (key === 'button, [role="button"]') return [send];
      return [];
    } };
  return { document, users, assistants, composer, bubble, reply, get sends() { return sends; } };
}

test('Work UI verifies second and third prompts only after a new user bubble, then reads each new reply', async () => {
  const { adapter } = loadAdapter();
  const chat = workChat();
  chat.users.push(chat.bubble('START'));
  chat.assistants.push(chat.reply('Перша відповідь.'));
  for (let turn = 2; turn <= 3; turn++) {
    const prompt = `Продовжуй ${turn}`;
    chat.composer.innerText = prompt;
    const request = validRequest({ requestId: `op-${turn}`, promptText: prompt, mode: 'SUBMIT_EXISTING' });
    const sent = await adapter.execute(request, { document: chat.document, wait: async () => {} });
    assert.equal(sent.status, adapter.STATUS.SENT_VERIFIED, `turn ${turn}: ${sent.safeDiagnosticCode}`);
    assert.equal(sent.assistantBaselineCount, turn - 1);
    assert.equal(chat.sends, turn - 1);
    const reportRequest = validRequest({ mode: 'READ_ASSISTANT_REPORT',
      assistantBaselineKnown: true, assistantBaselineCount: sent.assistantBaselineCount });
    const beforeReply = await adapter.execute(reportRequest, { document: chat.document });
    assert.equal(beforeReply.assistantComplete, false);
    chat.assistants.push(chat.reply(`Відповідь ${turn}.`));
    const afterReply = await adapter.execute(reportRequest, { document: chat.document });
    assert.equal(afterReply.status, adapter.STATUS.READY);
    assert.equal(afterReply.assistantText, `Відповідь ${turn}.`);
    assert.equal(afterReply.assistantComplete, true);
  }
});

test('Work UI ignores sidebar bubbles and reads only the user prompt body', async () => {
  const { adapter } = loadAdapter();
  const chat = workChat();
  const sidebar = chat.bubble('Продовжуй 2');
  sidebar.closest = () => null;
  chat.users.push(sidebar);
  const prior = chat.bubble('START\nКопіювати повідомлення');
  prior.closest = () => ({ tagName: 'MAIN' });
  prior.querySelector = selector => selector.includes('whitespace-pre-wrap') ? { innerText: 'START' } : null;
  chat.users.push(prior);
  chat.composer.innerText = 'Продовжуй 2';
  const sent = await adapter.execute(validRequest({ requestId: 'sidebar-op',
    promptText: 'Продовжуй 2', mode: 'SUBMIT_EXISTING' }),
  { document: chat.document, wait: async () => {} });
  assert.equal(sent.status, adapter.STATUS.SENT_VERIFIED);
  assert.equal(chat.sends, 1);
});

test('Work UI recognizes a keyed assistant reply without a localized role heading', async () => {
  const { adapter } = loadAdapter();
  const chat = workChat();
  const outside = chat.reply('Sidebar preview');
  outside.closest = () => null;
  const reply = chat.reply('Відповідь після першого промпта.');
  reply.closest = () => ({ tagName: 'MAIN' });
  reply.querySelector = selector => selector.includes('data-conversation-role') ? null
    : selector.includes('data-markdown-text-style') ? { innerText: 'Відповідь після першого промпта.' }
    : null;
  chat.assistants.push(outside, reply);
  const result = await adapter.execute(validRequest({ mode: 'READ_ASSISTANT_REPORT',
    assistantBaselineKnown: true, assistantBaselineCount: 0 }), { document: chat.document });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(result.assistantText, 'Відповідь після першого промпта.');
});

function powerSliderPage({ start = 1, reacts = true, total = 3 } = {}) {
  let value = start;
  let open = false;
  let keypresses = 0;
  const visible = { isConnected: true, getBoundingClientRect: () => ({ width: 100, height: 20 }) };
  const menu = { ...visible };
  const control = {
    ...visible, innerText: 'Средний',
    getAttribute: name => ({ 'aria-label': 'Выбрать модель ChatGPT', 'aria-haspopup': 'menu' })[name] || null,
    closest: () => null, focus() {}, click() { open = !open; }
  };
  const thumb = { getAttribute: name => ({
    'aria-valuemin': '0', 'aria-valuemax': '2', 'aria-valuenow': String(value)
  })[name] || null };
  const row = {
    ...visible,
    getAttribute: name => ({
      'aria-keyshortcuts': 'ArrowLeft ArrowRight', 'aria-describedby': 'effort-status effort-help'
    })[name] || null,
    closest: selector => selector === '[role="menu"]' ? menu : null,
    querySelector: selector => selector === '[role="slider"]' ? thumb : null,
    focus() {},
    dispatchEvent(event) {
      assert.equal(event.key, 'ArrowRight');
      keypresses += 1;
      if (reacts) value = Math.min(2, value + 1);
      return true;
    }
  };
  const document = {
    body: { innerText: '' },
    getElementById(id) {
      if (id !== 'effort-status') return null;
      return {
        innerText: ['Низкий', 'Средний', 'Высокий'][value] + `, ${value + 1} из ${total}.`,
        getAttribute: name => name === 'role' ? 'status' : null
      };
    },
    querySelectorAll(selector) {
      if (selector.includes('[data-reasoning-slider="true"]')) return open ? [row] : [];
      if (selector.includes('button, [role="button"], [role="combobox"]')) return [control];
      return [];
    }
  };
  return { document, state: () => ({ value, open, keypresses }) };
}

test('current ChatGPT three-step effort slider reaches High and proves its announced state', async () => {
  const { adapter } = loadAdapter({ KeyboardEvent: class KeyboardEvent {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  } });
  const page = powerSliderPage();
  const result = await adapter.execute(validRequest({ mode: 'ENSURE_HIGH_EFFORT' }),
    { document: page.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(result.effortLevel, 'high');
  assert.equal(result.safeDiagnosticCode, 'EFFORT_HIGH_SLIDER_CONFIRMED');
  assert.deepEqual(page.state(), { value: 2, open: false, keypresses: 1 });
});

test('effort slider fails closed if its key action is ignored or shape changes', async () => {
  const { adapter } = loadAdapter({ KeyboardEvent: class KeyboardEvent {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  } });
  for (const page of [powerSliderPage({ reacts: false }), powerSliderPage({ total: 4 })]) {
    const result = await adapter.execute(validRequest({ mode: 'ENSURE_HIGH_EFFORT' }),
      { document: page.document, wait: async () => {} });
    assert.notEqual(result.status, adapter.STATUS.READY);
    assert.equal(page.state().open, false);
  }
});

test('response stays bound to the submitted user message after history virtualization', async () => {
  const { adapter } = loadAdapter();
  const chat = workChat();
  const user = chat.bubble('CONTINUE');
  const originalAttr = user.getAttribute;
  user.getAttribute = name => name === 'data-message-id' ? 'current-user-id' : originalAttr(name);
  user.compareDocumentPosition = assistant => assistant.current ? 4 : 2;
  chat.users.push(user);
  const old = chat.reply('old answer'); chat.assistants.push(old);
  const request = validRequest({mode:'READ_ASSISTANT_REPORT',assistantBaselineKnown:true,assistantBaselineCount:17,
    submittedUserMessageKey:'message:current-user-id'});
  const pending = await adapter.execute(request,{document:chat.document});
  assert.equal(pending.assistantComplete,false,'old answer preceding current user cannot advance the scenario');
  const current = chat.reply('current answer');current.current=true;chat.assistants.splice(0,1,current);
  const ready = await adapter.execute(request,{document:chat.document});
  assert.equal(ready.assistantComplete,true,'one visible current answer is enough even when the saved history count is 17');
  assert.equal(ready.assistantText,'current answer');
  const wrong = await adapter.execute({...request,submittedUserMessageKey:'message:other-user'},{document:chat.document});
  assert.equal(wrong.assistantComplete,false);
});

test('a fresh verified generation can track its new answer when Work never mounts the user bubble', async () => {
  const { adapter } = loadAdapter();
  const chat = workChat();
  chat.assistants.push(chat.reply('Відповідь на перший промпт.'));
  const request = validRequest({ mode: 'READ_ASSISTANT_REPORT', assistantBaselineKnown: true,
    assistantBaselineCount: 0, responseCorrelationToken: '[APSTEP:slot:1]',
    freshConversationGenerationVerified: true });
  const ready = await adapter.execute(request, { document: chat.document });
  assert.equal(ready.status, adapter.STATUS.READY);
  assert.equal(ready.assistantText, 'Відповідь на перший промпт.');
  const unproven = await adapter.execute({ ...request, freshConversationGenerationVerified: false },
    { document: chat.document });
  assert.equal(unproven.assistantComplete, false, 'the fallback needs persisted proof from the physical fresh-chat Send');
});

test('already observed Send acknowledgement does not depend on a background timer', async () => {
  const { adapter } = loadAdapter({setTimeout(){throw Error('background timers are suspended');}});
  const chat = workChat();chat.composer.innerText='Continue now';
  const sent=await adapter.execute(validRequest({mode:'SUBMIT_EXISTING',promptText:'Continue now'}),{document:chat.document});
  assert.equal(sent.status,adapter.STATUS.SENT_VERIFIED);assert.equal(chat.sends,1);
});

test('a delayed request past its execution deadline cannot dispatch a physical Send',async()=>{
  const {adapter}=loadAdapter();const chat=workChat();chat.composer.innerText='Continue now';
  const result=await adapter.execute(validRequest({mode:'SUBMIT_EXISTING',promptText:'Continue now',executionDeadlineAt:1}),{document:chat.document});
  assert.equal(chat.sends,0);assert.equal(result.submissionEvidence,'PROVEN_NO_EFFECT');
  assert.equal(result.safeDiagnosticCode,'SEND_REQUEST_EXPIRED_BEFORE_EFFECT');
});

test('scenario step marker survives an optimistic user ID changing after reload', async () => {
  let clock = 2000;
  class ClockDate extends Date { static now() { return clock; } }
  const { adapter } = loadAdapter({Date: ClockDate});
  const chat = workChat();
  const user = chat.bubble('CONTINUE\n\nСлужбова мітка: [APSTEP:slot:12]');
  user.getAttribute = name => name === 'data-user-message-bubble' ? 'true'
    : name === 'data-message-id' ? 'server-id-after-reload' : null;
  user.compareDocumentPosition = assistant => assistant.current ? 4 : 2;
  chat.users.push(user);
  const current = chat.reply('New final report'); current.current = true;
  chat.assistants.push(current);
  const request = validRequest({mode:'READ_ASSISTANT_REPORT', assistantBaselineKnown:true,
    assistantBaselineCount:17, submittedUserMessageKey:'message:optimistic-id',
    responseCorrelationToken:'[APSTEP:slot:12]', requireStableResponse:true});
  const candidate = await adapter.execute(request,{document:chat.document});
  assert.equal(candidate.assistantComplete,false);
  assert.equal(candidate.responseAnchorKind,'STEP_MARKER');
  clock += 1001;
  const ready = await adapter.execute(request,{document:chat.document});
  assert.equal(ready.assistantComplete,true);
  assert.equal(ready.assistantText,'New final report');
  assert.equal(ready.submittedKeyMatched,false);
  const nextStep = await adapter.execute({...request,responseCorrelationToken:'[APSTEP:slot:13]'},{document:chat.document});
  assert.equal(nextStep.assistantComplete,false,'a repeated CONTINUE from another step cannot supply its answer');
});

test('a reply before the marked user turn cannot advance a scenario', async () => {
  const { adapter } = loadAdapter(); const chat = workChat();
  const user = chat.bubble('CONTINUE [APSTEP:slot:2]'); user.compareDocumentPosition = () => 2;
  chat.users.push(user); chat.assistants.push(chat.reply('Old report quoting [APSTEP:slot:2]'));
  const result = await adapter.execute(validRequest({mode:'READ_ASSISTANT_REPORT',
    assistantBaselineKnown:true, assistantBaselineCount:0, responseCorrelationToken:'[APSTEP:slot:2]'}),{document:chat.document});
  assert.equal(result.assistantComplete,false);
  assert.equal(result.assistantText,'');
});

test('legacy fresh-chat response can be matched only to its sole exact user prompt', async () => {
  const { adapter } = loadAdapter(); const chat = workChat();
  const user = chat.bubble('START exact'); user.compareDocumentPosition = () => 4;
  chat.users.push(user); chat.assistants.push(chat.reply('Legacy answer'));
  const request = validRequest({mode:'READ_ASSISTANT_REPORT', assistantBaselineKnown:true,
    assistantBaselineCount:0, submittedUserMessageKey:'turn:old-layout',submittedPromptText:'START exact'});
  const ready = await adapter.execute(request,{document:chat.document});
  assert.equal(ready.assistantComplete,true); assert.equal(ready.responseAnchorKind,'LEGACY_SINGLE_TURN');
  chat.users.unshift(chat.bubble('START exact'));
  const historical = await adapter.execute(request,{document:chat.document});
  assert.equal(historical.assistantComplete,false);
});
