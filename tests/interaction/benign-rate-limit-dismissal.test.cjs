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

function install({ document, execute }) {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/content-script.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  let listener;
  const sandbox = {
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } },
    ChatGPTInteractionAdapter: { execute },
    document,
    Promise,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
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

test('exact Ukrainian notice is acknowledged, returns RATE_LIMITED, then continues only on a later request', async () => {
  let clicked = 0;
  let dialogVisible = true;
  let adapterCalls = 0;
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
      adapterCalls += 1;
      assert.equal(dialogVisible, false);
      return { status: 'READY', requestId: request.requestId };
    },
  });

  const held = await send(listener, { requestId: 'op-1', taskId: 'task-1' });
  assert.equal(held.ok, true);
  assert.equal(held.data.status, 'RATE_LIMITED');
  assert.equal(held.data.safeDiagnosticCode, 'RATE_LIMIT_DIALOG_ACKNOWLEDGED');
  assert.equal(held.data.requestId, 'op-1');
  assert.equal(held.data.taskId, 'task-1');
  assert.equal(clicked, 1);
  assert.equal(adapterCalls, 0, 'the acknowledged request must not continue into adapter/Send');

  const resumed = await send(listener, { requestId: 'op-2', taskId: 'task-1' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.status, 'READY');
  assert.equal(clicked, 1, 'acknowledgement must not repeat after the dialog disappears');
  assert.equal(adapterCalls, 1, 'a later Core-scheduled request may continue normally');
});

test('Ukrainian rate-limit wording variant with Підтвердити is acknowledged safely', async () => {
  let clicked = 0;
  let adapterCalls = 0;
  const button = visibleElement('Підтвердити', { click() { clicked += 1; } });
  const dialog = visibleElement(
    'Занадто багато запитів Ви надсилаєте запити занадто швидко. '
      + 'Ми тимчасово обмежили доступ до ваших розмов. '
      + 'Спробуйте ще раз через кілька хвилин. Підтвердити',
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
      adapterCalls += 1;
      return { status: 'READY', requestId: request.requestId };
    },
  });

  const response = await send(listener, { requestId: 'op-confirm', taskId: 'task-1' });
  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'RATE_LIMITED');
  assert.equal(response.data.safeDiagnosticCode, 'RATE_LIMIT_DIALOG_ACKNOWLEDGED');
  assert.equal(clicked, 1);
  assert.equal(adapterCalls, 0, 'acknowledgement request must not continue into adapter/Send');
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

test('generic Підтвердити outside the whitelisted rate-limit dialog is never auto-clicked', async () => {
  let clicked = 0;
  const button = visibleElement('Підтвердити', { click() { clicked += 1; } });
  const dialog = visibleElement('Підтвердьте зміну облікового запису, щоб продовжити', { buttons: [button] });
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

  const response = await send(listener, { requestId: 'op-unsafe-confirm' });
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

test('incomplete lookalike notice is not whitelisted', async () => {
  let clicked = 0;
  const button = visibleElement('Зрозуміло', { click() { clicked += 1; } });
  const dialog = visibleElement(
    'Забагато запитів Ви надсилаєте запити надто швидко. Зачекайте кілька хвилин. Зрозуміло',
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
    async execute(request) { return { status: 'MANUAL_REVIEW_REQUIRED', requestId: request.requestId }; },
  });
  const response = await send(listener);
  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'MANUAL_REVIEW_REQUIRED');
  assert.equal(clicked, 0);
});

test('a second simultaneous modal disables automatic acknowledgement', async () => {
  let clicked = 0;
  const rateButton = visibleElement('Зрозуміло', { click() { clicked += 1; } });
  const rateDialog = visibleElement(
    'Забагато запитів Ви надсилаєте запити надто швидко. '
      + 'Ми тимчасово обмежили доступ до ваших розмов. '
      + 'Зачекайте кілька хвилин, перш ніж спробувати знову. Зрозуміло',
    { buttons: [rateButton] },
  );
  const securityDialog = visibleElement('Security verification required');
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog, [role="alertdialog"], [aria-modal="true"]') {
        return [rateDialog, securityDialog];
      }
      return [];
    },
  };

  const listener = install({
    document,
    async execute(request) { return { status: 'MANUAL_REVIEW_REQUIRED', requestId: request.requestId }; },
  });
  const response = await send(listener);
  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'MANUAL_REVIEW_REQUIRED');
  assert.equal(clicked, 0);
});
