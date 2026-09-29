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
