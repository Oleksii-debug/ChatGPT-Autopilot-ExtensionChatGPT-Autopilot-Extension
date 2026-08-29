'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAdapter() {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/chatgpt-adapter.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  let clock = 0;
  class FakeDate extends Date { static now() { clock += 100; return clock; } }
  class FakeEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  class FakeTextAreaElement {}
  class FakeInputElement {}
  const sandbox = {
    URL,
    Date: FakeDate,
    setTimeout,
    clearTimeout,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    HTMLTextAreaElement: FakeTextAreaElement,
    HTMLInputElement: FakeInputElement,
    console,
    location: { href: 'https://chatgpt.com/c/abc' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: sourcePath });
  return { adapter: sandbox.ChatGPTInteractionAdapter, sandbox };
}

function request(mode, overrides = {}) {
  return Object.assign({
    requestId: 'operation-1',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText: 'exact recovery prompt',
    mode
  }, overrides);
}

function fixture({ composerText = '', userMessages = [], bodyText = '', buttons = [], statusTexts = [] } = {}) {
  let clicks = 0;
  const form = {
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return buttons;
      return [];
    },
    getAttribute() { return null; }
  };
  const composer = {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'TEXTAREA',
    value: composerText,
    getAttribute(name) { return name === 'aria-label' ? 'Message' : null; },
    getBoundingClientRect() { return { width: 100, height: 20 }; },
    closest(name) { return name === 'form' ? form : null; },
    focus() {},
    dispatchEvent() {}
  };
  const messages = userMessages.map((text) => ({
    isConnected: true,
    hidden: false,
    disabled: false,
    innerText: text,
    getAttribute(name) { return name === 'data-message-author-role' ? 'user' : null; },
    getBoundingClientRect() { return { width: 100, height: 20 }; }
  }));
  const statuses = statusTexts.map((text) => ({
    isConnected: true,
    hidden: false,
    disabled: false,
    innerText: text,
    getAttribute(name) { return name === 'role' ? 'alert' : null; },
    getBoundingClientRect() { return { width: 100, height: 20 }; }
  }));
  for (const button of buttons) {
    const original = button.click;
    button.click = () => { clicks += 1; original?.(); };
  }
  const document = {
    body: { innerText: bodyText },
    querySelectorAll(selector) {
      if (selector === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return [composer];
      if (selector === 'button, [role="button"]') return buttons;
      if (selector === '[role="dialog"], dialog') return [];
      if (selector === '[role="alert"], [role="status"], [aria-live="assertive"]') return statuses;
      if (selector === '[data-message-author-role="user"], [data-author="user"], article') return messages;
      return [];
    }
  };
  return { document, composer, clicks: () => clicks };
}

function stopButton() {
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'BUTTON',
    innerText: 'Stop generating',
    getAttribute(name) { return name === 'aria-label' ? 'Stop generating' : null; },
    getBoundingClientRect() { return { width: 20, height: 20 }; },
    click() { throw new Error('Stop must never be clicked by the adapter'); }
  };
}

test('uncertain recovery does not treat plain matching history as operation proof', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture({ userMessages: ['older', 'exact recovery prompt'] });
  const result = await adapter.execute(request('VERIFY_AFTER_UNCERTAIN_SUBMIT'), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.SUBMISSION_UNCERTAIN);
  assert.equal(result.safeDiagnosticCode, 'RECOVERY_STALE_MATCH_UNPROVEN');
  assert.equal(result.submissionEvidence, 'HISTORY_MATCH_NOT_OPERATION_BOUND');
  assert.equal(fx.clicks(), 0);
});

test('uncertain recovery recognizes the exact prompt still pending in composer', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture({ composerText: 'exact recovery prompt' });
  const result = await adapter.execute(request('VERIFY_AFTER_UNCERTAIN_SUBMIT'), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.INSERTED_NOT_SENT);
  assert.equal(result.safeDiagnosticCode, 'RECOVERY_PROMPT_PENDING');
  assert.equal(fx.clicks(), 0);
});

test('recovery fails closed on a different conversation URL before using DOM evidence', async () => {
  const { adapter, sandbox } = loadAdapter();
  sandbox.location.href = 'https://chatgpt.com/c/other';
  const fx = fixture({ userMessages: ['exact recovery prompt'] });
  const result = await adapter.execute(request('VERIFY_AFTER_UNCERTAIN_SUBMIT'), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.TEMPORARY_ERROR);
  assert.match(result.safeDiagnosticCode, /^URL_MISMATCH/);
  assert.equal(fx.clicks(), 0);
});

test('PREPARE_SEND reports BUSY and never activates the Stop control', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture({ composerText: 'exact recovery prompt', buttons: [stopButton()] });
  const result = await adapter.execute(request('PREPARE_SEND'), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.BUSY);
  assert.match(result.safeDiagnosticCode, /^STOP_CONTROL_VISIBLE/);
  assert.equal(fx.clicks(), 0);
});

test('rate-limit surface blocks SUBMIT_EXISTING before any Send effect', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture({
    composerText: 'exact recovery prompt',
    bodyText: 'conversation text is not error evidence',
    statusTexts: ['Too many requests. Try again later.']
  });
  const result = await adapter.execute(request('SUBMIT_EXISTING'), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.RATE_LIMITED);
  assert.match(result.safeDiagnosticCode, /^RATE_LIMIT_SURFACE_VISIBLE/);
  assert.equal(fx.clicks(), 0);
});
