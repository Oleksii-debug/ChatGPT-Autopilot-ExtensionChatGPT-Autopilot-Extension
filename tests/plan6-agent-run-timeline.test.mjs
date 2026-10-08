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
