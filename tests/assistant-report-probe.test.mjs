import test from 'node:test';
import assert from 'node:assert/strict';

import { probeAssistantConversation } from '../src/core/assistant-report-probe.js';

function makeChrome(tabsInitial = []) {
  const calls = { create: [], update: [], reload: [], remove: [] };
  const tabs = tabsInitial.map(item => ({ ...item }));
  return {
    calls,
    tabs: {
      async query() { return tabs.map(item => ({ ...item })); },
      async create(args) {
        calls.create.push(args);
        const tab = {
          id: 99,
          url: args.url,
          pendingUrl: args.url,
          status: 'loading',
          autoDiscardable: true,
        };
        tabs.push(tab);
        return { ...tab };
      },
      async update(id, args) {
        calls.update.push([id, args]);
        const tab = tabs.find(item => item.id === id);
        if (tab) Object.assign(tab, args);
        return tab ? { ...tab } : null;
      },
      async reload(id) {
        calls.reload.push(id);
        const tab = tabs.find(item => item.id === id);
        if (tab) {
          tab.status = 'loading';
          tab.discarded = false;
          tab.frozen = false;
        }
      },
      async remove(id) { calls.remove.push(id); },
    },
  };
}

function transport() {
  return {
    calls: [],
    async execute(id, request) {
      this.calls.push([id, request]);
      return {
        status: 'READY',
        assistantComplete: true,
        safeDiagnosticCode: 'ASSISTANT_RESPONSE_READY',
      };
    },
  };
}

test('persistent managed probe protects a healthy Scenario tab and reads it in place', async () => {
  const chrome = makeChrome([{
    id: 1,
    url: 'https://chatgpt.com/c/abc',
    status: 'complete',
    autoDiscardable: true,
  }]);
  const tx = transport();

  const out = await probeAssistantConversation(chrome, tx, {
    conversationUrl: 'https://chatgpt.com/c/abc',
    taskId: 'task-1',
    persistentManagedTab: true,
  });

  assert.equal(out.status, 'READY');
  assert.deepEqual(chrome.calls.update, [[1, { autoDiscardable: false }]]);
  assert.equal(tx.calls.length, 1);
  assert.deepEqual(chrome.calls.create, []);
  assert.deepEqual(chrome.calls.remove, []);
});

test('persistent managed probe never blocks on an already-loading tab', async () => {
  const chrome = makeChrome([{
    id: 2,
    url: 'https://chatgpt.com/c/abc',
    status: 'loading',
    autoDiscardable: true,
  }]);
  const tx = transport();

  const out = await probeAssistantConversation(chrome, tx, {
    conversationUrl: 'https://chatgpt.com/c/abc',
    persistentManagedTab: true,
  });

  assert.equal(out.status, 'TEMPORARY_ERROR');
  assert.equal(out.safeDiagnosticCode, 'ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING');
  assert.equal(out.tabRecoveryPending, true);
  assert.equal(tx.calls.length, 0);
});

test('discarded managed tab is protected and reloaded without response replacement', async () => {
  const chrome = makeChrome([{
    id: 3,
    url: 'https://chatgpt.com/c/abc',
    status: 'complete',
    discarded: true,
    autoDiscardable: true,
  }]);
  const tx = transport();

  const out = await probeAssistantConversation(chrome, tx, {
    conversationUrl: 'https://chatgpt.com/c/abc',
    persistentManagedTab: true,
  });

  assert.equal(out.safeDiagnosticCode, 'ASSISTANT_RESPONSE_TAB_RELOAD_STARTED');
  assert.equal(out.tabRecoveryPending, true);
  assert.deepEqual(chrome.calls.reload, [3]);
  assert.equal(tx.calls.length, 0);
});

test('missing managed conversation is reopened once and kept for the next poll', async () => {
  const chrome = makeChrome([]);
  const tx = transport();

  const out = await probeAssistantConversation(chrome, tx, {
    conversationUrl: 'https://chatgpt.com/c/abc',
    persistentManagedTab: true,
  });

  assert.equal(out.safeDiagnosticCode, 'ASSISTANT_RESPONSE_TAB_REOPENED_WAITING');
  assert.equal(out.tabRecoveryPending, true);
  assert.equal(chrome.calls.create.length, 1);
  assert.deepEqual(chrome.calls.remove, []);
  assert.equal(tx.calls.length, 0);
});
