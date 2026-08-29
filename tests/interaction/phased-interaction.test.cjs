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
  class FakeDate extends Date {
    static now() { clock += 1000; return clock; }
  }
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
    requestId: 'op-phase-1',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText: 'exact pending prompt',
    preSendDelayMs: 1000,
    mode
  }, overrides);
}

function fixture(initialValue = '') {
  const messages = [];
  let clicks = 0;
  const form = {
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return [send];
      return [];
    },
    getAttribute() { return null; }
  };
  const composer = {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'TEXTAREA',
    value: initialValue,
    getAttribute(name) {
      if (name === 'aria-label') return 'Message';
      return null;
    },
    getBoundingClientRect() { return { width: 100, height: 20 }; },
    closest(name) { return name === 'form' ? form : null; },
    focus() {},
    dispatchEvent() {}
  };
  const send = {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'BUTTON',
    innerText: '',
    getAttribute(name) {
      if (name === 'aria-label') return 'Send message';
      if (name === 'aria-disabled') return 'false';
      return null;
    },
    getBoundingClientRect() { return { width: 20, height: 20 }; },
    click() {
      clicks += 1;
      messages.push({
        isConnected: true,
        hidden: false,
        disabled: false,
        innerText: composer.value,
        getAttribute(name) { return name === 'data-message-author-role' ? 'user' : null; },
        getBoundingClientRect() { return { width: 100, height: 20 }; }
      });
      composer.value = '';
    }
  };
  const document = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return [composer];
      if (selector === 'button, [role="button"]') return [send];
      if (selector === '[role="dialog"], dialog') return [];
      if (selector === '[data-message-author-role="user"], [data-author="user"], article') return messages;
      return [];
    }
  };
  return { document, composer, send, messages, clicks: () => clicks };
}

test('phased modes validate prompt requirements without requiring legacy delay', () => {
  const { adapter } = loadAdapter();
  assert.equal(adapter.validateRequest(request('INSERT_ONLY')), null);
  assert.equal(adapter.validateRequest(request('PREPARE_SEND')), null);
  assert.equal(adapter.validateRequest(request('SUBMIT_EXISTING')), null);
  assert.equal(adapter.validateRequest(request('SUBMIT_EXISTING', { promptText: undefined })), 'PROMPT_MISSING');
});

test('INSERT_ONLY proves insertion and performs zero Send clicks', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture('');
  const result = await adapter.execute(request('INSERT_ONLY'), { document: fx.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.INSERTED_NOT_SENT);
  assert.equal(result.safeDiagnosticCode, 'INSERTION_TEXT_PROVEN');
  assert.equal(fx.composer.value, 'exact pending prompt');
  assert.equal(fx.clicks(), 0);
});

test('INSERT_ONLY refuses to overwrite unrelated composer content', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture('user draft');
  const result = await adapter.execute(request('INSERT_ONLY'), { document: fx.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.safeDiagnosticCode, 'COMPOSER_CONTAINS_OTHER_CONTENT');
  assert.equal(fx.composer.value, 'user draft');
  assert.equal(fx.clicks(), 0);
});

test('PREPARE_SEND revalidates exact pending prompt and never clicks Send', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture('exact pending prompt');
  const result = await adapter.execute(request('PREPARE_SEND'), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(result.safeDiagnosticCode, 'PENDING_PROMPT_READY_TO_SUBMIT');
  assert.equal(fx.clicks(), 0);
});

test('PREPARE_SEND fails closed when pending prompt changed', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture('changed prompt');
  const result = await adapter.execute(request('PREPARE_SEND'), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.safeDiagnosticCode, 'PENDING_PROMPT_MISMATCH_PRE_SEND');
  assert.equal(fx.clicks(), 0);
});

test('SUBMIT_EXISTING is the only phased call that performs Send and verifies result', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture('exact pending prompt');
  const result = await adapter.execute(request('SUBMIT_EXISTING'), { document: fx.document, wait: async () => {} });
  assert.equal(fx.clicks(), 1);
  assert.equal(result.status, adapter.STATUS.SENT_VERIFIED);
  assert.equal(result.submissionEvidence, 'NEW_USER_MESSAGE_MATCH');
});

test('SUBMIT_EXISTING performs zero clicks after a prompt swap', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture('attacker changed prompt');
  const result = await adapter.execute(request('SUBMIT_EXISTING'), { document: fx.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(fx.clicks(), 0);
});
