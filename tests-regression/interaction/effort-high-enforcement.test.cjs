'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAdapter() {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/chatgpt-adapter.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  let clock = 0;
  class FakeDate extends Date {
    static now() { clock += 100; return clock; }
  }
  const sandbox = {
    URL,
    Date: FakeDate,
    setTimeout,
    clearTimeout,
    console,
    location: { href: 'https://chatgpt.com/c/abc' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: sourcePath });
  return sandbox.ChatGPTInteractionAdapter;
}

function request() {
  return {
    requestId: 'effort-check-1',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText: '',
    preSendDelayMs: 1000,
    mode: 'ENSURE_HIGH_EFFORT',
  };
}

function visibleBase() {
  return {
    isConnected: true,
    hidden: false,
    disabled: false,
    matches() { return false; },
    getBoundingClientRect() { return { width: 100, height: 24 }; },
  };
}

function fixture(initial = 'Medium') {
  let current = initial;
  let menuOpen = false;
  let controlClicks = 0;
  let optionClicks = 0;
  const menu = {
    ...visibleBase(),
    innerText: 'Instant Medium High Extra High',
    getAttribute(name) { return name === 'role' ? 'menu' : null; },
  };
  const control = {
    ...visibleBase(),
    tagName: 'BUTTON',
    get innerText() { return current; },
    getAttribute(name) {
      if (name === 'aria-label') return `Thinking level: ${current}`;
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'data-testid') return 'thinking-level-control';
      return null;
    },
    closest() { return null; },
    focus() {},
    click() { controlClicks += 1; menuOpen = true; },
  };
  const highOption = {
    ...visibleBase(),
    tagName: 'DIV',
    innerText: 'High',
    getAttribute(name) {
      if (name === 'role') return 'menuitemradio';
      if (name === 'aria-checked') return current === 'High' ? 'true' : 'false';
      return null;
    },
    closest(selector) { return menuOpen && /role="menu"/.test(selector) ? menu : null; },
    focus() {},
    click() { optionClicks += 1; current = 'High'; menuOpen = false; },
  };
  const doc = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog' || selector === '[role="alertdialog"]' || selector === '[aria-modal="true"]') return [];
      if (selector === '[role="alert"], [role="status"], [aria-live="assertive"]') return [];
      if (selector === 'button, [role="button"]') return menuOpen ? [control, highOption] : [control];
      if (selector.includes('[role="combobox"]') || selector.includes('[role="slider"]') || selector.includes('input[type="range"]')) return [control];
      if (selector.includes('[role="menuitemradio"]')) return menuOpen ? [highOption, control] : [control];
      return [];
    },
  };
  return {
    doc,
    get current() { return current; },
    get controlClicks() { return controlClicks; },
    get optionClicks() { return optionClicks; },
  };
}

