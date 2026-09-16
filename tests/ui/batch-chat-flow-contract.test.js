import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const uiPath = new URL('../../src/ui/batch-chat-flow-ui.js', import.meta.url);
const cadencePath = new URL('../../src/ui/prompt-cadence-ui.js', import.meta.url);

const source = await readFile(uiPath, 'utf8');
const cadenceSource = await readFile(cadencePath, 'utf8');

test('batch UI is loaded by the existing options UI module', () => {
  assert.match(cadenceSource, /import ['"]\.\/batch-chat-flow-ui\.js['"];?/);
});

test('batch UI exposes one-session rolling concurrency controls', () => {
  for (const id of [
    'batch-chat-flow-section',
    'batch-chat-flow-enabled',
    'batch-chat-flow-seeds',
    'batch-chat-flow-concurrency',
    'batch-chat-flow-total',
    'batch-chat-flow-interval',
    'batch-chat-flow-primary',
    'batch-chat-flow-continue',
    'batch-chat-flow-count',
    'batch-chat-flow-final',
    'batch-chat-flow-save',
    'batch-chat-flow-start',
    'batch-chat-flow-status',
  ]) assert.match(source, new RegExp(id));
  assert.match(source, /SET_BATCH_CHAT_FLOW/);
  assert.match(source, /START_BATCH_CHAT_FLOW/);
  assert.match(source, /GET_BATCH_CHAT_FLOW/);
});

test('batch UI does not silently save an unchecked batch mode', () => {
  assert.match(source, /if \(!enabledInput\.checked\)/);
});

test('batch UI uses globalThis.chrome for safe non-Chrome evaluation', () => {
  assert.doesNotMatch(source, /\bchrome\?\.runtime/);
  assert.match(source, /globalThis\.chrome\?\.runtime/);
});
