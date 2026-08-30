import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../../src/ui/start-save-guard.js', import.meta.url), 'utf8');

function makeHarness({ saveSucceeds = true } = {}) {
  let version = 1;
  let validationInvalid = false;
  let normalStartCount = 0;
  let saveClickCount = 0;
  let guardHandler = null;

  const makeEvent = () => ({
    defaultPrevented: false,
    immediateStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.immediateStopped = true; },
  });

  const startButton = {
    id: 'start-session-button',
    disabled: false,
    addEventListener(type, handler, options) {
      assert.equal(type, 'click');
      assert.equal(options?.capture, true);
      guardHandler = handler;
    },
    click() {
      const event = makeEvent();
      const result = guardHandler?.(event);
      if (!event.immediateStopped) normalStartCount += 1;
      return result;
    },
  };

  const saveButton = {
    click() {
      saveClickCount += 1;
      if (saveSucceeds) version += 1;
      else validationInvalid = true;
    },
  };

  const elements = {
    'start-session-button': startButton,
    'save-session-button': saveButton,
    'command-result': { textContent: '' },
    'app-status': { textContent: '' },
    'live-announcer': { textContent: '' },
  };

  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelector(selector) {
      if (selector === '#session-list [aria-current="page"]') return { id: 'session-select-session-1' };
      if (selector === '#session-editor [aria-invalid="true"]') return validationInvalid ? {} : null;
      return null;
    },
  };

  const chrome = {
    runtime: {
      async sendMessage(message) {
        assert.equal(message.channel, 'autopilot-ui');
        assert.equal(message.command, 'GET_SESSION');
        assert.equal(message.payload.sessionId, 'session-1');
        return { ok: true, data: { session: { id: 'session-1', version } } };
      },
    },
  };

  const context = {
    document,
    chrome,
    Promise,
    Date,
    Number,
    Error,
    setTimeout: (fn) => { fn(); return 1; },
    requestAnimationFrame: (fn) => fn(),
  };
  vm.runInNewContext(source, context, { filename: 'start-save-guard.js' });

  return {
    makeEvent,
    get guardHandler() { return guardHandler; },
    get normalStartCount() { return normalStartCount; },
    get saveClickCount() { return saveClickCount; },
    elements,
  };
}

test('options loads save-before-start guard before the normal options handler', () => {
  const guardAt = html.indexOf('<script type="module" src="start-save-guard.js"></script>');
  const optionsAt = html.indexOf('<script type="module" src="options.js"></script>');
  assert.ok(guardAt >= 0, 'start-save guard script missing');
  assert.ok(optionsAt > guardAt, 'guard must load before options.js');
});

test('Start saves the current stopped-session configuration before allowing normal Start', async () => {
  const h = makeHarness({ saveSucceeds: true });
  const first = h.makeEvent();
  await h.guardHandler(first);

  assert.equal(first.defaultPrevented, true);
  assert.equal(first.immediateStopped, true);
  assert.equal(h.saveClickCount, 1, 'Start must trigger exactly one save');
  assert.equal(h.normalStartCount, 1, 'normal START_SESSION click must run only after saved Core version is observed');
});

test('Start remains blocked when Save validation fails', async () => {
  const h = makeHarness({ saveSucceeds: false });
  const first = h.makeEvent();
  await h.guardHandler(first);

  assert.equal(h.saveClickCount, 1);
  assert.equal(h.normalStartCount, 0, 'invalid unsaved configuration must never reach START_SESSION');
});
