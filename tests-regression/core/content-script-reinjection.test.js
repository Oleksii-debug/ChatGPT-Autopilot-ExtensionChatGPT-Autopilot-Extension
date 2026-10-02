import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/interaction/content-script.js', import.meta.url), 'utf8');
test('reinjection replaces the obsolete adapter listener and remains idempotent for the current adapter', async () => {
  const listeners = new Set();
  const runtime = { onMessage: {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); },
  } };
  const root = vm.createContext({ chrome: { runtime }, document: { querySelectorAll() { return []; } },
    setTimeout, clearTimeout, ChatGPTInteractionAdapter: { async execute() { return { marker: 'old' }; } } });
  vm.runInContext(source, root);
  root.ChatGPTInteractionAdapter = { async execute() { return { marker: 'current' }; } };
  vm.runInContext(source, root);
  vm.runInContext(source, root);
  assert.equal(listeners.size, 1);
  const result = await new Promise(resolve => [...listeners][0]({ channel: 'autopilot-interaction',
    request: { mode: 'CHECK_ONLY' } }, {}, resolve));
  assert.equal(result.data.marker, 'current');
});
