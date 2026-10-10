import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRunTimelineV1, MAX_AGENT_TIMELINE_ENTRIES } from '../src/core/agent-run-timeline.js';

function job() {
  return {
    id: 'agent-1',
    config: { goal: 'PRIVATE_GOAL_999', apiKey: 'NEVER_EXPORT_999' },
    runtime: {
      stepCount: 9, completedCycles: 2, modelCalls: 3, totalTokens: 450,
      estimatedCostUsd: 0.016,
      currentUrl: 'https://secret.invalid/?token=PRIVATE_999',
      lastError: 'CREDENTIAL_SECRET_999',
      verifiedOutcome: { checks: [{ detail: 'PRIVATE_CHECK_999' }] },
      plan: { revision: 4, nodes: [{ state: 'READY', prompt: 'PRIVATE_NODE_999' }, { state: 'VERIFIED' }] },
      history: [
        { at: 10, type: 'owner-instruction', message: 'PRIVATE_INSTRUCTION_999' },
        { at: 20, type: 'action', action: { type: 'click', value: 'PRIVATE_FORM_999', ref: 'password' }, message: 'SENSITIVE_999' },
        { at: 30, type: 'plan-node-verified', message: 'PRIVATE_RESULT_999' },
        { at: 40, type: 'approval-stale', reason: 'SECRET_999' },
        { at: 50, type: 'noncanonical-secret-type', message: 'SECRET_999' },
      ],
    },
  };
}

test('Agent timeline projects existing job without effects and redacts private data', () => {
  const original = job();
  const before = structuredClone(original);
  const result = buildAgentRunTimelineV1(original);
  assert.equal(result.jobId, 'agent-1');
  assert.equal(result.evidenceOnly, true);
  assert.equal(result.mayReplayExternalEffect, false);
  assert.equal(result.includesPrivatePrompts, false);
  assert.deepEqual(result.entries.map(entry => entry.category), ['OWNER', 'ACTION', 'PLAN', 'OWNER', 'RECOVERY']);
  assert.equal(result.entries[1].actionType, 'click');
  assert.equal(result.entries[4].event, 'OTHER');
  assert.deepEqual(result.plan.stateCounts, { READY: 1, VERIFIED: 1 });
  assert.equal(result.plan.revision, 4);
  assert.deepEqual(result.counters, {
    steps: 9, cycles: 2, modelCalls: 3, totalTokens: 450, estimatedCostUsd: 0.016, verifiedChecks: 1, ownerEvents: 2,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.entries), true);
  assert.deepEqual(original, before);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /PRIVATE_|SECRET|SENSITIVE|password|token=/);
});

test('keyboard UI filters can never broaden source authority', () => {
  const original = job();
  const actions = buildAgentRunTimelineV1(original, { filter: 'ACTION', limit: 1 });
  assert.equal(actions.entries.length, 1);
  assert.equal(actions.entries[0].event, 'action');
  assert.equal(actions.mayReplayExternalEffect, false);
  assert.equal(buildAgentRunTimelineV1(original, { filter: 'CHECKPOINT' }).entries.length, 0);
  for (const filter of ['WRITE', 'EXECUTE', 'ALLOW', '', true]) {
    assert.throws(() => buildAgentRunTimelineV1(original, { filter }), /filter/);
  }
  assert.throws(() => buildAgentRunTimelineV1(original, { limit: MAX_AGENT_TIMELINE_ENTRIES + 1 }), /limit/);
  assert.throws(() => buildAgentRunTimelineV1(original, { filter: 'ALL', policy: 'ALLOW' }), /unknown/);
});

test('bounded last-N timeline remains deterministic under long-run history', () => {
  const original = job();
  original.runtime.history = Array.from({ length: 6000 }, (_, i) => ({
    at: i + 1, type: 'action', message: 'SENSITIVE-' + i,
  }));
  const output = buildAgentRunTimelineV1(original, { limit: 3 });
  assert.equal(output.totalRecorded, 6000);
  assert.equal(output.inspectedEntries, 2048);
  assert.equal(output.returnedEntries, 3);
  assert.equal(output.truncated, true);
  assert.deepEqual(output.entries.map(entry => entry.entryId), [
    'agent-history:5997', 'agent-history:5998', 'agent-history:5999',
  ]);
  assert.doesNotMatch(JSON.stringify(output), /SENSITIVE/);
  assert.deepEqual(output, buildAgentRunTimelineV1(structuredClone(original), { limit: 3 }));
});

test('corrupt restored records and hostile accessors fail closed without evaluating getters', () => {
  let accessed = 0;
  const input = job();
  Object.defineProperty(input.runtime.history[0], 'type', {
    enumerable: true, get() { accessed += 1; return 'action'; },
  });
  assert.throws(() => buildAgentRunTimelineV1(input), /accessor-backed/);
  assert.equal(accessed, 0);
  const exotic = job();
  exotic.runtime.history = new Array(3);
  exotic.runtime.history[2] = { type: 'action' };
  assert.throws(() => buildAgentRunTimelineV1(exotic), /dense/);
  const raw = job();
  Object.defineProperty(raw.runtime.history[0], 'message', {
    enumerable: true, get() { throw new Error('secret getter executed'); },
  });
  assert.doesNotThrow(() => buildAgentRunTimelineV1(raw));
  const hidden = { limit: 20 };
  Object.defineProperty(hidden, 'filter', {
    enumerable: true, get() { accessed += 1; return 'ALL'; },
  });
  assert.throws(() => buildAgentRunTimelineV1(job(), hidden), /accessor-backed/);
  assert.equal(accessed, 0);
});

