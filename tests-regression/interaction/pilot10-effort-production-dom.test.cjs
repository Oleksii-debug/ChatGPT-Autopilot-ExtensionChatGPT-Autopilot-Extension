'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAdapter() {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/chatgpt-adapter.js');
  const sandbox = {
    URL, Date, setTimeout, clearTimeout, console,
    location: { href: 'https://chatgpt.com/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), sandbox, { filename: sourcePath });
  return sandbox.ChatGPTInteractionAdapter;
}

function visible(base = {}) {
  return Object.assign({
    isConnected: true, hidden: false, disabled: false, parentElement: null,
    matches() { return false; },
    getBoundingClientRect() { return { width: 120, height: 30 }; },
    focus() {},
  }, base);
}

function fixture(startLevel) {
  let menuOpen = false;
  let level = startLevel;
  let value = startLevel === 'high' ? 2 : 1;
  const menu = visible({ getAttribute: (n) => n === 'role' ? 'menu' : null, closest: () => null });
  const thumb = visible({
    getAttribute(n) {
      if (n === 'role') return 'slider';
      if (n === 'aria-valuenow') return String(value);
      if (n === 'aria-valuemin') return '0';
      if (n === 'aria-valuemax') return '3';
      if (n === 'aria-valuetext') return level;
      return null;
    },
  });
  const control = visible({
    innerText: 'Зусилля для міркування',
    getAttribute(n) {
      if (n === 'data-selected-reasoning-effort') return level;
      if (n === 'data-codex-intelligence-trigger') return 'true';
      if (n === 'data-composer-navigation-target') return 'reasoning';
      if (n === 'aria-label') return 'Вибрати модель ChatGPT';
      if (n === 'aria-haspopup') return 'menu';
      return null;
    },
    closest() { return null; },
    click() { menuOpen = !menuOpen; },
  });
  const row = visible({
    getAttribute(n) {
      if (n === 'data-reasoning-slider') return 'true';
      if (n === 'role') return 'menuitem';
      if (n === 'aria-valuetext') return level;
      return null;
    },
    closest(selector) { return selector.includes('[role="menu"') ? menu : null; },
    querySelector(selector) { return selector === '[role="slider"]' ? thumb : null; },
    dispatchEvent(event) {
      if (event.key === 'ArrowRight') {
        value = Math.min(3, value + 1);
        if (value >= 2) level = 'high';
      }
      return true;
    },
  });
  const document = {
    body: { innerText: '' },
    getElementById() { return null; },
    querySelectorAll(selector) {
      if (selector.includes('[data-selected-reasoning-effort]')) return [control];
      if (selector === '[data-reasoning-slider="true"]') return menuOpen ? [row] : [];
      if (selector === '[role="menu"], [role="listbox"], [role="radiogroup"], [role="dialog"]') return menuOpen ? [menu] : [];
      return [];
    },
  };
  return { document, level: () => level };
}

function request() {
  return { requestId: 'effort-1', taskId: 'task-1', expectedUrl: 'https://chatgpt.com/', promptText: '', mode: 'ENSURE_HIGH_EFFORT' };
}

test('Pilot 10 accepts explicit production High state without opening picker', async () => {
  const adapter = loadAdapter();
  const f = fixture('high');
  const result = await adapter.execute(request(), { document: f.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(result.effortLevel, 'high');
});

test('Pilot 10 moves Medium to High without assuming the obsolete 0..2 slider', async () => {
  const adapter = loadAdapter();
  const f = fixture('medium');
  const result = await adapter.execute(request(), { document: f.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(f.level(), 'high');
});
