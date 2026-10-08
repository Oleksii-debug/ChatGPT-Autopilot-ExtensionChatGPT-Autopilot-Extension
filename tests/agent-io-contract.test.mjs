import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentActionHandlerRegistry,
  AgentActionType,
  AgentEventSink,
  AgentEventType,
  getAgentActionRequiredCapability,
  getAgentEventRequiredCapability,
  normalizeAgentAction,
  normalizeAgentEvent,
} from '../src/core/agent-io-contract.js';
import { AgentProviderId, CapabilityId } from '../src/core/capability-registry.js';

function action(overrides = {}) {
  return {
    schemaVersion: 1,
    actionId: 'act-1',
    type: AgentActionType.SUBMIT_PROMPT,
    providerId: AgentProviderId.CHATGPT_BROWSER,
    sessionId: 'session-1',
    taskId: 'task-1',
    createdAt: '2026-09-12T00:00:00Z',
    data: { prompt: 'hello' },
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    type: AgentEventType.ACTION_SUCCEEDED,
    providerId: AgentProviderId.CHATGPT_BROWSER,
    actionId: 'act-1',
    occurredAt: '2026-09-12T00:00:01Z',
    data: { verified: true },
    ...overrides,
  };
}

test('normalizes versioned provider-bound action envelope', () => {
  const normalized = normalizeAgentAction(action());
  assert.equal(normalized.createdAt, '2026-09-12T00:00:00.000Z');
  assert.deepEqual(normalized.data, { prompt: 'hello' });
  assert.ok(Object.isFrozen(normalized));
});

test('action envelope fails closed on unknown schema, type, or provider', () => {
  assert.throws(() => normalizeAgentAction(action({ schemaVersion: 2 })), /schemaVersion/);
  assert.throws(() => normalizeAgentAction(action({ type: 'shell-command' })), /Unsupported agent action type/);
  assert.throws(() => normalizeAgentAction(action({ providerId: 'unknown-provider' })), /Unsupported agent provider/);
});

test('normalizes event envelope and rejects malformed identities', () => {
  const normalized = normalizeAgentEvent(event());
  assert.equal(normalized.occurredAt, '2026-09-12T00:00:01.000Z');
  assert.throws(() => normalizeAgentEvent(event({ eventId: 'bad id with spaces' })), /eventId is invalid/);
});



test('action and event semantics are explicitly bound to provider capabilities', () => {
  assert.equal(getAgentActionRequiredCapability(AgentActionType.SUBMIT_PROMPT), CapabilityId.VERIFIED_PROMPT_SUBMIT);
  assert.equal(getAgentActionRequiredCapability(AgentActionType.PROBE_COMPLETION), CapabilityId.ASSISTANT_COMPLETION_PROBE);
  assert.equal(getAgentActionRequiredCapability(AgentActionType.RECOVER_INTERACTION), CapabilityId.SAFE_RESTART_RECOVERY);
  assert.equal(getAgentEventRequiredCapability(AgentEventType.COMPLETION_OBSERVED), CapabilityId.ASSISTANT_COMPLETION_PROBE);
  assert.equal(getAgentEventRequiredCapability(AgentEventType.RATE_LIMIT_OBSERVED), CapabilityId.RATE_LIMIT_CLASSIFICATION);
  assert.equal(getAgentEventRequiredCapability(AgentEventType.RECOVERY_REQUIRED), CapabilityId.SAFE_RESTART_RECOVERY);
  assert.equal(getAgentEventRequiredCapability(AgentEventType.ACTION_SUCCEEDED), null);
  assert.throws(() => getAgentActionRequiredCapability('future-action'), /Unsupported agent action type/);
  assert.throws(() => getAgentEventRequiredCapability('future-event'), /Unsupported agent event type/);
});

test('handler registry is additive and does not create scheduler semantics', async () => {
  const registry = new AgentActionHandlerRegistry();
  registry.register(AgentProviderId.CHATGPT_BROWSER, AgentActionType.SUBMIT_PROMPT, async (normalized, context) => ({
    actionId: normalized.actionId,
    transport: context.transport,
  }));
  assert.equal(registry.has(AgentProviderId.CHATGPT_BROWSER, AgentActionType.SUBMIT_PROMPT), true);
  assert.deepEqual(await registry.execute(action(), { transport: 'existing-core' }), {
    actionId: 'act-1',
    transport: 'existing-core',
  });
  assert.throws(() => registry.register(AgentProviderId.CHATGPT_BROWSER, AgentActionType.SUBMIT_PROMPT, () => {}), /already registered/);
});

test('event sink validates before publishing', async () => {
  const seen = [];
  const sink = new AgentEventSink({ onEvent: value => seen.push(value) });
  const emitted = await sink.emit(event());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].eventId, emitted.eventId);
  await assert.rejects(() => sink.emit(event({ type: 'unknown-event' })), /Unsupported agent event type/);
  assert.equal(seen.length, 1);
});


test('Plan-1: action and event fields fail closed on authority injection without invoking getters', () => {
  let reads = 0;
  const trapped = action();
  Object.defineProperty(trapped, 'actionId', { enumerable: true, get() { reads += 1; throw new Error('invoked'); } });
  assert.throws(() => normalizeAgentAction(trapped), /data properties/);
  assert.equal(reads, 0);
  assert.throws(() => normalizeAgentAction(action({ permissionGranted: true })), /unknown field/);
  assert.throws(() => normalizeAgentEvent(event({ executionAuthorized: true })), /unknown field/);
  const symbolic = action();
  symbolic[Symbol('hidden')] = true;
  assert.throws(() => normalizeAgentAction(symbolic), /unknown field/);
});

test('Plan-1: untrusted nested payload rejects cycles, accessors, prototype pollution, sparse data and excess bytes', () => {
  const circular = {}; circular.self = circular;
  assert.throws(() => normalizeAgentAction(action({ data: circular })), /acyclic/);
  const nested = { ok: {} };
  let reads = 0;
  Object.defineProperty(nested.ok, 'unsafe', { enumerable: true, get() { reads += 1; return 'leak'; } });
  assert.throws(() => normalizeAgentAction(action({ data: nested })), /data properties/);
  assert.equal(reads, 0);
  const forbidden = Object.create(null);
  Object.defineProperty(forbidden, '__proto__', { value: 'pollute', enumerable: true });
  assert.throws(() => normalizeAgentAction(action({ data: forbidden })), /unsafe property key/);
  const sparse = []; sparse.length = 2; sparse[0] = 'one';
  assert.throws(() => normalizeAgentAction(action({ data: { items: sparse } })), /non-canonical array fields|sparse/);
  assert.throws(() => normalizeAgentAction(action({ data: { prompt: 'x'.repeat(70_000) } })), /size limit/);
});

test('Plan-1: nested effect data stays immutable and independent of caller mutation', () => {
  const original = { nested: { effectId: 'effect-1', checked: ['first'] } };
  const snapshot = normalizeAgentAction(action({ data: original }));
  original.nested.effectId = 'effect-2';
  original.nested.checked.push('second');
  assert.equal(snapshot.data.nested.effectId, 'effect-1');
  assert.deepEqual(snapshot.data.nested.checked, ['first']);
  assert.equal(Object.isFrozen(snapshot.data.nested), true);
  assert.equal(Object.isFrozen(snapshot.data.nested.checked), true);
  assert.throws(() => normalizeAgentAction(action({ data: { value: Number.POSITIVE_INFINITY } })), /acyclic JSON/);
});