test('Agent UI has native labelled controls and only renders redacted projection as text', async () => {
  const { readFile } = await import('node:fs/promises');
  const root = new URL('../', import.meta.url);
  const html = await readFile(new URL('src/ui/options.html', root), 'utf8');
  const script = await readFile(new URL('src/ui/options.js', root), 'utf8');
  assert.match(html, /<details id="agent-run-timeline-details">/u);
  assert.match(html, /<label for="agent-run-timeline-filter">/u);
  assert.match(html, /<select id="agent-run-timeline-filter">/u);
  assert.match(html, /<button id="agent-run-timeline-refresh-button" type="button">/u);
  assert.match(html, /<button id="agent-run-timeline-export-button" type="button">/u);
  assert.match(html, /<ol id="agent-run-timeline-list" aria-label="[^"]+">/u);
  const start = script.indexOf('function renderAgentRunTimeline(job)');
  const end = script.indexOf('function renderBrowserAgentList()', start);
  assert.ok(start >= 0 && end > start);
  const projection = script.slice(start, end);
  assert.match(projection, /buildAgentRunTimelineV1\(job, \{ filter \}\)/u);
  assert.match(projection, /list\.replaceChildren\(\)/u);
  assert.match(projection, /document\.createElement\('li'\)/u);
  assert.match(projection, /description\.textContent/u);
  assert.match(projection, /downloadJson\(timeline,/u);
  assert.doesNotMatch(projection, /innerHTML|outerHTML|insertAdjacentHTML|eval\(/u);
  assert.match(script, /renderAgentRunTimeline\(job\);/u);
});

test('explicit invalid event timestamps fail closed; missing legacy time stays distinguishable on restart', () => {
  for (const at of [null, '0', '2030-01-01', -1, NaN, Infinity, 8_640_000_000_000_001]) {
    const input = job();
    input.runtime.history[0].at = at;
    assert.throws(() => buildAgentRunTimelineV1(input), /entry timestamp is invalid/);
    if (Number.isFinite(at)) {
      assert.throws(() => buildAgentRunTimelineV1(structuredClone(input)), /entry timestamp is invalid/);
    }
  }
  const legacy = job();
  delete legacy.runtime.history[0].at;
  const output = buildAgentRunTimelineV1(legacy);
  assert.equal(output.entries[0].at, 0);
  assert.equal(output.evidenceOnly, true);
  assert.equal(output.mayReplayExternalEffect, false);
  assert.deepEqual(output, buildAgentRunTimelineV1(structuredClone(legacy)));
  let getterCalls = 0;
  const accessor = job();
  Object.defineProperty(accessor.runtime.history[0], 'at', {
    enumerable: true, get() { getterCalls += 1; throw Error('PRIVATE_TIME_GETTER'); },
  });
  assert.throws(() => buildAgentRunTimelineV1(accessor), /accessor-backed/);
  assert.equal(getterCalls, 0);
});


test('S1 time evidence distinguishes recorded epoch-zero from absent legacy timestamp after JSON restart', () => {
  const input = job();
  input.runtime.history = [{ at: 0, type: 'action' }, { type: 'action' }];
  const output = buildAgentRunTimelineV1(input);
  assert.deepEqual(output.entries.map(entry => [entry.at, entry.timeEvidence]), [
    [0, 'RECORDED'], [0, 'MISSING_LEGACY'],
  ]);
  assert.deepEqual(output, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(input))));
  assert.equal(output.mayReplayExternalEffect, false);
  assert.equal(output.evidenceMap.externalEffectVerified, false);
  assert.equal(Object.isFrozen(output.entries[0]), true);
});

test('S1 explicitly present undefined, fractional and negative-zero event times fail closed', () => {
  for (const at of [undefined, 0.5, -0]) {
    const input = job();
    input.runtime.history[0].at = at;
    assert.throws(() => buildAgentRunTimelineV1(input), /entry timestamp is invalid/);
  }
  const { entries } = buildAgentRunTimelineV1(job());
  assert.equal(entries[0].timeEvidence, 'RECORDED');
});

test('S1 UI announces timestamp provenance using semantic native time text', async () => {
  const { readFile } = await import('node:fs/promises');
  const script = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  assert.match(script, /entry\.timeEvidence === 'RECORDED'/u);
  assert.match(script, /'Час не записано'/u);
  assert.doesNotMatch(script.slice(script.indexOf('function renderAgentRunTimeline(job)'),
    script.indexOf('function renderBrowserAgentList()')), /innerHTML|outerHTML|insertAdjacentHTML/u);
});

test('S1 hostile inspection traps cannot leak diagnostic text or trigger recorded effects', () => {
  const marker = 'PRIVATE_TRAP_PAYLOAD_DO_NOT_EXPORT';
  const failures = [
    () => {
      const input = job();
      input.runtime = new Proxy(input.runtime, { getPrototypeOf() { throw Error(marker); } });
      return buildAgentRunTimelineV1(input);
    },
    () => {
      const input = job();
      return buildAgentRunTimelineV1(new Proxy(input, {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'runtime') throw Error(marker);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }));
    },
    () => buildAgentRunTimelineV1(job(), new Proxy({}, { ownKeys() { throw Error(marker); } })),
    () => {
      const input = job();
      input.runtime.history[0] = new Proxy(input.runtime.history[0], {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'at') throw Error(marker);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      return buildAgentRunTimelineV1(input);
    },
    () => {
      const input = job();
      input.runtime.history = new Proxy(input.runtime.history, {
        getPrototypeOf() { throw Error(marker); },
      });
      return buildAgentRunTimelineV1(input);
    },
  ];
  for (const fail of failures) {
    assert.throws(fail, error => error instanceof Error && !error.message.includes(marker));
  }
  const persisted = JSON.parse(JSON.stringify(job()));
  const result = buildAgentRunTimelineV1(persisted);
  assert.equal(result.mayReplayExternalEffect, false);
  assert.equal(result.evidenceMap.externalEffectVerified, false);
  assert.deepEqual(result, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(persisted))));
});

test('S1 projected plan and recorded outcome array lengths never execute Proxy get traps', () => {
  const marker = 'PRIVATE_LENGTH_GETTER_EXPOSED';
  for (const field of ['plan', 'outcome']) {
    const input = job();
    const array = field === 'plan' ? input.runtime.plan.nodes : input.runtime.verifiedOutcome.checks;
    const proxy = new Proxy(array, {
      get(target, key) {
        if (key === 'length') throw Error(marker);
        return Reflect.get(target, key);
      },
    });
    if (field === 'plan') input.runtime.plan.nodes = proxy;
    else input.runtime.verifiedOutcome.checks = proxy;
    const projected = buildAgentRunTimelineV1(input);
    assert.equal(projected.mayReplayExternalEffect, false);
    assert.equal(projected.evidenceMap.externalEffectVerified, false);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_LENGTH_GETTER_EXPOSED/u);
  }
});

test('S1 present undefined history/nodes fail closed while truly absent legacy fields remain non-authorizing', () => {
  for (const field of ['history', 'nodes']) {
    const corrupt = job();
    if (field === 'history') corrupt.runtime.history = undefined;
    else corrupt.runtime.plan.nodes = undefined;
    assert.throws(() => buildAgentRunTimelineV1(corrupt), /dense array|plain array/);
    assert.throws(() => buildAgentRunTimelineV1(structuredClone(corrupt)), /dense array|plain array/);

    const legacy = job();
    if (field === 'history') delete legacy.runtime.history;
    else delete legacy.runtime.plan.nodes;
    const projection = buildAgentRunTimelineV1(legacy);
    assert.equal(projection.evidenceOnly, true);
    assert.equal(projection.mayReplayExternalEffect, false);
    assert.equal(projection.evidenceMap.externalEffectVerified, false);
    assert.deepEqual(projection, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(legacy))));
  }

  const corruptRestart = job();
  corruptRestart.runtime.history = null;
  assert.throws(() => buildAgentRunTimelineV1(JSON.parse(JSON.stringify(corruptRestart))), /dense array/);
});


test('S1 timeline status is a keyboard-reachable NVDA live region', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const statusTag = html.match(/<p\s+id="agent-run-timeline-status"[^>]*>/u)?.[0];
  assert.ok(statusTag, 'timeline status element must exist');
  assert.match(statusTag, /role="status"/u);
  assert.match(statusTag, /aria-live="polite"/u);
  assert.match(statusTag, /aria-atomic="true"/u);
  assert.match(statusTag, /tabindex="0"/u);
  assert.match(html, /<ol\s+id="agent-run-timeline-list"\s+aria-label="[^"]+"/u);
});


