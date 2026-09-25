import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(first.scenarioSlots[0].completedResponses, 3);
  assert.equal(first.summary.completedResponses, 3);
  assert.equal(first.scenarioSlots[0].category, 'WAITING_RESPONSE');
});

test('scenario send totals survive READY, Core cleanup, and the next chat generation', () => {
  const scenario = cycle('autosport', 17, 16);
  const source = { coreState: { sessionOrder: [scenario.coreSession.id],
    sessionsById: { [scenario.coreSession.id]: scenario.coreSession } }, scenarios: [scenario] };
  scenario.runtime.chat.state = 'READY';
  scenario.runtime.chat.sessionId = '';
  scenario.runtime.totalCompletedTurns = 17;
  scenario.runtime.stepIndex = 0;
  scenario.runtime.repeatIndex = 0;
  let view = projectGlobalStatus(source);
  assert.equal(view.scenarioSlots[0].verifiedSends, 17);
  assert.equal(view.scenarioSlots[0].completedResponses, 17);
  assert.equal(view.summary.verifiedSends, 17, 'retained Core proof is not counted twice');
  delete source.coreState.sessionsById[scenario.coreSession.id];
  view = projectGlobalStatus(structuredClone(source));
  assert.equal(view.summary.verifiedSends, 17, 'cleaning the old Core Session cannot erase confirmed history');

  scenario.runtime.generation = 2;
  scenario.runtime.chat.generation = 2;
  scenario.runtime.chat.state = 'NEW';
  view = projectGlobalStatus(source);
  assert.equal(view.scenarioSlots[0].verifiedSends, 0, 'the next generation starts at zero');
  assert.equal(view.scenarioSlots[0].completedResponses, 0);
  assert.equal(view.summary.verifiedSends, 17, 'historical confirmed sends remain in the global total');
});

test('multi-round chat progress uses the full generation length', () => {
  const scenario = cycle('rounds', 0, 19);
  scenario.config.roundsPerGeneration = 2;
  scenario.runtime.round = 1;
  scenario.runtime.stepIndex = 1;
  scenario.runtime.repeatIndex = 1;
  scenario.runtime.chat.state = 'READY';
  scenario.runtime.chat.sessionId = '';
  const view = projectGlobalStatus({ scenarios: [scenario] });
  assert.equal(view.scenarioSlots[0].message, 20);
  assert.equal(view.scenarioSlots[0].messagesPerGeneration, 34);
  assert.equal(view.scenarioSlots[0].verifiedSends, 19);
  assert.equal(view.scenarioSlots[0].completedResponses, 19);
});

test('five 17-turn scenarios retain all confirmed sends without counting an ambiguous new effect', () => {
  const scenarios = Array.from({ length: 5 }, (_, index) => cycle(`slot-${index}`, 0, 17));
  for (const scenario of scenarios) {
    scenario.runtime.generation = 2;
    scenario.runtime.chat.generation = 2;
    scenario.runtime.chat.sessionId = '';
    scenario.runtime.chat.state = 'NEW';
  }
  const view = projectGlobalStatus({ scenarios, coreState: { sessionOrder: [], sessionsById: {} } });
  assert.equal(view.summary.verifiedSends, 85);
  assert.equal(view.summary.completedResponses, 85);
  assert.equal(view.scenarioSlots.every(row => row.verifiedSends === 0), true);
  const ambiguous = scenarios[0];
  ambiguous.runtime.chat.state = 'WAITING';
  ambiguous.runtime.chat.sessionId = 'ambiguous:core';
  const coreState = { sessionOrder: ['ambiguous:core'], sessionsById: {
    'ambiguous:core': { scenarioWork: { managed: true }, successfulSendCount: 1, operation: { phase: 'AMBIGUOUS' } },
  } };
  assert.equal(projectGlobalStatus({ scenarios, coreState }).summary.verifiedSends, 85);
  assert.equal(view.summary.verifiedSendHistoryComplete, false,
    'legacy runtime without a retired-send ledger reports a lower bound');
});

test('durable send ledger counts timed-out effects and never counts pending cleanup twice', () => {
  const scenario = cycle('timeout', 0, 0);
  scenario.runtime.verifiedSendHistoryComplete = true;
  scenario.runtime.retiredVerifiedSends = 1;
  scenario.runtime.generationRetiredVerifiedSends = 1;
  scenario.runtime.cleanupPendingSessionIds = ['old:core'];
  scenario.runtime.chat.state = 'NEW';
  scenario.runtime.chat.sessionId = '';
  const old = { id: 'old:core', successfulSendCount: 1,
    scenarioWork: { managed: true, scenarioId: 'timeout', generation: 1 } };
  const coreState = { sessionOrder: ['old:core'], sessionsById: { 'old:core': old } };
  let view = projectGlobalStatus({ scenarios: [scenario], coreState });
  assert.equal(view.summary.verifiedSends, 1);
  assert.equal(view.scenarioSlots[0].verifiedSends, 1);
  assert.equal(view.summary.completedResponses, 0);
  assert.equal(view.summary.verifiedSendHistoryComplete, true);

  delete coreState.sessionsById['old:core'];
  const replacement = { id: 'replacement:core', successfulSendCount: 1,
    operation: { phase: 'SENT_VERIFIED' }, scenarioWork: { managed: true, scenarioId: 'timeout', generation: 1 } };
  coreState.sessionOrder = ['replacement:core'];
  coreState.sessionsById['replacement:core'] = replacement;
  scenario.runtime.chat.state = 'WAITING';
  scenario.runtime.chat.sessionId = 'replacement:core';
  view = projectGlobalStatus(structuredClone({ scenarios: [scenario], coreState }));
  assert.equal(view.summary.verifiedSends, 2);
  assert.equal(view.scenarioSlots[0].verifiedSends, 2);
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

test('simplified and ordinary sessions are separate rows with one shared verified total', () => {
  const sessionsById = {
    simple: { id: 'simple', name: 'Simple', simplifiedSession: true, runState: 'RUNNING', successfulSendCount: 4 },
    full: { id: 'full', name: 'Full', runState: 'PAUSED', successfulSendCount: 2 },
  };
  const view = projectGlobalStatus({ coreState: { sessionOrder: ['simple', 'full'], sessionsById } });
  assert.equal(view.summary.total, 2);
  assert.equal(view.summary.verifiedSends, 6);
  assert.equal(view.sessions.length, 1);
  assert.equal(view.simplifiedSessions.length, 1);
  assert.equal(view.summary.RUNNING, 1);
  assert.equal(view.summary.PAUSED, 1);
});
