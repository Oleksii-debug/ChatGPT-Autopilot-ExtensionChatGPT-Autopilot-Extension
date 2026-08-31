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

test('CHECK_ONLY restores a missing receiver in an already-open ChatGPT tab and retries exactly once', async () => {
  const sends = [];
  const injections = [];
  const chromeApi = {
    tabs: {
      async sendMessage(tabId, message) {
        sends.push({ tabId, message });
        if (sends.length === 1) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return { ok: true, data: { status: InteractionResult.READY } };
      },
    },
    scripting: {
      async executeScript(details) { injections.push(details); },
    },
  };
  const transport = new ChromeInteractionTransport(chromeApi);
  const request = { requestId:'r-check', taskId:'t1', mode:'CHECK_ONLY', expectedUrl:'https://chatgpt.com/g/g-x/c/y' };

  const result = await transport.execute(17, request);

  assert.equal(result.status, InteractionResult.READY);
  assert.equal(sends.length, 2, 'CHECK_ONLY must retry only once after receiver restoration');
  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0], {
    target: { tabId: 17 },
    files: [
      'src/interaction/chatgpt-adapter.js',
      'src/interaction/content-script.js',
    ],
  });
});

test('effectful SUBMIT_EXISTING never injects or retries after a missing receiver error', async () => {
  let sends = 0;
  let injections = 0;
  const chromeApi = {
    tabs: {
      async sendMessage() {
        sends += 1;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    },
    scripting: {
      async executeScript() { injections += 1; },
    },
  };
  const transport = new ChromeInteractionTransport(chromeApi);

  await assert.rejects(
    () => transport.execute(17, { requestId:'r-submit', taskId:'t1', mode:'SUBMIT_EXISTING' }),
    /receiving end does not exist/i,
  );
  assert.equal(sends, 1);
  assert.equal(injections, 0, 'effectful send phase must never be automatically replayed');
});

test('CHECK_ONLY missing-receiver recovery fails closed when scripting permission/runtime is unavailable', async () => {
  let sends = 0;
  const chromeApi = {
    tabs: {
      async sendMessage() {
        sends += 1;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    },
  };
  const transport = new ChromeInteractionTransport(chromeApi);

  await assert.rejects(
    () => transport.execute(17, { requestId:'r-check', taskId:'t1', mode:'CHECK_ONLY' }),
    /scripting recovery is unavailable/i,
  );
  assert.equal(sends, 1);
});
