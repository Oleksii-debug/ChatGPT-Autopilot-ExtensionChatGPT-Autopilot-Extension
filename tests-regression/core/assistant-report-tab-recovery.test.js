import test from 'node:test';
import assert from 'node:assert/strict';

import { ChromeInteractionTransport } from '../../src/core/interaction-transport.js';
import { InteractionResult } from '../../src/shared/protocol.js';

const URL = 'https://chatgpt.com/c/scenario-response';
const readRequest = () => ({
  requestId: 'scenario-read',
  taskId: 'scenario-task',
  mode: 'READ_ASSISTANT_REPORT',
  expectedUrl: URL,
});

test('READ_ASSISTANT_REPORT replaces a tab that disappeared before readiness and removes the temporary tab', async () => {
  const created = [];
  const removed = [];
  const sent = [];
  const chromeApi = {
    tabs: {
      async get(tabId) {
        if (tabId === 17) throw new Error('No tab with id: 17');
        return { id: tabId, url: URL, status: 'complete', discarded: false, frozen: false };
      },
      async create(details) {
        created.push(details);
        return { id: 99, url: details.url, status: 'complete' };
      },
      async remove(tabId) { removed.push(tabId); },
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
        return {
          ok: true,
          data: {
            status: InteractionResult.READY,
            assistantComplete: true,
            assistantText: 'finished',
          },
        };
      },
    },
  };
  const transport = new ChromeInteractionTransport(chromeApi);

  const result = await transport.execute(17, readRequest());

  assert.equal(result.status, InteractionResult.READY);
  assert.deepEqual(created, [{ url: URL, active: false }]);
  assert.deepEqual(removed, [99]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tabId, 99);
  assert.equal(sent[0].message.request.mode, 'READ_ASSISTANT_REPORT');
});

test('READ_ASSISTANT_REPORT performs one bounded wake attempt for a frozen tab then falls back to one fresh read-only tab', async () => {
  let clock = 0;
  let reloads = 0;
  let creates = 0;
  let removes = 0;
  const chromeApi = {
    tabs: {
      async get(tabId) {
        if (tabId === 17) {
          return { id: 17, url: URL, status: 'complete', frozen: true, discarded: false };
        }
        return { id: tabId, url: URL, status: 'complete', frozen: false, discarded: false };
      },
      async reload(tabId) {
        assert.equal(tabId, 17);
        reloads += 1;
      },
      async create(details) {
        creates += 1;
        return { id: 101, url: details.url, status: 'complete' };
      },
      async remove(tabId) {
        assert.equal(tabId, 101);
        removes += 1;
      },
      async sendMessage(tabId) {
        assert.equal(tabId, 101);
        return { ok: true, data: { status: InteractionResult.READY, assistantComplete: true } };
      },
    },
  };
  const transport = new ChromeInteractionTransport(chromeApi, {
    tabReadinessOptions: {
      timeoutMs: 100,
      wakeTimeoutMs: 3,
      pollIntervalMs: 1,
      now: () => clock,
      wait: async ms => { clock += ms; },
    },
  });

  const result = await transport.execute(17, readRequest());

  assert.equal(result.status, InteractionResult.READY);
  assert.equal(reloads, 1, 'a frozen evidence tab must be woken at most once');
  assert.equal(creates, 1, 'after bounded wake failure only one temporary exact-conversation tab is allowed');
  assert.equal(removes, 1, 'the temporary read-only tab must be retired');
  assert.equal(clock, 3, 'the frozen tab recovery must stay bounded by the configured wake budget');
});

test('effectful SUBMIT_EXISTING never creates a replacement tab after a lost tab', async () => {
  let creates = 0;
  let sends = 0;
  const chromeApi = {
    tabs: {
      async sendMessage() {
        sends += 1;
        throw new Error('No tab with id: 17');
      },
      async create() {
        creates += 1;
        return { id: 99, url: URL };
      },
    },
  };
  const transport = new ChromeInteractionTransport(chromeApi);

  await assert.rejects(
    () => transport.execute(17, {
      requestId: 'submit',
      taskId: 'scenario-task',
      mode: 'SUBMIT_EXISTING',
      expectedUrl: URL,
    }),
    error => error.safeDiagnosticCode === 'INTERACTION_SEND_FAILED',
  );
  assert.equal(sends, 1);
  assert.equal(creates, 0, 'effectful Send must never be replayed through a replacement tab');
});