test('S1 hostile persisted Proxy cannot spoof numeric plan or recorded-check array lengths', () => {
  for (const field of ['plan', 'checks']) {
    const input = job();
    const array = field === 'plan' ? input.runtime.plan.nodes : input.runtime.verifiedOutcome.checks;
    const spoof = new Proxy(array, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === 'length') return { ...descriptor, value: '0' };
        return descriptor;
      },
    });
    if (field === 'plan') input.runtime.plan.nodes = spoof;
    else input.runtime.verifiedOutcome.checks = spoof;
    const expected = field === 'plan' ? /plan nodes length is invalid/ : /checks length is invalid/;
    assert.throws(() => buildAgentRunTimelineV1(input), expected);
    const valid = buildAgentRunTimelineV1(job());
    assert.equal(valid.mayReplayExternalEffect, false);
    assert.equal(valid.evidenceMap.externalEffectVerified, false);
  }
});

test('S1 cost evidence observes one descriptor and never coerces attacker-controlled values', () => {
  const marker = 'PRIVATE_COST_COERCION_EFFECT';
  const input = job();
  const runtime = input.runtime;
  let costReads = 0;
  let hostileCoercions = 0;
  input.runtime = new Proxy(runtime, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== 'estimatedCostUsd') return descriptor;
      costReads += 1;
      return {
        ...descriptor,
        value: costReads === 1 ? 0.016 : {
          valueOf() {
            hostileCoercions += 1;
            throw Error(marker);
          },
        },
      };
    },
  });
  const output = buildAgentRunTimelineV1(input);
  assert.equal(costReads, 1, 'evidence must use one recorded observation');
  assert.equal(hostileCoercions, 0, 'a changed descriptor must not run code');
  assert.equal(output.counters.estimatedCostUsd, 0.016);
  assert.equal(output.evidenceOnly, true);
  assert.equal(output.mayReplayExternalEffect, false);
  assert.equal(output.evidenceMap.externalEffectVerified, false);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_COST_COERCION_EFFECT/u);

  const corrupt = job();
  corrupt.runtime.estimatedCostUsd = {
    valueOf() {
      hostileCoercions += 1;
      throw Error(marker);
    },
  };
  assert.equal(buildAgentRunTimelineV1(corrupt).counters.estimatedCostUsd, null);
  assert.equal(hostileCoercions, 0);

  for (const value of ['0.016', -1, Number.POSITIVE_INFINITY, 1_000_000.01]) {
    const restored = JSON.parse(JSON.stringify(job()));
    restored.runtime.estimatedCostUsd = value;
    const projected = buildAgentRunTimelineV1(restored);
    assert.equal(projected.counters.estimatedCostUsd, null);
    assert.equal(projected.mayReplayExternalEffect, false);
  }
});

test('S1 uses canonical bounded Specialist dispatch metadata without treating it as effect proof', () => {
  const input = job();
  input.runtime.specialistDispatchByAgentId = {
    'secret-agent-1': {
      state: 'PROVIDER_SUCCEEDED',
      providerId: 'PRIVATE_PROVIDER_DO_NOT_EXPORT',
      providerReceiptId: 'PRIVATE_RECEIPT_DO_NOT_EXPORT',
      resultArtifactRefs: [
        { artifactId: 'PRIVATE_ARTIFACT_DO_NOT_EXPORT', sha256: 'a'.repeat(64) },
      ],
    },
    'secret-agent-2': {
      state: 'AMBIGUOUS', effectMayHaveOccurred: true, errorCode: 'PRIVATE_ERROR_DO_NOT_EXPORT',
      resultArtifactRefs: [],
    },
    'secret-agent-3': {
      state: 'FAILED_SAFE', providerReceiptId: '', resultArtifactRefs: [],
    },
  };
  const timeline = buildAgentRunTimelineV1(input);
  const dispatch = timeline.evidenceMap.specialistProviderDispatch;
  assert.equal(dispatch.source, 'CANONICAL_AGENT_RUNTIME_DISPATCH_METADATA_ONLY');
  assert.equal(dispatch.inspectedAttempts, 3);
  assert.equal(dispatch.statusCounts.PROVIDER_SUCCEEDED, 1);
  assert.equal(dispatch.statusCounts.AMBIGUOUS, 1);
  assert.equal(dispatch.statusCounts.FAILED_SAFE, 1);
  assert.equal(dispatch.receiptIdsRecorded, 1);
  assert.equal(dispatch.artifactReferencesRecorded, 1);
  assert.equal(dispatch.externalEffectVerified, false);
  assert.equal(dispatch.artifactProvenanceVerified, false);
  assert.equal(timeline.mayReplayExternalEffect, false);
  assert.equal(Object.isFrozen(dispatch), true);
  assert.equal(Object.isFrozen(dispatch.statusCounts), true);
  assert.doesNotMatch(JSON.stringify(timeline), /PRIVATE_|secret-agent/);
  assert.deepEqual(timeline, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(input))));

  const legacy = job();
  delete legacy.runtime.specialistDispatchByAgentId;
  const omitted = buildAgentRunTimelineV1(legacy).evidenceMap.specialistProviderDispatch;
  assert.equal(omitted.recordPresent, false);
  assert.equal(omitted.inspectedAttempts, 0);
  assert.equal(omitted.externalEffectVerified, false);
});

test('S1 Specialist projection fails closed on hostile or corrupted persisted dispatch evidence', () => {
  const marker = 'PRIVATE_DISPATCH_TRAP_MUST_NOT_LEAK';
  const cases = [
    () => { const x = job(); x.runtime.specialistDispatchByAgentId = null; return x; },
    () => { const x = job(); x.runtime.specialistDispatchByAgentId = { a: { state: 'OWNER_ALLOW' } }; return x; },
    () => {
      const x = job();
      x.runtime.specialistDispatchByAgentId = { a: { state: 'PROVIDER_SUCCEEDED', resultArtifactRefs: new Array(2) } };
      return x;
    },
    () => {
      const x = job();
      const map = {};
      Object.defineProperty(map, 'a', { enumerable: true, get() { throw Error(marker); } });
      x.runtime.specialistDispatchByAgentId = map;
      return x;
    },
    () => {
      const x = job();
      x.runtime.specialistDispatchByAgentId = new Proxy({}, { ownKeys() { throw Error(marker); } });
      return x;
    },
    () => {
      const x = job();
      const map = {};
      map[Symbol(marker)] = { state: 'DISPATCHING' };
      x.runtime.specialistDispatchByAgentId = map;
      return x;
    },
  ];
  for (const produce of cases) {
    assert.throws(() => buildAgentRunTimelineV1(produce()), error =>
      error instanceof Error && !error.message.includes(marker));
  }
  const oversized = job();
  oversized.runtime.specialistDispatchByAgentId = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => ['agent-' + index, { state: 'DISPATCHING' }]),
  );
  assert.throws(() => buildAgentRunTimelineV1(oversized), /bounded record schema/);

  const corruptRestart = job();
  corruptRestart.runtime.specialistDispatchByAgentId = { a: { state: 'UNKNOWN' } };
  assert.throws(
    () => buildAgentRunTimelineV1(JSON.parse(JSON.stringify(corruptRestart))),
    /dispatch state is invalid/,
  );
});

