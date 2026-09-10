'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
global.location = { href: 'https://chatgpt.com/c/abc' };
global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
const vm = require('node:vm');
const sandbox = { URL, Date, setTimeout, clearTimeout, location: global.location, getComputedStyle: global.getComputedStyle };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/interaction/chatgpt-adapter.js'), 'utf8'), sandbox);
const adapter = sandbox.ChatGPTInteractionAdapter;

function request(mode, promptText) {
  return {
    requestId: 'op-live-regression-1',
    taskId: 'task-1',
    expectedUrl: 'https://chatgpt.com/c/abc',
    promptText,
    mode,
  };
}

function reflowLikeRichEditor(text) {
  // Representative presentation-only changes from a rich contenteditable editor:
  // paragraph boundaries, NBSP and CR/LF normalization. Non-whitespace bytes stay exact.
  return String(text)
    .replace(/\n/g, '\n\n')
    .replace(/ {2}/g, '\u00a0 ');
}

function contentEditableFixture(promptTransform = reflowLikeRichEditor) {
  const messages = [];
  let clicks = 0;
  let document;
  const form = {
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return [send];
      return [];
    },
    getAttribute() { return null; },
    parentElement: null,
  };
  const composer = {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'DIV',
    innerText: '',
    textContent: '',
    parentElement: null,
    ownerDocument: null,
    getAttribute(name) {
      if (name === 'contenteditable') return 'true';
      if (name === 'aria-label') return 'Message';
      if (name === 'role') return 'textbox';
      return null;
    },
    getBoundingClientRect() { return { width: 700, height: 120 }; },
    closest(name) { return name === 'form' ? form : null; },
    focus() {},
    dispatchEvent() { return true; },
  };
  const send = {
    isConnected: true,
    hidden: false,
    disabled: false,
    tagName: 'BUTTON',
    parentElement: null,
    innerText: '',
    textContent: '',
    getAttribute(name) {
      if (name === 'aria-label') return 'Send message';
      if (name === 'aria-disabled') return 'false';
      if (name === 'data-testid') return 'send-button';
      return null;
    },
    getBoundingClientRect() { return { width: 32, height: 32 }; },
    click() {
      clicks += 1;
      const sentText = composer.innerText;
      messages.push({
        isConnected: true,
        hidden: false,
        disabled: false,
        innerText: sentText,
        textContent: sentText,
        parentElement: null,
        getAttribute(name) { return name === 'data-message-author-role' ? 'user' : null; },
        getBoundingClientRect() { return { width: 700, height: 120 }; },
        querySelectorAll() { return []; },
      });
      composer.innerText = '';
      composer.textContent = '';
    },
  };
  document = {
    defaultView: global,
    body: { innerText: '', textContent: '' },
    querySelectorAll(selector) {
      if (selector === 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]') return [composer];
      if (selector === 'button, [role="button"]') return [send];
      if (selector === '[role="dialog"], dialog') return [];
      if (selector === '[role="alertdialog"]') return [];
      if (selector === '[aria-modal="true"]') return [];
      if (selector === '[role="alert"], [role="status"], [aria-live="assertive"]') return [];
      if (selector === '[data-message-author-role="user"], [data-author="user"], article') return messages;
      return [];
    },
    execCommand(command, _ui, value) {
      assert.equal(command, 'insertText');
      composer.innerText = promptTransform(value);
      composer.textContent = composer.innerText;
      return true;
    },
  };
  composer.ownerDocument = document;
  return { document, composer, send, messages, clicks: () => clicks };
}

test('semantic proof accepts rich-editor whitespace reflow but rejects content mutation', () => {
  const expected = 'Рядок 1\n\nРядок 2  з двома пробілами\nРядок 3';
  const observed = reflowLikeRichEditor(expected);
  assert.equal(adapter.promptTextMatches(observed, expected), true);
  assert.equal(adapter.promptTextMatches(observed.replace('Рядок 2', 'ІНШИЙ РЯДОК'), expected), false);
});

