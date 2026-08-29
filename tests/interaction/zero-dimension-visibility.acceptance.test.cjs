'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAdapter() {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/chatgpt-adapter.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sandbox = {
    URL,
    Date,
    setTimeout,
    clearTimeout,
    console,
    location: { href: 'https://chatgpt.com/c/abc' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: sourcePath });
  return sandbox.ChatGPTInteractionAdapter;
}

function editor(width, height) {
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'DIV',
    innerText: '',
    getAttribute(name) {
      if (name === 'contenteditable') return 'true';
      if (name === 'aria-label') return 'Message';
      return null;
    },
    getBoundingClientRect() { return { width, height }; },
    closest() { return null; }
  };
}

function documentWith(...editors) {
  return {
    querySelectorAll(selector) {
      if (selector.includes('contenteditable')) return editors;
      return [];
    }
  };
}

test('zero-width semantic composer is not a visible competing candidate', () => {
  const adapter = loadAdapter();
  const real = editor(320, 40);
  const zeroWidthDecoy = editor(0, 40);
  const found = adapter.findVisibleComposer(documentWith(zeroWidthDecoy, real));

  assert.equal(found.ambiguous, false);
  assert.equal(found.element, real);
});

test('zero-height semantic composer is not a visible competing candidate', () => {
  const adapter = loadAdapter();
  const real = editor(320, 40);
  const zeroHeightDecoy = editor(320, 0);
  const found = adapter.findVisibleComposer(documentWith(real, zeroHeightDecoy));

  assert.equal(found.ambiguous, false);
  assert.equal(found.element, real);
});
