import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectGlobalStatus } from '../src/core/global-status.js';

const cycle = (id, sends = 0, responses = 0) => ({
  id, name: id,
  config: { steps: [{ repeat: 1 }, { repeat: 15 }, { repeat: 1 }] },
  runtime: {
    mode: 'CHAT_CYCLE', runState: 'RUNNING', generation: 1,
    stepIndex: 1, repeatIndex: 2, totalCompletedTurns: responses,
    chat: { key: 'chat', role: 'CHAT', generation: 1, state: 'WAITING', sessionId: `${id}:core` },
  },
  coreSession: { id: `${id}:core`, runState: 'RUNNING', operation: { phase: 'SENT_VERIFIED' },
    successfulSendCount: sends, scenarioWork: { managed: true } },
});

test('five persistent scenario slots appear in the global panel without ONE_PASS rows', () => {
  const scenarios = Array.from({ length: 5 }, (_, index) => cycle(`autosport-${index}`, 1, 0));
  const coreState = { sessionOrder: scenarios.map(item => item.coreSession.id),
    sessionsById: Object.fromEntries(scenarios.map(item => [item.coreSession.id, item.coreSession])) };
  const view = projectGlobalStatus({ coreState, scenarios });
  assert.equal(view.summary.total, 5);
  assert.equal(view.summary.WAITING_RESPONSE, 5);
  assert.equal(view.summary.verifiedSends, 5);
  assert.equal(view.sessions.length, 0);
  assert.equal(view.scenarioSlots.length, 5);
  assert.equal(Object.values(view.summary).filter(Number.isInteger).includes(-1), false);
});

test('one scenario shows message four, four confirmed sends and three finished responses after reload', () => {
  const scenario = cycle('autosport', 4, 3);
  const source = { coreState: { sessionOrder: [scenario.coreSession.id],
    sessionsById: { [scenario.coreSession.id]: scenario.coreSession } }, scenarios: [scenario] };
  const first = projectGlobalStatus(source);
  const restored = projectGlobalStatus(structuredClone(source));
  assert.deepEqual(restored, first);
  assert.equal(first.scenarioSlots[0].message, 4);
  assert.equal(first.scenarioSlots[0].messagesPerGeneration, 17);
  assert.equal(first.scenarioSlots[0].verifiedSends, 4);
  assert.equal(first.summary.completedResponses, 3);
  assert.equal(first.scenarioSlots[0].category, 'WAITING_RESPONSE');
});

test('31 orchestration roles remain mutually exclusive and display round seven', () => {
  const view = projectGlobalStatus({ orchestras: [{ id: 'o', name: 'Autosport', ownerPaused: false,
    config: { enabled: true }, runtime: { mode: 'RUN', hierarchy: {
      currentRound: 7, nodeCount: 31, rootCount: 1, managerCount: 5, workerCount: 25,
      lifecycleCounts: { WAITING: 10, TERMINAL: 20, PREPARING_EFFECT: 1 },
    } } }] });
  assert.equal(view.summary.total, 31);
  assert.equal(view.summary.WAITING_RESPONSE, 10);
  assert.equal(view.summary.READY, 20);
  assert.equal(view.summary.RUNNING, 1);
  assert.equal(view.orchestration[0].round, 7);
  assert.equal(view.orchestration[0].managers, 5);
  assert.equal(view.orchestration[0].workers, 25);
});

test('orchestration effect phases distinguish acknowledged waiting from prepared work', () => {
  const view = projectGlobalStatus({ orchestras: [{ id: 'o', name: 'Roles', ownerPaused: false,
    config: { enabled: true }, runtime: { hierarchy: {
      currentRound: 7, nodeCount: 31, rootCount: 1, managerCount: 5, workerCount: 25,
      effectCounts: { WAITING_RESPONSE: 10, READY: 20, RUNNING: 1 },
      roleEffectCounts: {
        director: { WAITING_RESPONSE: 1 },
        manager: { WAITING_RESPONSE: 2, READY: 3 },
        worker: { WAITING_RESPONSE: 7, READY: 17, RUNNING: 1 },
      },
    } } }] });
  assert.equal(view.summary.total, 31);
  assert.equal(view.summary.WAITING_RESPONSE, 10);
  assert.equal(view.orchestration[0].roleEffectCounts.manager.READY, 3);
  assert.equal(view.orchestration[0].roleEffectCounts.worker.RUNNING, 1);
});

test('ambiguous Send and duplicate UI reads never increment verified counter', () => {
  const scenario = cycle('s', 0, 0);
  scenario.coreSession.operation.phase = 'AMBIGUOUS';
  const source = { coreState: { sessionOrder: [scenario.coreSession.id],
    sessionsById: { [scenario.coreSession.id]: scenario.coreSession } }, scenarios: [scenario] };
  assert.equal(projectGlobalStatus(source).summary.verifiedSends, 0);
  assert.equal(projectGlobalStatus(source).summary.AMBIGUOUS_EFFECT, 1);
  scenario.coreSession.operation.phase = 'SENT_VERIFIED';
  scenario.coreSession.successfulSendCount = 1;
  assert.equal(projectGlobalStatus(source).summary.verifiedSends, 1);
  assert.equal(projectGlobalStatus(source).summary.verifiedSends, 1);
});

test('Browser Agent waiting states stay mutually exclusive and never project as READY', () => {
  const states = [
    'WAITING_PERMISSION',
    'WAITING_APPROVAL',
    'WAITING_CAPABILITY',
    'WAITING_SCHEDULE',
  ];
  const agentJobs = states.map((state, index) => ({
    id: `agent-${index + 1}`,
    config: { name: state },
    runtime: { runState: state },
  }));

  const view = projectGlobalStatus({ agentJobs });
  assert.equal(view.summary.total, 4);
  assert.equal(view.summary.READY, 0);
  for (const state of states) {
    assert.equal(view.summary[state], 1);
  }
  assert.deepEqual(view.agents.map(row => row.category), states);
});

test('Global Status UI exposes Ukrainian owner-action waiting labels', async () => {
  const source = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  for (const expected of [
    'Потрібен дозвіл сайту',
    'Очікує підтвердження дії',
    'Потрібен дозвіл capability',
    'Очікує розкладу',
  ]) {
    assert.match(source, new RegExp(expected));
  }
  assert.match(source, /globalStatusCategoryLabel\(row\.category\)/);
});
