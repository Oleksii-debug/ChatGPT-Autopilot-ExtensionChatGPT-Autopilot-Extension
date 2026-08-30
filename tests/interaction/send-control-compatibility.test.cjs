'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../src/interaction/content-script.js'),
  'utf8'
);

function element(attributes = {}) {
  const attrs = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    innerText: '',
    textContent: '',
    value: '',
    id: attributes.id || '',
    type: attributes.type || '',
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    getBoundingClientRect() {
      return { width: 100, height: 30 };
    },
  };
}

function harness({ buttonAttributes = {}, initiallyDisabled = false } = {}) {
  let listener = null;
  let observedTestId = null;
  let clicks = 0;

  const button = element(buttonAttributes);
  button.disabled = initiallyDisabled;
  button.click = () => { clicks += 1; };

  const form = element({ 'data-testid': 'composer-form' });
  form.querySelectorAll = (selector) => selector.includes('button') ? [button] : [];

  const composer = element({ id: 'prompt-textarea', 'aria-label': 'Message ChatGPT' });
  composer.closest = (selector) => selector === 'form' ? form : null;

  const document = {
    querySelectorAll(selector) {
      if (selector.includes('[role="dialog"]')) return [];
      if (selector.includes('#prompt-textarea')) return [composer];
      return [];
    },
  };

  const adapter = {
    async execute(request) {
      observedTestId = button.getAttribute('data-testid');
      if (request.mode === 'SUBMIT_EXISTING' && /send-button/.test(observedTestId || '')) {
        button.click();
        return { status: 'SENT_VERIFIED' };
      }
      return { status: 'UNKNOWN_UI', safeDiagnosticCode: 'SEND_BUTTON_NOT_FOUND' };
    },
  };

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    ChatGPTInteractionAdapter: adapter,
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) { listener = fn; },
        },
      },
    },
  });
  vm.runInContext(source, context, { filename: 'content-script.js' });
  assert.equal(typeof listener, 'function');

  async function invoke(mode = 'SUBMIT_EXISTING') {
    return await new Promise((resolve, reject) => {
      const keepAlive = listener({
        channel: 'autopilot-interaction',
        request: { mode, requestId: 'req-1', taskId: 'task-1' },
      }, {}, resolve);
      if (keepAlive !== true) reject(new Error('listener did not keep the response channel alive'));
    });
  }

  return {
    button,
    invoke,
    get observedTestId() { return observedTestId; },
    get clicks() { return clicks; },
  };
}

test('Ukrainian accessible Send label is exposed to the existing fail-closed adapter only for the request', async () => {
  const h = harness({ buttonAttributes: { 'aria-label': 'Надіслати повідомлення' } });
  const response = await h.invoke();

  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'SENT_VERIFIED');
  assert.match(h.observedTestId, /autopilot-send-button/);
  assert.equal(h.clicks, 1);
  assert.equal(h.button.getAttribute('data-testid'), null, 'temporary compatibility identity must be restored');
  assert.equal(h.button.getAttribute('data-autopilot-send-compat'), null);
});

test('a unique submit button inside the exact composer form is accepted as a structural Send fallback', async () => {
  const h = harness({ buttonAttributes: { type: 'submit', 'aria-label': 'Submit' } });
  const response = await h.invoke();

  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'SENT_VERIFIED');
  assert.match(h.observedTestId, /autopilot-send-button/);
  assert.equal(h.clicks, 1);
  assert.equal(h.button.getAttribute('data-testid'), null);
});

test('compatibility polling waits for a localized Send control to become enabled', async () => {
  const h = harness({
    buttonAttributes: { 'aria-label': 'Надіслати' },
    initiallyDisabled: true,
  });
  setTimeout(() => { h.button.disabled = false; }, 150);

  const started = Date.now();
  const response = await h.invoke();

  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'SENT_VERIFIED');
  assert.equal(h.clicks, 1);
  assert.ok(Date.now() - started >= 100, 'request should wait for the Send button to enable');
});
