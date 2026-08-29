'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROMPT = 'exact pending prompt';

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

function request() {
  return {
    requestId: 'op-send-proof-1',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText: PROMPT,
    mode: 'SUBMIT_EXISTING'
  };
}

function userMessage(text, { hidden = false } = {}) {
  return {
    isConnected: true,
    hidden,
    disabled: false,
    innerText: text,
    getAttribute(name) {
      if (name === 'data-message-author-role') return 'user';
      return null;
    },
    getBoundingClientRect() { return { width: 100, height: 20 }; }
  };
}

function fixture(initialValue = PROMPT, options = {}) {
  const messages = [...(options.messages || [])];
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
      if (options.onClick) {
        options.onClick({ messages, composer });
        return;
      }
      messages.push(userMessage(composer.value));
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
  return { document, composer, messages, clicks: () => clicks };
}

test('SUBMIT_EXISTING verifies one strict post-click appended user message', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture();
  const result = await adapter.execute(request(), { document: fx.document, wait: async () => {} });
  assert.equal(fx.clicks(), 1);
  assert.equal(result.status, adapter.STATUS.SENT_VERIFIED);
  assert.equal(result.submissionEvidence, 'NEW_USER_MESSAGE_MATCH');
});

test('hidden stale identical history becoming visible after click is not operation-local proof', async () => {
  const { adapter } = loadAdapter();
  const stale = userMessage(PROMPT, { hidden: true });
  const fx = fixture(PROMPT, {
    messages: [stale],
    onClick({ composer }) {
      stale.hidden = false;
      composer.value = '';
    }
  });

  const result = await adapter.execute(request(), { document: fx.document, wait: async () => {} });
  assert.equal(fx.clicks(), 1);
  assert.equal(result.status, adapter.STATUS.SUBMISSION_UNCERTAIN);
  assert.notEqual(result.status, adapter.STATUS.SENT_VERIFIED);
});

test('post-click exact prompt still pending in composer blocks SENT_VERIFIED', async () => {
  const { adapter } = loadAdapter();
  const fx = fixture(PROMPT, {
    onClick({ messages }) {
      messages.push(userMessage(PROMPT));
    }
  });

  const result = await adapter.execute(request(), { document: fx.document, wait: async () => {} });
  assert.equal(fx.clicks(), 1);
  assert.equal(result.status, adapter.STATUS.SUBMISSION_UNCERTAIN);
  assert.equal(result.safeDiagnosticCode, 'POST_CLICK_PROMPT_STILL_PENDING');
});

test('SPA navigation away after click cannot produce SENT_VERIFIED', async () => {
  const { adapter, sandbox } = loadAdapter();
  const fx = fixture(PROMPT, {
    onClick({ messages, composer }) {
      messages.push(userMessage(PROMPT));
      composer.value = '';
      sandbox.location.href = 'https://chatgpt.com/c/other';
    }
  });

  const result = await adapter.execute(request(), { document: fx.document, wait: async () => {} });
  assert.equal(fx.clicks(), 1);
  assert.equal(result.status, adapter.STATUS.SUBMISSION_UNCERTAIN);
  assert.equal(result.safeDiagnosticCode, 'URL_CHANGED_AFTER_SEND_CLICK');
});