test('S1 corrupt recorded checks fail closed rather than becoming zero after restart', () => {
  for (const corruptChecks of [null, undefined, '', {}, 7]) {
    const input = job();
    input.runtime.verifiedOutcome.checks = corruptChecks;
    assert.throws(() => buildAgentRunTimelineV1(input), /checks must be a bounded dense array/);
    const clone = structuredClone(input);
    assert.throws(() => buildAgentRunTimelineV1(clone), /checks must be a bounded dense array/);
    if (corruptChecks !== undefined) {
      assert.throws(() => buildAgentRunTimelineV1(JSON.parse(JSON.stringify(input))), /checks must be a bounded dense array/);
    }
  }
  const legacy = job();
  delete legacy.runtime.verifiedOutcome.checks;
  const output = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(legacy)));
  assert.equal(output.evidenceMap.recordedOutcome.criteriaRecorded, 0);
  assert.equal(output.evidenceMap.recordedOutcome.externalEffectVerified, false);
  assert.equal(output.mayReplayExternalEffect, false);
  assert.equal(Object.isFrozen(output.evidenceMap.recordedOutcome), true);
});

test('S1 recorded outcome time rejects forged persisted values without getter execution', () => {
  const marker = 'PRIVATE_VERIFICATION_TIME_GETTER';
  for (const corruptAt of [undefined, null, '42', -1, -0, 0.5, NaN, Infinity, 8_640_000_000_000_001]) {
    const input = job();
    input.runtime.verifiedOutcome.verifiedAt = corruptAt;
    assert.throws(() => buildAgentRunTimelineV1(input), /verifiedAt is invalid/);
    assert.throws(() => buildAgentRunTimelineV1(structuredClone(input)), /verifiedAt is invalid/);
  }
  const input = job();
  let calls = 0;
  Object.defineProperty(input.runtime.verifiedOutcome, 'verifiedAt', {
    enumerable: true,
    get() { calls += 1; throw Error(marker); },
  });
  assert.throws(() => buildAgentRunTimelineV1(input), /accessor-backed verifiedAt/u);
  assert.equal(calls, 0);
  const valid = job();
  valid.runtime.verifiedOutcome.verifiedAt = 123;
  const recorded = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(valid)));
  assert.equal(recorded.evidenceMap.recordedOutcome.recordedAt, 123);
  assert.equal(recorded.evidenceMap.externalEffectVerified, false);
  valid.runtime.verifiedOutcome.verifiedAt = 0;
  assert.equal(buildAgentRunTimelineV1(valid).evidenceMap.recordedOutcome.recordedAt, null);
  delete valid.runtime.verifiedOutcome.verifiedAt;
  assert.equal(buildAgentRunTimelineV1(valid).evidenceMap.recordedOutcome.recordedAt, null);
  assert.doesNotMatch(JSON.stringify(recorded), /PRIVATE_|NEVER_EXPORT|SECRET_999|CREDENTIAL_SECRET/u);
});

test('S1 durable execution ownership metadata projection is bounded, redacted and read-only after restart', () => {
  const input = job();
  input.runtime.specialistExecutionOwnerships = [
    { state: 'AVAILABLE', nodeId: 'private-node-1', effectId: 'private-effect-1', policyEnvelopeId: 'PRIVATE_POLICY_MARKER' },
    { state: 'OWNED', nodeId: 'private-node-2', effectId: 'private-effect-2', ownerId: 'PRIVATE_OWNER_MARKER' },
    { state: 'RECONCILE', nodeId: 'private-node-3', effectId: 'private-effect-3', ambiguityReason: 'PRIVATE_FAILURE_MARKER' },
  ];
  const before = structuredClone(input);
  const snapshot = buildAgentRunTimelineV1(input);
  const result = snapshot.evidenceMap.specialistExecutionOwnership;
  assert.equal(result.source, 'CANONICAL_AGENT_RUNTIME_OWNERSHIP_METADATA_ONLY');
  assert.equal(result.recordPresent, true);
  assert.equal(result.inspectedRecords, 3);
  assert.deepEqual(result.stateCounts, {
    AVAILABLE: 1, OWNED: 1, HANDOFF_PENDING: 0, RECONCILE: 1, VERIFIED: 0, MANUAL_REVIEW: 0,
  });
  assert.equal(result.structurallyBoundNodeRecords, 3);
  assert.equal(result.agentTreeEdgesVerified, false);
  assert.equal(result.externalEffectVerified, false);
  assert.equal(snapshot.evidenceMap.externalEffectVerified, false);
  assert.equal(snapshot.mayReplayExternalEffect, false);
  assert.deepEqual(input, before);
  assert.deepEqual(snapshot, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(input))));
  assert.equal(Object.isFrozen(result.stateCounts), true);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|private-node|private-effect/u);
  const legacy = job();
  delete legacy.runtime.specialistExecutionOwnerships;
  const missing = buildAgentRunTimelineV1(legacy).evidenceMap.specialistExecutionOwnership;
  assert.equal(missing.recordPresent, false);
  assert.equal(missing.inspectedRecords, 0);
  assert.equal(missing.agentTreeEdgesVerified, false);
});

test('S1 malformed or spoofed durable execution ownership never becomes zero or verified evidence', () => {
  const marker = 'PRIVATE_OWNERSHIP_TRAP_DO_NOT_EXPORT';
  const record = { state: 'OWNED', nodeId: 'node-1', effectId: 'effect-1' };
  const cases = [
    null, undefined, {}, new Array(2), [null], [3], [record, record],
    [{ ...record, state: 'OWNER_APPROVED' }],
    [{ ...record, nodeId: '' }],
    [{ ...record, effectId: ' PRIVATE_ALIAS' }],
    Array.from({ length: 129 }, (_, i) => ({ ...record, nodeId: 'node-' + i })),
  ];
  const extra = [record];
  extra.extra = marker;
  cases.push(extra);
  for (const value of cases) {
    const input = job();
    input.runtime.specialistExecutionOwnerships = value;
    assert.throws(
      () => buildAgentRunTimelineV1(input),
      error => error instanceof Error && !error.message.includes(marker),
    );
  }
  const accessor = [record];
  let invoked = 0;
  Object.defineProperty(accessor, '0', { get() { invoked += 1; throw Error(marker); }, enumerable: true });
  const input = job();
  input.runtime.specialistExecutionOwnerships = accessor;
  assert.throws(() => buildAgentRunTimelineV1(input), error => !error.message.includes(marker));
  assert.equal(invoked, 0);
  input.runtime.specialistExecutionOwnerships = new Proxy([record], {
    ownKeys() { throw Error(marker); },
  });
  assert.throws(() => buildAgentRunTimelineV1(input), error => !error.message.includes(marker));
  input.runtime.specialistExecutionOwnerships = [{ ...record, state: 'WRONG' }];
  assert.throws(() => buildAgentRunTimelineV1(JSON.parse(JSON.stringify(input))), /identity\/state/u);
  assert.equal(buildAgentRunTimelineV1(job()).mayReplayExternalEffect, false);
});

