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

function visibleDialog(text) {
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    innerText: text,
    getAttribute() { return null; },
    getBoundingClientRect() { return { width: 300, height: 120 }; }
  };
}

test('localized unknown confirmation dialog fails closed without relying on English keywords', () => {
  const adapter = loadAdapter();
  const dialog = visibleDialog('Підтвердьте дію, щоб продовжити');
  const doc = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog') return [dialog];
      return [];
    }
  };
  const result = adapter.detectBlockingState(doc);
  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.code, 'UNRECOGNIZED_DIALOG');
});

test('known security dialog remains manual review', () => {
  const adapter = loadAdapter();
  const dialog = visibleDialog('Security verification required');
  const doc = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog') return [dialog];
      return [];
    }
  };
  const result = adapter.detectBlockingState(doc);
  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.code, 'UNKNOWN_OR_SECURITY_DIALOG');
});
