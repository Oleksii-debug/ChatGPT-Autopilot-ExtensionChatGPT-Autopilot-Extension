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
  assert.equal(map.completeHistoryInspected, true);
  assert.deepEqual(map.observed, {
    planRevisionEvents: 1,
    ownerInterventionEvents: 1,
    actionRecordedEvents: 1,
    recoveryRecordedEvents: 1,
    checkpointRecordedEvents: 1,
    specialistProviderEvents: 1,
  });
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
  assert.equal(result.evidenceMap.completeHistoryInspected, false);
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
