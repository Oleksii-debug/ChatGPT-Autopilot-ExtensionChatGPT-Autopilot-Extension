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

test('Plan-1: unbound action lifecycle evidence cannot be published after restart', async () => {
  const sink = new AgentEventSink({ onEvent: () => { throw new Error('unbound event published'); } });
  for (const type of [AgentEventType.ACTION_STARTED, AgentEventType.ACTION_SUCCEEDED, AgentEventType.ACTION_FAILED]) {
    assert.throws(() => normalizeAgentEvent(event({ type, actionId: null })), /requires an exact actionId/);
    await assert.rejects(() => sink.emit(event({ type, actionId: '' })), /requires an exact actionId/);
  }
  assert.equal(normalizeAgentEvent(event({ type: AgentEventType.COMPLETION_OBSERVED, actionId: null })).actionId, null);
});

test('Plan-1: handler existence probes never recognize invalid provider aliases', () => {
  const registry = new AgentActionHandlerRegistry();
  registry.register(AgentProviderId.CHATGPT_BROWSER, AgentActionType.SUBMIT_PROMPT, () => true);
  assert.equal(registry.has(AgentProviderId.CHATGPT_BROWSER, AgentActionType.SUBMIT_PROMPT), true);
  assert.equal(registry.has(` ${AgentProviderId.CHATGPT_BROWSER} `, AgentActionType.SUBMIT_PROMPT), false);
  assert.equal(registry.has(AgentProviderId.CHATGPT_BROWSER, ` ${AgentActionType.SUBMIT_PROMPT} `), false);
  assert.equal(registry.has(AgentProviderId.CHATGPT_BROWSER, 'future-action'), false);
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


test('Plan-1: hostile action/event type coercion cannot execute or disclose secrets', () => {
  const secret = 'secret-value-not-for-logs';
  let hooks = 0;
  const hostileType = { toString() { hooks += 1; throw new Error(secret); } };
  assert.throws(() => normalizeAgentAction(action({ type: hostileType })), /Unsupported agent action type/);
  assert.throws(() => normalizeAgentEvent(event({ type: hostileType })), /Unsupported agent event type/);
  assert.equal(hooks, 0);
  let rejection;
  try { normalizeAgentAction(action({ data: { secret: secret.repeat(9000) } })); } catch (error) { rejection = error; }
  assert.ok(rejection);
  assert.match(rejection.message, /size limit/);
  assert.doesNotMatch(rejection.message, /secret-value-not-for-logs/);
});


test('Plan-1: Agent chronology rejects ambiguous, rolled and timezone-free timestamps', () => {
  for (const timestamp of [
    '0', '2026-09-12', '2026-09-12T00:00:00',
    '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z',
    '2026-09-12T24:00:00Z', '2026-09-12T00:00:00.1234Z',
    '2026-09-12T00:00:00+25:00',
  ]) {
    assert.throws(
      () => normalizeAgentAction(action({ createdAt: timestamp })),
      /timestamp|calendar date/i,
      'action must reject ' + timestamp,
    );
    assert.throws(
      () => normalizeAgentEvent(event({ occurredAt: timestamp })),
      /timestamp|calendar date/i,
      'event must reject ' + timestamp,
    );
  }
  assert.equal(
    normalizeAgentAction(action({ createdAt: '2026-09-12T02:00:00+02:00' })).createdAt,
    '2026-09-12T00:00:00.000Z',
  );
  assert.equal(
    normalizeAgentEvent(event({ occurredAt: '2026-09-11T23:59:59.500-01:00' })).occurredAt,
    '2026-09-12T00:59:59.500Z',
  );
});

test('Plan-1: capability queries and handler lookup never coerce attacker-controlled action types', () => {
  let invoked = 0;
  const hostile = {
    toString() { invoked += 1; throw new Error('secret-do-not-emit'); },
    valueOf() { invoked += 1; throw new Error('secret-do-not-emit'); },
  };
  assert.throws(() => getAgentActionRequiredCapability(hostile), /Unsupported agent action type/);
  assert.throws(() => getAgentEventRequiredCapability(hostile), /Unsupported agent event type/);
  const registry = new AgentActionHandlerRegistry();
  assert.throws(() => registry.register(AgentProviderId.CHATGPT_BROWSER, hostile, () => {}), /Unsupported agent action type/);
  assert.equal(registry.has(AgentProviderId.CHATGPT_BROWSER, hostile), false);
  assert.equal(registry.has(hostile, AgentActionType.SUBMIT_PROMPT), false);
  assert.equal(invoked, 0, 'untrusted coercion hooks must not run');
  assert.equal(getAgentActionRequiredCapability(AgentActionType.SUBMIT_PROMPT), CapabilityId.VERIFIED_PROMPT_SUBMIT);
});


test('Plan-1 S1: agent action/event diagnostics redact unknown keys and do not invoke hostile accessors', () => {
  const secret = 'OWNER-PRIVATE-TOKEN-SHOULD-NOT-BE-DISCLOSED';
  let reads = 0;
  const hostileAction = action();
  Object.defineProperty(hostileAction, secret, {
    enumerable: true,
    get() { reads += 1; throw new Error('must not call this getter'); },
  });
  assert.throws(() => normalizeAgentAction(hostileAction), error => {
    assert.match(error.message, /unknown field|enumerable own data properties/);
    assert.doesNotMatch(error.message, /OWNER-PRIVATE|TOKEN-SHOULD|getter/);
    return true;
  });

  const hostileEvent = event();
  Object.defineProperty(hostileEvent, Symbol(secret), { enumerable: true, value: 'ALLOW' });
  assert.throws(() => normalizeAgentEvent(hostileEvent), error => {
    assert.match(error.message, /unknown field|enumerable own data properties/);
    assert.doesNotMatch(error.message, /OWNER-PRIVATE|TOKEN-SHOULD/);
    return true;
  });
  assert.equal(reads, 0);
});


test('Plan-1 S1: explicit corrupt action/event payload cannot silently erase evidence on recovery', () => {
  const legacyAction = action(); delete legacyAction.data;
  const legacyEvent = event(); delete legacyEvent.data;
  const restoredAction = normalizeAgentAction(legacyAction);
  const restoredEvent = normalizeAgentEvent(legacyEvent);
  assert.deepEqual(restoredAction.data, {});
  assert.deepEqual(restoredEvent.data, {});
  assert.deepEqual(normalizeAgentAction(JSON.parse(JSON.stringify(restoredAction))), restoredAction);
  assert.deepEqual(normalizeAgentEvent(JSON.parse(JSON.stringify(restoredEvent))), restoredEvent);

  for (const corruptData of [null, undefined]) {
    const untrustedAction = action({ data: corruptData });
    const untrustedEvent = event({ data: corruptData });
    assert.throws(
      () => normalizeAgentAction(untrustedAction),
      /action data contains corrupt explicitly present data/,
    );
    assert.throws(
      () => normalizeAgentEvent(untrustedEvent),
      /event data contains corrupt explicitly present data/,
    );
    assert.equal(untrustedAction.data, corruptData);
    assert.equal(untrustedEvent.data, corruptData);
  }
  const validAction = normalizeAgentAction(action({
    data: { effect: { effectId: 'effect-reserved', phase: 'PREPARED' } },
  }));
  const validEvent = normalizeAgentEvent(event({
    data: { observed: { artifactId: 'artifact-verified', result: 'OK' } },
  }));
  assert.equal(Object.isFrozen(validAction.data.effect), true);
  assert.equal(Object.isFrozen(validEvent.data.observed), true);
  assert.deepEqual(normalizeAgentAction(JSON.parse(JSON.stringify(validAction))), validAction);
  assert.deepEqual(normalizeAgentEvent(JSON.parse(JSON.stringify(validEvent))), validEvent);
});

test('Plan-1 S1: hostile Proxy reflection never leaks errors or publishes false action/effect evidence', async () => {
  const secret = 'PRIVATE-OWNER-CREDENTIAL-IN-REFLECTION-TRAP';
  let traps = 0;
  const hostile = (target, operation) => new Proxy(target, {
    [operation]() {
      traps += 1;
      throw new Error(secret);
    },
  });
  const assertSafeDenial = operation => {
    assert.throws(operation, error => {
      assert.match(error.message, /cannot be safely inspected/);
      assert.doesNotMatch(error.message, /PRIVATE-OWNER|CREDENTIAL|REFLECTION-TRAP/);
      return true;
    });
  };

  for (const operation of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    assertSafeDenial(() => normalizeAgentAction(hostile(action(), operation)));
    assertSafeDenial(() => normalizeAgentEvent(hostile(event(), operation)));
    assertSafeDenial(() => normalizeAgentAction(action({
      data: { nested: hostile({ effectId: 'effect-not-committed' }, operation) },
    })));
    assertSafeDenial(() => normalizeAgentEvent(event({
      data: { nested: hostile({ verified: false }, operation) },
    })));
    assertSafeDenial(() => normalizeAgentAction(action({
      data: { stages: hostile(['pending'], operation) },
    })));
    assertSafeDenial(() => normalizeAgentEvent(event({
      data: { observations: hostile(['not-verified'], operation) },
    })));
  }
  assert.equal(traps, 18, 'each hostile trap must be rejected without re-evaluation');

  const recorded = [];
  const sink = new AgentEventSink({ onEvent: value => recorded.push(value) });
  await assert.rejects(
    () => sink.emit(hostile(event(), 'ownKeys')),
    error => {
      assert.match(error.message, /cannot be safely inspected/);
      assert.doesNotMatch(error.message, /PRIVATE-OWNER|CREDENTIAL/);
      return true;
    },
  );
  assert.equal(recorded.length, 0, 'denied evidence cannot reach the event sink');
  assert.equal(traps, 19);

  // A rejected hostile input must not poison the normal path or cold recovery.
  const stableAction = normalizeAgentAction(action({ data: {
    effectId: 'effect-verified-before-commit', status: 'PENDING',
  } }));
  const stableEvent = await sink.emit(event({ data: { observed: true, attempts: [1] } }));
  assert.equal(recorded.length, 1);
  assert.deepEqual(normalizeAgentAction(JSON.parse(JSON.stringify(stableAction))), stableAction);
  assert.deepEqual(normalizeAgentEvent(JSON.parse(JSON.stringify(stableEvent))), stableEvent);
  assert.ok(Object.isFrozen(stableAction.data));
  assert.ok(Object.isFrozen(stableEvent.data.attempts));
});

test('Plan-1 S1: direct actions and events reject JSON-lossy negative zero across restart', () => {
  const validAction = normalizeAgentAction(action({ data: { offset: 0 } }));
  const validEvent = normalizeAgentEvent(event({ data: { metrics: [{ offset: 0 }] } }));
  assert.equal(validAction.data.offset, 0);
  assert.equal(validEvent.data.metrics[0].offset, 0);
  for (const payload of [{ offset: -0 }, { metrics: [{ offset: -0 }] }]) {
    assert.throws(() => normalizeAgentAction(action({ data: payload })), /non-canonical negative zero/);
    assert.throws(() => normalizeAgentEvent(event({ data: payload })), /non-canonical negative zero/);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(validAction.data)), { offset: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(validEvent.data)), { metrics: [{ offset: 0 }] });
});

test('Plan-1 S1: nested Agent I/O array snapshots never invoke hostile Proxy length getters', () => {
  const secret = 'PRIVATE-PROXY-ARRAY-LENGTH-TRAP';
  let lengthReads = 0;
  const wrap = items => new Proxy(items, {
    get(target, property, receiver) {
      if (property === 'length') {
        lengthReads += 1;
        throw new Error(secret);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const normalizedAction = normalizeAgentAction(action({
    data: { steps: wrap([{ effectId: 'effect-1', attempt: 1 }]) },
  }));
  const normalizedEvent = normalizeAgentEvent(event({
    data: { observations: wrap(['observed']) },
  }));
  assert.deepEqual(normalizedAction.data.steps, [{ effectId: 'effect-1', attempt: 1 }]);
  assert.deepEqual(normalizedEvent.data.observations, ['observed']);
  assert.equal(lengthReads, 0, 'descriptor-only normalization must not evaluate the length getter');

  // Neither a cold JSON roundtrip nor immutable snapshots should change evidence.
  const coldAction = normalizeAgentAction(JSON.parse(JSON.stringify(normalizedAction)));
  const coldEvent = normalizeAgentEvent(JSON.parse(JSON.stringify(normalizedEvent)));
  assert.deepEqual(coldAction.data, normalizedAction.data);
  assert.deepEqual(coldEvent.data, normalizedEvent.data);
  assert.ok(Object.isFrozen(normalizedAction.data.steps));
  assert.ok(Object.isFrozen(normalizedEvent.data.observations));

  const smuggled = ['observed'];
  smuggled.injectedPermission = 'ALLOW';
  assert.throws(
    () => normalizeAgentEvent(event({ data: { observations: wrap(smuggled) } })),
    error => {
      assert.match(error.message, /non-canonical array fields/);
      assert.doesNotMatch(error.message, /PRIVATE-PROXY-ARRAY-LENGTH-TRAP/);
      return true;
    },
  );
  assert.equal(lengthReads, 0, 'negative validation must never invoke the untrusted getter');
});


test('Plan-1 S1: optional Agent I/O references cannot erase a corrupt durable identity', async () => {
  const liveEvents = [];
  const sink = new AgentEventSink({ onEvent: observed => liveEvents.push(observed) });
  const validAction = normalizeAgentAction(action({ sessionId: null, taskId: null }));
  const validEvent = normalizeAgentEvent(event({ sessionId: null, taskId: null }));
  assert.equal(validAction.sessionId, null);
  assert.equal(validEvent.taskId, null);
  assert.deepEqual(normalizeAgentAction(JSON.parse(JSON.stringify(validAction))), validAction);
  assert.deepEqual(normalizeAgentEvent(JSON.parse(JSON.stringify(validEvent))), validEvent);

  for (const field of ['sessionId', 'taskId']) {
    const invalidAction = action({ [field]: '' });
    const invalidEvent = event({ [field]: '' });
    assert.throws(() => normalizeAgentAction(invalidAction), /is invalid/);
    assert.throws(() => normalizeAgentEvent(invalidEvent), /is invalid/);
    await assert.rejects(() => sink.emit(invalidEvent), /is invalid/);
    assert.equal(invalidAction[field], '', 'rejected action must not be modified');
    assert.equal(invalidEvent[field], '', 'rejected event must not be modified');
  }
  const nonLinked = event({ type: AgentEventType.COMPLETION_OBSERVED, actionId: '' });
  assert.throws(() => normalizeAgentEvent(nonLinked), /actionId is invalid/);
  await assert.rejects(() => sink.emit(nonLinked), /actionId is invalid/);
  assert.equal(liveEvents.length, 0, 'invalid evidence never reaches the event sink');
});

test('Plan-1 S1: signed extended ISO years agree across Agent contracts and cold restart', () => {
  const signed = '+010000-02-29T03:04:05+01:00';
  const expected = '+010000-02-29T02:04:05.000Z';
  const normalizedAction = normalizeAgentAction(action({ createdAt: signed }));
  const normalizedEvent = normalizeAgentEvent(event({ occurredAt: signed }));
  assert.equal(normalizedAction.createdAt, expected);
  assert.equal(normalizedEvent.occurredAt, expected);
  assert.deepEqual(normalizeAgentAction(JSON.parse(JSON.stringify(normalizedAction))), normalizedAction);
  assert.deepEqual(normalizeAgentEvent(JSON.parse(JSON.stringify(normalizedEvent))), normalizedEvent);
  for (const invalid of [
    '+010000-02-30T03:04:05Z',
    '+010000-13-01T03:04:05Z',
    '+010000-02-29T24:04:05Z',
    '+10000-02-29T03:04:05Z',
    '10000-02-29T03:04:05Z',
  ]) {
    assert.throws(() => normalizeAgentAction(action({ createdAt: invalid })),
      /timestamp|calendar date/i, 'invalid action date must fail closed: ' + invalid);
    assert.throws(() => normalizeAgentEvent(event({ occurredAt: invalid })),
      /timestamp|calendar date/i, 'invalid event date must fail closed: ' + invalid);
  }
});
