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

function harness({ buttonAttributes = {} } = {}) {
  let listener = null;
  let observedTestId = null;
  let clicks = 0;

  const button = element(buttonAttributes);
  button.click = () => { clicks += 1; };

  const composer = element({ id: 'prompt-textarea', 'aria-label': 'Message ChatGPT' });
  composer.closest = () => null;

  const document = {
    querySelectorAll(selector) {
      if (selector.includes('[role="dialog"]')) return [];
      if (selector.includes('#prompt-textarea')) return [composer];
      if (selector === 'button, [role="button"]') return [button];
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

  async function invoke() {
    return await new Promise((resolve, reject) => {
      const keepAlive = listener({
        channel: 'autopilot-interaction',
        request: { mode: 'SUBMIT_EXISTING', requestId: 'req-no-form', taskId: 'task-1' },
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

test('Ukrainian Send remains usable when the live ChatGPT composer has no form wrapper', async () => {
  const h = harness({ buttonAttributes: { 'aria-label': 'Надіслати повідомлення' } });
  const response = await h.invoke();

  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'SENT_VERIFIED');
  assert.match(h.observedTestId, /autopilot-send-button/);
  assert.equal(h.clicks, 1);
  assert.equal(h.button.getAttribute('data-testid'), null, 'temporary compatibility identity must be restored');
  assert.equal(h.button.getAttribute('data-autopilot-send-compat'), null);
});
