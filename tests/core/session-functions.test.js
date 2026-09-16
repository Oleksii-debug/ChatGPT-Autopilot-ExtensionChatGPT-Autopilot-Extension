import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionFunctionId,
  SESSION_FUNCTIONS,
  createDefaultSessionFunctions,
  normalizeSessionFunctions,
  setSessionFunctionConfig,
  setSessionFunctionEnabled,
  validateSessionFunctions,
} from '../../src/core/session-functions.js';

test('default Session enables ordinary sending and disables optional modules', () => {
  const functions = createDefaultSessionFunctions();
  assert.equal(functions[SessionFunctionId.ORDINARY_SEND].enabled, true);
  assert.equal(functions[SessionFunctionId.BATCH_CHAT].enabled, false);
  assert.equal(functions[SessionFunctionId.PROMPT_CADENCE].enabled, false);
  assert.equal(functions[SessionFunctionId.DRIVE_SOURCE].enabled, false);
  assert.deepEqual(Object.keys(functions).sort(), [...SESSION_FUNCTIONS].sort());
});

test('legacy or missing function configuration normalizes without losing defaults', () => {
  const functions = normalizeSessionFunctions({
    batch_chat: { enabled: true, config: { concurrency: 5 } },
  });
  assert.equal(functions.batch_chat.enabled, true);
  assert.deepEqual(functions.batch_chat.config, { concurrency: 5 });
  assert.equal(functions.ordinary_send.enabled, true);
  assert.equal(functions.prompt_cadence.enabled, false);
});

test('function enablement changes only the selected module', () => {
  const before = createDefaultSessionFunctions();
  const after = setSessionFunctionEnabled(before, SessionFunctionId.BATCH_CHAT, true);
  assert.equal(after.batch_chat.enabled, true);
  assert.equal(after.ordinary_send.enabled, true);
  assert.equal(before.batch_chat.enabled, false);
});

test('function configuration remains isolated from enablement state', () => {
  const before = createDefaultSessionFunctions();
  const after = setSessionFunctionConfig(before, SessionFunctionId.BATCH_CHAT, { concurrency: 5 });
  assert.deepEqual(after.batch_chat.config, { concurrency: 5 });
  assert.equal(after.batch_chat.enabled, false);
});

test('unknown module identifiers fail closed', () => {
  assert.throws(() => setSessionFunctionEnabled({}, 'unknown_module', true), /Unknown Session function/);
  assert.throws(() => setSessionFunctionConfig({}, 'unknown_module', {}), /Unknown Session function/);
});

test('function registry validates normalized enabled/config shape', () => {
  const functions = validateSessionFunctions(createDefaultSessionFunctions());
  for (const id of SESSION_FUNCTIONS) {
    assert.equal(typeof functions[id].enabled, 'boolean');
    assert.equal(typeof functions[id].config, 'object');
  }
});
