import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAgentRunTimelineV1 } from '../src/core/agent-run-timeline.js';

function sample() {
  return {
    id: 'job-evidence-boundary',
    runtime: {
      plan: { revision: 12, nodes: [{ state: 'READY' }] },
      history: [
        { type: 'plan', at: 10, message: 'PRIVATE_PLAN_TEXT' },
        { type: 'owner', at: 20, message: 'PRIVATE_OWNER_TOKEN' },
        { type: 'action', at: 30, action: { type: 'click', value: 'PRIVATE_EXTERNAL_ACTION' } },
        { type: 'specialist-provider-succeeded', at: 40, message: 'PRIVATE_PROVIDER_RESPONSE' },
        { type: 'page-watch-timeout', at: 45, message: 'PRIVATE_RECOVERY_REASON' },
        { type: 'cycle-done', at: 50, message: 'PRIVATE_RESULT' },
      ],
    },
  };
}

test('recorded events are a bounded presence map, never external effect proof', () => {
  const input = sample();
  const original = structuredClone(input);
  const timeline = buildAgentRunTimelineV1(input);
  const map = timeline.evidenceMap;
  assert.equal(map.scope, 'INSPECTED_CANONICAL_HISTORY_ONLY');
  assert.equal(map.allRetainedHistoryInspected, true);
  assert.deepEqual(map.observed, {
    planRevisionEvents: 1,
    ownerInterventionEvents: 1,
    actionRecordedEvents: 1,
    recoveryRecordedEvents: 1,
    checkpointRecordedEvents: 1,
    specialistProviderEvents: 1,
  });
  assert.equal(map.completeLifetimeHistoryKnown, false);
  assert.equal(map.externalEffectVerified, false);
  assert.deepEqual(map.notEstablishedByThisProjection, [
    'BEFORE_AFTER_SNAPSHOTS', 'EXTERNAL_EFFECT_RECEIPTS',
    'TOOL_EXECUTION_RECEIPTS', 'ARTIFACT_PROVENANCE', 'AGENT_TREE_EDGES',
  ]);
  assert.equal(Object.isFrozen(map), true);
  assert.equal(Object.isFrozen(map.observed), true);
  assert.equal(Object.isFrozen(map.notEstablishedByThisProjection), true);
  assert.deepEqual(input, original);
  assert.doesNotMatch(JSON.stringify(timeline), /PRIVATE_/);
});

test('forged event types and injected messages cannot establish receipts or owner authority', () => {
  const input = sample();
  input.runtime.history.push({
    type: 'EXTERNAL_EFFECT_RECEIPTS', at: 60, message: 'OWNER_APPROVED_SECRET',
    action: { type: 'click', value: 'PRIVATE_SECRET' },
    authority: 'ALLOW',
  });
  const timeline = buildAgentRunTimelineV1(input);
  assert.equal(timeline.entries.at(-1).event, 'OTHER');
  assert.equal(timeline.entries.at(-1).actionType, '');
  assert.equal(timeline.evidenceMap.externalEffectVerified, false);
  assert.equal(timeline.evidenceMap.observed.ownerInterventionEvents, 1);
  assert.equal(timeline.evidenceMap.observed.actionRecordedEvents, 1);
  assert.doesNotMatch(JSON.stringify(timeline), /OWNER_APPROVED_SECRET|PRIVATE_SECRET/);
  assert.deepEqual(buildAgentRunTimelineV1(structuredClone(input)), timeline);
});

test('history truncation never advertises complete provenance or global event counts', () => {
  const input = sample();
  input.runtime.history = Array.from({ length: 2200 }, (_, index) => ({
    at: index + 1, type: index === 0 ? 'owner' : 'action',
    message: 'PRIVATE_HISTORY_CONTENT',
  }));
  const result = buildAgentRunTimelineV1(input, { limit: 1, filter: 'ACTION' });
  assert.equal(result.evidenceMap.allRetainedHistoryInspected, false);
  assert.equal(result.totalRecorded, 2200);
  assert.equal(result.inspectedEntries, 2048);
  assert.equal(result.evidenceMap.observed.ownerInterventionEvents, 0);
  assert.equal(result.evidenceMap.observed.actionRecordedEvents, 2048);
  assert.equal(result.evidenceMap.externalEffectVerified, false);
  assert.equal(result.truncated, true);
  assert.equal(result.returnedEntries, 1);
});

