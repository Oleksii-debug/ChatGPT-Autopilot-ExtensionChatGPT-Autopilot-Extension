'use strict';

const assert = require('node:assert/strict');
const { canUpgradeUncertainSubmit } = require('../../src/interaction/chatgpt-live-send-recovery.js');

function visibleElement(value = '') {
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    value,
    innerText: value,
    textContent: value,
    getAttribute() { return null; },
    getBoundingClientRect() { return { width: 100, height: 30 }; },
  };
}

const composer = visibleElement('');
const adapter = {
  findVisibleComposer: () => ({ element: composer, ambiguous: false }),
  detectBlockingState: () => ({ status: 'BUSY', code: 'STOP_CONTROL_VISIBLE' }),
};
const doc = { querySelectorAll: () => [] };
const request = {
  mode: 'VERIFY_AFTER_UNCERTAIN_SUBMIT',
  expectedUrl: 'https://chatgpt.com/c/expected',
};
const uncertain = {
  status: 'SUBMISSION_UNCERTAIN',
  safeDiagnosticCode: 'RECOVERY_UNCERTAIN',
  normalizedObservedUrl: 'https://chatgpt.com/c/expected',
};

assert.equal(canUpgradeUncertainSubmit(doc, adapter, request, uncertain), true,
  'verification-only recovery must accept correct route + empty composer + active generation');
assert.equal(canUpgradeUncertainSubmit(doc, adapter, request, {
  ...uncertain,
  normalizedObservedUrl: 'https://chatgpt.com/c/other',
}), false, 'a different conversation must never be accepted');
composer.value = 'still pending';
assert.equal(canUpgradeUncertainSubmit(doc, adapter, request, uncertain), false,
  'a non-empty composer must never be accepted as a verified send');
composer.value = '';
adapter.detectBlockingState = () => null;
assert.equal(canUpgradeUncertainSubmit(doc, adapter, request, uncertain), false,
  'verification recovery requires active generation evidence');

console.log('live-send-recovery-verify: PASS');