test('S1 hidden ownership entries cannot masquerade as durable evidence across cold restart', () => {
  const marker = 'PRIVATE_HIDDEN_OWNERSHIP_NEVER_EXPORT';
  const ownership = { state: 'OWNED', nodeId: 'node-visible', effectId: 'effect-visible', note: marker };
  const hidden = job();
  const records = [ownership];
  Object.defineProperty(records, '0', { value: ownership, enumerable: false, configurable: true, writable: true });
  hidden.runtime.specialistExecutionOwnerships = records;
  assert.throws(() => buildAgentRunTimelineV1(hidden), error =>
    error instanceof Error &&
    /canonical dense array/u.test(error.message) &&
    !error.message.includes(marker),
    'a hidden record would be counted before JSON storage but lost after restart');

  const valid = job();
  valid.runtime.specialistExecutionOwnerships = [ownership];
  const before = buildAgentRunTimelineV1(valid);
  const restarted = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(valid)));
  assert.deepEqual(before, restarted);
  assert.equal(before.evidenceMap.specialistExecutionOwnership.inspectedRecords, 1);
  assert.equal(before.evidenceMap.specialistExecutionOwnership.externalEffectVerified, false);
  assert.equal(before.evidenceMap.specialistExecutionOwnership.agentTreeEdgesVerified, false);
  assert.equal(before.mayReplayExternalEffect, false);
  assert.doesNotMatch(JSON.stringify(before), /PRIVATE_HIDDEN|node-visible|effect-visible/u);
});

test('S1 ownership descriptor guards fail closed without getter, Proxy trap or replay', () => {
  const marker = 'PRIVATE_OWNERSHIP_TRAP_NEVER_EXPORT';
  let getterCalls = 0;
  const array = [{ state: 'OWNED', nodeId: 'node-1', effectId: 'effect-1' }];
  Object.defineProperty(array, '0', {
    enumerable: false, configurable: true,
    get() { getterCalls += 1; throw Error(marker); },
  });
  const input = job();
  input.runtime.specialistExecutionOwnerships = array;
  assert.throws(() => buildAgentRunTimelineV1(input), error =>
    error instanceof Error && /canonical dense array/u.test(error.message) &&
    !error.message.includes(marker));
  assert.equal(getterCalls, 0);
  input.runtime.specialistExecutionOwnerships = new Proxy([
    { state: 'OWNED', nodeId: 'node-1', effectId: 'effect-1' },
  ], {
    getOwnPropertyDescriptor(target, key) {
      if (key === '0') throw Error(marker);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.throws(() => buildAgentRunTimelineV1(input), error =>
    error instanceof Error && /cannot be safely inspected/u.test(error.message) &&
    !error.message.includes(marker));
  assert.equal(getterCalls, 0);
  assert.equal(buildAgentRunTimelineV1(job()).mayReplayExternalEffect, false);
});

test('S1 execution ownership summary is exposed by native text, never user-content HTML', async () => {
  const { readFile } = await import('node:fs/promises');
  const script = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  const section = script.slice(script.indexOf('function renderAgentRunTimeline(job)'), script.indexOf('function renderBrowserAgentList()'));
  assert.match(section, /specialistExecutionOwnership\.inspectedRecords/u);
  assert.match(section, /specialistExecutionOwnership\.stateCounts\.RECONCILE/u);
  assert.match(section, /зв’язки Agent tree/u);
  assert.doesNotMatch(section, /innerHTML|outerHTML|insertAdjacentHTML/u);
});

test('S1 durable ownership refuses one effect assigned to multiple nodes after JSON restart', () => {
  const source = job();
  source.runtime.specialistExecutionOwnerships = [
    { state: 'OWNED', nodeId: 'node-A', effectId: 'effect-shared', ownerId: 'PRIVATE_OWNER_A' },
    { state: 'RECONCILE', nodeId: 'node-B', effectId: 'effect-shared', ownerId: 'PRIVATE_OWNER_B' },
  ];
  for (const candidate of [source, JSON.parse(JSON.stringify(source))]) {
    assert.throws(() => buildAgentRunTimelineV1(candidate),
      /execution ownership record has invalid or duplicate identity\/state/);
  }
  // Different canonical effect identities retain the original read-only
  // projection without exposing owner IDs or implying external completion.
  source.runtime.specialistExecutionOwnerships[1].effectId = 'effect-distinct';
  const clean = buildAgentRunTimelineV1(source);
  assert.equal(clean.evidenceMap.specialistExecutionOwnership.inspectedRecords, 2);
  assert.equal(clean.evidenceMap.specialistExecutionOwnership.structurallyBoundNodeRecords, 2);
  assert.equal(clean.evidenceMap.specialistExecutionOwnership.externalEffectVerified, false);
  assert.equal(clean.evidenceMap.specialistExecutionOwnership.agentTreeEdgesVerified, false);
  assert.equal(clean.mayReplayExternalEffect, false);
  assert.equal(clean.evidenceOnly, true);
  assert.deepEqual(clean, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(source))));
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE_OWNER_A|PRIVATE_OWNER_B|effect-shared|effect-distinct/);
});

test('S1 recorded Specialist dispatch receipt identities must be unique and structurally safe across restart', () => {
  const input = job();
  input.runtime.specialistDispatchByAgentId = {
    first: { state: 'PROVIDER_SUCCEEDED', providerReceiptId: 'receipt-1' },
    second: { state: 'AMBIGUOUS', providerReceiptId: 'receipt-1' },
  };
  for (const candidate of [input, JSON.parse(JSON.stringify(input))]) {
    assert.throws(() => buildAgentRunTimelineV1(candidate), /receipt identity is invalid or duplicated/u);
  }
  input.runtime.specialistDispatchByAgentId.second.providerReceiptId = 'receipt-2';
  const good = buildAgentRunTimelineV1(input);
  assert.equal(good.evidenceMap.specialistProviderDispatch.receiptIdsRecorded, 2);
  assert.equal(good.evidenceMap.specialistProviderDispatch.externalEffectVerified, false);
  assert.equal(good.mayReplayExternalEffect, false);
  assert.deepEqual(good, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(input))));
  assert.doesNotMatch(JSON.stringify(good), /receipt-1|receipt-2/u);
});

test('S1 refuses non-string, control and accessor Specialist receipt identities without disclosure or replay', () => {
  const marker = 'PRIVATE_RECEIPT_TRAP_DO_NOT_LEAK';
  for (const value of [7, {}, true, 'receipt-\u202e-hidden', 'receipt-\n-wrong', 'a'.repeat(241)]) {
    const input = job();
    input.runtime.specialistDispatchByAgentId = {
      first: { state: 'PROVIDER_SUCCEEDED', providerReceiptId: value },
    };
    assert.throws(() => buildAgentRunTimelineV1(input), error =>
      error instanceof Error && /receipt identity is invalid or duplicated/u.test(error.message) &&
      !error.message.includes(marker));
  }
  let called = 0;
  const input = job();
  const attempt = { state: 'PROVIDER_SUCCEEDED' };
  Object.defineProperty(attempt, 'providerReceiptId', {
    enumerable: true,
    get() { called += 1; throw Error(marker); },
  });
  input.runtime.specialistDispatchByAgentId = { first: attempt };
  assert.throws(() => buildAgentRunTimelineV1(input), error =>
    error instanceof Error && !error.message.includes(marker));
  assert.equal(called, 0);
  assert.equal(buildAgentRunTimelineV1(job()).mayReplayExternalEffect, false);
});


