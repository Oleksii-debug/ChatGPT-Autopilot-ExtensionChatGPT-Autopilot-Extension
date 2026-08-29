'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

function loadAdapter(extra = {}) {
  const sourcePath = path.resolve(__dirname, '../../src/interaction/chatgpt-adapter.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sandbox = Object.assign({
    URL,
    Date,
    setTimeout,
    clearTimeout,
    console,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    location: { href: 'https://chatgpt.com/c/abc' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  }, extra);
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: sourcePath });
  return sandbox.ChatGPTInteractionAdapter;
}

function request(overrides = {}) {
  return Object.assign({
    requestId: 'manual09-op-1',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText: 'Exact ProseMirror prompt ✅',
    mode: 'INSERT_ONLY'
  }, overrides);
}

function makeEnvironment(options = {}) {
  const events = [];
  let clicks = 0;
  const state = { activeElement: null };

  const defaultView = {
    Event: FakeEvent,
    InputEvent: FakeEvent,
    getSelection() {
      return { removeAllRanges() {}, addRange() {} };
    }
  };

  const ownerDocument = {
    defaultView,
    activeElement: null,
    createRange() { return { selectNodeContents() {} }; },
    execCommand(command, _showUi, value) {
      if (options.execCommand === false || command !== 'insertText' || !state.activeElement) return false;
      state.activeElement._setFrameworkText(value);
      return true;
    }
  };

  function makeComposer({ initialText = '', directMutationUpdatesModel = false } = {}) {
    let frameworkText = initialText;
    let domText = initialText;
    const element = {
      id: 'prompt-textarea',
      className: 'ProseMirror',
      isConnected: true,
      hidden: false,
      disabled: false,
      tagName: 'DIV',
      ownerDocument,
      parentElement: { querySelectorAll() { return []; } },
      get innerText() { return frameworkText; },
      get textContent() { return domText; },
      set textContent(value) {
        domText = String(value);
        if (directMutationUpdatesModel) frameworkText = String(value);
      },
      getAttribute(name) {
        if (name === 'contenteditable') return 'true';
        if (name === 'id') return 'prompt-textarea';
        if (name === 'aria-disabled') return 'false';
        if (name === 'role') return 'textbox';
        return null;
      },
      getBoundingClientRect() { return { width: 500, height: 48 }; },
      closest() { return null; },
      focus() {
        state.activeElement = element;
        ownerDocument.activeElement = element;
      },
      dispatchEvent(event) {
        events.push(event.type);
        return true;
      },
      _setFrameworkText(value) {
        frameworkText = String(value);
        domText = String(value);
        events.push('execCommand:insertText');
      }
    };
    return element;
  }

  const send = {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'BUTTON',
    innerText: '',
    getAttribute(name) {
      if (name === 'aria-label') return 'Send message';
      if (name === 'aria-disabled') return 'false';
      return null;
    },
    getBoundingClientRect() { return { width: 24, height: 24 }; },
    click() { clicks += 1; }
  };

  function buildDocument(composer) {
    return {
      body: { innerText: '' },
      querySelectorAll(selector) {
        if (selector === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return [composer];
        if (selector === 'button, [role="button"]') return [send];
        if (selector === '[role="dialog"], dialog') return [];
        if (selector === '[data-message-author-role="user"], [data-author="user"], article') return [];
        return [];
      }
    };
  }

  return { makeComposer, buildDocument, events, clicks: () => clicks };
}

test('INSERT_ONLY uses the composer ownerDocument editing transaction and never Sends', async () => {
  const env = makeEnvironment();
  const composer = env.makeComposer();
  const globalDocument = {
    queryCommandSupported() { return false; },
    execCommand() { throw new Error('global document must not own composer editing'); }
  };
  const adapter = loadAdapter({ document: globalDocument });

  const result = await adapter.execute(request(), {
    document: env.buildDocument(composer),
    wait: async () => {}
  });

  assert.equal(result.status, adapter.STATUS.INSERTED_NOT_SENT);
  assert.equal(result.safeDiagnosticCode, 'INSERTION_TEXT_PROVEN');
  assert.equal(composer.innerText, 'Exact ProseMirror prompt ✅');
  assert.equal(env.events.includes('execCommand:insertText'), true);
  assert.equal(env.clicks(), 0);
});

test('contenteditable fallback is accepted only when resulting editor text is observable', async () => {
  const env = makeEnvironment({ execCommand: false });
  const composer = env.makeComposer({ directMutationUpdatesModel: true });
  const adapter = loadAdapter();

  const result = await adapter.execute(request(), {
    document: env.buildDocument(composer),
    wait: async () => {}
  });

  assert.equal(result.status, adapter.STATUS.INSERTED_NOT_SENT);
  assert.equal(result.safeDiagnosticCode, 'INSERTION_TEXT_PROVEN');
  assert.equal(composer.innerText, 'Exact ProseMirror prompt ✅');
  assert.deepEqual(env.events.slice(-2), ['beforeinput', 'input']);
  assert.equal(env.clicks(), 0);
});

test('INSERT_ONLY refuses to overwrite an unrelated ProseMirror draft', async () => {
  const env = makeEnvironment();
  const composer = env.makeComposer({ initialText: 'Existing user draft' });
  const adapter = loadAdapter();

  const result = await adapter.execute(request(), {
    document: env.buildDocument(composer),
    wait: async () => {}
  });

  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.safeDiagnosticCode, 'COMPOSER_CONTAINS_OTHER_CONTENT');
  assert.equal(composer.innerText, 'Existing user draft');
  assert.equal(env.clicks(), 0);
});
