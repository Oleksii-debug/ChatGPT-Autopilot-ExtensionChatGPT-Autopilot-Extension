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

function visibleElement(text = '', attrs = {}) {
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    innerText: text,
    title: attrs.title || '',
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    getBoundingClientRect() { return { width: 240, height: 48 }; }
  };
}

function fixture({
  bodyText = '',
  dialogs = [],
  alertDialogs = [],
  ariaModals = [],
  statuses = [],
  buttons = [],
  composers = []
} = {}) {
  return {
    body: { innerText: bodyText },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog') return dialogs;
      if (selector === '[role="alertdialog"]') return alertDialogs;
      if (selector === '[aria-modal="true"]') return ariaModals;
      if (selector === '[role="alert"], [role="status"], [aria-live="assertive"]') return statuses;
      if (selector === 'button, [role="button"]') return buttons;
      if (selector === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return composers;
      return [];
    }
  };
}

test('unknown visible dialog outranks stale BUSY and rate-limit text underneath', () => {
  const adapter = loadAdapter();
  const dialog = visibleElement('Підтвердьте дію, щоб продовжити', { role: 'dialog' });
  const stop = visibleElement('Stop generating', { 'aria-label': 'Stop generating' });
  const result = adapter.detectBlockingState(fixture({
    bodyText: 'Too many requests. Try again later.',
    dialogs: [dialog],
    buttons: [stop]
  }));

  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.code, 'UNRECOGNIZED_DIALOG');
});

test('ARIA alertdialog is a fail-closed modal even when its localized text is unknown', () => {
  const adapter = loadAdapter();
  const alertDialog = visibleElement('Продовжити цю дію?', { role: 'alertdialog' });
  const stop = visibleElement('Stop generating', { 'aria-label': 'Stop generating' });
  const result = adapter.detectBlockingState(fixture({ alertDialogs: [alertDialog], buttons: [stop] }));

  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.code, 'UNRECOGNIZED_DIALOG');
});

test('aria-modal true surface is fail closed and a duplicate role dialog node is processed once', () => {
  const adapter = loadAdapter();
  const modal = visibleElement('Платіж потребує підтвердження', {
    role: 'dialog',
    'aria-modal': 'true'
  });
  const result = adapter.detectBlockingState(fixture({ dialogs: [modal], ariaModals: [modal] }));

  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.code, 'UNRECOGNIZED_DIALOG');
});

test('security/account/payment dialog remains manual review and is never downgraded to retry', () => {
  const adapter = loadAdapter();
  const dialog = visibleElement('Payment confirmation required', { role: 'dialog' });
  const status = visibleElement('Rate limit reached', { role: 'alert' });
  const result = adapter.detectBlockingState(fixture({ dialogs: [dialog], statuses: [status] }));

  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.code, 'UNKNOWN_OR_SECURITY_DIALOG');
});

test('conversation body text mentioning try again later does not manufacture RATE_LIMITED', () => {
  const adapter = loadAdapter();
  const result = adapter.detectBlockingState(fixture({
    bodyText: 'User message: please try again later when the upload is ready.'
  }));

  assert.equal(result, null);
});

test('visible accessibility alert provides rate-limit evidence', () => {
  const adapter = loadAdapter();
  const status = visibleElement('Too many requests. Try again later.', { role: 'alert' });
  const result = adapter.detectBlockingState(fixture({ statuses: [status] }));

  assert.equal(result.status, adapter.STATUS.RATE_LIMITED);
  assert.equal(result.code, 'RATE_LIMIT_SURFACE_VISIBLE');
});

test('visible accessibility status provides temporary-error evidence', () => {
  const adapter = loadAdapter();
  const status = visibleElement('Something went wrong. Please try again.', { role: 'status' });
  const result = adapter.detectBlockingState(fixture({ statuses: [status] }));

  assert.equal(result.status, adapter.STATUS.TEMPORARY_ERROR);
  assert.equal(result.code, 'TEMPORARY_ERROR_SURFACE_VISIBLE');
});

test('BUSY requires a generation-stop control, not any button containing the word stop', () => {
  const adapter = loadAdapter();
  const unrelated = visibleElement('Stop sharing', { 'aria-label': 'Stop sharing' });
  assert.equal(adapter.detectBlockingState(fixture({ buttons: [unrelated] })), null);

  const generationStop = visibleElement('', { 'aria-label': 'Stop response' });
  const result = adapter.detectBlockingState(fixture({ buttons: [generationStop] }));
  assert.equal(result.status, adapter.STATUS.BUSY);
  assert.equal(result.code, 'STOP_CONTROL_VISIBLE');
});

test('visible sign-in control without a composer remains AUTH_REQUIRED', () => {
  const adapter = loadAdapter();
  const signIn = visibleElement('Log in', { 'aria-label': 'Log in' });
  const result = adapter.detectBlockingState(fixture({ buttons: [signIn] }));

  assert.equal(result.status, adapter.STATUS.AUTH_REQUIRED);
  assert.equal(result.code, 'AUTH_SURFACE_VISIBLE');
});