test('malformed persisted counters fail closed instead of silently reporting zero, including JSON restart', () => {
  const fields = ['stepCount', 'completedCycles', 'modelCalls', 'totalTokens'];
  for (const field of fields) {
    for (const invalid of [-1, 0.5, '9', null, NaN, Infinity, -0]) {
      const input = job();
      input.runtime[field] = invalid;
      assert.throws(() => buildAgentRunTimelineV1(input), /persisted counter is invalid/);
      // JSON storage changes NaN/Infinity to null and -0 to 0; only a
      // storage-preserving malformed case supports a cold-restart assertion.
      if (invalid === -1 || invalid === 0.5 || invalid === '9' || invalid === null) {
        const restarted = JSON.parse(JSON.stringify(input));
        assert.throws(() => buildAgentRunTimelineV1(restarted), /persisted counter is invalid/);
      }
    }
    const legacy = job();
    delete legacy.runtime[field];
    const result = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(legacy)));
    const displayed = { stepCount: 'steps', completedCycles: 'cycles', modelCalls: 'modelCalls', totalTokens: 'totalTokens' }[field];
    assert.equal(result.counters[displayed], 0);
    assert.equal(result.evidenceOnly, true);
    assert.equal(result.mayReplayExternalEffect, false);
  }

  let privateGetterCalls = 0;
  const accessor = job();
  Object.defineProperty(accessor.runtime, 'stepCount', {
    enumerable: true,
    get() { privateGetterCalls++; throw new Error('PRIVATE_COUNTER_GETTER'); },
  });
  assert.throws(() => buildAgentRunTimelineV1(accessor), /accessor-backed stepCount/);
  assert.equal(privateGetterCalls, 0);

  const invalidRevision = job();
  invalidRevision.runtime.plan.revision = -1;
  assert.throws(() => buildAgentRunTimelineV1(invalidRevision), /persisted counter is invalid/);
  assert.throws(() => buildAgentRunTimelineV1(JSON.parse(JSON.stringify(invalidRevision))), /persisted counter is invalid/);
  delete invalidRevision.runtime.plan.revision;
  assert.equal(buildAgentRunTimelineV1(invalidRevision).plan.revision, 0);
  assert.doesNotMatch(JSON.stringify(buildAgentRunTimelineV1(job())), /PRIVATE_COUNTER_GETTER/);
});


test('S1 persisted undefined verified outcome fails closed; canonical null and absent legacy outcomes stay nonauthorizing', () => {
  const corrupt = job();
  corrupt.runtime.verifiedOutcome = undefined;
  assert.throws(() => buildAgentRunTimelineV1(corrupt), /Agent persisted outcome is invalid/u);
  const canonicalUnverified = job();
  canonicalUnverified.runtime.verifiedOutcome = null;
  const noOutcome = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(canonicalUnverified)));
  assert.equal(noOutcome.evidenceMap.recordedOutcome.recordPresent, false);
  assert.equal(noOutcome.evidenceMap.recordedOutcome.externalEffectVerified, false);
  assert.equal(noOutcome.mayReplayExternalEffect, false);
  assert.deepEqual(noOutcome, buildAgentRunTimelineV1(canonicalUnverified));
  const missing = job();
  delete missing.runtime.verifiedOutcome;
  const projection = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(missing)));
  assert.equal(projection.evidenceMap.recordedOutcome.recordPresent, false);
  assert.equal(projection.evidenceMap.recordedOutcome.criteriaRecorded, 0);
  assert.equal(projection.evidenceMap.recordedOutcome.externalEffectVerified, false);
  assert.equal(projection.evidenceOnly, true);
  assert.equal(projection.mayReplayExternalEffect, false);
  assert.doesNotMatch(JSON.stringify(projection), /PRIVATE_|NEVER_EXPORT/u);
  assert.deepEqual(projection, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(missing))));
});


test('S1 actual fresh canonical BrowserAgentRuntime projects an inspectable timeline without effect replay after cold JSON restart', async () => {
  const { createBrowserAgentRuntime } = await import('../src/core/browser-agent.js');
  const fresh = { id: 'agent-fresh', config: {}, runtime: createBrowserAgentRuntime(1234) };
  assert.equal(fresh.runtime.plan, null);
  assert.equal(fresh.runtime.verifiedOutcome, null, 'canonical unverified sentinel must not be treated as corrupt');
  const first = buildAgentRunTimelineV1(fresh);
  assert.equal(first.jobId, 'agent-fresh');
  assert.equal(first.totalRecorded, 0);
  assert.equal(first.evidenceMap.recordedOutcome.recordPresent, false);
  assert.equal(first.evidenceMap.recordedOutcome.externalEffectVerified, false);
  assert.equal(first.evidenceOnly, true);
  assert.equal(first.mayReplayExternalEffect, false);
  assert.deepEqual(first, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(fresh))));
});


test('S1 dispatch-map identities are canonical before evidence counts, including cold restart', () => {
  const valid = job();
  valid.runtime.specialistDispatchByAgentId = {
    'agent:0/worker-1': { state: 'PROVIDER_SUCCEEDED', providerReceiptId: 'receipt-1' },
  };
  const observed = buildAgentRunTimelineV1(valid).evidenceMap.specialistProviderDispatch;
  assert.equal(observed.inspectedAttempts, 1);
  assert.equal(observed.receiptIdsRecorded, 1);
  assert.equal(observed.externalEffectVerified, false);
  assert.deepEqual(
    observed,
    buildAgentRunTimelineV1(JSON.parse(JSON.stringify(valid))).evidenceMap.specialistProviderDispatch,
  );

  for (const hostileIdentity of [
    '', ' secret-agent', '_proto', 'agent one', 'agent\u202eoverride',
    'agent\u2067override', 'agent\nnewline', 'agent\u0000null', 'x'.repeat(181),
  ]) {
    const corrupted = job();
    const map = Object.create(null);
    Object.defineProperty(map, hostileIdentity, {
      configurable: true, enumerable: true, writable: true,
      value: { state: 'PROVIDER_SUCCEEDED', providerReceiptId: 'PRIVATE_RECEIPT_NO_EXPORT' },
    });
    corrupted.runtime.specialistDispatchByAgentId = map;
    for (const candidate of [corrupted, JSON.parse(JSON.stringify(corrupted))]) {
      assert.throws(() => buildAgentRunTimelineV1(candidate), error =>
        error instanceof Error &&
        /dispatch map exceeds the bounded record schema/u.test(error.message) &&
        (hostileIdentity.length === 0 || !error.message.includes(hostileIdentity)) &&
        !error.message.includes('PRIVATE_RECEIPT_NO_EXPORT'),
      );
    }
  }
  let getterInvocations = 0;
  const corrupted = job();
  const map = Object.create(null);
  Object.defineProperty(map, 'bad\nkey', {
    enumerable: true, get() { getterInvocations += 1; throw Error('PRIVATE_TRAP'); },
  });
  corrupted.runtime.specialistDispatchByAgentId = map;
  assert.throws(() => buildAgentRunTimelineV1(corrupted), /dispatch map exceeds the bounded record schema/u);
  assert.equal(getterInvocations, 0);
});


