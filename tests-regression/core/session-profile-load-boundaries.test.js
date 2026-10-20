import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, MAX_PHYSICAL_TASKS, MAX_LOGICAL_TASKS } from '../../src/core/schema.js';
import { applyPortableProfile, exportPortableProfile, previewPortableProfile } from '../../src/core/portable-profile.js';

function makeSession(index, tasks = 1) {
  return {
    id: `load-session-${index}`, name: `Сеанс ${index}`, promptMode: 'shared', sharedPrompt: 'Продовжуй.',
    runMode: 'one-pass', tabStrategy: 'keep-open', minimumSendIntervalSeconds: 1,
    tasks: Array.from({ length: tasks }, (_, task) => ({
      id: `load-task-${index}-${task}`, url: 'https://chatgpt.com/', enabled: true,
      label: `Завдання ${task}`, promptOverride: '',
    })),
  };
}
const profile = sessions => ({ format: 'chatgpt-autopilot-profile', version: 1,
  profileName: 'Профіль навантаження', sessions });

test('a million logical cycles use one physical task and survive profile export/import', () => {
  const session = { ...makeSession(1), configuredTaskCount: MAX_LOGICAL_TASKS };
  const original = profile([session]);
  assert.equal(previewPortableProfile(original, 100).taskCount, MAX_LOGICAL_TASKS);
  const state = createEmptyState(100);
  applyPortableProfile(state, original, { now: 100 });
  assert.equal(state.sessionsById[session.id].taskOrder.length, 1);
  const exported = exportPortableProfile(state);
  const restored = createEmptyState(200);
  applyPortableProfile(restored, exported, { now: 200 });
  assert.equal(restored.sessionsById[session.id].configuredTaskCount, MAX_LOGICAL_TASKS);
  assert.equal(restored.sessionsById[session.id].taskOrder.length, 1);
});

test('100 parallel sessions with mixed modes import/export without multiplying task identities', () => {
  const input = profile(Array.from({ length: 100 }, (_, index) => ({
    ...makeSession(index + 1), tabStrategy: ['worker', 'keep-open', 'open-close'][index % 3],
    runMode: index % 2 ? 'continuous' : 'one-pass',
  })));
  const state = createEmptyState(100);
  assert.equal(previewPortableProfile(input).sessionCount, 100);
  applyPortableProfile(state, input, { now: 100 });
  assert.equal(state.sessionOrder.length, 100);
  assert.equal(new Set(state.sessionOrder).size, 100);
  assert.equal(exportPortableProfile(state).sessions.length, 100);
  assert.ok(state.sessionOrder.every(id => state.sessionsById[id].runState === 'STOPPED'));
});

test('maximum physical tasks are accepted, but 1001 tasks and invalid logical expansion fail before mutation', () => {
  const session = makeSession(1, MAX_PHYSICAL_TASKS);
  const state = createEmptyState(100);
  applyPortableProfile(state, profile([session]), { now: 100 });
  assert.equal(state.sessionsById[session.id].taskOrder.length, MAX_PHYSICAL_TASKS);
  const before = structuredClone(state);
  assert.throws(() => applyPortableProfile(state, profile([makeSession(2, MAX_PHYSICAL_TASKS + 1)])), /physical tasks/);
  assert.deepEqual(state, before);
  const invalidExpansion = { ...session, configuredTaskCount: MAX_LOGICAL_TASKS };
  assert.throws(() => applyPortableProfile(state, profile([invalidExpansion])), /one shared URL and one shared prompt/);
  assert.deepEqual(state, before);
});
