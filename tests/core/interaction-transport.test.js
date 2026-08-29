import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromeInteractionTransport } from '../../src/core/interaction-transport.js';
import { InteractionResult } from '../../src/shared/protocol.js';

test('transport sends one bounded request to the selected tab', async () => {
  let observed;
  const chromeApi = { tabs: { async sendMessage(tabId, message) { observed = { tabId, message }; return { ok:true, data:{ status:InteractionResult.READY } }; } } };
  const transport = new ChromeInteractionTransport(chromeApi);
  const result = await transport.execute(9, { requestId:'r1', taskId:'t1', mode:'CHECK_ONLY', expectedUrl:'https://chatgpt.com/c/x' });
  assert.equal(result.status, InteractionResult.READY);
  assert.equal(observed.tabId, 9);
  assert.equal(observed.message.channel, 'autopilot-interaction');
  assert.equal(observed.message.request.requestId, 'r1');
});

test('transport fails closed on malformed content-script response', async () => {
  const chromeApi = { tabs: { async sendMessage() { return { ok:false, error:{ message:'safe failure' } }; } } };
  const transport = new ChromeInteractionTransport(chromeApi);
  await assert.rejects(() => transport.execute(9, { requestId:'r1' }), /safe failure/);
});
