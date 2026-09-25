import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SelectionSourceCaptureV1,
  captureSelectionSourceInPage,
} from '../src/core/selection-source-capture.js';

function chromeFixture({
  url = 'https://example.com/page',
  title = 'Example',
  permission = true,
  result = { url: 'https://example.com/page', text: 'Selected text', tooLarge: false, length: 13 },
} = {}) {
  let executeCalls = 0;
  let currentUrl = url;
  const api = {
    tabs: {
      async query() {
        return [
          { id: 7, url: currentUrl, title, active: true },
          { id: 8, url: 'chrome://settings/', title: 'Settings', active: false },
        ];
      },
      async get(id) {
        assert.equal(id, 7);
        return { id, url: currentUrl, title, active: true };
      },
    },
    permissions: {
      async contains({ origins }) {
        assert.deepEqual(origins, ['https://example.com/*']);
        return permission;
      },
    },
    scripting: {
      async executeScript(details) {
        executeCalls += 1;
        assert.deepEqual(details.target, { tabId: 7, frameIds: [0] });
        assert.equal(details.func, captureSelectionSourceInPage);
        return [{ frameId: 0, result }];
      },
    },
    _executeCalls: () => executeCalls,
    _navigate(next) { currentUrl = next; },
  };
  return api;
}

test('lists only HTTP(S) tabs and reports existing capture permission without requesting it', async () => {
  const chrome = chromeFixture();
  const capture = new SelectionSourceCaptureV1({ chromeApi: chrome });
  const listed = await capture.listTabs();
  assert.equal(listed.tabs.length, 1);
  assert.deepEqual(listed.tabs[0], {
    tabId: 7,
    title: 'Example',
    url: 'https://example.com/page',
    active: true,
    captureAllowed: true,
  });
});

test('selection capture normalizes through SelectionActionSourceV1 and preserves untrusted-data authority fence', async () => {
  const chrome = chromeFixture();
  const capture = new SelectionSourceCaptureV1({ chromeApi: chrome, now: () => 1_798_000_000_000 });
  const out = await capture.capture({ tabId: 7, kind: 'SELECTION' });
  assert.equal(out.source.kind, 'SELECTION');
  assert.equal(out.source.text, 'Selected text');
  assert.equal(out.source.uri, 'https://example.com/page');
  assert.equal(out.source.capturedContentIsUntrusted, true);
  assert.equal(out.source.instructionAuthority, false);
  assert.equal(out.source.permissionGranted, false);
  assert.equal(out.tab.tabId, 7);
  assert.equal(chrome._executeCalls(), 1);
});

test('capture fails before page scripting when host permission is not already granted', async () => {
  const chrome = chromeFixture({ permission: false });
  const capture = new SelectionSourceCaptureV1({ chromeApi: chrome });
  await assert.rejects(
    () => capture.capture({ tabId: 7, kind: 'CURRENT_PAGE' }),
    /must already be granted/,
  );
  assert.equal(chrome._executeCalls(), 0);
});

test('capture rejects oversized source rather than silently truncating it', async () => {
  const chrome = chromeFixture({
    result: { url: 'https://example.com/page', text: '', tooLarge: true, length: 100001 },
  });
  const capture = new SelectionSourceCaptureV1({ chromeApi: chrome });
  await assert.rejects(
    () => capture.capture({ tabId: 7, kind: 'CURRENT_PAGE' }),
    /exceeds 100000 characters/,
  );
});

test('capture rejects navigation races instead of binding content to a different current page', async () => {
  const chrome = chromeFixture();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    const value = await original(details);
    chrome._navigate('https://example.com/other');
    return value;
  };
  const capture = new SelectionSourceCaptureV1({ chromeApi: chrome });
  await assert.rejects(
    () => capture.capture({ tabId: 7, kind: 'SELECTION' }),
    /navigated while source content was being captured/,
  );
});

test('capture request accessors fail closed without executing caller getters', async () => {
  const chrome = chromeFixture();
  const capture = new SelectionSourceCaptureV1({ chromeApi: chrome });
  let reads = 0;
  const hostile = { kind: 'SELECTION' };
  Object.defineProperty(hostile, 'tabId', {
    enumerable: true,
    get() {
      reads += 1;
      return 7;
    },
  });
  await assert.rejects(() => capture.capture(hostile), /enumerable own data property/);
  assert.equal(reads, 0);
  assert.equal(chrome._executeCalls(), 0);
});
