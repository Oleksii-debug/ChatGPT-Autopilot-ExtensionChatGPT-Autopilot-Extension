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
  class FakeDate extends Date { static now() { clock += 1000; return clock; } }
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

function request(mode) {
  return {
    requestId: 'op-send-control-1',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText: PROMPT,
    mode
  };
}

function makeButton({ ariaLabel = '', testId = '', text = '', disabled = false, onClick = null } = {}) {
  let clicks = 0;
  return {
    isConnected: true,
    hidden: false,
    disabled,
    tagName: 'BUTTON',
    innerText: text,
    getAttribute(name) {
      if (name === 'aria-label') return ariaLabel || null;
      if (name === 'data-testid') return testId || null;
      if (name === 'aria-disabled') return disabled ? 'true' : 'false';
      return null;
    },
    getBoundingClientRect() { return { width: 24, height: 24 }; },
    click() {
      clicks += 1;
      onClick?.();
    },
    clicks() { return clicks; }
  };
}

function fixture(buttons) {
  const messages = [];
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
    value: PROMPT,
    getAttribute(name) {
      if (name === 'aria-label') return 'Message';
      return null;
    },
    getBoundingClientRect() { return { width: 120, height: 30 }; },
    closest(name) { return name === 'form' ? form : null; },
    focus() {},
    dispatchEvent() {}
  };
  const document = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return [composer];
      if (selector === 'button, [role="button"]') return buttons;
      if (selector === '[role="dialog"], dialog') return [];
      if (selector === '[data-message-author-role="user"], [data-author="user"], article') return messages;
      return [];
    }
  };
  function appendSubmission() {
    messages.push({
      isConnected: true,
      hidden: false,
      disabled: false,
      innerText: composer.value,
      getAttribute(name) { return name === 'data-message-author-role' ? 'user' : null; },
      getBoundingClientRect() { return { width: 120, height: 30 }; }
    });
    composer.value = '';
  }
  return { document, composer, messages, appendSubmission };
}

test('PREPARE_SEND rejects a lone Send feedback decoy without clicking it', async () => {
  const adapter = loadAdapter();
  const feedback = makeButton({ ariaLabel: 'Send feedback' });
  const fx = fixture([feedback]);
  const result = await adapter.execute(request('PREPARE_SEND'), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.INSERTED_NOT_SENT);
  assert.equal(result.safeDiagnosticCode, 'SEND_NOT_ENABLED_PRE_SEND');
  assert.equal(feedback.clicks(), 0);
});

test('SUBMIT_EXISTING rejects a lone Submit file decoy without any effect', async () => {
  const adapter = loadAdapter();
  const submitFile = makeButton({ ariaLabel: 'Submit file' });
  const fx = fixture([submitFile]);
  const result = await adapter.execute(request('SUBMIT_EXISTING'), { document: fx.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.INSERTED_NOT_SENT);
  assert.equal(submitFile.clicks(), 0);
});

test('strong send-button identity outranks a visible Send feedback decoy', async () => {
  const adapter = loadAdapter();
  let fx;
  const actual = makeButton({ ariaLabel: 'Send message', testId: 'send-button', onClick: () => fx.appendSubmission() });
  const feedback = makeButton({ ariaLabel: 'Send feedback' });
  fx = fixture([feedback, actual]);
  const result = await adapter.execute(request('SUBMIT_EXISTING'), { document: fx.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.SENT_VERIFIED);
  assert.equal(actual.clicks(), 1);
  assert.equal(feedback.clicks(), 0);
});

test('stable send-button test id works even when aria label is localized', async () => {
  const adapter = loadAdapter();
  let fx;
  const actual = makeButton({ ariaLabel: 'Надіслати', testId: 'send-button', onClick: () => fx.appendSubmission() });
  fx = fixture([actual]);
  const result = await adapter.execute(request('SUBMIT_EXISTING'), { document: fx.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.SENT_VERIFIED);
  assert.equal(actual.clicks(), 1);
});

test('two equally strong visible Send controls fail closed', async () => {
  const adapter = loadAdapter();
  const first = makeButton({ ariaLabel: 'Send message', testId: 'send-button' });
  const second = makeButton({ ariaLabel: 'Send message', testId: 'send-button' });
  const fx = fixture([first, second]);
  const result = await adapter.execute(request('PREPARE_SEND'), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.INSERTED_NOT_SENT);
  assert.equal(result.safeDiagnosticCode, 'SEND_NOT_ENABLED_PRE_SEND');
  assert.equal(first.clicks(), 0);
  assert.equal(second.clicks(), 0);
});
