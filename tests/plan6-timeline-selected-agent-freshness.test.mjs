import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// This is the real options.js function text, not a reimplementation of the
// production selection/read/export gates.
const source = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'expected production function boundaries');
  return source.slice(first, last);
}

test('Plan6 S1 selected Agent identity and owner mutation invalidate prior Timeline Core proof', () => {
  const ui = { selectedBrowserAgentId: 'agent-a', agentTimelineStale: false };
  const agentOwnerOperations = new Set();
  const agentViewFence = { select: id => ({ id }) };
  let invalidations = 0;
  const agentJobsReadGate = { invalidate() { invalidations += 1; } };
  const functions = runInNewContext(
    section('function selectBrowserAgentView(id)', 'function finishAgentOwnerOperation(') +
      '\n({ selectBrowserAgentView, beginAgentOwnerOperation });',
    { ui, agentOwnerOperations, agentViewFence, agentJobsReadGate, agentOwnerOperationSequence: 0 },
  );
  functions.selectBrowserAgentView('agent-a');
  assert.equal(ui.agentTimelineStale, false, 'same selection does not invent stale evidence');
  functions.selectBrowserAgentView('agent-b');
  assert.equal(ui.selectedBrowserAgentId, 'agent-b');
  assert.equal(ui.agentTimelineStale, true, 'new selection cannot use prior Core proof');
  ui.agentTimelineStale = false;
  const op = functions.beginAgentOwnerOperation('START', 'agent-b');
  assert.equal(op.ticket.id, 'agent-b');
  assert.equal(ui.agentTimelineStale, true, 'owner action invalidates pre-action evidence');
  assert.equal(invalidations, 1);
  assert.equal(functions.beginAgentOwnerOperation('START', 'agent-b'), null,
    'duplicate in-flight owner action must not claim a second operation');
});

test('Plan6 S1 Timeline export refuses cross-Agent identity mismatch without invoking projection', () => {
  const status = { textContent: '' };
  const ui = {
    agentTimelineStale: false,
    selectedBrowserAgentId: 'agent-b',
    agentTimelineJob: { id: 'agent-a' },
  };
  let projected = 0;
  let downloaded = 0;
  const announcements = [];
  const exportAgentRunTimeline = runInNewContext(
    section('function exportAgentRunTimeline()', 'function renderBrowserAgentList()') +
      '\nexportAgentRunTimeline;',
    {
      ui,
      $: id => id === 'agent-run-timeline-status' ? status : { value: 'ALL' },
      announce: value => announcements.push(value),
      buildAgentRunTimelineV1: () => { projected += 1; return { evidenceOnly: true }; },
      downloadJson: () => { downloaded += 1; },
    },
  );
  exportAgentRunTimeline();
  assert.equal(ui.agentTimelineStale, true);
  assert.equal(projected, 0, 'mismatched evidence cannot enter the projection');
  assert.equal(downloaded, 0);
  assert.match(status.textContent, /не відповідає хронології/u);
  assert.ok(announcements.length > 0, 'NVDA live announcement is generated');

  ui.agentTimelineStale = false;
  ui.agentTimelineJob = { id: 'agent-b' };
  exportAgentRunTimeline();
  assert.equal(downloaded, 1, 'matching accepted identity keeps read-only export usable');
  assert.equal(projected, 1);
  assert.equal(ui.agentTimelineStale, false);

  ui.agentTimelineStale = true;
  exportAgentRunTimeline();
  assert.equal(downloaded, 1, 'failed Core proof still blocks matching identity');
});

test('Plan6 S1 Core list freshness gate survives rejected read and accepts verified recovery', async () => {
  const ui = { selectedBrowserAgentId: 'agent-a', agentTimelineStale: true,
    browserAgentJobs: [], agentPolicyDirty: false, agentPolicyEditEpoch: 0 };
  let accepted = false;
  let rendered;
  let next = { data: { jobs: [{ id: 'agent-b' }], selectedId: 'agent-b' } };
  let currentTicket = true;
  const fn = runInNewContext(
    section("async function loadBrowserAgentJobs({ selectId = '' } = {})",
      'async function selectBrowserAgentJob()') +
      '\nloadBrowserAgentJobs;',
    {
      ui,
      agentViewFence: { beginRead: () => 1, currentRead: () => currentTicket },
      readAgentJobsWithDeadlineV1: reader => reader(),
      agentJobsReadGate: { read: async () => next, current: () => accepted },
      selectBrowserAgentView: id => { ui.selectedBrowserAgentId = id; ui.agentTimelineStale = true; },
      renderBrowserAgentList: () => {},
      renderBrowserAgentJob: job => { rendered = job; },
      $: () => ({ textContent: '' }),
    },
  );
  assert.equal((await fn()).applied, false);
  assert.equal(ui.agentTimelineStale, true, 'unaccepted Core data cannot clear stale gate');
  accepted = true;
  currentTicket = false;
  assert.equal((await fn()).applied, false);
  assert.equal(ui.agentTimelineStale, true, 'overtaken Core response cannot clear gate');
  currentTicket = true;
  const result = await fn();
  assert.equal(result.applied, true);
  assert.equal(ui.selectedBrowserAgentId, 'agent-b');
  assert.equal(ui.agentTimelineStale, false, 'accepted current Core data restores export');
  assert.equal(rendered.id, 'agent-b');
});
