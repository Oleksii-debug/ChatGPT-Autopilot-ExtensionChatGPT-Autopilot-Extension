import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedSessionIdsForFairness, SchedulingClass, sessionSchedulingClass } from '../../src/core/scheduler-fairness.js';
import { createEmptyState, createSession, createTask } from '../../src/core/schema.js';

function makeSession(id, kind = 'ordinary') {
  const task = createTask({ id: `${id}-task`, url: 'https://chatgpt.com/' });
  const session = createSession({ id, name: id, tasks: [task], sharedPrompt: 'x', now: 1 });
  if (kind === 'scenario') session.scenarioWork = { managed: true };
  if (kind === 'worker') session.orchestrationWorker = { managed: true };
  if (kind === 'coordinator') session.orchestrationCoordinator = { managed: true };
  if (kind === 'remote') session.remoteDispatch = { managed: true };
  return session;
}

function stateWith(specs) {
  const state = createEmptyState(1);
  for (const [id, kind] of specs) {
    state.sessionsById[id] = makeSession(id, kind);
    state.sessionOrder.push(id);
  }
  return state;
}

test('all managed runtime session types are classified separately from ordinary Sessions', () => {
  assert.equal(sessionSchedulingClass(makeSession('o')), SchedulingClass.ORDINARY);
  for (const kind of ['scenario','worker','coordinator','remote']) {
    assert.equal(sessionSchedulingClass(makeSession(kind, kind)), SchedulingClass.MANAGED);
  }
});

test('ordinary Sessions are attempted first after a managed Send', () => {
  const state = stateWith([
    ['m1','scenario'], ['m2','worker'], ['o1','ordinary'], ['m3','scenario'], ['o2','ordinary'],
  ]);
  state.sendArbiter.lastSentSessionId = 'm1';
  state.sendArbiter.lastSentSchedulingClass = SchedulingClass.MANAGED;
  assert.deepEqual(orderedSessionIdsForFairness(state), ['o1','m2','o2','m3','m1']);
});

test('managed Sessions are attempted first after an ordinary Send', () => {
  const state = stateWith([
    ['m1','scenario'], ['o1','ordinary'], ['m2','scenario'], ['o2','ordinary'],
  ]);
  state.sendArbiter.lastSentSessionId = 'o1';
  state.sendArbiter.lastSentSchedulingClass = SchedulingClass.ORDINARY;
  assert.deepEqual(orderedSessionIdsForFairness(state), ['m2','o2','m1','o1']);
});



test('mixed scheduling interleaves classes even before any verified Send history exists', () => {
  const state = stateWith([
    ['m1','scenario'], ['m2','scenario'], ['m3','scenario'], ['m4','scenario'],
    ['o1','ordinary'], ['o2','ordinary'],
  ]);
  assert.deepEqual(orderedSessionIdsForFairness(state), ['m1','o1','m2','o2','m3','m4']);
});
test('fairness survives cleanup of the last managed Session', () => {
  const state = stateWith([
    ['m2','scenario'], ['m3','scenario'], ['o1','ordinary'], ['o2','ordinary'],
  ]);
  state.sendArbiter.lastSentSessionId = 'deleted-managed-session';
  state.sendArbiter.lastSentSchedulingClass = SchedulingClass.MANAGED;
  assert.deepEqual(orderedSessionIdsForFairness(state).slice(0, 2), ['o1','m2']);
  assert.ok(orderedSessionIdsForFairness(state).indexOf('o2') < 4);
});

test('single-class scheduling still rotates after the last sender', () => {
  const state = stateWith([['m1','scenario'], ['m2','scenario'], ['m3','scenario']]);
  state.sendArbiter.lastSentSessionId = 'm2';
  state.sendArbiter.lastSentSchedulingClass = SchedulingClass.MANAGED;
  assert.deepEqual(orderedSessionIdsForFairness(state), ['m3','m1','m2']);
});
