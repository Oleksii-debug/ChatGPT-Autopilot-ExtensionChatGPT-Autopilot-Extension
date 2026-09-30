import test from 'node:test';
import assert from 'node:assert/strict';

import { ChromeInteractionTransport } from '../../src/core/interaction-transport.js';
import { InteractionResult } from '../../src/shared/protocol.js';

const URL = 'https://chatgpt.com/c/scenario-diagnostic';

for (const safeDiagnosticCode of ['ASSISTANT_RESPONSE_TAB_MISSING', 'ASSISTANT_RESPONSE_TAB_FROZEN']) {
  test(`READ_ASSISTANT_REPORT recovers once when content script returns ${safeDiagnosticCode}`, async () => {
    let creates = 0;
    let removes = 0;
    let sends = 0;
    const chromeApi = {
      tabs: {
        async get(tabId) {
          return { id: tabId, url: URL, status: 'complete', discarded: false, frozen: false };
        },
        async sendMessage(tabId) {
          sends += 1;
          if (tabId === 17) {
            return {
              ok: true,
              data: {
                status: InteractionResult.TEMPORARY_ERROR,
                safeDiagnosticCode,
                assistantComplete: false,
              },
            };
          }
          assert.equal(tabId, 91);
          return {
            ok: true,
            data: {
              status: InteractionResult.READY,
              safeDiagnosticCode: 'ASSISTANT_RESPONSE_READY',
              assistantComplete: true,
              assistantText: 'done',
            },
          };
        },
        async create(details) {
          creates += 1;
          assert.deepEqual(details, { url: URL, active: false });
          return { id: 91, url: URL, status: 'complete' };
        },
        async remove(tabId) {
          assert.equal(tabId, 91);
          removes += 1;
        },
      },
    };
    const transport = new ChromeInteractionTransport(chromeApi);

    const result = await transport.execute(17, {
      requestId: `read-${safeDiagnosticCode}`,
      taskId: 'scenario-task',
      mode: 'READ_ASSISTANT_REPORT',
      expectedUrl: URL,
    });

    assert.equal(result.status, InteractionResult.READY);
    assert.equal(result.assistantComplete, true);
    assert.equal(creates, 1);
    assert.equal(removes, 1);
    assert.equal(sends, 2, 'one original read plus one bounded replacement read');
  });
}

test('effectful result diagnostics never activate read-only replacement-tab fallback', async () => {
  let creates = 0;
  const chromeApi = {
    tabs: {
      async sendMessage() {
        return {
          ok: true,
          data: {
            status: InteractionResult.TEMPORARY_ERROR,
            safeDiagnosticCode: 'ASSISTANT_RESPONSE_TAB_MISSING',
          },
        };
      },
      async create() {
        creates += 1;
        return { id: 91, url: URL };
      },
    },
  };
  const transport = new ChromeInteractionTransport(chromeApi);

  const result = await transport.execute(17, {
    requestId: 'effectful',
    taskId: 'scenario-task',
    mode: 'SUBMIT_EXISTING',
    expectedUrl: URL,
  });

  assert.equal(result.status, InteractionResult.TEMPORARY_ERROR);
  assert.equal(creates, 0);
});
