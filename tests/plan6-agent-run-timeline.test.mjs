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
  assert.equal(clean.evidenceMap.agentTreeEdgesVerified, false);
  assert.equal(clean.mayReplayExternalEffect, false);
  assert.equal(clean.evidenceOnly, true);
  assert.deepEqual(clean, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(source))));
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE_OWNER_A|PRIVATE_OWNER_B|effect-shared|effect-distinct/);
});
