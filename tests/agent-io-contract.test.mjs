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


test('Agent IO outer envelopes are exact descriptor snapshots with zero getter execution', () => {
  let reads = 0;
  const accessor = action();
  Object.defineProperty(accessor, 'providerId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return AgentProviderId.CHATGPT_BROWSER;
    },
  });
  assert.throws(() => normalizeAgentAction(accessor), /enumerable own data property/);
  assert.equal(reads, 0);

  const inherited = Object.assign(Object.create({ actionId: 'forged' }), action());
  assert.throws(() => normalizeAgentAction(inherited), /plain object/);

  const unknown = action({ hiddenAuthority: true });
  assert.throws(() => normalizeAgentAction(unknown), /unknown field/);

  const symbol = action();
  symbol[Symbol('authority')] = true;
  assert.throws(() => normalizeAgentAction(symbol), /unknown field/);

  const hidden = action();
  Object.defineProperty(hidden, 'shadow', { enumerable: false, value: true });
  assert.throws(() => normalizeAgentAction(hidden), /unknown field/);

  const eventAccessor = event();
  Object.defineProperty(eventAccessor, 'eventId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'evt-2';
    },
  });
  assert.throws(() => normalizeAgentEvent(eventAccessor), /enumerable own data property/);
  assert.equal(reads, 0);
});

test('Agent IO identity, type and timestamp boundaries never coerce caller objects', () => {
  let coercions = 0;
  const coercive = {
    toString() {
      coercions += 1;
      return 'act-1';
    },
    valueOf() {
      coercions += 1;
      return 1;
    },
  };

  assert.throws(() => normalizeAgentAction(action({ actionId: coercive })), /actionId is invalid/);
  assert.throws(() => normalizeAgentAction(action({ providerId: coercive })), /providerId is invalid/);
  assert.throws(() => normalizeAgentAction(action({ type: coercive })), /Unsupported agent action type/);
  assert.throws(() => normalizeAgentAction(action({ createdAt: coercive })), /timestamp string/);
  assert.equal(coercions, 0);

  assert.throws(() => normalizeAgentAction(action({ actionId: 1 })), /actionId is invalid/);
  assert.throws(() => normalizeAgentAction(action({ type: ' submit-prompt ' })), /Unsupported agent action type/);
  assert.throws(() => normalizeAgentEvent(event({ eventId: 1 })), /eventId is invalid/);
  assert.equal(getAgentActionRequiredCapability(AgentActionType.SUBMIT_PROMPT), CapabilityId.VERIFIED_PROMPT_SUBMIT);
});

test('Agent IO snapshots bounded portable data without executing nested getters', () => {
  let reads = 0;
  const nested = { prompt: 'hello', metadata: {} };
  Object.defineProperty(nested.metadata, 'secret', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'do-not-read';
    },
  });
  assert.throws(() => normalizeAgentAction(action({ data: nested })), /enumerable own data property/);
  assert.equal(reads, 0);

  const sparse = new Array(2);
  sparse[0] = 'one';
  assert.throws(() => normalizeAgentAction(action({ data: { values: sparse } })), /enumerable own data property/);

  const symbolData = { prompt: 'hello' };
  symbolData[Symbol('authority')] = true;
  assert.throws(() => normalizeAgentAction(action({ data: symbolData })), /symbol field/);

  const exotic = Object.create({ inherited: true });
  exotic.prompt = 'hello';
  assert.throws(() => normalizeAgentAction(action({ data: exotic })), /plain data objects/);

  assert.throws(() => normalizeAgentAction(action({ data: { value: -0 } })), /non-canonical number/);
  assert.throws(() => normalizeAgentEvent(event({ data: { value: Number.POSITIVE_INFINITY } })), /non-canonical number/);
});

test('Agent IO normalized data is immutable and detached from caller mutation', () => {
  const raw = action({
    data: {
      prompt: 'hello',
      metadata: { attempt: 1 },
      tags: ['safe'],
    },
  });
  const normalized = normalizeAgentAction(raw);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.data));
  assert.ok(Object.isFrozen(normalized.data.metadata));
  assert.ok(Object.isFrozen(normalized.data.tags));

  raw.data.prompt = 'mutated';
  raw.data.metadata.attempt = 999;
  raw.data.tags[0] = 'changed';
  assert.equal(normalized.data.prompt, 'hello');
  assert.equal(normalized.data.metadata.attempt, 1);
  assert.deepEqual(normalized.data.tags, ['safe']);
});

test('Agent IO registry and sink option boundaries reject coercive aliases without executing them', () => {
  const registry = new AgentActionHandlerRegistry();
  let coercions = 0;
  const coercive = {
    toString() {
      coercions += 1;
      return AgentProviderId.CHATGPT_BROWSER;
    },
  };
  assert.equal(registry.has(coercive, AgentActionType.SUBMIT_PROMPT), false);
  assert.equal(registry.has(AgentProviderId.CHATGPT_BROWSER, coercive), false);
  assert.throws(
    () => registry.register(coercive, AgentActionType.SUBMIT_PROMPT, () => {}),
    /providerId is invalid/,
  );

  const options = {};
  Object.defineProperty(options, 'onEvent', {
    enumerable: true,
    get() {
      coercions += 1;
      return () => {};
    },
  });
  assert.throws(() => new AgentEventSink(options), /enumerable own data property/);
  assert.equal(coercions, 0);
});
