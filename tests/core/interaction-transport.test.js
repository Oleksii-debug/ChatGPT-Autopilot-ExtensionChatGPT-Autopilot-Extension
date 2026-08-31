import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromeInteractionTransport } from '../../src/core/interaction-transport.js';
import { InteractionResult } from '../../src/shared/protocol.js';

function readyTabApi(extra = {}, url = 'https://chatgpt.com/c/x') {
  return {
    async get(tabId) {
      return { id: tabId, url, status: 'complete' };
    },
    ...extra,
  };
}

test('transport sends one bounded request to the selected tab', async () => {
  let observed;
  const chromeApi = { tabs: readyTabApi({ async sendMessage(tabId, message) { observed = { tabId, message }; return { ok:true, data:{ status:InteractionResult.READY } }; } }) };
  const transport = new ChromeInteractionTransport(chromeApi);
  const result = await transport.execute(9, { requestId:'r1', taskId:'t1', mode:'CHECK_ONLY', expectedUrl:'https://chatgpt.com/c/x' });
  assert.equal(result.status, InteractionResult.READY);
  assert.equal(observed.tabId, 9);
  assert.equal(observed.message.channel, 'autopilot-interaction');
  assert.equal(observed.message.request.requestId, 'r1');
});

test('CHECK_ONLY waits for a newly created or worker-navigated tab before messaging the receiver', async () => {
  let status = 'loading';
  let gets = 0;
  let sends = 0;
  let injections = 0;
  let clock = 0;
  const chromeApi = {
    tabs: {
      async get(tabId) {
        gets += 1;
        if (gets >= 2) status = 'complete';
        return { id: tabId, url: 'https://chatgpt.com/c/x', status };
      },
      async sendMessage() {
        sends += 1;
        if (status !== 'complete') {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return { ok: true, data: { status: InteractionResult.READY } };
      },
    },
    scripting: {
      async executeScript() {
        injections += 1;
        throw new Error('Frame with ID 0 was removed.');
      },
    },
  };
  const transport = new ChromeInteractionTransport(chromeApi, {
    tabReadinessOptions: {
      timeoutMs: 1000,
      pollIntervalMs: 1,
      now: () => clock,
      wait: async (ms) => { clock += ms; },
    },
  });

  const result = await transport.execute(17, {
    requestId: 'r-check',
    taskId: 't1',
    mode: 'CHECK_ONLY',
    expectedUrl: 'https://chatgpt.com/c/x',
  });

  assert.equal(result.status, InteractionResult.READY);
  assert.equal(gets, 2, 'the transport must observe document readiness before messaging');
  assert.equal(sends, 1, 'readiness must avoid a speculative missing-receiver send');
  assert.equal(injections, 0, 'a loading document must not trigger receiver injection');
});

test('CHECK_ONLY navigation timeout exposes a safe diagnostic and performs zero interaction attempts', async () => {
  let clock = 0;
  let sends = 0;
  let injections = 0;
  const chromeApi = {
    tabs: {
      async get(tabId) {
        return { id: tabId, url: 'https://chatgpt.com/c/x', status: 'loading' };
      },
      async sendMessage() { sends += 1; },
    },
    scripting: {
      async executeScript() { injections += 1; },
    },
  };
  const transport = new ChromeInteractionTransport(chromeApi, {
    tabReadinessOptions: {
      timeoutMs: 3,
      pollIntervalMs: 1,
      now: () => clock,
      wait: async (ms) => { clock += ms; },
    },
  });

  await assert.rejects(
    () => transport.execute(17, {
      requestId: 'r-check',
      taskId: 't1',
      mode: 'CHECK_ONLY',
      expectedUrl: 'https://chatgpt.com/c/x',
    }),
    (error) => error.safeDiagnosticCode === 'TAB_NAVIGATION_TIMEOUT'
      && error.autopilotTaskId === 't1'
      && error.autopilotMode === 'CHECK_ONLY',
  );
  assert.equal(sends, 0);
  assert.equal(injections, 0);
});

test('CHECK_ONLY polls a hydrated document until the ChatGPT composer becomes ready', async () => {
  let sends = 0;
  let clock = 0;
  const chromeApi = {
    tabs: readyTabApi({
      async sendMessage() {
        sends += 1;
        if (sends < 3) {
          return {
            ok: true,
            data: {
              status: InteractionResult.TEMPORARY_ERROR,
              safeDiagnosticCode: 'COMPOSER_NOT_READY',
            },
          };
        }
        return { ok: true, data: { status: InteractionResult.READY, safeDiagnosticCode: 'READY' } };
      },
    }),
  };
  const transport = new ChromeInteractionTransport(chromeApi, {
    checkOnlyUiReadinessOptions: {
      timeoutMs: 10,
      pollIntervalMs: 1,
      now: () => clock,
      wait: async (ms) => { clock += ms; },
    },
  });

  const result = await transport.execute(17, {
    requestId: 'r-hydration',
    taskId: 't1',
    mode: 'CHECK_ONLY',
    expectedUrl: 'https://chatgpt.com/c/x',
  });

  assert.equal(result.status, InteractionResult.READY);
  assert.equal(sends, 3);
  assert.equal(clock, 2);
});

test('CHECK_ONLY hydration polling remains bounded and returns the safe temporary result', async () => {
  let sends = 0;
  let clock = 0;
  const chromeApi = {
    tabs: readyTabApi({
      async sendMessage() {
        sends += 1;
        return {
          ok: true,
          data: {
            status: InteractionResult.TEMPORARY_ERROR,
            safeDiagnosticCode: 'COMPOSER_NOT_READY',
          },
        };
      },
    }),
  };
  const transport = new ChromeInteractionTransport(chromeApi, {
    checkOnlyUiReadinessOptions: {
      timeoutMs: 3,
      pollIntervalMs: 1,
      now: () => clock,
      wait: async (ms) => { clock += ms; },
    },
  });

  const result = await transport.execute(17, {
    requestId: 'r-hydration-timeout',
    taskId: 't1',
    mode: 'CHECK_ONLY',
    expectedUrl: 'https://chatgpt.com/c/x',
  });

  assert.equal(result.status, InteractionResult.TEMPORARY_ERROR);
  assert.equal(result.safeDiagnosticCode, 'COMPOSER_NOT_READY');
  assert.equal(sends, 4);
  assert.equal(clock, 3);
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
    tabs: readyTabApi({
      async sendMessage(tabId, message) {
        sends.push({ tabId, message });
        if (sends.length === 1) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return { ok: true, data: { status: InteractionResult.READY } };
      },
    }, 'https://chatgpt.com/g/g-x/c/y'),
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
    tabs: readyTabApi({
      async sendMessage() {
        sends += 1;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    }),
  };
  const transport = new ChromeInteractionTransport(chromeApi);

  await assert.rejects(
    () => transport.execute(17, {
      requestId:'r-check',
      taskId:'t1',
      mode:'CHECK_ONLY',
      expectedUrl:'https://chatgpt.com/c/x',
    }),
    (error) => error.safeDiagnosticCode === 'INTERACTION_RECEIVER_RESTORE_FAILED'
      && /scripting recovery is unavailable/i.test(String(error.cause?.message)),
  );
  assert.equal(sends, 1);
});
