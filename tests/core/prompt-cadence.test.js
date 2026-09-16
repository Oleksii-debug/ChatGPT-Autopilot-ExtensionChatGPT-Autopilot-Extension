import test from 'node:test';
import assert from 'node:assert/strict';
import { CadencedRepository, getPromptCadenceConfig, setPromptCadenceConfig } from '../../src/core/prompt-cadence.js';

function state() {
  return {
    profile: { promptCadenceBySessionId: {} },
    sessionsById: {
      s1: {
        id: 's1',
        sharedPrompt: 'primary',
        lastSuccessfulSendAt: 0,
        cadenceVerifiedSendCount: 0,
        tasksById: { t1: { id: 't1', promptOverride: '' } },
      },
    },
  };
}

function clone(value) { return structuredClone(value); }

function memoryRepo(initial) {
  let stored = clone(initial);
  return {
    async load() { return clone(stored); },
    async update(mutator) {
      const draft = clone(stored);
      const result = await mutator(draft);
      stored = clone(result || draft);
      return clone(stored);
    },
    snapshot() { return clone(stored); },
  };
}

test('cadence count increments only when lastSuccessfulSendAt advances', async () => {
  const initial = state();
  setPromptCadenceConfig(initial, 's1', { enabled: true, secondaryPrompt: 'secondary', everyN: 2 });
  const repo = new CadencedRepository(memoryRepo(initial));
  await repo.update(draft => {
    draft.sessionsById.s1.status = 'BUSY';
    return draft;
  });
  let loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.cadenceVerifiedSendCount, 0);
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'primary');

  await repo.update(draft => {
    draft.sessionsById.s1.lastSuccessfulSendAt = 1000;
    return draft;
  });
  loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.cadenceVerifiedSendCount, 1);
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'secondary');
  assert.equal(loaded.sessionsById.s1.tasksById.t1.promptOverride, 'secondary');

  await repo.update(draft => {
    draft.sessionsById.s1.lastSuccessfulSendAt = 1100;
    return draft;
  });
  loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.cadenceVerifiedSendCount, 2);
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'primary');
});

test('cadence projection does not mutate persisted primary prompt', async () => {
  const initial = state();
  initial.sessionsById.s1.cadenceVerifiedSendCount = 1;
  initial.profile.promptCadenceBySessionId.s1 = {
    enabled: true,
    secondaryPrompt: 'secondary',
    everyN: 2,
  };
  const base = memoryRepo(initial);
  const repo = new CadencedRepository(base);
  const projected = await repo.load();
  assert.equal(projected.sessionsById.s1.sharedPrompt, 'secondary');
  const persisted = base.snapshot();
  assert.equal(persisted.sessionsById.s1.sharedPrompt, 'primary');
  assert.equal(persisted.sessionsById.s1.tasksById.t1.promptOverride, '');
});

test('disabled or invalid cadence stays primary and normalization remains bounded', () => {
  const s = state();
  assert.deepEqual(getPromptCadenceConfig(s, 's1'), { enabled: false, secondaryPrompt: '', everyN: 10 });
  const config = setPromptCadenceConfig(s, 's1', { enabled: false, secondaryPrompt: '', everyN: 99999999 });
  assert.deepEqual(config, { enabled: false, secondaryPrompt: '', everyN: 1000000 });
  assert.throws(() => setPromptCadenceConfig(s, 'missing', { enabled: true, secondaryPrompt: 'x', everyN: 2 }), /Session not found/);
});
