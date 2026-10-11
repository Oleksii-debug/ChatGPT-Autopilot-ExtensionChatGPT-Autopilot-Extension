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