test('real chess 2925-char multiline prompt is proven after contenteditable reflow', async () => {
  // The private user profile is delivered privately; public checkouts use a synthetic long prompt.
  const privateProfilePath = path.join(ROOT, 'Chess-profile.json');
  const profile = fs.existsSync(privateProfilePath) ? JSON.parse(fs.readFileSync(privateProfilePath, 'utf8')) : { sessions: [{ sharedPrompt: Array.from({ length: 119 }, (_, i) => `Рядок ${i}: тест  шахового промпту.`).join('\n') }] };
  const prompt = profile.sessions[0].sharedPrompt;
  assert.equal(prompt.length, 2925);
  assert.equal(prompt.split('\n').length, 119);
  const fx = contentEditableFixture();
  const result = await adapter.execute(request('INSERT_ONLY', prompt), { document: fx.document, wait: async () => {} });
  assert.equal(result.status, adapter.STATUS.INSERTED_NOT_SENT);
  assert.equal(result.safeDiagnosticCode, 'INSERTION_TEXT_PROVEN');
  assert.equal(result.composerState, 'VISIBLE_NONEMPTY');
  assert.equal(adapter.promptTextMatches(fx.composer.innerText, prompt), true);
  assert.equal(fx.clicks(), 0);
});

test('PREPARE_SEND accepts semantically identical rich-editor rendering and performs zero Send', async () => {
  const prompt = 'A\n\nB  C\nD';
  const fx = contentEditableFixture();
  fx.composer.innerText = reflowLikeRichEditor(prompt);
  fx.composer.textContent = fx.composer.innerText;
  const result = await adapter.execute(request('PREPARE_SEND', prompt), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.READY);
  assert.equal(result.safeDiagnosticCode, 'PENDING_PROMPT_READY_TO_SUBMIT');
  assert.equal(fx.clicks(), 0);
});

test('SUBMIT_EXISTING sends once and verifies a reflowed user message', async () => {
  const prompt = 'A\n\nB  C\nD';
  const fx = contentEditableFixture();
  fx.composer.innerText = reflowLikeRichEditor(prompt);
  fx.composer.textContent = fx.composer.innerText;
  const result = await adapter.execute(request('SUBMIT_EXISTING', prompt), { document: fx.document, wait: async () => {} });
  assert.equal(fx.clicks(), 1);
  assert.equal(result.status, adapter.STATUS.SENT_VERIFIED);
  assert.equal(result.safeDiagnosticCode, 'SEND_VERIFIED_OPERATION_LOCAL_APPEND');
});

