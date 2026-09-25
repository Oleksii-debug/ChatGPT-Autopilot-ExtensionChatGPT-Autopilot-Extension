import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adapter = require('../src/interaction/chatgpt-adapter.js');

function el({ role = '', text = '', aria = '', children = [] } = {}) {
  return {
    isConnected: true,
    disabled: false,
    hidden: false,
    innerText: text,
    textContent: text,
    value: '',
    title: '',
    parentElement: null,
    getAttribute(name) {
      if (name === 'data-message-author-role' || name === 'data-author') return role;
      if (name === 'aria-label') return aria;
      return null;
    },
    matches() { return false; },
    contains(other) { return children.includes(other); },
    querySelectorAll(selector) {
      if (selector.includes('.whitespace-pre-wrap') || selector.includes('[data-message-content]') || selector.includes('[class*="markdown"]')) {
        return children;
      }
      return [];
    },
  };
}

function docWith({ assistantText = '', busy = false } = {}) {
  const body = el({ text: assistantText });
  const assistant = el({ role: 'assistant', text: assistantText, children: [body] });
  const stop = el({ text: 'Stop generating', aria: 'Stop generating' });
  return {
    visibilityState: 'visible',
    querySelectorAll(selector) {
      if (selector.includes('[data-message-author-role="assistant"]')) return assistantText ? [assistant] : [];
      if (selector === 'button, [role="button"]') return busy ? [stop] : [];
      if (selector.includes('[role="dialog"]') || selector.includes('[role="alertdialog"]') || selector.includes('[aria-modal="true"]')) return [];
      if (selector.includes('[role="alert"]') || selector.includes('[role="status"]')) return [];
      if (selector.includes('textarea') || selector.includes('[contenteditable="true"]')) return [];
      return [];
    },
  };
}

test('READ_ASSISTANT_REPORT returns final assistant text when generation is complete', async () => {
  const oldLocation = globalThis.location;
  globalThis.location = { href: 'https://chatgpt.com/c/abc123' };
  try {
    const result = await adapter.execute({
      requestId: 'r1', taskId: 't1', mode: 'READ_ASSISTANT_REPORT', expectedUrl: 'https://chatgpt.com/c/abc123', promptText: '', assistantBaselineKnown: true, assistantBaselineCount: 0,
    }, { document: docWith({ assistantText: 'final worker report', busy: false }) });
    assert.equal(result.status, 'READY');
    assert.equal(result.assistantComplete, true);
    assert.equal(result.assistantText, 'final worker report');
    assert.equal(result.safeDiagnosticCode, 'ASSISTANT_RESPONSE_READY');
  } finally {
    globalThis.location = oldLocation;
  }
});

test('READ_ASSISTANT_REPORT does not treat a streaming response as final', async () => {
  const oldLocation = globalThis.location;
  globalThis.location = { href: 'https://chatgpt.com/c/abc123' };
  try {
    const result = await adapter.execute({
      requestId: 'r2', taskId: 't1', mode: 'READ_ASSISTANT_REPORT', expectedUrl: 'https://chatgpt.com/c/abc123', promptText: '', assistantBaselineKnown: true, assistantBaselineCount: 0,
    }, { document: docWith({ assistantText: 'partial', busy: true }) });
    assert.equal(result.status, 'BUSY');
    assert.equal(result.assistantComplete, false);
    assert.equal(result.safeDiagnosticCode, 'ASSISTANT_RESPONSE_STREAMING');
  } finally {
    globalThis.location = oldLocation;
  }
});


test('READ_ASSISTANT_REPORT does not mistake a pre-existing assistant turn for the new worker report', async () => {
  const oldLocation = globalThis.location;
  globalThis.location = { href: 'https://chatgpt.com/c/abc123' };
  try {
    const result = await adapter.execute({
      requestId: 'r3', taskId: 't1', mode: 'READ_ASSISTANT_REPORT', expectedUrl: 'https://chatgpt.com/c/abc123', promptText: '', assistantBaselineKnown: true, assistantBaselineCount: 1,
    }, { document: docWith({ assistantText: 'old assistant response', busy: false }) });
    assert.equal(result.status, 'TEMPORARY_ERROR');
    assert.equal(result.assistantComplete, false);
    assert.equal(result.assistantText, '');
    assert.equal(result.safeDiagnosticCode, 'ASSISTANT_NEW_RESPONSE_NOT_STARTED');
  } finally {
    globalThis.location = oldLocation;
  }
});
