import test from 'node:test';
import assert from 'node:assert/strict';

import { TabReadinessError, waitForTaskTabReady } from '../../src/core/tabs.js';

const expectedUrl = 'https://chatgpt.com/c/expected';

function fakeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    wait: async ms => { value += ms; },
    value: () => value,
  };
}

test('discarded ChatGPT tab is reloaded once and then accepted when ready', async () => {
  const clock = fakeClock();
  let getCalls = 0;
  let reloadCalls = 0;
  const chromeApi = {
    tabs: {
      async get() {
        getCalls += 1;
        if (getCalls === 1) {
          return {
            id: 7,
            url: expectedUrl,
            status: 'complete',
            discarded: true,
          };
        }
        return {
          id: 7,
          url: expectedUrl,
          status: 'complete',
          discarded: false,
        };
      },
      async reload(id) {
        assert.equal(id, 7);
        reloadCalls += 1;
      },
    },
  };

  const tab = await waitForTaskTabReady(chromeApi, 7, expectedUrl, {
    timeoutMs: 10000,
    wakeTimeoutMs: 1000,
    pollIntervalMs: 100,
    now: clock.now,
    wait: clock.wait,
  });

  assert.equal(tab.id, 7);
  assert.equal(reloadCalls, 1);
  assert.equal(getCalls, 2);
  assert.equal(clock.value(), 100);
});

test('frozen ChatGPT tab gets only one bounded wake attempt before safe failure', async () => {
  const clock = fakeClock();
  let reloadCalls = 0;
  const chromeApi = {
    tabs: {
      async get() {
        return {
          id: 8,
          url: expectedUrl,
          status: 'complete',
          frozen: true,
        };
      },
      async reload() {
        reloadCalls += 1;
      },
    },
  };

  await assert.rejects(
    waitForTaskTabReady(chromeApi, 8, expectedUrl, {
      timeoutMs: 10000,
      wakeTimeoutMs: 500,
      pollIntervalMs: 100,
      now: clock.now,
      wait: clock.wait,
    }),
    error => {
      assert.ok(error instanceof TabReadinessError);
      assert.equal(error.safeDiagnosticCode, 'TAB_WAKE_TIMEOUT');
      return true;
    },
  );

  assert.equal(reloadCalls, 1);
  assert.equal(clock.value(), 500);
});

test('suspended tab fails explicitly when Chrome reload API is unavailable', async () => {
  const clock = fakeClock();
  const chromeApi = {
    tabs: {
      async get() {
        return {
          id: 9,
          url: expectedUrl,
          status: 'complete',
          discarded: true,
        };
      },
    },
  };

  await assert.rejects(
    waitForTaskTabReady(chromeApi, 9, expectedUrl, {
      timeoutMs: 10000,
      now: clock.now,
      wait: clock.wait,
    }),
    error => {
      assert.ok(error instanceof TabReadinessError);
      assert.equal(error.safeDiagnosticCode, 'TAB_WAKE_API_UNAVAILABLE');
      return true;
    },
  );
});
