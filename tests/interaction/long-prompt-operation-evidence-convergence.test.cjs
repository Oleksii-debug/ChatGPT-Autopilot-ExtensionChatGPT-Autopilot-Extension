'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
class FakeEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
class FakeTextAreaElement { constructor() { this._value = ''; } get value() { return this._value; } set value(v) { this._value = String(v); } }
class FakeInputElement extends FakeTextAreaElement {}
function loadAdapter(DateImpl = Date) {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/chatgpt-adapter.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sandbox = { URL, Date: DateImpl, setTimeout, clearTimeout, Event: FakeEvent, InputEvent: FakeEvent, HTMLTextAreaElement: FakeTextAreaElement, HTMLInputElement: FakeInputElement, console, location: { href: 'https://chatgpt.com/c/abc' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: sourcePath }); return sandbox.ChatGPTInteractionAdapter;
}
function visible(overrides = {}) { return Object.assign({ isConnected: true, hidden: false, disabled: false, innerText: '', getAttribute() { return null; }, getBoundingClientRect() { return { width: 120, height: 24 }; } }, overrides); }
function attachment(name = 'pasted-text.txt') { return visible({ innerText: name, getAttribute(attr) { if (attr === 'aria-label') return `Attachment ${name}`; return null; }, querySelectorAll() { return []; } }); }
function userMessage(messageAttachments = [], text = '') { return visible({ innerText: text, getAttribute(attr) { if (attr === 'data-message-author-role') return 'user'; return null; }, querySelectorAll(selector) { if (selector.includes('attachment')) return messageAttachments; return []; } }); }
function request(mode, overrides = {}) { return Object.assign({ requestId: 'op-long-1', taskId: 'task-1', expectedUrl: 'https://chatgpt.com/c/abc', promptText: 'x'.repeat(50000), mode }, overrides); }
function fixture({ initialAttachments = [], transform } = {}) {
  const attachments = [...initialAttachments]; const messages = [];
  const composer = new FakeTextAreaElement(); Object.assign(composer, { isConnected: true, hidden: false, disabled: false, tagName: 'TEXTAREA' });
  composer.getAttribute = (attr) => attr === 'aria-label' ? 'Message' : null; composer.getBoundingClientRect = () => ({ width: 500, height: 80 }); composer.focus = () => {};
  const send = visible({ tagName: 'BUTTON', getAttribute(attr) { if (attr === 'data-testid') return 'send-button'; if (attr === 'aria-label') return 'Send'; if (attr === 'aria-disabled') return 'false'; return null; }, click() {} });
  const form = { getAttribute() { return null; }, querySelectorAll(selector) { if (selector === 'button, [role="button"]') return [send]; if (selector.includes('attachment')) return attachments; return []; } };
  composer.closest = (selector) => selector === 'form' ? form : null; composer.parentElement = form;
  composer.dispatchEvent = (event) => { if (event.type === 'input' && transform) transform({ composer, attachments, messages, send }); return true; };
  const document = { body: { innerText: '' }, querySelectorAll(selector) {
    if (selector === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return [composer];
    if (selector === 'button, [role="button"]') return [send];
    if (selector === '[data-message-author-role="user"], [data-author="user"], article') return messages;
    return [];
  } };
  return { document, composer, attachments, messages, send };
}

test('file-like transformation binds only to exact operation across phases', async () => {
  const adapter = loadAdapter(); const fx = fixture({ transform({ composer, attachments }) { composer._value = ''; attachments.push(attachment()); } });
  const inserted = await adapter.execute(request('INSERT_ONLY'), { document: fx.document, wait: async () => {} });
  assert.equal(inserted.insertionEvidence, 'OPERATION_BOUND_ACCEPTED_REPRESENTATION');
  assert.equal(inserted.safeDiagnosticCode, 'INSERTION_ATTACHMENT_OPERATION_BOUND');
  const ready = await adapter.execute(request('PREPARE_SEND'), { document: fx.document });
  assert.equal(ready.status, adapter.STATUS.READY);
  assert.equal(ready.safeDiagnosticCode, 'PENDING_ATTACHMENT_OPERATION_BOUND_READY');
  const wrong = await adapter.execute(request('PREPARE_SEND', { requestId: 'other-op' }), { document: fx.document });
  assert.equal(wrong.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
});

test('pre-existing attachment never becomes current-operation proof', async () => {
  const adapter = loadAdapter(); let transformed = false;
  const fx = fixture({ initialAttachments: [attachment('old.txt')], transform() { transformed = true; } });
  const result = await adapter.execute(request('INSERT_ONLY'), { document: fx.document, wait: async () => {} });
  assert.equal(result.safeDiagnosticCode, 'PREEXISTING_ATTACHMENT_BLOCKS_AUTOMATION'); assert.equal(transformed, false);
});

test('same-looking replacement node is rejected before Send', async () => {
  const adapter = loadAdapter(); const fx = fixture({ transform({ composer, attachments }) { composer._value = ''; attachments.push(attachment()); } });
  await adapter.execute(request('INSERT_ONLY'), { document: fx.document, wait: async () => {} }); fx.attachments[0] = attachment();
  const result = await adapter.execute(request('PREPARE_SEND'), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.safeDiagnosticCode, 'PENDING_REPRESENTATION_NOT_OPERATION_BOUND_PRE_SEND');
});

test('multiple file-like nodes after insertion are ambiguous', async () => {
  const adapter = loadAdapter(); const fx = fixture({ transform({ composer, attachments }) { composer._value = ''; attachments.push(attachment('a.txt'), attachment('b.txt')); } });
  const result = await adapter.execute(request('INSERT_ONLY'), { document: fx.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED); assert.equal(result.safeDiagnosticCode, 'ATTACHMENT_REPRESENTATION_AMBIGUOUS');
});

test('representation Send requires strict operation-local append and clears pending UI', async () => {
  const adapter = loadAdapter(); const fx = fixture({ transform({ composer, attachments }) { composer._value = ''; attachments.push(attachment()); } });
  fx.messages.push(userMessage([], 'older message'));
  await adapter.execute(request('INSERT_ONLY'), { document: fx.document, wait: async () => {} });
  fx.send.click = () => { fx.attachments.splice(0); fx.messages.push(userMessage([attachment()])); };
  const result = await adapter.execute(request('SUBMIT_EXISTING'), { document: fx.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.SENT_VERIFIED);
  assert.equal(result.safeDiagnosticCode, 'SEND_VERIFIED_BOUND_REPRESENTATION_OPERATION_LOCAL_APPEND');
});

test('same-looking stale history without this click baseline cannot prove another operation', async () => {
  const adapter = loadAdapter(); const fx = fixture(); fx.messages.push(userMessage([attachment()]));
  const result = await adapter.execute(request('VERIFY_AFTER_UNCERTAIN_SUBMIT', { requestId: 'fresh-op' }), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.SUBMISSION_UNCERTAIN);
  assert.notEqual(result.status, adapter.STATUS.SENT_VERIFIED);
});

test('uncertain representation recovers only from its own recorded pre-click baseline', async () => {
  let clock = 0; class FakeDate extends Date { static now() { clock += 1000; return clock; } }
  const adapter = loadAdapter(FakeDate); const fx = fixture({ transform({ composer, attachments }) { composer._value = ''; attachments.push(attachment()); } });
  fx.messages.push(userMessage([], 'before'));
  await adapter.execute(request('INSERT_ONLY'), { document: fx.document, wait: async () => {} });
  fx.send.click = () => {};
  const uncertain = await adapter.execute(request('SUBMIT_EXISTING'), { document: fx.document, wait: async () => {} });
  assert.equal(uncertain.status, adapter.STATUS.SUBMISSION_UNCERTAIN);
  fx.attachments.splice(0); fx.messages.push(userMessage([attachment()]));
  const recovered = await adapter.execute(request('VERIFY_AFTER_UNCERTAIN_SUBMIT'), { document: fx.document });
  assert.equal(recovered.status, adapter.STATUS.SENT_VERIFIED);
  assert.equal(recovered.safeDiagnosticCode, 'RECOVERY_BOUND_REPRESENTATION_OPERATION_LOCAL_APPEND');
});
