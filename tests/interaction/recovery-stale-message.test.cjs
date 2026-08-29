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
  return sandbox.ChatGPTInteractionAdapter;
}

function request() {
  return {
    requestId: 'op-repeat-2',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText: 'same recurring prompt',
    mode: 'VERIFY_AFTER_UNCERTAIN_SUBMIT'
  };
}

function fixture({ composerValue = '', previousMessages = [] } = {}) {
  const composer = {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'TEXTAREA',
    value: composerValue,
    getAttribute(name) {
      if (name === 'aria-label') return 'Message';
      return null;
    },
    getBoundingClientRect() { return { width: 100, height: 20 }; },
    closest() { return null; }
  };
  const messages = previousMessages.map((text) => ({
    isConnected: true,
    hidden: false,
    disabled: false,
    innerText: text,
    getAttribute(name) { return name === 'data-message-author-role' ? 'user' : null; },
    getBoundingClientRect() { return { width: 100, height: 20 }; }
  }));
  const document = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return [composer];
      if (selector === 'button, [role="button"]') return [];
      if (selector === '[role="dialog"], dialog') return [];
      if (selector === '[data-message-author-role="user"], [data-author="user"], article') return messages;
      return [];
    }
  };
  return { document };
}

test('uncertain recovery must not treat an old identical recurring prompt as proof of this operation', async () => {
  const adapter = loadAdapter();
  const fx = fixture({ previousMessages: ['same recurring prompt'] });
  const result = await adapter.execute(request(), { document: fx.document });
  assert.notEqual(result.status, adapter.STATUS.SENT_VERIFIED,
    'old identical prompt has no operation identity and cannot prove the current submit');
  assert.equal(result.status, adapter.STATUS.SUBMISSION_UNCERTAIN);
});

test('pending exact composer text outranks an old identical message during uncertain recovery', async () => {
  const adapter = loadAdapter();
  const fx = fixture({
    composerValue: 'same recurring prompt',
    previousMessages: ['same recurring prompt']
  });
  const result = await adapter.execute(request(), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.INSERTED_NOT_SENT,
    'prompt still in composer proves this operation was not safely established as sent');
  assert.equal(result.safeDiagnosticCode, 'RECOVERY_PROMPT_PENDING');
});
