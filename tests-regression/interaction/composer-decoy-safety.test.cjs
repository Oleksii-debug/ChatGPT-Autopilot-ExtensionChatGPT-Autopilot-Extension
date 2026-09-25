'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAdapter() {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/chatgpt-adapter.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  class FakeEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  class FakeTextAreaElement {}
  class FakeInputElement {}
  const sandbox = {
    URL,
    Date,
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

function makeTextarea({ label = 'Search notes', ariaDisabled = 'false', id = '' } = {}) {
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'TEXTAREA',
    value: '',
    id,
    getAttribute(name) {
      if (name === 'aria-label') return label;
      if (name === 'aria-disabled') return ariaDisabled;
      return null;
    },
    getBoundingClientRect() { return { width: 120, height: 30 }; },
    closest() { return null; },
    focus() {},
    dispatchEvent() {}
  };
}

function documentWith(editors) {
  return {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return editors;
      if (selector === 'button, [role="button"]') return [];
      if (selector === '[role="dialog"], dialog') return [];
      if (selector === '[data-message-author-role="user"], [data-author="user"], article') return [];
      return [];
    }
  };
}

test('single unrelated textarea is not accepted as the ChatGPT composer', () => {
  const adapter = loadAdapter();
  const decoy = makeTextarea({ label: 'Search notes' });
  const found = adapter.findVisibleComposer(documentWith([decoy]));
  assert.equal(found.element, null);
  assert.equal(found.ambiguous, false);
});

test('INSERT_ONLY never mutates an unrelated textarea while the real composer is absent', async () => {
  const adapter = loadAdapter();
  const decoy = makeTextarea({ label: 'Search notes' });
  const result = await adapter.execute({
    requestId: 'op-decoy-1',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText: 'exact prompt that must stay out of the decoy',
    mode: 'INSERT_ONLY'
  }, { document: documentWith([decoy]), wait: async () => {} });

  assert.equal(result.status, adapter.STATUS.TEMPORARY_ERROR);
  assert.equal(result.safeDiagnosticCode, 'COMPOSER_NOT_READY');
  assert.equal(decoy.value, '');
});

test('aria-disabled prompt-like textarea is rejected', () => {
  const adapter = loadAdapter();
  const disabled = makeTextarea({ label: 'Message', ariaDisabled: 'true' });
  const found = adapter.findVisibleComposer(documentWith([disabled]));
  assert.equal(found.element, null);
  assert.equal(found.ambiguous, false);
});

test('prompt semantic evidence still accepts the real composer surface', () => {
  const adapter = loadAdapter();
  const composer = makeTextarea({ label: 'Message' });
  const found = adapter.findVisibleComposer(documentWith([composer]));
  assert.equal(found.element, composer);
  assert.equal(found.ambiguous, false);
});

test('prompt-textarea id is accepted when accessibility text is temporarily absent', () => {
  const adapter = loadAdapter();
  const composer = makeTextarea({ label: '', id: 'prompt-textarea' });
  const found = adapter.findVisibleComposer(documentWith([composer]));
  assert.equal(found.element, composer);
  assert.equal(found.ambiguous, false);
});