test('PREPARE_SEND still fails closed on actual prompt content change', async () => {
  const prompt = 'A\nB\nC';
  const fx = contentEditableFixture();
  fx.composer.innerText = 'A\nB\nATTACKER';
  fx.composer.textContent = fx.composer.innerText;
  const result = await adapter.execute(request('PREPARE_SEND', prompt), { document: fx.document });
  assert.equal(result.status, adapter.STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(result.safeDiagnosticCode, 'PENDING_PROMPT_MISMATCH_PRE_SEND');
  assert.equal(fx.clicks(), 0);
});

test('MANUAL_REVIEW records the real diagnostic reason and pauses the Session', async () => {
  const { pathToFileURL } = require('node:url');
  const execution = await import(pathToFileURL(path.join(ROOT, 'src/core/execution.js')).href);
  const schema = await import(pathToFileURL(path.join(ROOT, 'src/core/schema.js')).href);
  const session = {
    taskOrder: ['t1'],
    tasksById: { t1: { status: 'IDLE', lastCheckedAt: 0, retryAfterAt: 0, manualReviewReason: '', lastVerifiedSendAt: 0, lastVerifiedFingerprint: '' } },
    runState: schema.RunState.RUNNING,
    retryBackoffMs: 30000,
    busyCheckDelayMs: 2000,
    currentTaskIndex: 0,
    operation: { phase: schema.OperationPhase.INSERTING, updatedAt: 0 },
  };
  execution.applyInteractionResult(session, 0, {
    status: 'MANUAL_REVIEW_REQUIRED',
    safeDiagnosticCode: 'INSERTION_NOT_PROVEN',
  }, { now: 123 });
  assert.equal(session.runState, schema.RunState.PAUSED);
  assert.equal(session.tasksById.t1.manualReviewReason, 'INSERTION_NOT_PROVEN');
  assert.equal(session.operation.phase, schema.OperationPhase.MANUAL_REVIEW);
});

test('explicit Resume clears only safe pre-submit manual review and retries', async () => {
  const { pathToFileURL } = require('node:url');
  const commands = await import(pathToFileURL(path.join(ROOT, 'src/core/commands.js')).href);
  const protocol = await import(pathToFileURL(path.join(ROOT, 'src/shared/protocol.js')).href);
  const schema = await import(pathToFileURL(path.join(ROOT, 'src/core/schema.js')).href);
  const state = schema.createEmptyState(1);
  const task = schema.createTask({ id: 't1', url: 'https://chatgpt.com/c/abc', label: 'Шахи 1' });
  const session = schema.createSession({ id: 's1', name: 'Шахи', tasks: [task], sharedPrompt: 'hello', now: 1 });
  session.runState = schema.RunState.PAUSED;
  task.status = 'MANUAL_REVIEW';
  task.manualReviewReason = 'INSERTION_NOT_PROVEN';
  session.operation = {
    operationId: 'op', sessionId: 's1', taskId: 't1', promptFingerprint: 'f',
    phase: schema.OperationPhase.MANUAL_REVIEW, targetUrl: task.normalizedUrl,
    createdAt: 1, updatedAt: 2, preSendDeadline: 0, submitStartedAt: 0,
    verificationDeadline: 0, promptText: 'hello'
  };
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  state.logs.s1 = [];
  const repo = {
    async load() { return structuredClone(state); },
    async update(fn) {
      const draft = structuredClone(state);
      const next = fn(draft) || draft;
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, structuredClone(next));
      return structuredClone(state);
    },
  };
  const dispatcher = new commands.CoreCommandDispatcher(repo, () => 100, { executionAvailable: true });
  await dispatcher.execute(protocol.CoreCommand.RESUME_SESSION, { sessionId: 's1' });
  assert.equal(state.sessionsById.s1.runState, schema.RunState.RUNNING);
  assert.equal(state.sessionsById.s1.tasksById.t1.manualReviewReason, '');
  assert.equal(state.sessionsById.s1.tasksById.t1.status, 'IDLE');
  assert.equal(state.sessionsById.s1.operation, null);
});

test('Resume refuses to erase manual review after a submit boundary was entered', async () => {
  const { pathToFileURL } = require('node:url');
  const commands = await import(pathToFileURL(path.join(ROOT, 'src/core/commands.js')).href);
  const protocol = await import(pathToFileURL(path.join(ROOT, 'src/shared/protocol.js')).href);
  const schema = await import(pathToFileURL(path.join(ROOT, 'src/core/schema.js')).href);
  const state = schema.createEmptyState(1);
  const task = schema.createTask({ id: 't1', url: 'https://chatgpt.com/c/abc' });
  const session = schema.createSession({ id: 's1', name: 'Шахи', tasks: [task], sharedPrompt: 'hello', now: 1 });
  session.runState = schema.RunState.PAUSED;
  task.status = 'MANUAL_REVIEW';
  task.manualReviewReason = 'PROMPT_CHANGED_AT_SUBMIT_BOUNDARY';
  session.operation = {
    operationId: 'op', sessionId: 's1', taskId: 't1', promptFingerprint: 'f',
    phase: schema.OperationPhase.MANUAL_REVIEW, targetUrl: task.normalizedUrl,
    createdAt: 1, updatedAt: 2, preSendDeadline: 0, submitStartedAt: 10,
    verificationDeadline: 0, promptText: 'hello'
  };
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  state.logs.s1 = [];
  const repo = {
    async load() { return structuredClone(state); },
    async update(fn) { const draft = structuredClone(state); return fn(draft) || draft; },
  };
  const dispatcher = new commands.CoreCommandDispatcher(repo, () => 100, { executionAvailable: true });
  await assert.rejects(
    () => dispatcher.execute(protocol.CoreCommand.RESUME_SESSION, { sessionId: 's1' }),
    /Resolve the uncertain send operation before retrying/
  );
});
