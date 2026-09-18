import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, createSession, createEmptyState, validateState } from '../../src/core/schema.js';
import { migrateState } from '../../src/core/storage.js';

function makeLegacyState() {
  const task = createTask({ id: 'task-1', url: 'https://chatgpt.com/c/one' });
  const session = createSession({ id: 'session-1', name: 'Legacy', tasks: [task] });
  delete session.activeFunctions;
  const state = createEmptyState(100);
  state.sessionsById[session.id] = session;
  state.sessionOrder = [session.id];
  state.logs[session.id] = [];
  return state;
}

test('legacy Session gets default function registry during state migration', () => {
  const state = migrateState(makeLegacyState(), 200);
  assert.equal(state.sessionsById['session-1'].activeFunctions.ordinary_send.enabled, true);
  assert.equal(state.sessionsById['session-1'].activeFunctions.batch_chat.enabled, false);
  assert.equal(state.sessionsById['session-1'].activeFunctions.prompt_cadence.enabled, false);
  assert.equal(state.sessionsById['session-1'].activeFunctions.drive_source.enabled, false);
  assert.doesNotThrow(() => validateState(state));
});
