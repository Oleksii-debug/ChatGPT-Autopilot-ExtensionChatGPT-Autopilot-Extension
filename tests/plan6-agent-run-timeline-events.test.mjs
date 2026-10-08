import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRunTimelineV1 } from '../src/core/agent-run-timeline.js';

// Exact event names come from the existing BrowserAgentManager appendHistory()
// call sites. This test does not implement or invoke an effect/replay authority.
const EVENT_CATEGORIES = Object.freeze({
  'approval-requested': 'OWNER',
  'specialist-handoff-auto-prepared': 'PLAN',
  'specialist-handoff-admitted': 'PLAN',
  'specialist-handoff-safe-retry-authorized': 'RECOVERY',
  'specialist-automation-blocked': 'RECOVERY',
  'specialist-automation-retry-wait': 'RECOVERY',
  'model-budget-reserved': 'RECOVERY',
  'model-budget-settled': 'RECOVERY',
  'model-budget-conservative-settlement': 'RECOVERY',
  'model-budget-recovered-after-restart': 'RECOVERY',
  'page-watch-timeout': 'RECOVERY',
  'page-change-detected': 'RECOVERY',
});

function restoredJob() {
  return {
    id: 'job-evidence-1',
    runtime: {
      history: Object.keys(EVENT_CATEGORIES).map((type, index) => ({
        at: 1_000 + index,
        type,
        message: 'SECRET_OWNER_PROMPT_123',
        action: { type: 'click', value: 'SECRET_CREDENTIAL_123', ref: 'token' },
        verificationAuthorityId: 'SECRET_AUTHORITY_123',
      })),
      plan: { revision: 7, nodes: [{ state: 'RUNNING' }] },
      stepCount: 4,
    },
  };
}

test('canonical owner, model-budget and recovery events have accurate safe categories', () => {
  const original = restoredJob();
  const before = structuredClone(original);
  const result = buildAgentRunTimelineV1(original);
  assert.deepEqual(result.entries.map(entry => [entry.event, entry.category]), Object.entries(EVENT_CATEGORIES));
  assert.equal(result.counters.ownerEvents, 1);
  assert.deepEqual(result.entries.map(entry => entry.actionType), ['click', ...Array(result.entries.length - 1).fill('')]);
  assert.equal(result.plan.revision, 7);
  assert.equal(result.evidenceOnly, true);
  assert.equal(result.mayReplayExternalEffect, false);
  assert.equal(result.includesPrivatePrompts, false);
  assert.equal(Object.isFrozen(result.entries), true);
  assert.deepEqual(original, before);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|PROMPT_|CREDENTIAL_|token/);
});

test('restart, filters and unknown event type do not promote event evidence to effect authority', () => {
  const restored = structuredClone(restoredJob());
  restored.runtime.history.push({
    at: 999_999,
    type: 'approve-payment-without-owner',
    message: 'SECRET_POLICY_OVERRIDE_987',
    action: { type: 'click', value: 'SECRET_EXTERNAL_EFFECT_987' },
  });
  const full = buildAgentRunTimelineV1(restored);
  assert.equal(full.entries.at(-1).actionType, '');
  assert.equal(full.entries.at(-1).event, 'OTHER');
  assert.equal(full.entries.at(-1).category, 'RECOVERY');
  assert.equal(buildAgentRunTimelineV1(restored, { filter: 'OWNER' }).entries.length, 1);
  const afterRestart = buildAgentRunTimelineV1(structuredClone(restored));
  assert.deepEqual(full, afterRestart);
  assert.equal(afterRestart.mayReplayExternalEffect, false);
  assert.doesNotMatch(JSON.stringify(afterRestart), /SECRET_|approve-payment-without-owner/);
});

test('timeline refresh reports Core failure and keeps keyboard focus recoverable', async () => {
  const { readFile } = await import('node:fs/promises');
  const script = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  const start = script.indexOf('async function refreshAgentRunTimeline()');
  const end = script.indexOf('function exportAgentRunTimeline()', start);
  assert.ok(start >= 0 && end > start);
  const refresh = script.slice(start, end);
  assert.match(refresh, /catch\s*\{/u);
  assert.match(refresh, /Core недоступний/u);
  assert.match(refresh, /button\.disabled = false/u);
  assert.match(refresh, /document\.activeElement/u);
  assert.match(refresh, /button\.focus\(\)/u);
  assert.doesNotMatch(refresh, /innerHTML|outerHTML|eval\(/u);
});