test('S1 canonical evidence arrays reject forged properties and concealed descriptors without fake counts', () => {
  const cases = [
    input => { input.runtime.plan.nodes.extra = { state: 'VERIFIED' }; },
    input => { Object.defineProperty(input.runtime.plan.nodes, '0', { enumerable: false }); },
    input => { input.runtime.verifiedOutcome.checks.extra = { private: 'PRIVATE_INJECTED' }; },
    input => { Object.defineProperty(input.runtime.verifiedOutcome.checks, '0', { enumerable: false }); },
    input => {
      const refs = [{ artifactId: 'PRIVATE_ARTIFACT' }];
      refs.extra = 'PRIVATE_UNVERIFIED_PROOF';
      input.runtime.specialistDispatchByAgentId = {
        'agent-a': { state: 'PROVIDER_SUCCEEDED', resultArtifactRefs: refs },
      };
    },
  ];
  for (const corrupt of cases) {
    const input = job();
    corrupt(input);
    assert.throws(() => buildAgentRunTimelineV1(input), error =>
      error instanceof Error && /canonical dense array/u.test(error.message) &&
      !/PRIVATE_|NEVER_EXPORT/u.test(error.message));
  }
  const valid = job();
  valid.runtime.specialistDispatchByAgentId = {
    'agent-a': { state: 'PROVIDER_SUCCEEDED', resultArtifactRefs: [{ artifactId: 'PRIVATE_ARTIFACT' }] },
  };
  const projection = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(valid)));
  assert.equal(projection.evidenceMap.specialistProviderDispatch.artifactReferencesRecorded, 1);
  assert.equal(projection.evidenceMap.specialistProviderDispatch.artifactProvenanceVerified, false);
  assert.equal(projection.evidenceMap.externalEffectVerified, false);
  assert.equal(projection.mayReplayExternalEffect, false);
  assert.doesNotMatch(JSON.stringify(projection), /PRIVATE_|NEVER_EXPORT/u);
  assert.deepEqual(projection, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(valid))));
});

test('S1 hostile evidence array traps never execute getters or expose private diagnostics', () => {
  const marker = 'PRIVATE_EVIDENCE_TRAP_NEVER_LEAK';
  let reads = 0;
  const checked = [ { state: 'READY' } ];
  const maliciousNodes = new Proxy(checked, {
    get(_target, key, receiver) {
      if (key === '0') { reads += 1; throw Error(marker); }
      return Reflect.get(_target, key, receiver);
    },
  });
  const valid = job();
  valid.runtime.plan.nodes = maliciousNodes;
  const success = buildAgentRunTimelineV1(valid);
  assert.equal(success.plan.nodeCount, 1);
  assert.equal(reads, 0);
  assert.equal(success.evidenceOnly, true);
  const unsafe = job();
  unsafe.runtime.verifiedOutcome.checks = new Proxy([{}], {
    ownKeys() { throw Error(marker); },
  });
  assert.throws(() => buildAgentRunTimelineV1(unsafe), error =>
    error instanceof Error && !error.message.includes(marker));
  assert.equal(reads, 0);
  unsafe.runtime.verifiedOutcome.checks = [ {} ];
  unsafe.runtime.specialistDispatchByAgentId = {
    'agent-a': { state: 'PROVIDER_SUCCEEDED', resultArtifactRefs: new Proxy([{}], {
      getOwnPropertyDescriptor(_target, key) {
        if (key === '0') throw Error(marker);
        return Reflect.getOwnPropertyDescriptor(_target, key);
      },
    }) },
  };
  assert.throws(() => buildAgentRunTimelineV1(unsafe), error =>
    error instanceof Error && !error.message.includes(marker));
  assert.equal(reads, 0);
});


test('S1 canonical retained history refuses malformed earlier events beyond the last-N window', () => {
  // A forged event count must not include holes outside the scanned suffix.
  const sparse = job();
  sparse.runtime.history = Array.from({ length: 2300 }, (_, at) => ({ at, type: 'action' }));
  delete sparse.runtime.history[0];
  assert.throws(() => buildAgentRunTimelineV1(sparse), /canonical dense array/u);

  const concealed = job();
  concealed.runtime.history = Array.from({ length: 2300 }, (_, at) => ({ at, type: 'action' }));
  Object.defineProperty(concealed.runtime.history, '0', { enumerable: false });
  assert.throws(() => buildAgentRunTimelineV1(concealed), /canonical dense array/u);

  const injected = job();
  injected.runtime.history.extra = { type: 'done', secret: 'PRIVATE_FAKE_HISTORY' };
  assert.throws(() => buildAgentRunTimelineV1(injected), error =>
    error instanceof Error && /canonical dense array/u.test(error.message) &&
    !error.message.includes('PRIVATE_FAKE_HISTORY'));
  const symbolic = job();
  symbolic.runtime.history[Symbol('PRIVATE_FAKED_HISTORY')] = { type: 'done' };
  assert.throws(() => buildAgentRunTimelineV1(symbolic), /canonical dense array/u);
});

