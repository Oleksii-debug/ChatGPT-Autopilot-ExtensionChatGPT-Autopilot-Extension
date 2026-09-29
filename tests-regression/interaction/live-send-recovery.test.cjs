'use strict';

const assert = require('node:assert/strict');
const {
  ensureHighEffort,
  routeProvesExpectedConversation,
  canUpgradeUncertainSubmit,
} = require('../../src/interaction/chatgpt-live-send-recovery.js');

function element(label = '') {
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    innerText: label,
    textContent: label,
    value: '',
    attrs: new Map(),
    getAttribute(name) { return this.attrs.get(name) ?? null; },
    setAttribute(name, value) { this.attrs.set(name, String(value)); },
    getBoundingClientRect() { return { width: 100, height: 30 }; },
    click() {},
  };
}

function composer(scope, value = '') {
  const el = element('');
  el.value = value;
  el.closest = (selector) => selector === 'form' ? scope : null;
  return el;
}

function testRouteProof() {
  assert.equal(routeProvesExpectedConversation('https://chatgpt.com/c/abc', 'https://chatgpt.com/'), true);
  assert.equal(routeProvesExpectedConversation('https://chatgpt.com/c/abc', 'https://chatgpt.com/g/demo'), true);
  assert.equal(routeProvesExpectedConversation('https://chatgpt.com/c/abc', 'https://chatgpt.com/c/abc'), true);
  assert.equal(routeProvesExpectedConversation('https://chatgpt.com/c/other', 'https://chatgpt.com/c/abc'), false);
  assert.equal(routeProvesExpectedConversation('https://evil.example/c/abc', 'https://chatgpt.com/'), false);
}

function testStrongSendEvidence() {
  const scope = { querySelectorAll: () => [] };
  const empty = composer(scope, '');
  const adapter = {
    findVisibleComposer: () => ({ element: empty, ambiguous: false }),
    detectBlockingState: () => ({ status: 'BUSY', code: 'STOP_CONTROL_VISIBLE' }),
  };
  const doc = { querySelectorAll: () => [] };
  const request = { mode: 'SUBMIT_EXISTING', expectedUrl: 'https://chatgpt.com/' };
  const result = {
    status: 'SUBMISSION_UNCERTAIN',
    safeDiagnosticCode: 'SEND_CLICK_UNCERTAIN',
    normalizedObservedUrl: 'https://chatgpt.com/c/new-chat',
  };
  assert.equal(canUpgradeUncertainSubmit(doc, adapter, request, result), true);

  empty.value = 'prompt still pending';
  assert.equal(canUpgradeUncertainSubmit(doc, adapter, request, result), false);
  empty.value = '';
  adapter.detectBlockingState = () => null;
  assert.equal(canUpgradeUncertainSubmit(doc, adapter, request, result), false);
  adapter.detectBlockingState = () => ({ status: 'BUSY' });
  assert.equal(canUpgradeUncertainSubmit(doc, adapter, { ...request, mode: 'VERIFY_AFTER_UNCERTAIN_SUBMIT' }, result), true);
  assert.equal(canUpgradeUncertainSubmit(doc, adapter, { ...request, expectedUrl: 'https://chatgpt.com/c/original' }, result), false);
}

async function testAlreadyHighDoesNotClick() {
  const control = element('High');
  let clicks = 0;
  control.click = () => { clicks += 1; };
  const scope = { querySelectorAll: () => [control] };
  const input = composer(scope);
  const doc = {
    querySelectorAll: () => [control],
    dispatchEvent() {},
  };
  const adapter = { findVisibleComposer: () => ({ element: input, ambiguous: false }) };
  const result = await ensureHighEffort(doc, adapter, { wait: async () => {} });
  assert.equal(result.outcome, 'ALREADY_HIGH');
  assert.equal(result.attempts, 0);
  assert.equal(clicks, 0);
}

async function testSelectsHigh() {
  const control = element('Medium');
  const high = element('High');
  let menuOpen = false;
  control.click = () => { menuOpen = !menuOpen; };
  high.click = () => {
    control.innerText = 'High';
    control.textContent = 'High';
    menuOpen = false;
  };
  const scope = { querySelectorAll: () => [control] };
  const input = composer(scope);
  const doc = {
    querySelectorAll: () => menuOpen ? [control, high] : [control],
    dispatchEvent() {},
  };
  const adapter = { findVisibleComposer: () => ({ element: input, ambiguous: false }) };
  const result = await ensureHighEffort(doc, adapter, { wait: async () => {} });
  assert.equal(result.outcome, 'HIGH_SELECTED');
  assert.equal(result.attempts, 1);
  assert.equal(control.innerText, 'High');
}

async function testHighFailureIsBounded() {
  const control = element('Medium');
  let clicks = 0;
  control.click = () => { clicks += 1; };
  const scope = { querySelectorAll: () => [control] };
  const input = composer(scope);
  const doc = {
    querySelectorAll: () => [control],
    dispatchEvent() {},
  };
  const adapter = { findVisibleComposer: () => ({ element: input, ambiguous: false }) };
  const result = await ensureHighEffort(doc, adapter, { wait: async () => {} });
  assert.equal(result.outcome, 'HIGH_UNAVAILABLE_CONTINUE_SEND');
  assert.equal(result.attempts, 2);
  assert.ok(clicks <= 4, `selection loop was not bounded: ${clicks} clicks`);
}

(async () => {
  testRouteProof();
  testStrongSendEvidence();
  await testAlreadyHighDoesNotClick();
  await testSelectsHigh();
  await testHighFailureIsBounded();
  console.log('live-send-recovery: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
