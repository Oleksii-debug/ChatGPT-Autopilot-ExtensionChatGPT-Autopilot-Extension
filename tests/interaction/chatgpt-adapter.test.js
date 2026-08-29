'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../../src/interaction/chatgpt-adapter.js');

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
  assert.equal(
    adapter.normalizeUrl('https://chatgpt.com/c/abc/?x=1#frag'),
    'https://chatgpt.com/c/abc'
  );
});

test('sameExpectedChat rejects another conversation', () => {
  assert.equal(adapter.sameExpectedChat('https://chatgpt.com/c/abc', 'https://chatgpt.com/c/abc'), true);
  assert.equal(adapter.sameExpectedChat('https://chatgpt.com/c/def', 'https://chatgpt.com/c/abc'), false);
  assert.equal(adapter.sameExpectedChat('https://example.com/c/abc', 'https://chatgpt.com/c/abc'), false);
});

test('request validation rejects unsafe/malformed operations', () => {
  assert.equal(adapter.validateRequest(validRequest()), null);
  assert.equal(adapter.validateRequest(validRequest({ preSendDelayMs: 999 })), 'PRE_SEND_DELAY_INVALID');
  assert.equal(adapter.validateRequest(validRequest({ preSendDelayMs: 30001 })), 'PRE_SEND_DELAY_INVALID');
  assert.equal(adapter.validateRequest(validRequest({ promptText: undefined })), 'PROMPT_MISSING');
  assert.equal(adapter.validateRequest(validRequest({ mode: 'CLICK_EVERYTHING' })), 'MODE_INVALID');
});

test('CHECK_ONLY does not mutate DOM and rejects URL mismatch', async () => {
  const previousLocation = global.location;
  global.location = { href: 'https://chatgpt.com/c/other' };
  const fakeDocument = { querySelectorAll: () => [], body: { innerText: '' } };
  const result = await adapter.execute(validRequest({ mode: 'CHECK_ONLY' }), { document: fakeDocument });
  assert.equal(result.status, adapter.STATUS.TEMPORARY_ERROR);
  assert.equal(result.safeDiagnosticCode, 'URL_MISMATCH');
  global.location = previousLocation;
});

test('malformed request returns fail-closed result before DOM mutation', async () => {
  let queried = 0;
  const fakeDocument = { querySelectorAll: () => { queried += 1; return []; }, body: { innerText: '' } };
  const result = await adapter.execute(validRequest({ preSendDelayMs: 10 }), { document: fakeDocument });
  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.safeDiagnosticCode, 'PRE_SEND_DELAY_INVALID');
  assert.equal(queried, 0);
});

test('rate limit is classified without retry or send', () => {
  const previousLocation = global.location;
  global.location = { href: 'https://chatgpt.com/c/abc' };
  const fakeDocument = {
    body: { innerText: 'Too many requests. Try again later.' },
    querySelectorAll(selector) {
      if (selector.includes('button')) return [];
      if (selector.includes('[role="dialog"]')) return [];
      if (selector.includes('textarea')) return [];
      return [];
    }
  };
  const block = adapter.detectBlockingState(fakeDocument);
  assert.equal(block.status, adapter.STATUS.RATE_LIMITED);
  global.location = previousLocation;
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
  const previousStyle = global.getComputedStyle;
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  const fakeDocument = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return [stopButton];
      if (selector.includes('[role="dialog"]')) return [];
      return [];
    }
  };
  const block = adapter.detectBlockingState(fakeDocument);
  assert.equal(block.status, adapter.STATUS.BUSY);
  assert.equal(block.code, 'STOP_CONTROL_VISIBLE');
  global.getComputedStyle = previousStyle;
});

test('ambiguous equal visible composers fail closed', () => {
  const previousStyle = global.getComputedStyle;
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
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
  global.getComputedStyle = previousStyle;
});
