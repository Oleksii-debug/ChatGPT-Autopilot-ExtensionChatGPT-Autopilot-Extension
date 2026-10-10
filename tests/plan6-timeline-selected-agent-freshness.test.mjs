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
    section('function selectBrowserAgentView(id)', 'function agentOwnerResult(') +
      '\n({ selectBrowserAgentView, beginAgentOwnerOperation, finishAgentOwnerOperation });',
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
  ui.agentTimelineStale = false; // Simulate a competing accepted Core read.
  functions.finishAgentOwnerOperation(op);
  assert.equal(ui.agentTimelineStale, true, 'owner completion revokes a read racing the actual durable write');
  assert.equal(invalidations, 2, 'owner start and completion both invalidate accepted-read epochs');
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
  const agentOwnerOperations = new Set();
  const fn = runInNewContext(
    section("async function loadBrowserAgentJobs({ selectId = '' } = {})",
      'async function selectBrowserAgentJob()') +
      '\nloadBrowserAgentJobs;',
    {
      ui, agentOwnerOperations,
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
  agentOwnerOperations.add('START:agent-b');
  const duringOperation = await fn();
  assert.equal(duringOperation.applied, true);
  assert.equal(ui.agentTimelineStale, true,
    'a Core read racing a live owner operation cannot authorize a timeline export');
  agentOwnerOperations.clear();
  const result = await fn();
  assert.equal(result.applied, true);
  assert.equal(ui.selectedBrowserAgentId, 'agent-b');
  assert.equal(ui.agentTimelineStale, false, 'new Core data after owner completion restores export');
  assert.equal(rendered.id, 'agent-b');
});

test('Plan6 S1 refresh cannot overwrite stale owner-operation or cross-Agent export fence', async () => {
  const status = { textContent: '' };
  const button = { disabled: false, focus() {} };
  const ui = { agentTimelineStale: false, selectedBrowserAgentId: 'agent-a' };
  const announcements = [];
  let renders = 0;
  let readMode = 'OWNER_PENDING';
  const fn = runInNewContext(
    section('async function refreshAgentRunTimeline()', 'function exportAgentRunTimeline()') +
      '\nrefreshAgentRunTimeline;',
    {
      ui,
      $: id => id === 'agent-run-timeline-refresh-button' ? button : status,
      document: { activeElement: button, body: {} },
      loadBrowserAgentJobs: async () => {
        if (readMode === 'OWNER_PENDING') return { applied: true, job: { id: 'agent-a' } };
        ui.agentTimelineStale = false; // Accepted Core read with no active owner operation.
        if (readMode === 'CROSS_AGENT') return { applied: true, job: { id: 'agent-b' } };
        return { applied: true, job: { id: 'agent-a' } };
      },
      renderAgentRunTimeline: () => { renders += 1; },
      announce: message => { announcements.push(message); },
    },
  );
  await fn();
  assert.equal(ui.agentTimelineStale, true);
  assert.equal(renders, 0);
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /не підтверджено/u);
  assert.match(announcements.at(-1), /Експорт заблоковано/u);
  readMode = 'CROSS_AGENT';
  await fn();
  assert.equal(ui.agentTimelineStale, true, 'a cross-Agent successful read is not authority');
  assert.equal(renders, 0);
  readMode = 'RECOVERED';
  await fn();
  assert.equal(ui.agentTimelineStale, false);
  assert.equal(renders, 1, 'a matching accepted Core read recovers read-only timeline navigation');
  assert.match(announcements.at(-1), /оновлено з Core/u);
});
