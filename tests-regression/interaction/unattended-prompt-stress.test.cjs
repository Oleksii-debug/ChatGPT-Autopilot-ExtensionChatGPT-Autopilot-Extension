'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/interaction/chatgpt-adapter.js'), 'utf8');

function harness(prompt, composerText, { separated = false } = {}) {
  let clock = 1000;
  let clicks = 0;
  const messages = [];
  class Clock extends Date { static now() { return clock; } }
  class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  const visible = { isConnected: true, hidden: false, disabled: false, getBoundingClientRect: () => ({ width: 200, height: 40 }) };
  const form = { getAttribute: () => null, querySelectorAll: s => s === 'button, [role="button"]' ? [send] : [] };
  const composer = {
    ...visible,
    tagName: 'TEXTAREA',
    value: composerText,
    closest: () => form,
    focus() {},
    getAttribute: n => n === 'aria-label' ? 'Message' : null,
    dispatchEvent() { return true; },
  };
  const leaf = text => ({
    ...visible,
    innerText: text,
    getAttribute: n => n === 'data-message-author-role' ? 'user' : null,
    querySelectorAll: () => [],
  });
  const send = {
    ...visible,
    tagName: 'BUTTON',
    type: 'button',
    form,
    getAttribute: n => n === 'data-testid' ? 'send-button' : null,
    click() {
      clicks += 1;
      const sent = composer.value;
      messages.push(leaf(sent));
      composer.value = '';
    },
  };
  const document = {
    visibilityState: 'hidden',
    defaultView: { Event, InputEvent: Event },
    querySelectorAll(s) {
      if (s === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return [composer];
      if (s === 'button, [role="button"]') return [send];
      if (s === '[data-message-author-role="user"], [data-author="user"], article') return messages;
      return [];
    },
  };
  composer.ownerDocument = document;
  const conversationUrl = 'https://chatgpt.com/c/repeat-stress';
  const sandbox = { URL, Date: Clock, Event, InputEvent: Event, setTimeout, clearTimeout, location: { href: conversationUrl }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const adapter = sandbox.ChatGPTInteractionAdapter;
  async function wait(ms) { clock += ms; }
  async function submit() {
    return adapter.execute({ mode: 'SUBMIT_EXISTING', requestId: 'op', taskId: 't', expectedUrl: conversationUrl, promptText: prompt }, { document, wait });
  }
  return { adapter, submit, clicks: () => clicks, composer, messages, separated };
}

for (const copies of [2, 3, 32, 33, 100, 1000]) {
  test(`safe submit accepts ${copies} exact copies of the same prompt without an arbitrary repetition ceiling`, async () => {
    const prompt = 'A\nB\nC';
    const h = harness(prompt, prompt.repeat(copies));
    const result = await h.submit();
    assert.equal(result.status, h.adapter.STATUS.SENT_VERIFIED);
    assert.equal(h.clicks(), 1);
  });
}

test('safe submit accepts repeated copies separated by editor whitespace', async () => {
  const prompt = 'Alpha\nBeta';
  const h = harness(prompt, Array(100).fill(prompt).join('\n'));
  const result = await h.submit();
  assert.equal(result.status, h.adapter.STATUS.SENT_VERIFIED);
  assert.equal(h.clicks(), 1);
});

test('50000-character prompt repeated three times is still sent exactly once', async () => {
  const prompt = 'x'.repeat(50000);
  const h = harness(prompt, prompt.repeat(3));
  const result = await h.submit();
  assert.equal(result.status, h.adapter.STATUS.SENT_VERIFIED);
  assert.equal(h.clicks(), 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].innerText.length, 150000);
});

test('INSERT_ONLY accepts an already repeated configured prompt without appending another copy', async () => {
  const prompt = 'Do the work\nNow';
  const existing = prompt.repeat(100);
  const h = harness(prompt, existing);
  const result = await h.adapter.execute({
    mode: 'INSERT_ONLY', requestId: 'op-insert', taskId: 't', expectedUrl: 'https://chatgpt.com/c/repeat-stress', promptText: prompt,
  }, { document: h.composer.ownerDocument, wait: async () => {} });
  assert.equal(result.status, h.adapter.STATUS.INSERTED_NOT_SENT);
  assert.equal(result.safeDiagnosticCode, 'INSERTION_REPEATED_PROMPT_ACCEPTED');
  assert.equal(h.composer.value, existing);
  assert.equal(h.clicks(), 0);
});