test('keyboard reader sees limitations in semantic status, not a visual-only badge', async () => {
  const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  assert.match(html, /<ol id="agent-run-timeline-list" aria-label="[^"]+">/u);
  assert.match(html, /<label for="agent-run-timeline-filter">/u);
  const start = source.indexOf('function renderAgentRunTimeline(job)');
  const end = source.indexOf('async function refreshAgentRunTimeline()', start);
  assert.ok(start >= 0 && end > start);
  const projection = source.slice(start, end);
  assert.match(projection, /timeline\.evidenceMap\.observed\.planRevisionEvents/u);
  assert.match(projection, /зовнішніх ефектів/u);
  assert.match(projection, /серед переглянутих/u);
  assert.match(projection, /підрахунки неповні/u);
  assert.doesNotMatch(projection, /\.innerHTML\s*=|\.outerHTML\s*=|eval\(/u);
});

test('recorded outcome counters never claim independent external-effect verification', () => {
  const input = sample();
  const absent = buildAgentRunTimelineV1(input);
  assert.deepEqual(absent.evidenceMap.recordedOutcome, {
    source: 'CANONICAL_AGENT_RUNTIME_RECORDED_ONLY',
    recordPresent: false,
    criteriaRecorded: 0,
    recordedAt: null,
    externalEffectVerified: false,
  });
  input.runtime.verifiedOutcome = {
    verifiedAt: 1_750_000_000_000,
    snapshotSignature: 'PRIVATE_PAGE_SIGNATURE',
    checks: [{ criterion: 1, text: 'PRIVATE_OWNER_GOAL', detail: 'PRIVATE_TOOL_RECEIPT' }],
  };
  const seen = buildAgentRunTimelineV1(input);
  assert.equal(seen.counters.verifiedChecks, 1);
  assert.deepEqual(seen.evidenceMap.recordedOutcome, {
    source: 'CANONICAL_AGENT_RUNTIME_RECORDED_ONLY',
    recordPresent: true,
    criteriaRecorded: 1,
    recordedAt: 1_750_000_000_000,
    externalEffectVerified: false,
  });
  assert.equal(seen.evidenceMap.externalEffectVerified, false);
  assert.deepEqual(seen, buildAgentRunTimelineV1(structuredClone(input)));
  assert.equal(Object.isFrozen(seen.evidenceMap.recordedOutcome), true);
  assert.doesNotMatch(JSON.stringify(seen), /PRIVATE_|PAGE_SIGNATURE|TOOL_RECEIPT/);
});

test('malformed persisted outcome fails closed without running foreign getters', () => {
  const input = sample();
  let getterCalls = 0;
  input.runtime.verifiedOutcome = { verifiedAt: 100 };
  Object.defineProperty(input.runtime.verifiedOutcome, 'checks', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('PRIVATE_GETTER_EXECUTED'); },
  });
  assert.throws(() => buildAgentRunTimelineV1(input), /accessor-backed checks/);
  assert.equal(getterCalls, 0);
  input.runtime.verifiedOutcome = { checks: new Array(2) };
  input.runtime.verifiedOutcome.checks[1] = { criterion: 1 };
  assert.throws(() => buildAgentRunTimelineV1(input), /dense/);
  input.runtime.verifiedOutcome = { checks: Array.from({ length: 21 }, () => ({})) };
  assert.throws(() => buildAgentRunTimelineV1(input), /bounded/);
  input.runtime.verifiedOutcome = { checks: 'PRIVATE_NOT_AN_ARRAY' };
  assert.throws(() => buildAgentRunTimelineV1(input), /bounded/);
  input.runtime.verifiedOutcome = { verifiedAt: -1, checks: [] };
  const safe = buildAgentRunTimelineV1(input);
  assert.equal(safe.evidenceMap.recordedOutcome.recordedAt, null);
  assert.equal(safe.evidenceMap.recordedOutcome.criteriaRecorded, 0);
});

test('bounded identity and snapshot-scoped event ordinals survive restart without leaking malformed IDs', async () => {
  const base = sample();
  base.id = 'завдання_один';
  const before = buildAgentRunTimelineV1(base);
  assert.equal(before.jobId, 'завдання_один');
  assert.equal(before.entryIdentityScope, 'RETAINED_HISTORY_ORDINAL_NOT_DURABLE');
  assert.deepEqual(buildAgentRunTimelineV1(structuredClone(base)), before);
  assert.equal(before.mayReplayExternalEffect, false);
  // Bidi spoofing and actual control characters must not enter NVDA status
  // or downloadable evidence; a missing ID must never become an empty ID.
  for (const invalid of ['x'.repeat(129), 'owner\nsecret', 'owner\u0000secret', 'owner\u2028secret', 'owner\u202Esecret', null, undefined, 42, '']) {
    assert.throws(() => buildAgentRunTimelineV1({ ...base, id: invalid }), /job identity is invalid/);
  }
  const html = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  const projection = html.slice(html.indexOf('function renderAgentRunTimeline(job)'), html.indexOf('async function refreshAgentRunTimeline()'));
  assert.match(projection, /після обрізання історії/u);
  assert.doesNotMatch(projection, /\.innerHTML\s*=|\.outerHTML\s*=/u);
});
