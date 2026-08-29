import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { InteractionResult } from '../../src/shared/protocol.js';

class Repo {
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(fn) { const draft = structuredClone(this.state); const next = await fn(draft) || draft; next.revision = this.state.revision + 1; this.state = structuredClone(next); return this.load(); }
}

function setup() {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/example' });
  const session = createSession({ id: 's1', name: 'S', tasks: [task], sharedPrompt: 'hello', preSendDelayMs: 1000, minimumSendIntervalMs: 5000, now: 1 });
  session.runState = RunState.RUNNING;
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return state;
}

const chromeApi = { tabs: {
  async get() { return { id: 7, url: 'https://chatgpt.com/c/example' }; },
  async query() { return [{ id: 7, url: 'https://chatgpt.com/c/example' }]; },
  async create({ url }) { return { id: 8, url }; },
} };

test('executor persists pre-send wait after verified insertion', async () => {
  const repo = new Repo(setup());
  const clock = { value: 100 };
  const modes = [];
  const transport = { async execute(_tab, request) {
    modes.push(request.mode);
    if (request.mode === 'CHECK_ONLY') return { status: InteractionResult.READY };
    return { status: InteractionResult.INSERTED_NOT_SENT, composerState: 'VISIBLE_NONEMPTY', safeDiagnosticCode: 'INSERTION_TEXT_PROVEN' };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => clock.value, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  assert.equal(result.kind, 'WAIT_PRE_SEND');
  assert.deepEqual(modes, ['CHECK_ONLY', 'INSERT_ONLY']);
  assert.equal((await repo.load()).sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
});

test('executor verifies ambiguous operation before any new insertion', async () => {
  const state = setup();
  state.sessionsById.s1.runState = RunState.RECOVERING;
  state.sessionsById.s1.operation = { operationId:'op1', sessionId:'s1', taskId:'t1', promptFingerprint:'fp', promptText:'hello', phase:OperationPhase.AMBIGUOUS, targetUrl:'https://chatgpt.com/c/example', createdAt:1, updatedAt:2, preSendDeadline:0, submitStartedAt:2, verificationDeadline:0 };
  state.sendArbiter.lease = { ownerSessionId:'s1', operationId:'op1', acquiredAt:2, expiresAt:9999 };
  const repo = new Repo(state);
  const modes = [];
  const transport = { async execute(_tab, request) { modes.push(request.mode); return { status: InteractionResult.SENT_VERIFIED }; } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  assert.equal(result.kind, 'RECOVERED_SENT');
  assert.deepEqual(modes, ['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
  assert.equal((await repo.load()).sendArbiter.lease, null);
});