test('already-High chat is accepted without opening the effort menu', async () => {
  const adapter = loadAdapter();
  const fx = fixture('High');
  const result = await adapter.execute(request(), { document: fx.doc, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(result.safeDiagnosticCode, 'EFFORT_HIGH_CONFIRMED');
  assert.equal(fx.current, 'High');
  assert.equal(fx.controlClicks, 0);
  assert.equal(fx.optionClicks, 0);
});

test('Medium chat is switched to High and verified before work may continue', async () => {
  const adapter = loadAdapter();
  const fx = fixture('Medium');
  const result = await adapter.execute(request(), { document: fx.doc, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(result.safeDiagnosticCode, 'EFFORT_HIGH_SELECTED_AND_VERIFIED');
  assert.equal(fx.current, 'High');
  assert.equal(fx.controlClicks, 1);
  assert.equal(fx.optionClicks, 1);
});

test('Extra High satisfies the minimum High policy without downgrade', async () => {
  const adapter = loadAdapter();
  const fx = fixture('Extra High');
  const result = await adapter.execute(request(), { document: fx.doc, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(result.effortLevel, 'extra-high');
  assert.equal(fx.controlClicks, 0);
  assert.equal(fx.optionClicks, 0);
});

test('missing effort control fails closed before prompt insertion', async () => {
  const adapter = loadAdapter();
  const doc = {
    body: { innerText: '' },
    querySelectorAll() { return []; },
  };
  const result = await adapter.execute(request(), { document: doc, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.TEMPORARY_ERROR);
  assert.equal(result.safeDiagnosticCode, 'EFFORT_CONTROL_NOT_READY');
});

test('unrelated button named High is not accepted as a reasoning control', async () => {
  const adapter = loadAdapter();
  let clicks = 0;
  const button = {
    ...visibleBase(),
    tagName: 'BUTTON',
    innerText: 'High',
    getAttribute() { return null; },
    closest() { return null; },
    click() { clicks += 1; },
  };
  const doc = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return [button];
      if (selector.includes('[role="combobox"]') || selector.includes('[role="slider"]') || selector.includes('input[type="range"]')) return [button];
      if (selector.includes('[role="menuitemradio"]')) return [button];
      return [];
    },
  };
  const result = await adapter.execute(request(), { document: doc, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.TEMPORARY_ERROR);
  assert.equal(result.safeDiagnosticCode, 'EFFORT_CONTROL_NOT_READY');
  assert.equal(clicks, 0);
});

test('effort classifier recognizes English and Ukrainian levels', () => {
  const adapter = loadAdapter();
  assert.equal(adapter.classifyEffortLabel('Medium'), 'medium');
  assert.equal(adapter.classifyEffortLabel('High'), 'high');
  assert.equal(adapter.classifyEffortLabel('Extra High'), 'extra-high');
  assert.equal(adapter.classifyEffortLabel('Середній'), 'medium');
  assert.equal(adapter.classifyEffortLabel('Високий'), 'high');
});


test('model-only picker label can still select and prove High', async () => {
  const adapter = loadAdapter();
  let menuOpen = false;
  let selected = 'Medium';
  let pickerClicks = 0;
  let optionClicks = 0;
  const menu = {
    ...visibleBase(),
    innerText: 'Instant Medium High Extra High',
    getAttribute(name) { return name === 'role' ? 'menu' : null; },
  };
  const picker = {
    ...visibleBase(),
    tagName: 'BUTTON',
    innerText: 'GPT-5.6',
    getAttribute(name) {
      if (name === 'aria-label') return 'Model selector GPT-5.6';
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'data-testid') return 'model-switcher-dropdown-button';
      return null;
    },
    closest() { return null; },
    focus() {},
    click() { pickerClicks += 1; menuOpen = !menuOpen; },
  };
  const high = {
    ...visibleBase(),
    tagName: 'DIV',
    innerText: 'High',
    getAttribute(name) {
      if (name === 'role') return 'menuitemradio';
      if (name === 'aria-checked') return selected === 'High' ? 'true' : 'false';
      return null;
    },
    closest(selector) { return menuOpen && /role="menu"/.test(selector) ? menu : null; },
    focus() {},
    click() { optionClicks += 1; selected = 'High'; menuOpen = false; },
  };
  const doc = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog' || selector === '[role="alertdialog"]' || selector === '[aria-modal="true"]') return [];
      if (selector === '[role="alert"], [role="status"], [aria-live="assertive"]') return [];
      if (selector === 'button, [role="button"]') return menuOpen ? [picker, high] : [picker];
      if (selector.includes('[role="combobox"]') || selector.includes('[role="slider"]') || selector.includes('input[type="range"]')) return [picker];
      if (selector.includes('[role="menuitemradio"]')) return menuOpen ? [high, picker] : [picker];
      return [];
    },
  };
  const result = await adapter.execute(request(), { document: doc, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(result.safeDiagnosticCode, 'EFFORT_HIGH_SELECTED_AND_VERIFIED');
  assert.equal(selected, 'High');
  assert.equal(optionClicks, 1);
  assert.ok(pickerClicks >= 1);
});


test('model-only picker preserves selected Extra High without downgrade', async () => {
  const adapter = loadAdapter();
  let menuOpen = false;
  let selected = 'Extra High';
  let highClicks = 0;
  const menu = {
    ...visibleBase(),
    innerText: 'Instant Medium High Extra High',
    getAttribute(name) { return name === 'role' ? 'menu' : null; },
  };
  const picker = {
    ...visibleBase(),
    tagName: 'BUTTON',
    innerText: 'GPT-5.6',
    getAttribute(name) {
      if (name === 'aria-label') return 'Model selector GPT-5.6';
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'data-testid') return 'model-switcher-dropdown-button';
      return null;
    },
    closest() { return null; },
    focus() {},
    click() { menuOpen = !menuOpen; },
  };
  const option = (label) => ({
    ...visibleBase(),
    tagName: 'DIV',
    innerText: label,
    getAttribute(name) {
      if (name === 'role') return 'menuitemradio';
      if (name === 'aria-checked') return selected === label ? 'true' : 'false';
      return null;
    },
    closest(selector) { return menuOpen && /role="menu"/.test(selector) ? menu : null; },
    focus() {},
    click() { if (label === 'High') highClicks += 1; selected = label; menuOpen = false; },
  });
  const high = option('High');
  const extra = option('Extra High');
  const doc = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog' || selector === '[role="alertdialog"]' || selector === '[aria-modal="true"]') return [];
      if (selector === '[role="alert"], [role="status"], [aria-live="assertive"]') return [];
      if (selector === 'button, [role="button"]') return menuOpen ? [picker, high, extra] : [picker];
      if (selector.includes('[role="combobox"]') || selector.includes('[role="slider"]') || selector.includes('input[type="range"]')) return [picker];
      if (selector === '[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"]') return menuOpen ? [high, extra] : [];
      if (selector.includes('[role="menuitemradio"]')) return menuOpen ? [high, extra, picker] : [picker];
      return [];
    },
  };
  const result = await adapter.execute(request(), { document: doc, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(result.safeDiagnosticCode, 'EFFORT_HIGH_CONFIRMED_IN_PICKER');
  assert.equal(result.effortLevel, 'extra-high');
  assert.equal(selected, 'Extra High');
  assert.equal(highClicks, 0);
  assert.equal(menuOpen, false);
});


test('failed High proof closes the picker before returning fail-closed', async () => {
  const adapter = loadAdapter();
  let menuOpen = false;
  let pickerClicks = 0;
  const menu = {
    ...visibleBase(),
    innerText: 'Instant Medium',
    getAttribute(name) { return name === 'role' ? 'menu' : null; },
  };
  const picker = {
    ...visibleBase(),
    tagName: 'BUTTON',
    innerText: 'Medium',
    getAttribute(name) {
      if (name === 'aria-label') return 'Thinking level: Medium';
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'data-testid') return 'thinking-level-control';
      return null;
    },
    closest() { return null; },
    focus() {},
    click() { pickerClicks += 1; menuOpen = !menuOpen; },
  };
  const doc = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"], dialog' || selector === '[role="alertdialog"]' || selector === '[aria-modal="true"]') return [];
      if (selector === '[role="alert"], [role="status"], [aria-live="assertive"]') return [];
      if (selector === '[role="menu"], [role="listbox"], [role="radiogroup"], [role="dialog"]') return menuOpen ? [menu] : [];
      if (selector === 'button, [role="button"]') return [picker];
      if (selector.includes('[role="combobox"]') || selector.includes('[role="slider"]') || selector.includes('input[type="range"]')) return [picker];
      if (selector.includes('[role="menuitemradio"]')) return [picker];
      if (selector === '[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"]') return [];
      return [];
    },
  };
  const result = await adapter.execute(request(), { document: doc, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.TEMPORARY_ERROR);
  assert.equal(result.safeDiagnosticCode, 'EFFORT_HIGH_OPTION_NOT_READY');
  assert.equal(menuOpen, false);
  assert.equal(pickerClicks, 2);
});
