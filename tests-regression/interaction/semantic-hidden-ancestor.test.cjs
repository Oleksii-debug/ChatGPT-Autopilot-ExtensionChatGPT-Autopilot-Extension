'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

function loadAdapter() {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/chatgpt-adapter.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sandbox = {
    URL,
    Date,
    setTimeout,
    clearTimeout,
    console,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    location: { href: 'https://chatgpt.com/c/abc' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: sourcePath });
  return sandbox.ChatGPTInteractionAdapter;
}

function semanticParent({ ariaHidden = false, inertAttribute = false, inertProperty = false, parentElement = null } = {}) {
  return {
    parentElement,
    hidden: false,
    inert: inertProperty,
    getAttribute(name) {
      if (name === 'aria-hidden' && ariaHidden) return 'true';
      if (name === 'inert' && inertAttribute) return '';
      return null;
    }
  };
}

function composer({ parentElement = null, disabledState = false, label = 'Message' } = {}) {
  let value = '';
  let dispatches = 0;
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'TEXTAREA',
    parentElement,
    get value() { return value; },
    set value(next) { value = String(next); },
    getAttribute(name) {
      if (name === 'aria-label') return label;
      if (name === 'aria-disabled') return 'false';
      return null;
    },
    matches(selector) {
      return selector === ':disabled' ? disabledState : false;
    },
    getBoundingClientRect() { return { width: 500, height: 80 }; },
    closest() { return null; },
    focus() {},
    dispatchEvent() { dispatches += 1; return true; },
    mutationCount() { return dispatches; }
  };
}

function page(candidates) {
  return {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return candidates;
      return [];
    }
  };
}

function request() {
  return {
    requestId: 'hidden-op-1',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText: 'Do not write into a hidden composer',
    mode: 'INSERT_ONLY'
  };
}

test('composer under aria-hidden ancestor is rejected despite non-zero geometry', () => {
  const adapter = loadAdapter();
  const candidate = composer({ parentElement: semanticParent({ ariaHidden: true }) });
  const found = adapter.findVisibleComposer(page([candidate]));
  assert.equal(found.element, null);
  assert.equal(found.ambiguous, false);
});

test('composer under inert ancestor is rejected for attribute and property forms', () => {
  const adapter = loadAdapter();
  const byAttribute = composer({ parentElement: semanticParent({ inertAttribute: true }) });
  const byProperty = composer({ parentElement: semanticParent({ inertProperty: true }) });
  assert.equal(adapter.findVisibleComposer(page([byAttribute])).element, null);
  assert.equal(adapter.findVisibleComposer(page([byProperty])).element, null);
});

test('browser :disabled state rejects a control disabled by surrounding form semantics', () => {
  const adapter = loadAdapter();
  const candidate = composer({ disabledState: true });
  assert.equal(candidate.disabled, false, 'fixture proves direct disabled property is not the evidence');
  assert.equal(adapter.findVisibleComposer(page([candidate])).element, null);
});

test('hidden semantic decoy is removed before multiple-composer ranking', () => {
  const adapter = loadAdapter();
  const hiddenDecoy = composer({ parentElement: semanticParent({ ariaHidden: true }), label: 'Message' });
  const real = composer({ parentElement: semanticParent(), label: 'Message' });
  const found = adapter.findVisibleComposer(page([hiddenDecoy, real]));
  assert.equal(found.element, real);
  assert.equal(found.ambiguous, false);
});

test('INSERT_ONLY never mutates a composer hidden by ancestor semantics', async () => {
  const adapter = loadAdapter();
  const candidate = composer({ parentElement: semanticParent({ inertAttribute: true }) });
  const result = await adapter.execute(request(), { document: page([candidate]), wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.TEMPORARY_ERROR);
  assert.equal(result.safeDiagnosticCode, 'COMPOSER_NOT_READY');
  assert.equal(candidate.value, '');
  assert.equal(candidate.mutationCount(), 0);
});
