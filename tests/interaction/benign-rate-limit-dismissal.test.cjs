'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function visibleElement(text, options = {}) {
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    innerText: text,
    textContent: text,
    getAttribute(name) {
      if (name === 'aria-label') return options.ariaLabel || null;
      return null;
    },
    getBoundingClientRect() { return { width: 300, height: 120 }; },
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return options.buttons || [];
      return [];
    },
    click: options.click || (() => {}),
  };
}

function install({ document, execute, setTimeoutImpl }) {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/content-script.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  let listener;
  const sandbox = {
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } },
    ChatGPTInteractionAdapter: { execute },
    document,
    Promise,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setTimeout: setTimeoutImpl || ((callback) => { callback(); return 1; }),
  };
  vm.runInNewContext(source, sandbox, { filename: sourcePath });
  return listener;
}

async function send(listener, request = { requestId: 'op-1' }) {
  return new Promise((resolve) => {
    const keepAlive = listener({ channel: 'autopilot-interaction', request }, {}, resolve);
    assert.equal(keepAlive, true);
  });
}

test('exact Ukrainian too-many-requests notice is acknowledged before automation continues', async () => {
  let clicked = 0;
  let dialogVisible = true;
  const button = visibleElement('Зрозуміло', {
    click() {
      clicked += 1;
      dialogVisible = false;
    },
  });
  const dialog = visibleElement(
    'Забагато запитів Ви надсилаєте запити надто швидко. '
      + 'Ми тимчасово обмежили доступ до ваших розмов, щоб захистити ваші дані. '
      + 'Зачекайте кілька хвилин, перш ніж спробувати знову. Зрозуміло',
    { buttons: [button] },
  );
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog, [role="alertdialog"], [aria-modal="true"]') {
        return dialogVisible ? [dialog] : [];
      }
      return [];
    },
  };

  const listener = install({
    document,
    async execute(request) {
      assert.equal(clicked, 1, 'acknowledgement must happen before adapter execution');
      assert.equal(dialogVisible, false);
      return { status: 'READY', requestId: request.requestId };
    },
  });

  const response = await send(listener);
  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'READY');
  assert.equal(clicked, 1);
});

test('unknown confirmation dialog is never auto-accepted', async () => {
  let clicked = 0;
  const button = visibleElement('Зрозуміло', { click() { clicked += 1; } });
  const dialog = visibleElement('Підтвердьте купівлю підписки, щоб продовжити', { buttons: [button] });
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog, [role="alertdialog"], [aria-modal="true"]') return [dialog];
      return [];
    },
  };

  const listener = install({
    document,
    async execute(request) {
      assert.equal(clicked, 0);
      return { status: 'MANUAL_REVIEW_REQUIRED', requestId: request.requestId };
    },
  });

  const response = await send(listener);
  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'MANUAL_REVIEW_REQUIRED');
  assert.equal(clicked, 0);
});

test('rate-limit notice with a non-whitelisted action button is not clicked', async () => {
  let clicked = 0;
  const button = visibleElement('Продовжити', { click() { clicked += 1; } });
  const dialog = visibleElement(
    'Забагато запитів Ви надсилаєте запити надто швидко. Зачекайте кілька хвилин, перш ніж спробувати знову.',
    { buttons: [button] },
  );
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog, [role="alertdialog"], [aria-modal="true"]') return [dialog];
      return [];
    },
  };

  const listener = install({
    document,
    async execute(request) {
      assert.equal(clicked, 0);
      return { status: 'MANUAL_REVIEW_REQUIRED', requestId: request.requestId };
    },
  });

  const response = await send(listener);
  assert.equal(response.ok, true);
  assert.equal(clicked, 0);
});