test('S1 retained history descriptor inspection does not invoke getters or disclose trap errors', () => {
  const marker = 'PRIVATE_HISTORY_DESCRIPTOR_TRAP';
  let reads = 0;
  const input = job();
  const history = Array.from({ length: 2200 }, (_, at) => ({ at, type: 'action' }));
  input.runtime.history = new Proxy(history, {
    get(target, key, receiver) {
      if (key === '0' || key === 'length') {
        reads += 1;
        throw new Error(marker);
      }
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      if (key === '0') throw new Error(marker);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.throws(() => buildAgentRunTimelineV1(input), error =>
    error instanceof Error && /cannot be safely inspected/u.test(error.message) &&
    !error.message.includes(marker));
  assert.equal(reads, 0);
});

test('S1 canonical retained history still bounds last-N evidence and survives JSON restart', () => {
  const input = job();
  input.runtime.history = Array.from({ length: 2300 }, (_, at) => ({ at, type: 'action' }));
  const projected = buildAgentRunTimelineV1(input, { limit: 2 });
  assert.equal(projected.totalRecorded, 2300);
  assert.equal(projected.inspectedEntries, 2048);
  assert.equal(projected.returnedEntries, 2);
  assert.equal(projected.evidenceMap.completeLifetimeHistoryKnown, false);
  assert.equal(projected.evidenceMap.externalEffectVerified, false);
  assert.equal(projected.mayReplayExternalEffect, false);
  assert.deepEqual(projected, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(input)), { limit: 2 }));
});


test('S1 refuses hidden and accessor-backed Specialist dispatch evidence before JSON restart can erase it', () => {
  const marker = 'PRIVATE_DISPATCH_GETTER_NEVER_READ';
  const hidden = job();
  hidden.runtime.specialistDispatchByAgentId = {};
  Object.defineProperty(hidden.runtime.specialistDispatchByAgentId, 'agent-hidden', {
    enumerable: false, configurable: true, value: {
      state: 'PROVIDER_SUCCEEDED', providerReceiptId: marker,
    },
  });
  assert.throws(() => buildAgentRunTimelineV1(hidden), error =>
    error instanceof Error &&
    /enumerable data field/u.test(error.message) &&
    !error.message.includes(marker));

  let reads = 0;
  const accessor = job();
  accessor.runtime.specialistDispatchByAgentId = {};
  Object.defineProperty(accessor.runtime.specialistDispatchByAgentId, 'agent-accessor', {
    enumerable: true, configurable: true,
    get() { reads += 1; throw Error(marker); },
  });
  assert.throws(() => buildAgentRunTimelineV1(accessor), error =>
    error instanceof Error &&
    /enumerable data field/u.test(error.message) &&
    !error.message.includes(marker));
  assert.equal(reads, 0, 'an attacker getter must not run during evidence projection');

  const trapped = job();
  trapped.runtime.specialistDispatchByAgentId = new Proxy({
    'agent-visible': { state: 'DISPATCHING' },
  }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'agent-visible') throw Error(marker);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.throws(() => buildAgentRunTimelineV1(trapped), error =>
    error instanceof Error &&
    /record cannot be safely inspected/u.test(error.message) &&
    !error.message.includes(marker));
});

test('S1 canonical enumerable dispatch records survive cold restart without fabricating external receipts', () => {
  const input = job();
  input.runtime.specialistDispatchByAgentId = Object.create(null);
  Object.defineProperty(input.runtime.specialistDispatchByAgentId, 'agent-visible', {
    enumerable: true, configurable: true, writable: true,
    value: {
      state: 'PROVIDER_SUCCEEDED',
      providerReceiptId: 'PRIVATE_RECEIPT_NEVER_EXPORT',
      resultArtifactRefs: [{ artifactId: 'PRIVATE_ARTIFACT_NEVER_EXPORT' }],
    },
  });
  const before = buildAgentRunTimelineV1(input);
  const after = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(before, after);
  assert.equal(after.evidenceMap.specialistProviderDispatch.inspectedAttempts, 1);
  assert.equal(after.evidenceMap.specialistProviderDispatch.receiptIdsRecorded, 1);
  assert.equal(after.evidenceMap.specialistProviderDispatch.externalEffectVerified, false);
  assert.equal(after.evidenceMap.specialistProviderDispatch.artifactProvenanceVerified, false);
  assert.equal(after.mayReplayExternalEffect, false);
  assert.equal(after.evidenceOnly, true);
  assert.doesNotMatch(JSON.stringify(after), /PRIVATE_RECEIPT|PRIVATE_ARTIFACT/u);
});

test('S1 durable scalar evidence rejects non-enumerable fields lost on JSON restart', () => {
  const variations = [
    ['counter', input => Object.defineProperty(input.runtime, 'stepCount', {
      value: 31, enumerable: false, configurable: true,
    })],
    ['plan revision', input => Object.defineProperty(input.runtime.plan, 'revision', {
      value: 73, enumerable: false, configurable: true,
    })],
    ['plan node state', input => Object.defineProperty(input.runtime.plan.nodes[0], 'state', {
      value: 'VERIFIED', enumerable: false, configurable: true,
    })],
    ['recorded outcome time', input => Object.defineProperty(input.runtime.verifiedOutcome, 'verifiedAt', {
      value: 1234, enumerable: false, configurable: true,
    })],
  ];
  for (const [name, modify] of variations) {
    const input = job();
    modify(input);
    assert.throws(() => buildAgentRunTimelineV1(input),
      /persisted field must be an enumerable data field/u, name);
    // The input's hidden value vanishes after JSON restart. It must never
    // have been exported as durable evidence in the pre-restart projection.
    const restored = JSON.parse(JSON.stringify(input));
    const projection = buildAgentRunTimelineV1(restored);
    assert.equal(projection.mayReplayExternalEffect, false, name);
    assert.equal(projection.evidenceMap.externalEffectVerified, false, name);
  }
  const ordinary = job();
  ordinary.runtime.verifiedOutcome.verifiedAt = 1234;
  const before = buildAgentRunTimelineV1(ordinary);
  const after = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(ordinary)));
  assert.deepEqual(after, before);
  assert.equal(after.evidenceMap.recordedOutcome.recordedAt, 1234);
  assert.equal(after.counters.steps, 9);
  assert.equal(after.plan.stateCounts.READY, 1);
});

test('S1 persisted scalar descriptor traps fail closed without leaking or running getters', () => {
  const marker = 'PRIVATE_TIMELINE_FIELD_TRAP_NEVER_EXPORT';
  let invoked = 0;
  const accessor = job();
  Object.defineProperty(accessor.runtime.plan.nodes[0], 'state', {
    configurable: true, enumerable: true,
    get() { invoked += 1; throw new Error(marker); },
  });
  assert.throws(() => buildAgentRunTimelineV1(accessor),
    error => error instanceof Error && /accessor-backed state/u.test(error.message) &&
      !error.message.includes(marker));
  assert.equal(invoked, 0);

  const trapped = job();
  trapped.runtime.plan = new Proxy(trapped.runtime.plan, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'revision') throw Error(marker);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.throws(() => buildAgentRunTimelineV1(trapped),
    error => error instanceof Error && /cannot be safely inspected/u.test(error.message) &&
      !error.message.includes(marker));
  const recovered = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(job())));
  assert.equal(recovered.mayReplayExternalEffect, false);
  assert.equal(recovered.evidenceOnly, true);
});

test('S1 canonical event metadata does not disappear on JSON cold restart', () => {
  const valid = job();
  const before = buildAgentRunTimelineV1(valid);
  assert.equal(before.entries[1].actionType, 'click');
  assert.equal(before.entries[1].timeEvidence, 'RECORDED');
  assert.deepEqual(before, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(valid))));
  assert.equal(before.evidenceOnly, true);
  assert.equal(before.mayReplayExternalEffect, false);

  for (const field of ['type', 'at', 'action']) {
    const input = job();
    Object.defineProperty(input.runtime.history[1], field, { enumerable: false });
    assert.throws(() => buildAgentRunTimelineV1(input), error =>
      error instanceof Error && /persisted field must be an enumerable data field/u.test(error.message));
  }
  const nested = job();
  Object.defineProperty(nested.runtime.history[1].action, 'type', { enumerable: false });
  assert.throws(() => buildAgentRunTimelineV1(nested), /persisted field must be an enumerable data field/u);
  const corrupt = job();
  corrupt.runtime.history[1].type = undefined;
  assert.throws(() => buildAgentRunTimelineV1(corrupt), /Agent history event type is invalid/u);

  let getterReads = 0;
  const accessor = job();
  Object.defineProperty(accessor.runtime.history[1], 'at', {
    enumerable: true,
    get() { getterReads += 1; throw Error('PRIVATE_HISTORY_GETTER'); },
  });
  assert.throws(() => buildAgentRunTimelineV1(accessor), error =>
    error instanceof Error && /accessor-backed at/u.test(error.message) &&
    !error.message.includes('PRIVATE_HISTORY_GETTER'));
  assert.equal(getterReads, 0);
  const trap = job();
  trap.runtime.history[1] = new Proxy(trap.runtime.history[1], {
    getOwnPropertyDescriptor(target, field) {
      if (field === 'at') throw Error('PRIVATE_PROXY_EVENT');
      return Reflect.getOwnPropertyDescriptor(target, field);
    },
  });
  assert.throws(() => buildAgentRunTimelineV1(trap), error =>
    error instanceof Error && /cannot be safely inspected/u.test(error.message) &&
    !error.message.includes('PRIVATE_PROXY_EVENT'));
  assert.doesNotMatch(JSON.stringify(before), /PRIVATE_|NEVER_EXPORT|SENSITIVE/u);
});
