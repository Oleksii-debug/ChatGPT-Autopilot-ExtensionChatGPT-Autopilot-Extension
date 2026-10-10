import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('service worker exposes aggregate Scenario chat-pool read/write/lifecycle commands', async () => {
  const source = await readFile(new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');
  for (const command of [
    'GET_SCENARIO_CHAT_POOL',
    'UPDATE_SCENARIO_CHAT_POOL',
    'START_SCENARIO_CHAT_POOL',
    'PAUSE_SCENARIO_CHAT_POOL',
    'RESUME_SCENARIO_CHAT_POOL',
    'STOP_SCENARIO_CHAT_POOL',
    'DELETE_SCENARIO_CHAT_POOL',
  ]) assert.match(source, new RegExp(command), command);
  assert.match(source, /scenarioWork\.getChatPool/u);
  assert.match(source, /scenarioWork\.updateChatPool/u);
  assert.match(source, /scenarioWork\.pauseChatPool/u);
  assert.match(source, /scenarioWork\.resumeChatPool/u);
  assert.match(source, /scenarioWork\.stopChatPool/u);
});
